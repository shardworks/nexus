/**
 * spider.graft-rig-template engine — clockwork.
 *
 * Resolves a named rig template from the Spider's template registry, overlays
 * caller-supplied givens onto `${vars.<key>}` references in the template's
 * engine slots, and returns the template's engines as a tail graft.
 *
 * This generalises the inline graft-construction pattern used by
 * `implement-loop`, `seal` (recovery), and `step-session` so that trial
 * shapes, scenarios, and other configurable sub-rigs can be authored as named
 * templates instead of bespoke engines.
 *
 * Engine givens:
 *   - `template` (required, string) — the name of the rig template to graft.
 *   - `givens`   (optional, object) — caller-supplied key/value pairs. Each
 *     `${vars.<key>}` reference in the resolved template's engine givens is
 *     substituted with the matching value. References that do not match any
 *     caller-given key, and all `${writ}` / `${yields.*}` references in the
 *     template's engine givens, are left intact for Spider's normal
 *     spawn-time and run-time resolution.
 *
 *     `${yields.<engineId>.<path>}` references *inside the caller-supplied
 *     overlay's own string values* are resolved against this engine's
 *     `context.upstream` before substitution. This lets a caller pass
 *     dynamic values produced by upstream fixtures into the template (e.g.
 *     `cwd: '${yields.fixture-codex-checkout-setup.workdir}'`) — Spider's
 *     own `resolveYieldRefs` only walks top-level givens and would otherwise
 *     leave such refs unresolved through the nested `givens.givens` map.
 *
 * graftTail rule:
 *   If the resolved template declares a `resolutionEngine`, that engine id is
 *   used as `graftTail`. Otherwise the id of the last engine in the template's
 *   `engines` array (declaration order) is used.
 *
 * Yields:
 *   `{ template: <name>, givens: <caller givens with overlay yields resolved> }`
 *   The echoed `givens` is the post-resolution overlay, so trial-archive
 *   inspection shows what values were actually substituted.
 *
 * Failure modes:
 *   - `givens.template` not a non-empty string — throws immediately.
 *   - `givens.givens` not an object (and not undefined) — throws immediately.
 *   - Named template not found in registry — throws with the template name.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunResult, EngineRunContext } from '@shardworks/fabricator-apparatus';
import type { SpiderApi, RigTemplateEngine, SpiderEngineRunResult } from '../types.ts';
import { interpolateTemplate, resolveDotPath, SKIP } from '../template.ts';

/**
 * Resolve `${yields.<engineId>.<path>}` references in the caller's overlay
 * against this engine's upstream. Other expressions (`${writ}`, `${vars.*}`,
 * etc.) are left untouched — they're not part of the overlay's contract.
 *
 * Mirrors Spider's run-time `resolveYieldRefs` semantics: walks top-level
 * string values only, drops keys whose whole-value resolution yields
 * undefined, leaves non-string values literal.
 *
 * Without this pre-pass, callers can't pass `${yields.X.Y}` substitutions
 * through the overlay because Spider's spawn-time and run-time resolution
 * don't recurse into nested objects (and `givens.givens` is itself a
 * nested object on the engine's outer givens map).
 */
function resolveOverlayYields(
  overlay: Record<string, unknown>,
  upstream: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value !== 'string' || !value.includes('${')) {
      result[key] = value;
      continue;
    }
    const resolved = interpolateTemplate(value, (expr: string) => {
      if (!expr.startsWith('yields.')) {
        return SKIP; // not a yield ref — leave it alone
      }
      const withoutPrefix = expr.slice('yields.'.length);
      const dotIndex = withoutPrefix.indexOf('.');
      if (dotIndex < 0) return undefined; // malformed — drop the key
      const engineId = withoutPrefix.slice(0, dotIndex);
      const propPath = withoutPrefix.slice(dotIndex + 1);
      const engineYields = upstream[engineId];
      return resolveDotPath(engineYields, propPath);
    });
    if (resolved !== undefined) {
      result[key] = resolved;
    }
    // undefined whole-value → omit key (matches resolveYieldRefs)
  }
  return result;
}

const graftRigTemplateEngine: EngineDesign = {
  id: 'spider.graft-rig-template',

  async run(givens, context: EngineRunContext): Promise<EngineRunResult> {
    // ── Input validation ──────────────────────────────────────────────

    const templateName = givens.template;
    if (typeof templateName !== 'string' || templateName.trim() === '') {
      throw new Error(
        `spider.graft-rig-template: givens.template must be a non-empty string` +
        (templateName !== undefined ? ` (got ${JSON.stringify(templateName)})` : ' (missing)'),
      );
    }

    const callerGivens = givens.givens;
    if (callerGivens !== undefined && (typeof callerGivens !== 'object' || Array.isArray(callerGivens) || callerGivens === null)) {
      throw new Error(
        `spider.graft-rig-template: givens.givens must be a plain object or omitted` +
        ` (got ${Array.isArray(callerGivens) ? 'array' : JSON.stringify(callerGivens)})`,
      );
    }

    const rawOverlay = (callerGivens ?? {}) as Record<string, unknown>;

    // ── Resolve ${yields.X} refs inside the overlay ───────────────────
    // Spider's resolveYieldRefs at run time only walks top-level givens
    // and stops at non-string values. The overlay is a nested object, so
    // any ${yields.X} refs inside it survive unresolved unless we do this
    // pre-pass against context.upstream here.

    const overlay = resolveOverlayYields(rawOverlay, context.upstream);

    // ── Template lookup ───────────────────────────────────────────────

    const spider = guild().apparatus<SpiderApi>('spider');
    const template = spider.getTemplate(templateName);
    if (template === undefined) {
      throw new Error(
        `spider.graft-rig-template: template "${templateName}" not found in the registry`,
      );
    }

    // ── Build the graft with caller-given overlay ─────────────────────

    /**
     * Walk each engine slot in the template and pre-resolve
     * `${vars.<key>}` references for keys present in the caller's overlay.
     * Everything else — `${writ}`, `${yields.*}`, unmatched `${vars.*}` — is
     * left intact so Spider's existing spawn-time and run-time pipeline
     * handles them as normal.
     */
    function overlayGivens(
      rawGivens: Record<string, unknown> | undefined,
    ): Record<string, unknown> {
      if (!rawGivens) return {};
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawGivens)) {
        if (typeof value !== 'string') {
          // Non-string values pass through literally.
          result[key] = value;
          continue;
        }
        const resolved = interpolateTemplate(value, (expr: string) => {
          if (expr.startsWith('vars.')) {
            const varKey = expr.slice('vars.'.length);
            if (Object.prototype.hasOwnProperty.call(overlay, varKey)) {
              return overlay[varKey];
            }
          }
          // Leave everything else (writ, yields.*, unmatched vars.*) untouched.
          return SKIP;
        });
        // interpolateTemplate returns undefined for whole-value expressions
        // that resolve to undefined; omit those keys (matches template semantics).
        if (resolved !== undefined) {
          result[key] = resolved;
        }
      }
      return result;
    }

    const graft: RigTemplateEngine[] = template.engines.map((engine) => ({
      ...engine,
      givens: overlayGivens(engine.givens),
    }));

    // ── Compute graftTail ─────────────────────────────────────────────

    const graftTail: string =
      template.resolutionEngine ?? template.engines[template.engines.length - 1]!.id;

    // ── Return ────────────────────────────────────────────────────────

    const result: SpiderEngineRunResult = {
      status: 'completed',
      yields: { template: templateName, givens: overlay },
      graft,
      graftTail,
    };

    return result as EngineRunResult;
  },
};

export default graftRigTemplateEngine;
