/**
 * Discord webhook channel — unit tests.
 *
 * Covers:
 *   - Payload shape per trigger type (title, description, color, fields).
 *   - Color selection for stuck / failed / drained / unknown.
 *   - Env var missing → ok=false without touching the network.
 *   - 2xx response → ok=true.
 *   - 4xx / 5xx / network error → ok=false with error text.
 *   - Never throws across the send() boundary.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { PulseDoc } from '@shardworks/lattice-apparatus';

import {
  buildPayload,
  contextFields,
  createDiscordWebhookFactory,
  embedColorForTrigger,
} from './channel.ts';

// ── Fetch mock helpers ────────────────────────────────────────────

function mockFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function okResponse(body: string = ''): Response {
  // Discord webhooks typically respond 204 on success. The stock Response
  // constructor rejects a body with 204, so we pass `null` for the body on
  // 204 and hand-roll a 200 when callers want to include a body.
  if (body === '') {
    return new Response(null, { status: 204 });
  }
  return new Response(body, { status: 200 });
}

function errResponse(status: number, body: string = ''): Response {
  return new Response(body, { status });
}

function pulse(partial: Partial<PulseDoc> = {}): PulseDoc {
  const now = new Date().toISOString();
  return {
    id: 'p-test-1',
    source: 'reckoner',
    triggerType: 'reckoner.writ-stuck',
    writId: 'w-abcdef',
    title: 'Writ stuck',
    summary: 'something broke',
    linkUrl: null,
    context: {
      writShortId: 'w-abcdef',
      writPhase: 'stuck',
      writTitle: 'A writ',
      writType: 'mandate',
      stuckCause: 'engine-failure',
      retryable: false,
      detail: 'session crashed',
    },
    deliveryState: 'pending',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('embed color selection', () => {
  it('maps each trigger type to a distinct color', () => {
    const stuck = embedColorForTrigger('reckoner.writ-stuck');
    const failed = embedColorForTrigger('reckoner.writ-failed');
    const drained = embedColorForTrigger('reckoner.queue-drained');
    assert.notStrictEqual(stuck, failed);
    assert.notStrictEqual(stuck, drained);
    assert.notStrictEqual(failed, drained);
  });

  it('falls back to a neutral default for unknown trigger types', () => {
    const unknown = embedColorForTrigger('future.not-yet-invented');
    assert.equal(typeof unknown, 'number');
  });
});

describe('context field rendering', () => {
  it('renders stuck context with writ metadata and cause fields', () => {
    const fields = contextFields(
      pulse({
        triggerType: 'reckoner.writ-stuck',
        context: {
          writType: 'piece',
          stuckCause: 'engine-failure',
          retryable: true,
          detail: 'timeout',
        },
      }),
    );
    const map = new Map(fields.map((f) => [f.name, f.value]));
    assert.equal(map.get('Type'), 'piece');
    assert.equal(map.get('Cause'), 'engine-failure');
    assert.equal(map.get('Retryable'), 'true');
    assert.equal(map.get('Detail'), 'timeout');
  });

  it('renders failed context with resolution and childFailures', () => {
    const fields = contextFields(
      pulse({
        triggerType: 'reckoner.writ-failed',
        context: {
          writType: 'mandate',
          resolution: 'abandoned',
          childFailures: ['w-bad1', 'w-bad2'],
        },
      }),
    );
    const map = new Map(fields.map((f) => [f.name, f.value]));
    assert.equal(map.get('Resolution'), 'abandoned');
    assert.equal(map.get('Child failures'), 'w-bad1, w-bad2');
  });

  it('renders drain context with drainedAt and lastTerminalWritId', () => {
    const fields = contextFields(
      pulse({
        triggerType: 'reckoner.queue-drained',
        writId: null,
        context: {
          drainedAt: '2026-04-23T00:00:00Z',
          lastTerminalWritId: 'w-last-writ-id',
        },
      }),
    );
    const map = new Map(fields.map((f) => [f.name, f.value]));
    assert.equal(map.get('Drained at'), '2026-04-23T00:00:00Z');
    assert.equal(map.get('Last terminal'), 'w-last');
  });

  it('renders unknown trigger types with raw context keys', () => {
    const fields = contextFields(
      pulse({
        triggerType: 'future.some-event',
        writId: null,
        context: { anything: 'goes', count: 3 },
      }),
    );
    const map = new Map(fields.map((f) => [f.name, f.value]));
    assert.equal(map.get('anything'), 'goes');
    assert.equal(map.get('count'), '3');
  });
});

describe('buildPayload', () => {
  it('wraps the embed in an embeds array with title and description', () => {
    const payload = buildPayload(
      pulse({ title: 'Hello', summary: 'world' }),
    );
    assert.ok(Array.isArray(payload.embeds));
    const embeds = payload.embeds as Array<Record<string, unknown>>;
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0]?.title, 'Hello');
    assert.equal(embeds[0]?.description, 'world');
    assert.equal(typeof embeds[0]?.color, 'number');
    assert.ok(Array.isArray(embeds[0]?.fields));
  });

  it('omits url when linkUrl is null', () => {
    const payload = buildPayload(pulse({ linkUrl: null }));
    const embeds = payload.embeds as Array<Record<string, unknown>>;
    assert.ok(!('url' in (embeds[0] ?? {})));
  });

  it('includes url when linkUrl is set', () => {
    const payload = buildPayload(pulse({ linkUrl: 'https://example.invalid/x' }));
    const embeds = payload.embeds as Array<Record<string, unknown>>;
    assert.equal(embeds[0]?.url, 'https://example.invalid/x');
  });

  it('includes username when provided', () => {
    const payload = buildPayload(pulse(), { username: 'Reckoner' });
    assert.equal(payload.username, 'Reckoner');
  });
});

describe('Discord channel send()', () => {
  const ENV_VAR = 'TEST_LATTICE_DISCORD_WEBHOOK_URL';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('returns ok:false when the env var is unset and does not call fetch', async () => {
    let called = false;
    const restore = mockFetch(async () => {
      called = true;
      return okResponse();
    });
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const outcome = await channel.send(pulse());
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.error, /TEST_LATTICE_DISCORD_WEBHOOK_URL/);
      }
      assert.equal(called, false);
    } finally {
      restore();
    }
  });

  it('returns ok:true on a 2xx response', async () => {
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    const restore = mockFetch(async () => okResponse());
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const outcome = await channel.send(pulse());
      assert.equal(outcome.ok, true);
    } finally {
      restore();
    }
  });

  it('returns ok:false on a 4xx response with the status in the error', async () => {
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    const restore = mockFetch(async () => errResponse(404, 'not found'));
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const outcome = await channel.send(pulse());
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.error, /404/);
        assert.match(outcome.error, /not found/);
      }
    } finally {
      restore();
    }
  });

  it('returns ok:false on a 5xx response', async () => {
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    const restore = mockFetch(async () => errResponse(503, 'gateway'));
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const outcome = await channel.send(pulse());
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.error, /503/);
      }
    } finally {
      restore();
    }
  });

  it('returns ok:false when fetch throws', async () => {
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    const restore = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const outcome = await channel.send(pulse());
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.error, /network error/);
        assert.match(outcome.error, /ECONNREFUSED/);
      }
    } finally {
      restore();
    }
  });

  it('posts JSON with the built payload to the webhook URL', async () => {
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    let receivedUrl: string | undefined;
    let receivedBody: unknown;
    let receivedHeaders: Record<string, string> | undefined;
    const restore = mockFetch(async (input, init) => {
      receivedUrl = typeof input === 'string' ? input : String(input);
      receivedBody = JSON.parse(init?.body as string);
      receivedHeaders = init?.headers as Record<string, string>;
      return okResponse();
    });
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({
        type: 'discord-webhook',
        webhookUrlEnvVar: ENV_VAR,
      });
      const p = pulse({
        title: 'Writ stuck',
        summary: 'test summary',
      });
      await channel.send(p);
    } finally {
      restore();
    }
    assert.equal(receivedUrl, 'https://discord.invalid/webhook');
    assert.equal(receivedHeaders?.['Content-Type'], 'application/json');
    const body = receivedBody as Record<string, unknown>;
    assert.ok(Array.isArray(body.embeds));
    const embeds = body.embeds as Array<Record<string, unknown>>;
    assert.equal(embeds[0]?.title, 'Writ stuck');
    assert.equal(embeds[0]?.description, 'test summary');
  });

  it('defaults to DISCORD_WEBHOOK_URL when no env var is specified', async () => {
    const origEnv = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.invalid/default';
    let receivedUrl: string | undefined;
    const restore = mockFetch(async (input) => {
      receivedUrl = typeof input === 'string' ? input : String(input);
      return okResponse();
    });
    try {
      const factory = createDiscordWebhookFactory();
      const channel = factory.create({ type: 'discord-webhook' });
      await channel.send(pulse());
    } finally {
      restore();
      if (origEnv === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = origEnv;
    }
    assert.equal(receivedUrl, 'https://discord.invalid/default');
  });
});

describe('kit default export', () => {
  it('contributes latticeChannels with discord-webhook factory', async () => {
    const mod = await import('./index.ts');
    const plugin = mod.default as { kit: { latticeChannels?: Array<{ type: string }> } };
    assert.ok(plugin.kit);
    assert.ok(Array.isArray(plugin.kit.latticeChannels));
    assert.equal(plugin.kit.latticeChannels?.[0]?.type, 'discord-webhook');
  });
});
