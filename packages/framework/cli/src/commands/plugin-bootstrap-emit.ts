/**
 * Bootstrap-and-emit helper for `tool.installed` / `tool.removed`.
 *
 * `pluginInstall` and `pluginRemove` are pure CLI commands — they don't
 * run inside an Arbor-started guild. To honor the brief's
 * apparatus-owns-contract rule (the tool plugin emits its own install
 * event), we bootstrap a temporary guild runtime at the end of the
 * command, resolve the Clockworks API, emit, and then exit.
 *
 * Both the bootstrap-emit-shutdown sequence AND the underlying
 * `emit()` call are best-effort:
 *
 *   - If the guild fails to start (e.g. the just-installed plugin
 *     throws on start), the entire helper logs a `console.warn` and
 *     returns successfully — the `guild.json` write is the
 *     authoritative outcome and must not roll back (D20).
 *
 *   - If Clockworks isn't installed, the helper warns and exits — the
 *     event is simply not emitted; the install/remove still succeeds
 *     (D20 + D13).
 *
 *   - An emission failure is caught with a `console.warn` per D13.
 *
 * The brief is explicit that no `setTimeout`-style detached background
 * work is acceptable here — we wait for the guild to start, fire the
 * event, then move on.
 *
 * NB: The CLI-side `createGuild()` does not yet have a sibling
 * `stopGuild()` API. The helper relies on the process exiting after
 * the install/remove completes (the `nsg` CLI is a one-shot command).
 * If a long-lived shutdown contract lands later, plumb it through
 * here.
 */

import { createGuild } from '@shardworks/nexus-arbor';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

/**
 * Spin up the guild, emit the named event, and tear down.
 *
 * @param eventName  Either `'tool.installed'` or `'tool.removed'` —
 *                   the catalog-defined names for plugin lifecycle.
 * @param payload    JSON-serializable payload identifying the plugin.
 * @param guildHome  Root directory of the guild (containing guild.json).
 */
export async function bootstrapEmitToolEvent(
  eventName: 'tool.installed' | 'tool.removed',
  payload: Record<string, unknown>,
  guildHome: string,
): Promise<void> {
  try {
    const g = await createGuild(guildHome);
    let clockworks: ClockworksApi | undefined;
    try {
      clockworks = g.apparatus<ClockworksApi>('clockworks');
    } catch {
      // Clockworks isn't installed in this guild — there is no events
      // book to write to. Honor D20: warn but don't fail the command.
      console.warn(
        `[nsg plugin] Clockworks is not installed; skipping emission of ` +
          `"${eventName}". The guild.json change has been saved.`,
      );
      return;
    }

    try {
      await clockworks.emit(eventName, payload, 'framework');
    } catch (err) {
      // Best-effort emission per D13 — swallow with a warn.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[nsg plugin] Best-effort emit of "${eventName}" failed: ${reason}. ` +
          `The guild.json change has been saved.`,
      );
    }
  } catch (err) {
    // Bootstrap itself failed — e.g. the just-installed plugin throws
    // on start, or required apparatuses are missing. D20 calls for
    // warn-and-succeed; the operator can retry or open the guild
    // manually to investigate.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[nsg plugin] Bootstrap-emit for "${eventName}" failed: ${reason}. ` +
        `The guild.json change has been saved.`,
    );
  }
}
