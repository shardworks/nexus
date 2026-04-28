/**
 * `summon-relay` unit tests.
 *
 * Strategy:
 *
 *   - Use stubbed `AnimatorApi` and `LoomApi` apis on a test-managed
 *     `apparatusMap`, so we exercise every code path the relay drives
 *     against those apparatuses without booting their real machinery.
 *   - Use a real Clerk on an in-memory Stacks (`MemoryBackend`) so the
 *     writ-binding and circuit-breaker paths exercise the production
 *     setWritStatus / transition flow against actual SQLite-shaped
 *     read-modify-write semantics.
 *   - Drive the relay via its exported `createSummonRelay()` factory and
 *     call its `handler` directly with synthetic `GuildEvent` /
 *     `RelayContext` shapes — the dispatcher's contract is already
 *     covered by `dispatcher.test.ts`.
 *
 * Each `it()` corresponds to a clause in the commission's acceptance
 * signal or a behavioral case enumerated in task t7.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, setGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createSummonRelay } from './summon-relay.ts';
import type { GuildEvent, RelayContext } from './relay.ts';

// ── Structural shapes for the stubbed apparatuses ────────────────────
//
// These mirror the slim subset of the Animator / Loom API that the relay
// actually uses. Defining them locally keeps the test (and the
// package's own typecheck) independent of the Animator and Loom build
// graphs — the relay's structural contract is small enough to inline,
// and the assertions below all read fields directly off these shapes.

/** Minimal `RoleInfo` returned from `LoomApi.listRoles()`. */
interface RoleInfo {
  name: string;
  permissions: string[];
  source: string;
}

/** Minimal `LoomApi` slice the relay exercises. */
interface LoomApi {
  listRoles(): RoleInfo[];
  weave(...args: unknown[]): Promise<never>;
}

/** Minimal `SessionResult` shape returned by the stub Animator's promise. */
interface SessionResult {
  id: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider: string;
  exitCode: number;
}

/** Minimal `SummonRequest` — exactly what the relay populates. */
interface SummonRequest {
  prompt: string;
  role?: string;
  cwd: string;
  metadata?: Record<string, unknown>;
}

/** Minimal `AnimateHandle` — the relay only awaits `result`. */
interface AnimateHandle {
  sessionId: string;
  chunks: AsyncIterable<unknown>;
  result: Promise<SessionResult>;
}

// ── Stub apparatus shapes ────────────────────────────────────────────

interface SummonCall {
  request: SummonRequest;
  resolveResult: (result: SessionResult) => void;
  rejectResult: (err: unknown) => void;
}

interface StubAnimator {
  api: { summon: (request: SummonRequest) => AnimateHandle };
  calls: SummonCall[];
}

function makeStubAnimator(): StubAnimator {
  const calls: SummonCall[] = [];
  return {
    calls,
    api: {
      summon(request: SummonRequest): AnimateHandle {
        let resolveResult!: (result: SessionResult) => void;
        let rejectResult!: (err: unknown) => void;
        const result = new Promise<SessionResult>((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
        });
        const sessionId = `ses-test-${calls.length}`;
        const handle: AnimateHandle = {
          sessionId,
          chunks: (async function* (): AsyncIterable<never> { /* empty */ })(),
          result,
        };
        calls.push({ request, resolveResult, rejectResult });
        return handle;
      },
    },
  };
}

/** Build a fake LoomApi that knows about the supplied role names. */
function makeStubLoom(roles: string[]): LoomApi {
  const roleInfos: RoleInfo[] = roles.map((name) => ({
    name,
    permissions: [],
    source: 'guild',
  }));
  return {
    listRoles(): RoleInfo[] {
      return roleInfos;
    },
    async weave(): Promise<never> {
      throw new Error('stub loom: weave() not implemented for these tests');
    },
  };
}

// ── Test harness ─────────────────────────────────────────────────────

interface RelayFixture {
  clerk: ClerkApi;
  stacks: StacksApi;
  apparatusMap: Map<string, unknown>;
  animator: StubAnimator;
  loom: LoomApi;
  invoke: (
    event: GuildEvent | null,
    params: Record<string, unknown>,
  ) => Promise<void>;
}

interface FixtureOptions {
  /** Roles known to the stub Loom. Defaults to `['artificer']`. */
  roles?: string[];
  /** Whether to install the stub Animator (default: true). */
  withAnimator?: boolean;
  /** Whether to install the stub Loom (default: true). */
  withLoom?: boolean;
  /**
   * Result the stub Animator's `result` promise resolves to. Tests that
   * care about the resolved value override per-call instead. Default:
   * a generic 'completed' shape sufficient for typing.
   */
  defaultSessionResult?: SessionResult;
}

const DEFAULT_SESSION_RESULT: SessionResult = {
  id: 'ses-test',
  status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  provider: 'stub',
  exitCode: 0,
};

async function buildFixture(opts: FixtureOptions = {}): Promise<RelayFixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  // Stacks first.
  const stacksApparatus = stacksPlugin.apparatus;
  await stacksApparatus.start({ on(): void {}, kits(): never[] { return []; } });
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Materialize the Clerk-owned books so the in-memory backend has the
  // indexed schema available when start() prime its handles.
  backend.ensureBook(
    { ownerId: 'clerk', book: 'writs' },
    {
      indexes: [
        'phase',
        'type',
        'createdAt',
        'parentId',
        ['phase', 'type'],
        ['phase', 'createdAt'],
        ['parentId', 'phase'],
      ],
    },
  );
  backend.ensureBook(
    { ownerId: 'clerk', book: 'links' },
    {
      indexes: [
        'sourceId',
        'targetId',
        'label',
        ['sourceId', 'label'],
        ['targetId', 'label'],
      ],
    },
  );

  const clerkApparatus = clerkPlugin.apparatus;
  await clerkApparatus.start({
    on(): void {},
    kits(): never[] { return []; },
  });
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Stubs.
  const animator = makeStubAnimator();
  if (opts.withAnimator !== false) {
    apparatusMap.set('animator', animator.api);
  }
  const loom = makeStubLoom(opts.roles ?? ['artificer']);
  if (opts.withLoom !== false) {
    apparatusMap.set('loom', loom);
  }

  const relay = createSummonRelay();
  const defaultResult = opts.defaultSessionResult ?? DEFAULT_SESSION_RESULT;

  async function invoke(
    event: GuildEvent | null,
    params: Record<string, unknown>,
  ): Promise<void> {
    // Snapshot the call count so we only auto-resolve summons that the
    // relay invokes during this turn — earlier turns' results have
    // already been settled.
    const startIndex = animator.calls.length;
    const context: RelayContext = { home: fakeGuild.home, params };

    // Coerce the handler's result to a settled `{ ok, error }` shape
    // immediately so a synchronous rejection inside `validateParams`
    // does not show up as an "unhandled promise rejection" between
    // microtasks. Tests assert against the captured error explicitly.
    type Outcome =
      | { ok: true }
      | { ok: false; error: unknown };
    const outcomePromise: Promise<Outcome> = (async () => {
      try {
        await relay.handler(event, context);
        return { ok: true } as const;
      } catch (error) {
        return { ok: false, error } as const;
      }
    })();

    // Drain summons every tick until the handler settles. The handler
    // might wait on multiple consecutive `animator.summon` calls (the
    // breaker test does this in a loop), so we re-scan each turn.
    let outcome: Outcome | undefined;
    while (outcome === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = startIndex; i < animator.calls.length; i += 1) {
        animator.calls[i].resolveResult(defaultResult);
      }
      // Race the outcome against the next tick. A synchronous throw or
      // an early return both settle the outcome promise; in either
      // case we exit the loop on the next iteration.
      outcome = await Promise.race([
        outcomePromise,
        new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
      ]);
    }

    if (!outcome.ok) throw outcome.error;
  }

  return { clerk, stacks, apparatusMap, animator, loom, invoke };
}

// Helper: post a mandate writ in `open` phase via the Clerk.
async function postOpenMandate(
  clerk: ClerkApi,
  fields: { title?: string; body?: string } = {},
): Promise<WritDoc> {
  const writ = await clerk.post({
    title: fields.title ?? 'Test mandate',
    body: fields.body ?? 'A body',
  });
  return clerk.transition(writ.id, 'open');
}

function buildEvent(overrides: Partial<GuildEvent> = {}): GuildEvent {
  return {
    id: overrides.id ?? 'e-test-0001',
    name: overrides.name ?? 'writ.mandate.open',
    payload: overrides.payload ?? null,
    emitter: overrides.emitter ?? 'tester',
    firedAt: overrides.firedAt ?? '2026-04-25T12:00:00.000Z',
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('summon-relay — relay definition', () => {
  afterEach(() => clearGuild());

  it('registers under name "summon-relay" with the documented description', () => {
    const def = createSummonRelay();
    assert.equal(def.name, 'summon-relay');
    assert.equal(
      def.description,
      'Summon an anima session in response to an event.',
    );
    assert.equal(typeof def.handler, 'function');
  });
});

describe('summon-relay — parameter validation', () => {
  afterEach(() => clearGuild());

  it('throws when role is missing', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), { prompt: 'go' }),
      /role/i,
    );
    assert.equal(fix.animator.calls.length, 0);
  });

  it('throws when role is empty', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), { role: '', prompt: 'go' }),
      /role/i,
    );
  });

  it('throws when prompt is missing', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), { role: 'artificer' }),
      /prompt/i,
    );
  });

  it('throws when prompt is empty', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), { role: 'artificer', prompt: '' }),
      /prompt/i,
    );
  });

  it('throws when maxSessions is negative', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'artificer',
        prompt: 'go',
        maxSessions: -1,
      }),
      /maxSessions/,
    );
  });

  it('throws when maxSessions is non-numeric', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'artificer',
        prompt: 'go',
        maxSessions: 'lots' as unknown as number,
      }),
      /maxSessions/,
    );
  });
});

describe('summon-relay — apparatus resolution', () => {
  afterEach(() => clearGuild());

  it('throws a clear error when the Loom apparatus is not installed', async () => {
    const fix = await buildFixture({ withLoom: false });
    await assert.rejects(
      fix.invoke(buildEvent(), { role: 'artificer', prompt: 'go' }),
      /loom/i,
    );
    assert.equal(fix.animator.calls.length, 0);
  });

  it('throws a clear error when the Animator apparatus is not installed', async () => {
    const fix = await buildFixture({ withAnimator: false });
    await assert.rejects(
      fix.invoke(buildEvent(), { role: 'artificer', prompt: 'go' }),
      /animator/i,
    );
  });
});

describe('summon-relay — role validation', () => {
  afterEach(() => clearGuild());

  it('throws naming the missing role when the Loom does not know it', async () => {
    const fix = await buildFixture({ roles: ['scribe'] });
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'no-such-role',
        prompt: 'go',
      }),
      /no-such-role/,
    );
    assert.equal(fix.animator.calls.length, 0);
  });

  it('proceeds when the role is registered', async () => {
    const fix = await buildFixture({ roles: ['artificer'] });
    await fix.invoke(buildEvent(), {
      role: 'artificer',
      prompt: 'do the thing',
    });
    assert.equal(fix.animator.calls.length, 1);
  });
});

describe('summon-relay — writ binding', () => {
  afterEach(() => clearGuild());

  it('fetches the writ via the Clerk when event.payload.writId is a string', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, {
      title: 'Inspect the frobnicator',
    });
    await fix.invoke(
      buildEvent({ payload: { writId: writ.id } }),
      {
        role: 'artificer',
        prompt: 'Read your writ. Title: {{writ.title}}',
      },
    );
    assert.equal(fix.animator.calls.length, 1);
    assert.equal(
      fix.animator.calls[0].request.prompt,
      'Read your writ. Title: Inspect the frobnicator',
    );
    // Metadata records the bound writ id.
    assert.equal(
      (fix.animator.calls[0].request.metadata as Record<string, unknown>).writId,
      writ.id,
    );
  });

  it('synthesizes an in-memory writ when no writId is in the payload', async () => {
    const fix = await buildFixture();
    const event = buildEvent({
      id: 'e-test-syn',
      payload: { hello: 'world' },
    });
    await fix.invoke(event, {
      role: 'artificer',
      prompt: 'Title is: {{writ.title}}; type is: {{writ.type}}',
    });
    assert.equal(fix.animator.calls.length, 1);
    const prompt = fix.animator.calls[0].request.prompt!;
    assert.match(prompt, /Title is: Synthetic writ for writ\.mandate\.open/);
    assert.match(prompt, /type is: synthetic/);
    // Synthetic writs are never persisted — count remains 0.
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    assert.equal(await writsBook.count(), 0);
    // Metadata's writId starts with `syn-`.
    assert.match(
      (fix.animator.calls[0].request.metadata as Record<string, unknown>).writId as string,
      /^syn-/,
    );
  });

  it('treats a non-string writId as missing and falls back to synthetic', async () => {
    const fix = await buildFixture();
    await fix.invoke(
      buildEvent({ payload: { writId: 42 } }),
      {
        role: 'artificer',
        prompt: 'go',
      },
    );
    assert.equal(fix.animator.calls.length, 1);
    assert.match(
      (fix.animator.calls[0].request.metadata as Record<string, unknown>).writId as string,
      /^syn-/,
    );
  });
});

describe('summon-relay — template hydration', () => {
  afterEach(() => clearGuild());

  it('substitutes across writ.*, event.*, and params.* namespaces', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, { title: 'A title' });
    await fix.invoke(
      buildEvent({
        id: 'e-render-1',
        name: 'writ.mandate.open',
        payload: { writId: writ.id, hint: 'urgent' },
      }),
      {
        role: 'artificer',
        prompt:
          'writ:{{writ.title}}|event:{{event.name}}|payload:{{event.payload.hint}}|param:{{params.flag}}',
        flag: 'verbose',
      },
    );
    const prompt = fix.animator.calls[0].request.prompt!;
    assert.equal(
      prompt,
      'writ:A title|event:writ.mandate.open|payload:urgent|param:verbose',
    );
  });

  it('throws when a referenced template path resolves to undefined', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'artificer',
        prompt: 'value: {{event.payload.does_not_exist}}',
      }),
      /does_not_exist/,
    );
    assert.equal(fix.animator.calls.length, 0);
  });

  it('throws when a referenced top-level namespace is unknown', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'artificer',
        prompt: 'value: {{nope.something}}',
      }),
      /nope\.something/,
    );
  });

  it('does not expose role/prompt/maxSessions through params.*', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      fix.invoke(buildEvent(), {
        role: 'artificer',
        prompt: 'value: {{params.role}}',
      }),
      /params\.role/,
    );
  });
});

describe('summon-relay — session launch', () => {
  afterEach(() => clearGuild());

  it('calls animator.summon with the hydrated prompt, guild home cwd, and the documented metadata', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, { title: 'Summon target' });
    await fix.invoke(
      buildEvent({
        id: 'e-meta-1',
        name: 'writ.mandate.open',
        payload: { writId: writ.id },
      }),
      {
        role: 'artificer',
        prompt: 'Hello, {{writ.title}}',
      },
    );
    assert.equal(fix.animator.calls.length, 1);
    const req = fix.animator.calls[0].request;
    assert.equal(req.prompt, 'Hello, Summon target');
    assert.equal(req.role, 'artificer');
    assert.equal(req.cwd, '/tmp/test-guild');
    assert.deepEqual(req.metadata, {
      trigger: 'summon-relay',
      role: 'artificer',
      writId: writ.id,
      eventId: 'e-meta-1',
      eventName: 'writ.mandate.open',
    });
  });

  it('awaits the AnimateHandle.result before returning from the handler', async () => {
    const fix = await buildFixture();
    const def = createSummonRelay();
    let settled = false;

    // Run the handler manually so we can observe the await without
    // letting the fixture auto-resolve the result.
    const handlerPromise = (async () => {
      await def.handler(buildEvent(), {
        home: '/tmp/test-guild',
        params: { role: 'artificer', prompt: 'go' },
      });
      settled = true;
    })();

    // Wait long enough that the handler reaches the await on result.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fix.animator.calls.length, 1, 'summon should have been called');
    assert.equal(
      settled,
      false,
      'handler must not return until the session result resolves',
    );

    fix.animator.calls[0].resolveResult(DEFAULT_SESSION_RESULT);
    await handlerPromise;
    assert.equal(settled, true);
  });
});

describe('summon-relay — circuit breaker', () => {
  afterEach(() => clearGuild());

  it('launches up to maxSessions then transitions the writ to failed on the next call', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, { title: 'Loop guard' });

    // Three permitted attempts.
    for (let i = 0; i < 3; i += 1) {
      await fix.invoke(
        buildEvent({ id: `e-${i}`, payload: { writId: writ.id } }),
        { role: 'artificer', prompt: 'go', maxSessions: 3 },
      );
    }
    assert.equal(fix.animator.calls.length, 3);

    // Fourth attempt trips the breaker — no further launch, no throw.
    await fix.invoke(
      buildEvent({ id: 'e-3', payload: { writId: writ.id } }),
      { role: 'artificer', prompt: 'go', maxSessions: 3 },
    );
    assert.equal(fix.animator.calls.length, 3, 'no fourth launch');

    // Writ transitioned to `'failed'` with a resolution string naming
    // the relay and the cap.
    const updated = await fix.clerk.show(writ.id);
    assert.equal(updated.phase, 'failed');
    assert.match(updated.resolution ?? '', /summon-relay/);
    assert.match(updated.resolution ?? '', /3/);
  });

  it('persists the session-attempt counter on the writ status slot', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, { title: 'Counter check' });

    await fix.invoke(
      buildEvent({ payload: { writId: writ.id } }),
      { role: 'artificer', prompt: 'go' },
    );
    const after1 = await fix.clerk.show(writ.id);
    const status1 = after1.status?.clockworks as
      | { sessionAttempts?: number }
      | undefined;
    assert.equal(status1?.sessionAttempts, 1);

    await fix.invoke(
      buildEvent({ payload: { writId: writ.id } }),
      { role: 'artificer', prompt: 'go' },
    );
    const after2 = await fix.clerk.show(writ.id);
    const status2 = after2.status?.clockworks as
      | { sessionAttempts?: number }
      | undefined;
    assert.equal(status2?.sessionAttempts, 2);
  });

  it('disables the breaker when maxSessions is 0', async () => {
    const fix = await buildFixture();
    const writ = await postOpenMandate(fix.clerk, { title: 'Unbounded' });
    for (let i = 0; i < 5; i += 1) {
      await fix.invoke(
        buildEvent({ id: `e-${i}`, payload: { writId: writ.id } }),
        { role: 'artificer', prompt: 'go', maxSessions: 0 },
      );
    }
    assert.equal(fix.animator.calls.length, 5);
    const updated = await fix.clerk.show(writ.id);
    // Writ still open and no counter touched.
    assert.equal(updated.phase, 'open');
    assert.equal(updated.status?.clockworks, undefined);
  });

  it('bypasses the breaker entirely for synthetic writs', async () => {
    const fix = await buildFixture();
    // 11 invocations against a payload-less event — way over the default
    // cap of 10. With no real writ, nothing trips and nothing fails.
    for (let i = 0; i < 11; i += 1) {
      await fix.invoke(
        buildEvent({ id: `e-${i}` }),
        { role: 'artificer', prompt: 'go' },
      );
    }
    assert.equal(fix.animator.calls.length, 11);
    // No persisted writs whatsoever.
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    assert.equal(await writsBook.count(), 0);
  });
});
