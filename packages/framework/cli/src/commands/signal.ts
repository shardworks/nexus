/**
 * nsg signal — operator-facing event emission.
 *
 * The patron-facing counterpart to the anima-only `signal` tool exposed
 * by the Clockworks. Both surfaces resolve the running guild's
 * Clockworks apparatus and call `ClockworksApi.validateSignal(name)`
 * before emitting — there is one canonical validator path, owned by
 * the apparatus closure.
 *
 * Why hand-written instead of going through the auto-builder?
 *
 *   - The Commander auto-builder cannot JSON-parse a `--payload <json>`
 *     flag — that parsing happens here, locally, before the call into
 *     `ClockworksApi.emit`.
 *   - The auto-builder's positional convention only promotes `id`/`*Id`
 *     params; this command needs `<name>` as a positional argument.
 *   - The emitter is hardcoded to `'operator'` — not the `'anima'`
 *     default the tool uses.
 *
 * The CLI deliberately does not depend on the clockworks plugin
 * package; the minimum interface is declared inline and resolved at
 * runtime via `guild().apparatus<T>(name)`. This matches the same
 * lazy-resolution pattern other CLI commands use (see `start.ts`).
 */

import { Command } from 'commander';
import { guild } from '@shardworks/nexus-core';

// ── Local apparatus interface shim ───────────────────────────────────
//
// Just the two methods this command calls — validate-then-emit. The
// CLI does not depend on the clockworks plugin package; the apparatus
// is resolved at runtime via guild().apparatus<T>(name).

interface ClockworksApiLike {
  validateSignal(name: string): void;
  emit(name: string, payload: unknown, emitter: string): Promise<string>;
}

// ── Handler ──────────────────────────────────────────────────────────
//
// Exported separately from the Commander Command so it can be exercised
// directly in unit tests without spinning up Commander.

interface SignalHandlerInput {
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

  // Resolve the apparatus once per call. Both the validator-rejection
  // path and the apparatus-not-installed path surface as `Error:
  // <message>` through the Commander action handler — the validator
  // throws with the `signal:` prefix, the not-installed throw uses
  // the framework's apparatus-resolution message verbatim.
  const clockworks = g.apparatus<ClockworksApiLike>('clockworks');

  clockworks.validateSignal(input.name);

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
