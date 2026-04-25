/**
 * Bootstrap-and-emit helper for `tool.installed` / `tool.removed`.
 *
 * `pluginInstall` and `pluginRemove` are pure CLI commands — they don't
 * run inside an Arbor-started guild. To honor the brief's
 * apparatus-owns-contract rule (the tool plugin emits its own install
 * event), we bootstrap a temporary guild runtime at the end of the
 * command, resolve the Clockworks API, emit, then run
 * `StartedGuild.shutdown()` to release apparatus handles before
 * returning.
 *
 * Both the bootstrap-emit-shutdown sequence AND the underlying
 * `emit()` call are best-effort:
 *
 *   - If the guild fails to start (e.g. the just-installed plugin
 *     throws on start), the entire helper logs a `console.warn` and
 *     returns successfully — the `guild.json` write is the
 *     authoritative outcome and must not roll back (D20).
 *
 *   - If Clockworks isn't installed, the helper warns and shuts down
 *     anyway — the event is simply not emitted; the install/remove
 *     still succeeds (D20 + D13).
 *
 *   - An emission failure is caught with a `console.warn` per D13.
 *
 *   - A shutdown() failure is caught with a `console.warn` so it
 *     cannot turn an otherwise-successful install/remove into an
 *     error.
 *
 * The brief is explicit that no `setTimeout`-style detached background
 * work is acceptable here — we wait for the guild to start, fire the
 * event, run shutdown(), then move on.
 */

import { createGuild } from '@shardworks/nexus-arbor';
import type { StartedGuild } from '@shardworks/nexus-core';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

/**
 * Spin up the guild, emit the named event, and tear down via
 * `StartedGuild.shutdown()`.
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
  let g: StartedGuild | undefined;
  try {
    g = await createGuild(guildHome);
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
  } finally {
    // Tear down whatever apparatus did manage to start — this is what
    // the long-standing "no sibling stopGuild API yet" TODO was
    // waiting on. Now released via StartedGuild.shutdown().
    if (g !== undefined) {
      try {
        await g.shutdown();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[nsg plugin] Bootstrap teardown reported failures: ${reason}. ` +
            `The guild.json change has been saved.`,
        );
      }
    }
  }
}
