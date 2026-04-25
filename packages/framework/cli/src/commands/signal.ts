/**
 * nsg signal — operator-facing event emission.
 *
 * The patron-facing counterpart to the anima-only `signal` tool exposed
 * by the Clockworks. Both surfaces run the exact same three layers of
 * validation against the proposed event name; this command duplicates
 * the validator inline rather than importing the Clockworks plugin so
 * the CLI keeps its zero-dependency-on-plugin-packages discipline (see
 * `start.ts` for the same pattern with Spider/Oculus apparatuses).
 *
 * Why hand-written instead of going through the auto-builder?
 *
 *   - The Commander auto-builder cannot JSON-parse a `--payload <json>`
 *     flag — that parsing happens here, locally, before the call into
 *     `ClockworksApi.emit`.
 *   - The auto-builder's positional convention only promotes `id`/`*Id`
 *     params; this command needs `<name>` as a positional argument.
 *   - The emitter must default to `'operator'` (commission decision D4),
 *     not the `'anima'` default the tool uses.
 *
 * The anima-facing `signal` tool in
 * `packages/plugins/clockworks/src/tools/signal.ts` is marked
 * `callableBy: ['anima']` so the CLI auto-builder skips it — there is
 * no auto-registered duplicate of this command (commission decision D6).
 *
 * See commission c-modhilaw decisions D2, D4, D6, D7, D11.
 */

import { Command } from 'commander';
import { guild } from '@shardworks/nexus-core';

// ── Local apparatus interface shims ──────────────────────────────────
//
// The CLI package deliberately does not depend on the clockworks or
// clerk plugin packages. The minimum interfaces are declared inline
// and resolved at runtime via guild().apparatus<T>(name).

interface ClockworksApiLike {
  emit(name: string, payload: unknown, emitter: string): Promise<string>;
}

interface WritTypeInfoLike {
  name: string;
}

interface ClerkApiLike {
  listWritTypes(): WritTypeInfoLike[];
}

interface GuildConfigClockworksLike {
  events?: Record<string, unknown>;
}

interface GuildConfigLike {
  clockworks?: GuildConfigClockworksLike;
}

// ── Validator (mirrored from packages/plugins/clockworks/src/signal-validator.ts) ─
//
// Kept identical in behavior to the shared validator so both surfaces
// reject the same set of names with structurally-equivalent messages.
// The clockworks-side validator is the canonical source; this copy
// exists only so the CLI does not need to depend on the plugin package.

export const RESERVED_EVENT_NAMESPACES: readonly string[] = Object.freeze([
  'anima.',
  'commission.',
  'tool.',
  'migration.',
  'guild.',
  'standing-order.',
  'session.',
  'schedule.',
]);

export const WRIT_LIFECYCLE_SUFFIXES: readonly string[] = Object.freeze([
  'ready',
  'completed',
  'stuck',
  'failed',
]);

export function validateSignal(
  name: string,
  declaredEvents: Readonly<Record<string, unknown>>,
  writTypes: readonly string[],
): void {
  for (const prefix of RESERVED_EVENT_NAMESPACES) {
    if (name.startsWith(prefix)) {
      throw new Error(
        `signal: "${name}" is in the reserved framework namespace "${prefix}" ` +
          `and cannot be emitted via the signal tool. Reserved namespaces are ` +
          `owned by the framework.`,
      );
    }
  }

  for (const writType of writTypes) {
    for (const suffix of WRIT_LIFECYCLE_SUFFIXES) {
      if (name === `${writType}.${suffix}`) {
        throw new Error(
          `signal: "${name}" matches the framework-owned writ-lifecycle ` +
            `pattern "<type>.${suffix}" for writ type "${writType}". ` +
            `Writ lifecycle events are emitted by the Clerk.`,
        );
      }
    }
  }

  if (!Object.prototype.hasOwnProperty.call(declaredEvents, name)) {
    throw new Error(
      `signal: "${name}" is not declared in guild.json under ` +
        `clockworks.events. Declare the event (and a human-readable ` +
        `description) before emitting it.`,
    );
  }
}

// ── Handler ──────────────────────────────────────────────────────────
//
// Exported separately from the Commander Command so it can be exercised
// directly in unit tests without spinning up Commander.

export interface SignalHandlerInput {
  name: string;
  /** Raw JSON string from `--payload`, or undefined if the flag was omitted. */
  payloadJson?: string;
}

export async function runSignal(input: SignalHandlerInput): Promise<string> {
  let g;
  try {
    g = guild();
  } catch {
    throw new Error('Not inside a guild. Run `nsg init` to create one first.');
  }

  // Parse the payload locally — Commander hands us a string, but the
  // emit API expects the parsed value. Surfacing JSON parse failures
  // here keeps them attached to the --payload flag rather than the
  // (otherwise opaque) Clockworks emit error.
  let parsedPayload: unknown = undefined;
  if (input.payloadJson !== undefined) {
    try {
      parsedPayload = JSON.parse(input.payloadJson);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`signal: --payload is not valid JSON: ${reason}`);
    }
  }

  const clockworks = g.apparatus<ClockworksApiLike>('clockworks');
  const clerk = g.apparatus<ClerkApiLike>('clerk');
  const guildConfig = g.guildConfig() as GuildConfigLike;

  const declaredEvents = guildConfig.clockworks?.events ?? {};
  const writTypes = clerk.listWritTypes().map((t) => t.name);

  validateSignal(input.name, declaredEvents, writTypes);

  return clockworks.emit(input.name, parsedPayload, 'operator');
}

// ── Commander Command ────────────────────────────────────────────────

/**
 * Build the `nsg signal` Commander Command.
 *
 * Hand-written rather than auto-generated so the event name can live in
 * the positional slot and `--payload` can be JSON-parsed locally. The
 * action handler mirrors the auto-builder's contract: thrown errors
 * print as `Error: <message>` and exit with a non-zero code.
 */
export function buildSignalCommand(): Command {
  const cmd = new Command('signal')
    .description('Emit a custom event into the Clockworks events book')
    .argument('<name>', 'Event name (must be declared under clockworks.events)')
    .option(
      '--payload <json>',
      'JSON-serializable payload (parsed locally before emission). Omit for null.',
    )
    .action(async (name: string, opts: { payload?: string }) => {
      try {
        const id = await runSignal({ name, payloadJson: opts.payload });
        console.log(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  return cmd;
}
