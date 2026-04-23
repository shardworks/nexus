/**
 * Discord webhook channel for the Lattice.
 *
 * Delivers pulses as rich embeds via the Discord incoming-webhook API. The
 * webhook URL itself is a secret — this kit follows the same pattern as the
 * Copilot provider's `tokenEnvVar`: config names an environment variable,
 * and the URL is resolved from `process.env` at send time. Nothing secret
 * is ever written to `guild.json`.
 *
 * Payload shape (D11): `{ embeds: [ { title, description, url?, color, fields } ] }`.
 * Color and fields are keyed off `pulse.triggerType` and `pulse.context`.
 *
 * Delivery policy (D8): best-effort one-shot. 2xx → `{ ok: true }`;
 * non-2xx or network errors → `{ ok: false, error }`. Never throws past
 * the boundary.
 */

import type {
  DeliveryOutcome,
  LatticeChannel,
  LatticeChannelFactory,
  LatticeChannelInstanceConfig,
  PulseDoc,
} from '@shardworks/lattice-apparatus';

// ── Instance config ──────────────────────────────────────────────

/**
 * Instance config for the `discord-webhook` channel.
 *
 * The URL is never persisted in guild.json. Instead, the config names an
 * environment variable that holds the URL; the channel reads
 * `process.env[webhookUrlEnvVar]` at send time.
 */
export interface DiscordWebhookInstanceConfig extends LatticeChannelInstanceConfig {
  type: 'discord-webhook';
  /** Name of the env var holding the webhook URL. Defaults to `DISCORD_WEBHOOK_URL`. */
  webhookUrlEnvVar?: string;
  /**
   * Optional override of the username shown on the Discord message. Omitting
   * it lets Discord use the webhook's configured name.
   */
  username?: string;
}

// ── Colors per triggerType (D11) ─────────────────────────────────

const COLOR_STUCK = 0xffa500;
const COLOR_FAILED = 0xff4d4d;
const COLOR_DRAINED = 0x57f287;
const COLOR_DEFAULT = 0x5865f2;

/**
 * Pick a Discord embed color for a given trigger type.
 *
 * Distinct colors for stuck / failed / drained per D11; unknown trigger
 * types fall back to a neutral default so future emitters render
 * reasonably without requiring this file to be updated first.
 *
 * @internal Exported for testing.
 */
export function embedColorForTrigger(triggerType: string): number {
  if (triggerType === 'reckoner.writ-stuck') return COLOR_STUCK;
  if (triggerType === 'reckoner.writ-failed') return COLOR_FAILED;
  if (triggerType === 'reckoner.queue-drained') return COLOR_DRAINED;
  return COLOR_DEFAULT;
}

// ── Field rendering per context shape (D30) ──────────────────────

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Render context fields into Discord embed fields.
 *
 * The Reckoner's context payloads are trigger-typed (D30); this renderer
 * handles the three known shapes and degrades gracefully for unknown
 * trigger types by emitting a single field per context key.
 *
 * @internal Exported for testing.
 */
export function contextFields(pulse: PulseDoc): EmbedField[] {
  const fields: EmbedField[] = [];
  fields.push({ name: 'Trigger', value: pulse.triggerType, inline: true });
  if (pulse.writId) {
    fields.push({ name: 'Writ', value: shortWritId(pulse.writId), inline: true });
  }
  const ctx = pulse.context ?? {};
  if (pulse.triggerType === 'reckoner.writ-stuck') {
    if (typeof ctx.writType === 'string') fields.push({ name: 'Type', value: ctx.writType, inline: true });
    if (typeof ctx.stuckCause === 'string') fields.push({ name: 'Cause', value: ctx.stuckCause, inline: true });
    if (ctx.retryable !== undefined) fields.push({ name: 'Retryable', value: String(ctx.retryable), inline: true });
    if (typeof ctx.detail === 'string') fields.push({ name: 'Detail', value: truncate(ctx.detail, 800) });
  } else if (pulse.triggerType === 'reckoner.writ-failed') {
    if (typeof ctx.writType === 'string') fields.push({ name: 'Type', value: ctx.writType, inline: true });
    if (typeof ctx.resolution === 'string') fields.push({ name: 'Resolution', value: truncate(ctx.resolution, 800) });
    if (Array.isArray(ctx.childFailures) && ctx.childFailures.length > 0) {
      fields.push({
        name: 'Child failures',
        value: truncate(ctx.childFailures.map(String).join(', '), 800),
      });
    }
  } else if (pulse.triggerType === 'reckoner.queue-drained') {
    if (typeof ctx.drainedAt === 'string') fields.push({ name: 'Drained at', value: ctx.drainedAt, inline: true });
    if (typeof ctx.lastTerminalWritId === 'string') {
      fields.push({ name: 'Last terminal', value: shortWritId(ctx.lastTerminalWritId), inline: true });
    }
  } else {
    // Unknown trigger type — surface the raw context keys generically.
    for (const [key, value] of Object.entries(ctx)) {
      fields.push({ name: key, value: truncate(stringify(value), 400), inline: true });
    }
  }
  return fields;
}

/** Two-segment short id (`p-abc123` / `w-xyz789`). */
function shortWritId(id: string): string {
  return id.split('-').slice(0, 2).join('-');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Payload builder ──────────────────────────────────────────────

/**
 * Build the Discord webhook payload for a pulse.
 *
 * @internal Exported for testing so we can verify payload shape without
 * hitting the network.
 */
export function buildPayload(
  pulse: PulseDoc,
  options: { username?: string } = {},
): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    title: pulse.title,
    description: pulse.summary,
    color: embedColorForTrigger(pulse.triggerType),
    fields: contextFields(pulse),
    timestamp: pulse.createdAt,
  };
  if (pulse.linkUrl) {
    embed.url = pulse.linkUrl;
  }
  const payload: Record<string, unknown> = { embeds: [embed] };
  if (options.username !== undefined) {
    payload.username = options.username;
  }
  return payload;
}

// ── Channel factory ──────────────────────────────────────────────

/**
 * Create the `discord-webhook` channel factory.
 *
 * The factory is pure — no side effects at contribution time. Each call to
 * `create()` builds one channel instance bound to a specific env var.
 */
export function createDiscordWebhookFactory(): LatticeChannelFactory {
  return {
    type: 'discord-webhook',

    create(instanceConfig: LatticeChannelInstanceConfig): LatticeChannel {
      const cfg = instanceConfig as DiscordWebhookInstanceConfig;
      const envVar = cfg.webhookUrlEnvVar ?? 'DISCORD_WEBHOOK_URL';
      const username = cfg.username;

      return {
        type: 'discord-webhook',
        async send(pulse: PulseDoc): Promise<DeliveryOutcome> {
          const url = process.env[envVar];
          if (!url) {
            return {
              ok: false,
              error: `environment variable ${envVar} is not set`,
            };
          }
          const payload = buildPayload(pulse, username !== undefined ? { username } : {});
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              let body = '';
              try {
                body = await response.text();
              } catch {
                body = '<no body>';
              }
              return {
                ok: false,
                error: `Discord webhook returned ${response.status}: ${truncate(body, 200)}`,
              };
            }
            return { ok: true };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `network error: ${message}` };
          }
        },
      };
    },
  };
}
