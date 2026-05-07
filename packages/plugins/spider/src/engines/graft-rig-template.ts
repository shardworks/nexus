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
 *     caller-given key, and all `${writ}` / `${yields.*}` references, are
 *     left intact for Spider's normal spawn-time and run-time resolution.
 *
 * graftTail rule:
 *   If the resolved template declares a `resolutionEngine`, that engine id is
 *   used as `graftTail`. Otherwise the id of the last engine in the template's
 *   `engines` array (declaration order) is used.
 *
 * Yields:
 *   `{ template: <name>, givens: <caller givens or {}> }`
 *
 * Failure modes:
 *   - `givens.template` not a non-empty string — throws immediately.
 *   - `givens.givens` not an object (and not undefined) — throws immediately.
 *   - Named template not found in registry — throws with the template name.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { SpiderApi, RigTemplateEngine, SpiderEngineRunResult } from '../types.ts';
import { interpolateTemplate, SKIP } from '../template.ts';

const graftRigTemplateEngine: EngineDesign = {
  id: 'spider.graft-rig-template',

  async run(givens, _context): Promise<EngineRunResult> {
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

    const overlay = (callerGivens ?? {}) as Record<string, unknown>;

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
