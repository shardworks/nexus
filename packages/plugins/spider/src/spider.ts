/**
 * The Spider — rig execution engine apparatus.
 *
 * The Spider drives writ-to-completion by managing rigs: ordered pipelines
 * of engine instances. Each crawl() call performs one unit of work:
 *
 *   collect > processGrafts > checkBlocked > run > spawn   (priority order)
 *
 * collect      — check running engines for terminal session results
 *                (including sessions the animator heartbeat reconciler has
 *                 failed due to host death — spider does not probe liveness
 *                 itself; the heartbeat reconciler owns that signal)
 * processGrafts— process pending graft requests queued by collect/run
 * checkBlocked — poll registered block type checkers; unblock engines when cleared
 * run          — execute the next pending engine (clockwork inline, quick → launch)
 * spawn        — create a new rig for an open writ with no existing rig
 *
 * CDC on the rigs book (Phase 1 cascade) transitions the associated writ
 * when a rig reaches a terminal state (completed or failed).
 * The blocked status does NOT trigger the CDC handler.
 *
 * CDC on the writs book (Phase 1 cascade) cancels the associated rig
 * when a writ reaches a terminal state (completed, failed, or cancelled).
 * Guards in both handlers break the circular cascade path.
 *
 * See: docs/architecture/apparatus/spider.md
 */

import type { Plugin, StartupContext, KitEntry, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import { guild, generateId, shortId } from '@shardworks/nexus-core';
import type { StacksApi, Book, ReadOnlyBook, WhereClause } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { SessionDoc, AnimatorApi } from '@shardworks/animator-apparatus';
import type { KitRoleDefinition } from '@shardworks/loom-apparatus';

import type {
  RigDoc,
  RigStatus,
  RigFilters,
  EngineInstance,
  EngineAttempt,
  SpiderApi,
  CrawlResult,
  SpiderConfig,
  BlockType,
  BlockTypeInfo,
  CheckResult,
  RigTemplate,
  RigTemplateEngine,
  RigTemplateInfo,
  SpiderCollectResult,
  InputRequestDoc,
  SpiderWritStatus,
  SpiderStuckCause,
} from './types.ts';
import { resolveEngineRetryConfig } from '@shardworks/fabricator-apparatus';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';

import {
  animaSessionEngine,
  draftEngine,
  implementEngine,
  implementLoopEngine,
  manualMergeEngine,
  pieceSessionEngine,
  reviewEngine,
  reviseEngine,
  sealEngine,
} from './engines/index.ts';

import {
  writPhaseBlockType,
  scheduledTimeBlockType,
  bookUpdatedBlockType,
  patronInputBlockType,
  animatorPausedBlockType,
} from './block-types/index.ts';

import {
  crawlOneTool,
  crawlContinualTool,
  rigShowTool,
  rigListTool,
  rigForWritTool,
  rigResumeTool,
  inputRequestListTool,
  inputRequestShowTool,
  inputRequestAnswerTool,
  inputRequestCompleteTool,
  inputRequestRejectTool,
  inputRequestExportTool,
  inputRequestImportTool,
  engineDesignsTool,
  blockTypesTool,
  rigCancelTool,
} from './tools/index.ts';

import { spiderRoutes } from './oculus-routes.ts';

import { defaultRigTemplate } from './default-template.ts';

import {
  interpolateTemplate,
  extractExpressions,
  resolveDotPath,
  SKIP,
} from './template.ts';

// ── Kit contribution interface ─────────────────────────────────────────

/** Kit contribution interface for the Spider's rig template system. */
export interface SpiderKit {
  /** Named rig templates. Keys are unqualified; registered as pluginId.key. */
  rigTemplates?: Record<string, RigTemplate>;
  /** Writ type → rig template name mappings. Keys are unqualified writ type names. */
  rigTemplateMappings?: Record<string, string>;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Check whether a value is JSON-serializable.
 * Non-serializable yields cause engine failure — the Stacks cannot store them.
 */
function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the latest yields from a completed engine's attempts history.
 * Returns undefined when the engine has no attempts or no yield on the
 * tail entry. Used by `buildUpstreamMap` and graft-yield assembly.
 */
function latestAttempt(engine: EngineInstance): EngineAttempt | undefined {
  const attempts = engine.attempts;
  if (!attempts || attempts.length === 0) return undefined;
  return attempts[attempts.length - 1];
}

/**
 * Build the upstream yields map for a rig: all completed engine yields
 * keyed by engine id. Passed as context.upstream to the engine's run().
 *
 * With the types reshape, `attempts[-1].yields` is authoritative — the
 * engine no longer carries a top-level `yields` scalar.
 */
function buildUpstreamMap(rig: RigDoc): Record<string, unknown> {
  const upstream: Record<string, unknown> = {};
  for (const engine of rig.engines) {
    if (engine.status !== 'completed') continue;
    const tail = latestAttempt(engine);
    if (tail?.yields !== undefined) {
      upstream[engine.id] = tail.yields;
    }
  }
  return upstream;
}

/**
 * Count the total number of running engines across all rigs.
 */
export function countRunningEngines(rigs: RigDoc[]): number {
  let count = 0;
  for (const rig of rigs) {
    for (const engine of rig.engines) {
      if (engine.status === 'running') count++;
    }
  }
  return count;
}

/**
 * Count the number of running engines within a single rig.
 */
export function countRunningEnginesInRig(rig: RigDoc): number {
  let count = 0;
  for (const engine of rig.engines) {
    if (engine.status === 'running') count++;
  }
  return count;
}

/**
 * Terminal-success engine statuses — treated as "upstream satisfied" by
 * the dispatch predicate and by cascade-skip evaluation. A `skipped`
 * engine counts as terminal-success for dispatch purposes (its
 * downstream's upstream requirement is met).
 */
const TERMINAL_SUCCESS_ENGINE_STATUSES: ReadonlySet<EngineInstance['status']> =
  new Set(['completed', 'skipped']);

/**
 * Terminal engine statuses — completed, failed, cancelled, skipped.
 * These never participate in dispatch again.
 */
const TERMINAL_ENGINE_STATUSES: ReadonlySet<EngineInstance['status']> =
  new Set(['completed', 'failed', 'cancelled', 'skipped']);

/**
 * Derive the rig status from the current engine set plus the
 * operator-cancel marker. Pure projection: there is no independent
 * rig-level state any more.
 *
 *   cancelledAt set    → 'cancelled' (short-circuit, per D15)
 *   any engine running → 'running'
 *   any engine failed  → 'failed' (no running, at least one terminal-failed)
 *   all terminal,
 *     any completed    → 'completed'
 *   all terminal,
 *     no completed     → 'cancelled' (everything was cancelled/skipped/failed-less)
 *   otherwise          → 'running' (engines still pending / held)
 */
function deriveRigStatus(
  engines: EngineInstance[],
  cancelledAt: string | undefined,
): RigStatus {
  if (cancelledAt) return 'cancelled';

  const hasRunning = engines.some((e) => e.status === 'running');
  if (hasRunning) return 'running';

  const hasFailed = engines.some((e) => e.status === 'failed');
  if (hasFailed) return 'failed';

  const allTerminal = engines.every((e) => TERMINAL_ENGINE_STATUSES.has(e.status));
  if (!allTerminal) return 'running';

  const anyCompleted = engines.some((e) => e.status === 'completed');
  if (anyCompleted) return 'completed';

  // All terminal, none completed → only cancels/skips. Treat as cancelled.
  return 'cancelled';
}

// ── Template-based rig building ────────────────────────────────────────

/**
 * Compute the set of engine ids transitively reachable upstream of a given engine.
 * Uses BFS over the template's upstream arrays.
 */
function computeUpstreamReachable(
  engineId: string,
  engines: RigTemplateEngine[],
): Set<string> {
  const engineMap = new Map(engines.map((e) => [e.id, e]));
  const reachable = new Set<string>();
  const queue: string[] = [...(engineMap.get(engineId)?.upstream ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const deps = engineMap.get(current)?.upstream ?? [];
    queue.push(...deps);
  }
  return reachable;
}


/**
 * Evaluate a `when` condition against the upstream yields map.
 * Returns true if the engine should run, false if it should be skipped.
 *
 * The `when` expression must be a `${yields.<engineId>.<path>}` reference
 * with an optional `!` negation prefix.
 */
function evaluateWhen(when: string, upstream: Record<string, unknown>): boolean {
  let expr = when.trim();
  let negate = false;
  if (expr.startsWith('!')) {
    negate = true;
    expr = expr.slice(1);
  }
  // expr is now a bare yields ref like "${yields.<engineId>.<path>}"
  // Strip the ${...} wrapper to get the expression body
  let exprBody = expr;
  if (exprBody.startsWith('${') && exprBody.endsWith('}')) {
    exprBody = exprBody.slice(2, -1);
  }
  // exprBody: 'yields.<engineId>.<path>'
  const withoutPrefix = exprBody.slice('yields.'.length);
  const dotIndex = withoutPrefix.indexOf('.');
  const engineId = withoutPrefix.slice(0, dotIndex);
  const path = withoutPrefix.slice(dotIndex + 1);

  const engineYields = upstream[engineId];
  const value = resolveDotPath(engineYields, path);
  const truthy = !!value;
  return negate ? !truthy : truthy;
}

/**
 * Cascade-skip all pending engines whose `when` is false, given the current
 * upstream map. Returns the list of additionally skipped engine IDs.
 * Mutates the engines array in place.
 * Only engines with a `when` clause participate in cascade skipping.
 */
function cascadeSkip(engines: EngineInstance[], upstream: Record<string, unknown>): string[] {
  const cascaded: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const engine of engines) {
      if (engine.status !== 'pending' || !engine.when) continue;
      const allUpstreamDone = engine.upstream.every((upId) => {
        const dep = engines.find((e) => e.id === upId);
        return dep?.status === 'completed' || dep?.status === 'skipped';
      });
      if (!allUpstreamDone) continue;
      if (!evaluateWhen(engine.when, upstream)) {
        engine.status = 'skipped';
        cascaded.push(engine.id);
        changed = true;
      }
    }
  }
  return cascaded;
}

/**
 * Resolve `${yields.*}` expressions in a givens map at run time.
 *
 * Processes all string values containing `${yields.<engineId>.<path>}` and
 * resolves them from upstream engine yields via dot-path traversal.
 * Non-yield expressions and non-string values pass through unchanged.
 * Keys whose whole-value expression resolves to undefined are omitted.
 */
function resolveYieldRefs(
  givensSpec: Record<string, unknown>,
  upstream: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(givensSpec)) {
    if (typeof value !== 'string' || !value.includes('${')) {
      result[key] = value;
      continue;
    }
    const resolved = interpolateTemplate(value, (expr) => {
      if (!expr.startsWith('yields.')) {
        // Not a yield ref — leave in place (shouldn't remain after spawn-time, but safe)
        return SKIP;
      }
      const withoutPrefix = expr.slice('yields.'.length);
      const dotIndex = withoutPrefix.indexOf('.');
      if (dotIndex < 0) return undefined; // malformed — validated at startup
      const engineId = withoutPrefix.slice(0, dotIndex);
      const propPath = withoutPrefix.slice(dotIndex + 1);
      const engineYields = upstream[engineId];
      return resolveDotPath(engineYields, propPath);
    });
    if (resolved !== undefined) {
      result[key] = resolved;
    }
    // undefined whole-value → omit key
  }
  return result;
}

/**
 * Resolve a template engine's givens map at spawn time.
 *
 * Resolves `${writ}`, `${writ.<path>}`, and `${vars.<path>}` expressions.
 * `${yields.*}` expressions are left as-is (resolved at run time).
 * Keys whose whole-value expression resolves to undefined are omitted.
 * Non-string values are passed through literally.
 */
function resolveGivens(
  givens: Record<string, unknown> | undefined,
  context: { writ: WritDoc; spiderConfig: SpiderConfig },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(givens ?? {})) {
    // Use includes('${') rather than containsTemplate() so that escape sequences
    // (\${...}) are also processed and converted to literal ${ in the output.
    if (typeof value !== 'string' || !value.includes('${')) {
      result[key] = value;
      continue;
    }
    const resolved = interpolateTemplate(value, (expr) => {
      if (expr === 'writ') return context.writ;
      if (expr.startsWith('writ.')) {
        return resolveDotPath(context.writ, expr.slice('writ.'.length));
      }
      if (expr.startsWith('vars.')) {
        return resolveDotPath(context.spiderConfig.variables ?? {}, expr.slice('vars.'.length));
      }
      if (expr.startsWith('yields.')) {
        return SKIP; // leave for run-time resolution
      }
      return undefined; // unrecognized — caught at validation time
    });
    if (resolved !== undefined) {
      result[key] = resolved;
    }
    // undefined whole-value → omit key
  }
  return result;
}

/**
 * Build EngineInstance array and resolutionEngineId from a RigTemplate.
 */
function buildFromTemplate(
  template: RigTemplate,
  context: { writ: WritDoc; spiderConfig: SpiderConfig },
): { engines: EngineInstance[]; resolutionEngineId?: string } {
  const engines: EngineInstance[] = template.engines.map((entry) => ({
    id: entry.id,
    designId: entry.designId,
    status: 'pending' as const,
    upstream: entry.upstream ?? [],
    givensSpec: resolveGivens(entry.givens, context),
    ...(entry.when !== undefined ? { when: entry.when } : {}),
  }));
  return { engines, resolutionEngineId: template.resolutionEngine };
}

/**
 * Validate all `${...}` expressions in a single engine's givens.
 *
 * Returns a human-readable error string on the first invalid expression,
 * or null if all expressions are valid.
 *
 * Checks:
 * - Expression must start with 'writ', 'vars', or 'yields'
 * - 'writ' must be bare or have a dot-path ('writ.<path>')
 * - 'vars' must have at least one key after 'vars.' ('vars.<path>')
 * - 'yields' must have at least engineId and one path segment
 * - 'yields' engine IDs must exist in the template and be transitively upstream
 */
function validateGivensRefs(
  givens: Record<string, unknown>,
  engineId: string,
  engineIds: Set<string>,
  allEngines: RigTemplateEngine[],
): string | null {
  for (const value of Object.values(givens)) {
    if (typeof value !== 'string') continue;
    if (!value.includes('${')) continue; // no template expressions (bare strings or no ${)

    const expressions = extractExpressions(value);
    for (const expr of expressions) {
      if (expr === 'writ' || expr.startsWith('writ.')) {
        continue; // valid — whole writ or writ sub-property
      }
      if (expr.startsWith('vars.')) {
        // Must have at least one segment after 'vars.'
        if (expr === 'vars.') {
          return `engine "${engineId}" has invalid expression "\${${expr}}" — vars requires a key`;
        }
        continue; // valid
      }
      if (expr.startsWith('yields.')) {
        // Must be yields.<engineId>.<path> — at least two dots total
        const withoutPrefix = expr.slice('yields.'.length);
        const dotIndex = withoutPrefix.indexOf('.');
        if (dotIndex < 0) {
          return `engine "${engineId}" has invalid expression "\${${expr}}" — yields requires engineId and property path`;
        }
        const refEngineId = withoutPrefix.slice(0, dotIndex);

        if (!engineIds.has(refEngineId)) {
          return `engine "${engineId}" references \${yields.${refEngineId}} but "${refEngineId}" is not an engine in this template`;
        }

        const reachable = computeUpstreamReachable(engineId, allEngines);
        if (!reachable.has(refEngineId)) {
          const yieldPath = withoutPrefix.slice(dotIndex + 1);
          return `engine "${engineId}" references \${yields.${refEngineId}.${yieldPath}} but "${refEngineId}" is not upstream of "${engineId}"`;
        }
        continue; // valid
      }
      return `engine "${engineId}" has unrecognized expression "\${${expr}}"`;
    }
  }
  return null;
}

/**
 * Validate all configured rig templates at startup.
 * Fails fast on the first error with a '[spider]' prefixed message.
 */
function validateTemplates(
  rigTemplates: Record<string, RigTemplate>,
  fabricator: FabricatorApi,
): void {
  const builtinEngineIds = new Set([
    animaSessionEngine.id,
    draftEngine.id,
    implementEngine.id,
    implementLoopEngine.id,
    pieceSessionEngine.id,
    reviewEngine.id,
    reviseEngine.id,
    sealEngine.id,
  ]);

  for (const [templateKey, template] of Object.entries(rigTemplates)) {
    const engines = template.engines;

    // R13: Non-empty check
    if (engines.length === 0) {
      throw new Error(`[spider] rigTemplates.${templateKey}: template has no engines`);
    }

    // R6b: Duplicate ID check
    const engineIds = new Set<string>();
    for (const engine of engines) {
      if (engineIds.has(engine.id)) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: duplicate engine id "${engine.id}"`
        );
      }
      engineIds.add(engine.id);
    }

    // R6a: designId check
    for (const engine of engines) {
      const knownInFabricator = fabricator.getEngineDesign(engine.designId) !== undefined;
      const knownBuiltin = builtinEngineIds.has(engine.designId);
      if (!knownInFabricator && !knownBuiltin) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: engine "${engine.id}" references unknown designId "${engine.designId}"`
        );
      }
    }

    // R6c: Upstream reference check
    for (const engine of engines) {
      for (const upstreamId of engine.upstream ?? []) {
        if (!engineIds.has(upstreamId)) {
          throw new Error(
            `[spider] rigTemplates.${templateKey}: engine "${engine.id}" references unknown upstream "${upstreamId}"`
          );
        }
      }
    }

    // R6d: Cycle detection (DFS)
    {
      const visiting = new Set<string>();
      const visited = new Set<string>();

      const visit = (id: string): void => {
        if (visited.has(id)) return;
        if (visiting.has(id)) {
          throw new Error(
            `[spider] rigTemplates.${templateKey}: dependency cycle detected involving engine "${id}"`
          );
        }
        visiting.add(id);
        const engine = engines.find((e) => e.id === id)!;
        for (const dep of engine.upstream ?? []) {
          visit(dep);
        }
        visiting.delete(id);
        visited.add(id);
      };

      for (const engine of engines) {
        visit(engine.id);
      }
    }

    // R6e: resolutionEngine check
    if (template.resolutionEngine !== undefined && !engineIds.has(template.resolutionEngine)) {
      throw new Error(
        `[spider] rigTemplates.${templateKey}: resolutionEngine "${template.resolutionEngine}" is not an engine id in this template`
      );
    }

    // R7: Variable reference validation
    for (const engine of engines) {
      const refError = validateGivensRefs(engine.givens ?? {}, engine.id, engineIds, engines);
      if (refError !== null) {
        throw new Error(`[spider] rigTemplates.${templateKey}: ${refError}`);
      }
    }

    // when condition validation
    for (const engine of engines) {
      if (engine.when === undefined) continue;
      let expr = engine.when.trim();
      if (expr.startsWith('!')) {
        expr = expr.slice(1);
      }
      // Strip ${...} wrapper if present to get the expression body
      if (expr.startsWith('${') && expr.endsWith('}')) {
        expr = expr.slice(2, -1);
      }
      // Must be yields.<engineId>.<path>
      if (!expr.startsWith('yields.')) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: engine "${engine.id}" has invalid when expression "${engine.when}" — must be a \${yields.<engine_id>.<property>} reference with optional ! prefix`
        );
      }
      const withoutPrefix = expr.slice('yields.'.length);
      const dotIndex = withoutPrefix.indexOf('.');
      if (dotIndex < 0) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: engine "${engine.id}" has invalid when expression "${engine.when}" — must be a \${yields.<engine_id>.<property>} reference with optional ! prefix`
        );
      }
      const refEngineId = withoutPrefix.slice(0, dotIndex);
      const yieldProp = withoutPrefix.slice(dotIndex + 1);

      if (!engineIds.has(refEngineId)) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: engine "${engine.id}" when references \${yields.${refEngineId}} but "${refEngineId}" is not an engine in this template`
        );
      }
      const reachable = computeUpstreamReachable(engine.id, engines);
      if (!reachable.has(refEngineId)) {
        throw new Error(
          `[spider] rigTemplates.${templateKey}: engine "${engine.id}" when references \${yields.${refEngineId}.${yieldProp}} but "${refEngineId}" is not upstream of "${engine.id}"`
        );
      }
    }
  }
}

/**
 * Validate a set of grafted engines against the current rig.
 * Returns null if valid, or an error string if invalid.
 */
function validateGraft(
  rig: RigDoc,
  graft: RigTemplateEngine[],
  fabricator: FabricatorApi,
  maxEngines: number,
): string | null {
  // Max engines check
  if (rig.engines.length + graft.length > maxEngines) {
    return `Graft would exceed maxEnginesPerRig (${maxEngines}): rig has ${rig.engines.length} engines, graft adds ${graft.length}`;
  }

  const existingIds = new Set(rig.engines.map((e) => e.id));

  // Duplicate ID check
  const graftIds = new Set<string>();
  for (const engine of graft) {
    if (existingIds.has(engine.id) || graftIds.has(engine.id)) {
      return `Duplicate engine id "${engine.id}"`;
    }
    graftIds.add(engine.id);
  }

  // designId check
  for (const engine of graft) {
    if (fabricator.getEngineDesign(engine.designId) === undefined) {
      return `Engine "${engine.id}" references unknown designId "${engine.designId}"`;
    }
  }

  // Upstream reference check (can reference existing rig engines or other graft engines)
  const allIds = new Set([...existingIds, ...graftIds]);
  for (const engine of graft) {
    for (const upId of engine.upstream ?? []) {
      if (!allIds.has(upId)) {
        return `Engine "${engine.id}" references unknown upstream "${upId}"`;
      }
    }
  }

  // Cycle detection (DFS on combined engine set)
  {
    const allEngines = [
      ...rig.engines.map((e) => ({ id: e.id, upstream: e.upstream })),
      ...graft.map((e) => ({ id: e.id, upstream: e.upstream ?? [] })),
    ];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): string | null => {
      if (visited.has(id)) return null;
      if (visiting.has(id)) return `Dependency cycle detected involving engine "${id}"`;
      visiting.add(id);
      const eng = allEngines.find((e) => e.id === id);
      if (eng) {
        for (const dep of eng.upstream) {
          const err = visit(dep);
          if (err) return err;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return null;
    };

    for (const engine of graft) {
      const err = visit(engine.id);
      if (err) return err;
    }
  }

  // Build combined template engines list for upstream reachability checks
  const allTemplateEngines: RigTemplateEngine[] = [
    ...rig.engines.map((e) => ({ id: e.id, upstream: e.upstream } as RigTemplateEngine)),
    ...graft,
  ];

  // when reference validation
  for (const engine of graft) {
    if (engine.when === undefined) continue;
    let expr = engine.when.trim();
    if (expr.startsWith('!')) expr = expr.slice(1);
    // Strip ${...} wrapper if present
    if (expr.startsWith('${') && expr.endsWith('}')) {
      expr = expr.slice(2, -1);
    }
    if (!expr.startsWith('yields.')) {
      return `Engine "${engine.id}" has invalid when expression — must be a \${yields.<engineId>.<property>} reference`;
    }
    const withoutPrefix = expr.slice('yields.'.length);
    const dotIndex = withoutPrefix.indexOf('.');
    if (dotIndex < 0) {
      return `Engine "${engine.id}" has invalid when expression — must be a \${yields.<engineId>.<property>} reference`;
    }
    const refEngineId = withoutPrefix.slice(0, dotIndex);
    const allIds = new Set([...new Set(rig.engines.map((e) => e.id)), ...graft.map((e) => e.id)]);
    if (!allIds.has(refEngineId)) {
      return `Engine "${engine.id}" when references unknown engine "${refEngineId}"`;
    }
    const reachable = computeUpstreamReachable(engine.id, allTemplateEngines);
    if (!reachable.has(refEngineId)) {
      return `Engine "${engine.id}" when references "${refEngineId}" which is not upstream`;
    }
  }

  // yield reference validation in givens
  const allGraftIds = new Set([...new Set(rig.engines.map((e) => e.id)), ...graft.map((e) => e.id)]);
  for (const engine of graft) {
    const refError = validateGivensRefs(engine.givens ?? {}, engine.id, allGraftIds, allTemplateEngines);
    if (refError !== null) {
      return refError;
    }
  }

  return null; // Valid
}

// ── Block type type guard ──────────────────────────────────────────────

function isBlockType(value: unknown): value is BlockType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).check === 'function'
  );
}

// ── Block type registry ────────────────────────────────────────────────

class BlockTypeRegistry {
  private readonly types = new Map<string, BlockType>();
  private readonly provenance = new Map<string, string>();

  registerFromEntry(entry: KitEntry): void {
    const raw = entry.value;
    if (typeof raw !== 'object' || raw === null) return;
    // entry.value IS the blockTypes record — wrap it back so registerFromKit
    // can find it via kit.blockTypes (consistent with the fabricator pattern).
    this.registerFromKit({ blockTypes: raw } as Record<string, unknown>, entry.pluginId);
  }

  private registerFromKit(kit: Record<string, unknown>, pluginId: string): void {
    const raw = kit.blockTypes;
    if (typeof raw !== 'object' || raw === null) return;
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (!isBlockType(value)) continue;

      // Kit-vs-kit collision: throw at registration time. Two kits contributing
      // a block type with the same id is a guild-config hazard — resolvers
      // (and everything else that keys on the id) would silently bind to
      // whichever kit happened to load last. Refuse to start instead.
      const existingPlugin = this.provenance.get(value.id);
      if (existingPlugin !== undefined) {
        throw new Error(
          `[spider] blockTypes: block type "${value.id}" is contributed by two kits ` +
          `— kit "${existingPlugin}" already registered it, and ` +
          `kit "${pluginId}" attempted to register it again. ` +
          `Two kits cannot contribute the same block type id. ` +
          `Resolve by removing one of the kit contributions.`
        );
      }

      this.types.set(value.id, value);
      this.provenance.set(value.id, pluginId);
    }
  }

  get(id: string): BlockType | undefined {
    return this.types.get(id);
  }

  list(): BlockTypeInfo[] {
    const result: BlockTypeInfo[] = [];
    for (const [id, blockType] of this.types) {
      result.push({
        id,
        pluginId: this.provenance.get(id) ?? 'unknown',
        ...(blockType.pollIntervalMs !== undefined ? { pollIntervalMs: blockType.pollIntervalMs } : {}),
      });
    }
    return result;
  }
}

// ── Rig template registry ──────────────────────────────────────────────

/**
 * Manages merged rig template and mapping registries.
 * Config templates/mappings override kit contributions.
 * Kit templates are registered under qualified names (pluginId.templateName).
 */
class RigTemplateRegistry {
  /** Merged template registry: template name → RigTemplate */
  readonly templates = new Map<string, RigTemplate>();
  /** Config writ-type-to-template-name mappings */
  readonly configMappings = new Map<string, string>();
  /**
   * Kit-contributed mappings (first-registered wins). Each entry records
   * the contributing pluginId so the registry can fall back from an
   * unqualified templateName to the kit's own qualified `${pluginId}.${name}`
   * when no config-level template has claimed the unqualified slot.
   */
  readonly kitMappings = new Map<string, { templateName: string; pluginId: string }>();
  /** Config-declared template names (for override checking) */
  private configTemplateNames = new Set<string>();
  /** designId → pluginId that contributed it */
  private designSourceMap = new Map<string, string>();

  /**
   * Resolve the actual template name stored in `templates` for a kit
   * mapping entry. Prefer the literal value (so config-level overrides
   * with the same name win); otherwise fall back to the kit's own
   * qualified name. Returns undefined when neither form resolves.
   */
  private resolveKitMappedName(entry: { templateName: string; pluginId: string }): string | undefined {
    if (this.templates.has(entry.templateName)) return entry.templateName;
    if (!entry.templateName.includes('.')) {
      const qualified = `${entry.pluginId}.${entry.templateName}`;
      if (this.templates.has(qualified)) return qualified;
    }
    return undefined;
  }

  /**
   * Build the designId → pluginId map from all engine KitEntries.
   * Called once at startup before any kit registration.
   */
  buildDesignSourceMap(engineEntries: KitEntry[]): void {
    // Spider's built-in engines always map to 'spider'
    const builtinIds = [
      animaSessionEngine.id,
      draftEngine.id,
      implementEngine.id,
      implementLoopEngine.id,
      pieceSessionEngine.id,
      reviewEngine.id,
      reviseEngine.id,
      sealEngine.id,
    ];
    for (const id of builtinIds) {
      this.designSourceMap.set(id, 'spider');
    }

    // Scan engine entries from all sources
    // entry.value IS the engines bag (e.g. { draft: engine }) — wrap it back so
    // registerEnginesFromKit can find it via kit.engines (consistent with kit layout).
    for (const entry of engineEntries) {
      this.registerEnginesFromKit(entry.pluginId, { engines: entry.value } as Record<string, unknown>);
    }
  }

  private registerEnginesFromKit(pluginId: string, kit: Record<string, unknown>): void {
    const raw = kit.engines;
    if (typeof raw !== 'object' || raw === null) return;
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>).id === 'string' &&
        typeof (value as Record<string, unknown>).run === 'function'
      ) {
        const engineId = (value as Record<string, unknown>).id as string;
        this.designSourceMap.set(engineId, pluginId);
      }
    }
  }

  /**
   * Register config-declared templates. Called after validateTemplates() succeeds.
   */
  registerConfigTemplates(rigTemplates: Record<string, RigTemplate>): void {
    for (const [name, template] of Object.entries(rigTemplates)) {
      this.templates.set(name, template);
      this.configTemplateNames.add(name);
    }
  }

  /**
   * Register config-declared mappings.
   */
  registerConfigMappings(rigTemplateMappings: Record<string, string>): void {
    for (const [writType, templateName] of Object.entries(rigTemplateMappings)) {
      this.configMappings.set(writType, templateName);
    }
  }

  /**
   * Register a rigTemplates or rigTemplateMappings KitEntry.
   * Looks up requires/recommends from guild state for dependency-scoped validation.
   */
  registerFromEntry(entry: KitEntry): void {
    const g = guild();
    const standaloneKit = g.kits().find(k => k.id === entry.pluginId);
    let requires: string[] = [];
    let recommends: string[] = [];

    if (standaloneKit) {
      requires = standaloneKit.kit.requires ?? [];
      recommends = standaloneKit.kit.recommends ?? [];
    } else {
      const app = g.apparatuses().find(a => a.id === entry.pluginId);
      if (app) {
        requires = app.apparatus.requires ?? [];
        recommends = app.apparatus.recommends ?? [];
      }
    }

    // Reconstruct a kit-like record with requires/recommends for the existing logic
    const kitLike: Record<string, unknown> = {
      requires,
      recommends,
      [entry.type]: entry.value,
    };
    this.registerFromKit(entry.pluginId, kitLike);
  }

  /**
   * Register kit contributions (rigTemplates + rigTemplateMappings).
   * Validates and skips with console.warn on failure.
   */
  registerFromKit(pluginId: string, kit: Record<string, unknown>): void {
    // Handle rigTemplates
    const rawTemplates = kit.rigTemplates;
    if (rawTemplates !== undefined) {
      if (typeof rawTemplates !== 'object' || rawTemplates === null || Array.isArray(rawTemplates)) {
        console.warn(`[spider] Kit "${pluginId}" rigTemplates: expected an object — skipped`);
      } else {
        this.registerKitTemplates(pluginId, kit, rawTemplates as Record<string, unknown>);
      }
    }

    // Handle rigTemplateMappings
    const rawMappings = kit.rigTemplateMappings;
    if (rawMappings !== undefined) {
      if (typeof rawMappings !== 'object' || rawMappings === null || Array.isArray(rawMappings)) {
        console.warn(`[spider] Kit "${pluginId}" rigTemplateMappings: expected an object — skipped`);
      } else {
        this.registerKitMappings(pluginId, rawMappings as Record<string, unknown>);
      }
    }
  }

  private registerKitTemplates(
    pluginId: string,
    kit: Record<string, unknown>,
    rawTemplates: Record<string, unknown>,
  ): void {
    const allowedPlugins = new Set<string>([
      pluginId,
      ...((kit.requires as string[] | undefined) ?? []),
      ...((kit.recommends as string[] | undefined) ?? []),
      'spider',
    ]);

    for (const [templateName, rawTemplate] of Object.entries(rawTemplates)) {
      const qualifiedName = `${pluginId}.${templateName}`;

      // Config override check: skip silently
      if (this.configTemplateNames.has(qualifiedName)) continue;

      // Validate template shape
      if (
        typeof rawTemplate !== 'object' ||
        rawTemplate === null ||
        !Array.isArray((rawTemplate as Record<string, unknown>).engines)
      ) {
        console.warn(
          `[spider] Kit "${pluginId}" rigTemplates.${templateName}: missing required "engines" array — skipped`
        );
        continue;
      }

      const template = rawTemplate as RigTemplate;
      const validationError = this.validateKitTemplate(pluginId, templateName, template, allowedPlugins);
      if (validationError !== null) {
        console.warn(validationError);
        continue;
      }

      this.templates.set(qualifiedName, template);
    }
  }

  /**
   * Validate a kit-contributed template. Returns null on success, or an error message string.
   */
  private validateKitTemplate(
    pluginId: string,
    templateName: string,
    template: RigTemplate,
    allowedPlugins: Set<string>,
  ): string | null {
    const engines = template.engines;
    const prefix = `[spider] Kit "${pluginId}" rigTemplates.${templateName}`;

    if (engines.length === 0) {
      return `${prefix}: template has no engines`;
    }

    const engineIds = new Set<string>();
    for (const engine of engines) {
      if (engineIds.has(engine.id)) {
        return `${prefix}: duplicate engine id "${engine.id}"`;
      }
      engineIds.add(engine.id);
    }

    // Dependency-scoped designId check
    for (const engine of engines) {
      const sourcePlugin = this.designSourceMap.get(engine.designId);
      if (sourcePlugin === undefined) {
        return `${prefix}: engine "${engine.id}" references unknown designId "${engine.designId}"`;
      }
      if (!allowedPlugins.has(sourcePlugin)) {
        return `${prefix}: engine "${engine.id}" references designId "${engine.designId}" from plugin "${sourcePlugin}" which is not in requires/recommends`;
      }
    }

    // Upstream reference check
    for (const engine of engines) {
      for (const upId of engine.upstream ?? []) {
        if (!engineIds.has(upId)) {
          return `${prefix}: engine "${engine.id}" references unknown upstream "${upId}"`;
        }
      }
    }

    // Cycle detection (DFS)
    {
      const visiting = new Set<string>();
      const visited = new Set<string>();
      let cycleError: string | null = null;

      const visit = (id: string): void => {
        if (cycleError !== null || visited.has(id)) return;
        if (visiting.has(id)) {
          cycleError = `${prefix}: dependency cycle detected involving engine "${id}"`;
          return;
        }
        visiting.add(id);
        const eng = engines.find((e) => e.id === id)!;
        for (const dep of eng.upstream ?? []) {
          visit(dep);
        }
        visiting.delete(id);
        visited.add(id);
      };

      for (const engine of engines) {
        visit(engine.id);
        if (cycleError !== null) return cycleError;
      }
    }

    // resolutionEngine check
    if (template.resolutionEngine !== undefined && !engineIds.has(template.resolutionEngine)) {
      return `${prefix}: resolutionEngine "${template.resolutionEngine}" is not an engine id in this template`;
    }

    // Variable reference validation
    for (const engine of engines) {
      const refError = validateGivensRefs(engine.givens ?? {}, engine.id, engineIds, template.engines);
      if (refError !== null) {
        return `${prefix}: ${refError}`;
      }
    }

    // when condition validation
    for (const engine of engines) {
      if (engine.when === undefined) continue;
      let expr = engine.when.trim();
      if (expr.startsWith('!')) {
        expr = expr.slice(1);
      }
      // Strip ${...} wrapper if present
      if (expr.startsWith('${') && expr.endsWith('}')) {
        expr = expr.slice(2, -1);
      }
      if (!expr.startsWith('yields.')) {
        return `${prefix}: engine "${engine.id}" has invalid when expression "${engine.when}" — must be a \${yields.<engine_id>.<property>} reference with optional ! prefix`;
      }
      const withoutPrefix = expr.slice('yields.'.length);
      const dotIndex = withoutPrefix.indexOf('.');
      if (dotIndex < 0) {
        return `${prefix}: engine "${engine.id}" has invalid when expression "${engine.when}" — must be a \${yields.<engine_id>.<property>} reference with optional ! prefix`;
      }
      const refEngineId = withoutPrefix.slice(0, dotIndex);
      const yieldProp = withoutPrefix.slice(dotIndex + 1);

      if (!engineIds.has(refEngineId)) {
        return `${prefix}: engine "${engine.id}" when references \${yields.${refEngineId}} but "${refEngineId}" is not an engine in this template`;
      }
      const reachable = computeUpstreamReachable(engine.id, template.engines);
      if (!reachable.has(refEngineId)) {
        return `${prefix}: engine "${engine.id}" when references \${yields.${refEngineId}.${yieldProp}} but "${refEngineId}" is not upstream of "${engine.id}"`;
      }
    }

    return null;
  }

  private registerKitMappings(pluginId: string, rawMappings: Record<string, unknown>): void {
    for (const [writType, templateName] of Object.entries(rawMappings)) {
      if (typeof templateName !== 'string') {
        console.warn(
          `[spider] Kit "${pluginId}" rigTemplateMappings.${writType}: value must be a string — skipped`
        );
        continue;
      }

      // Config override: skip silently. Config-vs-kit precedence is unchanged;
      // the kit-vs-kit collision rule below only fires when no config mapping
      // claims the writ type.
      if (this.configMappings.has(writType)) continue;

      // Kit-vs-kit collision: throw at registration time. Two kits contributing
      // a mapping for the same writ type is a guild-config hazard — operators
      // resolve it by removing one of the contributions, or by overriding via
      // guild config.
      const existing = this.kitMappings.get(writType);
      if (existing !== undefined) {
        throw new Error(
          `[spider] rigTemplateMappings: writ type "${writType}" is mapped by two kits ` +
          `— kit "${existing.pluginId}" mapped it to "${existing.templateName}", and ` +
          `kit "${pluginId}" attempted to map it to "${templateName}". ` +
          `Two kits cannot contribute a mapping for the same writ type. ` +
          `Resolve by removing one of the kit mappings, or by overriding via ` +
          `guild config (spider.rigTemplateMappings).`
        );
      }

      this.kitMappings.set(writType, { templateName, pluginId });
    }
  }

  /**
   * Validate all mappings after Phase 1 scanning completes.
   * Config dangling mappings throw; kit dangling mappings warn and are removed.
   */
  validateDeferredMappings(): void {
    // Config mappings — throw on dangling
    for (const [writType, templateName] of this.configMappings) {
      if (!this.templates.has(templateName)) {
        throw new Error(
          `[spider] rigTemplateMappings.${writType}: references unknown template "${templateName}"`
        );
      }
    }

    // Kit mappings — warn and remove on dangling. An unqualified templateName
    // is considered resolved if either the bare name or the kit's own
    // `${pluginId}.${templateName}` exists in the template registry.
    for (const [writType, entry] of [...this.kitMappings]) {
      if (this.resolveKitMappedName(entry) === undefined) {
        console.warn(
          `[spider] Kit mapping "${writType}" → "${entry.templateName}": template not found — removed`
        );
        this.kitMappings.delete(writType);
      }
    }
  }

  /**
   * Validate kit mappings incrementally (for Phase 2 late-arriving apparatus).
   * Since deferred validation already ran, validate immediately.
   */
  validateIncrementalMappings(): void {
    for (const [writType, entry] of [...this.kitMappings]) {
      if (this.resolveKitMappedName(entry) === undefined) {
        console.warn(
          `[spider] Kit mapping "${writType}" → "${entry.templateName}": template not found — removed`
        );
        this.kitMappings.delete(writType);
      }
    }
  }

  /**
   * Look up the rig template for a given writ type.
   *
   * Dispatch is strictly opt-in: a writ type must have an explicit mapping
   * in `rigTemplateMappings` (config or kit) to be dispatched. Writ types
   * with no mapping return `undefined` and the caller should skip dispatch,
   * leaving the writ for non-dispatch handling (e.g. custom writ types
   * tracked without automatic dispatch).
   *
   * Precedence: config mapping → kit mapping → mandate-builtin fallback →
   * undefined.
   *
   * The mandate-builtin fallback preserves zero-config dispatch for Spider-
   * only guilds: when the requested writ type is exactly the literal
   * `'mandate'` (Clerk's sole builtin writ type) and no config or kit
   * mapping claims it, the registry resolves against a template named
   * `default` (config-level) or `spider.default` (kit-qualified). The
   * fallback is narrow — no other writ type is matched — so the opt-in-
   * dispatch contract for every non-builtin type is preserved.
   */
  lookup(writType: string): RigTemplate | undefined {
    // Step 1: Config mapping for this specific writ type
    const configMapped = this.configMappings.get(writType);
    if (configMapped !== undefined) {
      const t = this.templates.get(configMapped);
      if (t) return t;
      // Config points to nonexistent template — validated at startup, should not happen at runtime
    }

    // Step 2: Kit mapping for this specific writ type. Unqualified
    // templateName values resolve against the bare name first (so a
    // config-level template of the same name wins), then fall back to the
    // kit's own `${pluginId}.${templateName}` qualified form.
    const kitMapped = this.kitMappings.get(writType);
    if (kitMapped !== undefined) {
      const resolved = this.resolveKitMappedName(kitMapped);
      if (resolved !== undefined) {
        const t = this.templates.get(resolved);
        if (t) return t;
      }
    }

    // Step 3: Mandate-builtin fallback. Only the literal writ type
    // `'mandate'` is matched — every other unmapped writ type remains
    // inert. The resolution pattern mirrors `resolveKitMappedName`:
    // prefer the unqualified `default` template (so a config-level
    // override wins) and fall back to the kit-qualified `spider.default`.
    if (writType === 'mandate') {
      const defaultTemplate = this.templates.get('default') ?? this.templates.get('spider.default');
      if (defaultTemplate) return defaultTemplate;
    }

    // No explicit mapping — writ type is inert by configuration, skip dispatch.
    return undefined;
  }

  /**
   * List all registered templates with provenance info.
   */
  listTemplates(): RigTemplateInfo[] {
    const result: RigTemplateInfo[] = [];
    for (const [name, template] of this.templates) {
      let source: string;
      if (this.configTemplateNames.has(name)) {
        source = 'config';
      } else {
        // Kit templates are stored as "pluginId.templateName"
        const dotIdx = name.indexOf('.');
        source = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
      }
      result.push({ name, source, template });
    }
    return result;
  }

  /**
   * Return the merged effective writ-type → template-name mapping.
   * Config mappings override kit mappings for the same writ type.
   *
   * Includes the mandate-builtin fallback: when the `mandate` writ type has
   * no explicit config or kit mapping and a template named `default` or
   * `spider.default` is registered, the merged map reports
   * `mandate → default` (or `mandate → spider.default`). This keeps the
   * dispatchable-types query filter in `trySpawn` in sync with `lookup()`'s
   * narrow fallback, so zero-config Spider-only guilds still dispatch their
   * mandate writs without an explicit mapping declaration.
   */
  listTemplateMappings(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [writType, entry] of this.kitMappings) {
      // Report the resolved template name so callers can look it up
      // directly in listTemplates() without re-implementing the
      // bare-name-to-qualified-name fallback.
      result[writType] = this.resolveKitMappedName(entry) ?? entry.templateName;
    }
    for (const [writType, templateName] of this.configMappings) {
      result[writType] = templateName;
    }
    // Mandate-builtin fallback — only applies when no explicit mapping claims
    // `mandate`. Mirrors `lookup()`'s narrow final clause.
    if (!result['mandate']) {
      if (this.templates.has('default')) {
        result['mandate'] = 'default';
      } else if (this.templates.has('spider.default')) {
        result['mandate'] = 'spider.default';
      }
    }
    return result;
  }
}

// ── Apparatus factory ──────────────────────────────────────────────────

export function createSpider(): Plugin {
  let stacks: StacksApi;
  let rigsBook: Book<RigDoc>;
  let inputRequestsBook: Book<InputRequestDoc>;
  let sessionsBook: ReadOnlyBook<SessionDoc>;
  let writsBook: ReadOnlyBook<WritDoc>;
  let clerk: ClerkApi;
  let fabricator: FabricatorApi;
  let animator: AnimatorApi;
  let spiderConfig: SpiderConfig = {};

  const blockTypeRegistry = new BlockTypeRegistry();
  const rigTemplateRegistry = new RigTemplateRegistry();

  /**
   * In-memory store for hold metadata snapshots whose hold has just been
   * cleared. Key: "rigId:engineId". Populated when the dispatch predicate
   * observes a `check() === 'cleared'` result and surfaces the hold to
   * `tryRun` via `context.priorBlock`. Consumed and deleted in `tryRun`
   * when building EngineRunContext.
   */
  const pendingPriorBlocks = new Map<string, {
    type: string;
    condition: unknown;
    blockedAt: string;
    message?: string;
    lastCheckedAt?: string;
  }>();

  /**
   * In-memory queue of pending grafts.
   * Key: rigId. Value: { engineId, graft, writId }.
   * Written by tryCollect/tryRun when a completed engine has a graft.
   * Consumed by tryProcessGrafts.
   */
  const pendingGrafts = new Map<string, { engineId: string; graft: RigTemplateEngine[]; writId: string; graftTail?: string }>();

  // ── Internal crawl operations ─────────────────────────────────────

  /**
   * Build a patch fragment that sets `terminalAt` to the current ISO
   * timestamp when the rig does not already have one. Returns an empty
   * object when the rig's `terminalAt` is already set.
   *
   * Keep-first semantics: the first terminal transition pins `terminalAt`;
   * subsequent terminal transitions (e.g. a failed rig being cancelled)
   * must NOT overwrite the original value. This helper is the single
   * source of truth for that rule — every rig-level patch that writes a
   * terminal `status` value should spread its result into the patch.
   */
  function terminalAtPatch(rig: RigDoc, nextStatus: RigStatus): { terminalAt?: string } {
    if (rig.terminalAt !== undefined) return {};
    if (nextStatus === 'running') return {};
    return { terminalAt: new Date().toISOString() };
  }

  /**
   * Rig-status rollup patch-wrapper.
   *
   * The single point of truth for every engine-state-change patch. Given
   * the rig and a new engine set, derives the rig status as a pure
   * projection (see `deriveRigStatus`), computes `terminalAt` keep-first,
   * and writes both engines and status in one transaction. Optional
   * `extraPatch` applies additional fields alongside (e.g. cancelledAt).
   *
   * `opts.pendingGraft` overrides the rollup to force `status='running'`
   * when a graft is queued for the next crawl tick. This keeps the rig
   * from prematurely projecting to `'completed'` when the only completed
   * engines are the ones whose grafts still need to land.
   *
   * Every call-site that mutates the engine array must route through this
   * wrapper — there is no inline `rig.status = ...` assignment anywhere
   * else in Spider.
   */
  async function patchRigWithRollup(
    rig: RigDoc,
    updatedEngines: EngineInstance[],
    extraPatch: Partial<RigDoc> = {},
    opts: { pendingGraft?: boolean } = {},
  ): Promise<RigStatus> {
    const cancelledAt = (extraPatch.cancelledAt as string | undefined) ?? rig.cancelledAt;
    let nextStatus = deriveRigStatus(updatedEngines, cancelledAt);
    // Pending-graft override: treat the rig as still-running so the
    // rollup doesn't finalize while queued grafts are pending.
    if (opts.pendingGraft && nextStatus === 'completed') {
      nextStatus = 'running';
    }
    await rigsBook.patch(rig.id, {
      ...extraPatch,
      engines: updatedEngines,
      status: nextStatus,
      ...terminalAtPatch(rig, nextStatus),
    });
    return nextStatus;
  }

  /**
   * Append-on-start: push a new attempt row onto an engine's `attempts[]`
   * and return the updated engine. The caller then assembles the new
   * engines array for patching via `patchRigWithRollup`.
   *
   * Subsequent `finalizeAttempt(engine, …)` patches the tail row with
   * endedAt / status / error / yields on terminal.
   */
  function appendAttemptStart(
    engine: EngineInstance,
    startedAt: string,
  ): EngineInstance {
    const nextAttempts = [...(engine.attempts ?? []), { startedAt } as EngineAttempt];
    return { ...engine, attempts: nextAttempts };
  }

  /**
   * Patch the tail attempt with session metadata (e.g. sessionId set
   * after a quick engine launches). Does not change attempt status or
   * endedAt.
   */
  function patchTailAttempt(
    engine: EngineInstance,
    patch: Partial<EngineAttempt>,
  ): EngineInstance {
    const attempts = engine.attempts ?? [];
    if (attempts.length === 0) {
      // No open attempt — defensive no-op. Should not happen in normal flow.
      return engine;
    }
    const tail = attempts[attempts.length - 1];
    const nextAttempts = attempts.slice(0, -1).concat([{ ...tail, ...patch }]);
    return { ...engine, attempts: nextAttempts };
  }

  /**
   * Finalize the tail attempt: stamp endedAt, terminal status, and
   * optional error/yields. Returns the updated engine.
   */
  function finalizeAttempt(
    engine: EngineInstance,
    fields: {
      endedAt: string;
      status: 'completed' | 'failed';
      error?: string;
      yields?: unknown;
      sessionId?: string;
    },
  ): EngineInstance {
    return patchTailAttempt(engine, fields);
  }

  /**
   * Compute the back-off delay (in ms) for a given retryable attempt
   * count. `attemptCount` is the count of failed attempts observed so
   * far (zero-indexed: 1 → initial delay, 2 → initial*factor, …).
   */
  function computeBackoffDelay(
    backoff: { initialMs: number; maxMs: number; factor: number },
    attemptCount: number,
  ): number {
    if (attemptCount <= 0) return backoff.initialMs;
    const raw = backoff.initialMs * Math.pow(backoff.factor, attemptCount - 1);
    return Math.min(Math.floor(raw), backoff.maxMs);
  }

  /**
   * Failure outcome — the discriminated result of the single failure
   * handler. The handler classifies the incoming failure against the
   * engine design's retry policy and the failure's nature, then writes
   * the rig in one transaction.
   */
  type FailureOutcome =
    | { kind: 'rate-limit-held' }
    | { kind: 'retryable-within-budget'; attemptCount: number }
    | { kind: 'terminally-failed' };

  /**
   * The unified failure handler.
   *
   * Handles three cases:
   *   1. `rateLimited: true` — transition the engine to `pending` with
   *      `holdReason='rate-limit'`, close out the in-flight attempt
   *      without error, clear sessionId so the next dispatch launches
   *      fresh. `attemptCount` is NOT incremented — rate-limit is not a
   *      retryable failure, it's a hold.
   *   2. `retryable: true` AND the design has remaining retry budget —
   *      increment `attemptCount`, close out the in-flight attempt with
   *      status='failed'+error, set `holdUntil` from the design's
   *      back-off. Downstream stays pending.
   *   3. Otherwise — mark the engine `failed`, close out the in-flight
   *      attempt, cascade-cancel every non-terminal engine (pending or
   *      held). The rig rollup writes status='failed'.
   *
   * The engine-failure path does NOT write `writ.status.spider`
   * (D19). The rigs→writs CDC handler translates rig.status='failed' →
   * writ.phase='failed' directly.
   */
  async function handleEngineFailure(
    rig: RigDoc,
    engineId: string,
    errorMessage: string,
    opts: {
      retryable: boolean;
      rateLimited?: boolean;
      rateLimitSessionId?: string;
      detail?: string;
    },
  ): Promise<FailureOutcome> {
    const now = new Date().toISOString();
    const target = rig.engines.find((e) => e.id === engineId);
    if (!target) {
      throw new Error(`handleEngineFailure: engine "${engineId}" not found in rig "${rig.id}"`);
    }

    // ── Branch 1: rate-limit hold ──────────────────────────────────
    if (opts.rateLimited) {
      const condition = { sessionId: opts.rateLimitSessionId };
      const updatedEngines = rig.engines.map((e) => {
        if (e.id !== engineId) return e;
        // Close out the in-flight attempt without error; rate-limit is
        // not a failure of the attempt — the attempt just didn't run.
        // We use `status: 'failed'` on the attempt row to record that
        // it did not produce yields, but we do not increment the budget.
        const finalized = finalizeAttempt(e, {
          endedAt: now,
          status: 'failed',
          error: errorMessage,
        });
        return {
          ...finalized,
          status: 'pending' as const,
          // Use the registered BlockType id so the dispatch predicate's
          // gate check resolves against the `animator-paused` checker.
          // Using a made-up id (e.g. 'rate-limit') would leave the gate
          // unresolvable — the predicate would short-circuit to
          // `dispatchable: true` and the engine would hot-loop.
          holdReason: 'animator-paused',
          holdCondition: condition,
          // Leave holdUntil undefined — BlockType `animator-paused`'s
          // check() consults the Animator for the current window.
          holdUntil: undefined,
          lastCheckedAt: undefined,
        };
      });
      await patchRigWithRollup(rig, updatedEngines);
      return { kind: 'rate-limit-held' };
    }

    // ── Branch 2: retryable within budget ──────────────────────────
    const design = fabricator.getEngineDesign(target.designId);
    const retry = design ? resolveEngineRetryConfig(design) : { maxAttempts: 0, backoff: { initialMs: 30_000, maxMs: 600_000, factor: 2 } };
    const currentAttemptCount = target.attemptCount ?? 0;
    const budgetRemaining = currentAttemptCount < retry.maxAttempts;

    if (opts.retryable && budgetRemaining) {
      const nextAttemptCount = currentAttemptCount + 1;
      const delayMs = computeBackoffDelay(retry.backoff, nextAttemptCount);
      const holdUntil = new Date(Date.now() + delayMs).toISOString();
      const updatedEngines = rig.engines.map((e) => {
        if (e.id !== engineId) return e;
        const finalized = finalizeAttempt(e, {
          endedAt: now,
          status: 'failed',
          error: errorMessage,
        });
        return {
          ...finalized,
          status: 'pending' as const,
          attemptCount: nextAttemptCount,
          holdReason: 'retry-backoff',
          holdUntil,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      });
      await patchRigWithRollup(rig, updatedEngines);
      return { kind: 'retryable-within-budget', attemptCount: nextAttemptCount };
    }

    // ── Branch 3: terminal failure (cascade-cancel downstream) ─────
    const updatedEngines = rig.engines.map((e) => {
      if (e.id === engineId) {
        const finalized = finalizeAttempt(e, {
          endedAt: now,
          status: 'failed',
          error: errorMessage,
        });
        return {
          ...finalized,
          status: 'failed' as const,
          // Clear any hold metadata; the engine is terminal now.
          holdUntil: undefined,
          holdReason: undefined,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      }
      // Cascade-cancel any pending engine (covers both plain pending and
      // held engines — those are pending-with-hold in the new model).
      if (e.status === 'pending') {
        return {
          ...e,
          status: 'cancelled' as const,
          holdUntil: undefined,
          holdReason: undefined,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      }
      return e;
    });
    await patchRigWithRollup(rig, updatedEngines);
    return { kind: 'terminally-failed' };
  }

  /**
   * Mark an engine cancelled and propagate cancellation to the rig.
   * Cancels all pending engines (including those with hold metadata).
   * Does NOT call Animator.cancel() — that is the caller's responsibility.
   *
   * This path is triggered by explicit operator-cancel (`api.cancel`); the
   * rig rollup observes `cancelledAt` and short-circuits to `'cancelled'`.
   */
  async function cancelEngine(
    rig: RigDoc,
    engineId: string,
    reason?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updatedEngines = rig.engines.map((e) => {
      if (e.id === engineId) {
        const withCloseout = (e.attempts && e.attempts.length > 0 && !e.attempts[e.attempts.length - 1].endedAt)
          ? finalizeAttempt(e, { endedAt: now, status: 'failed', error: reason })
          : e;
        return {
          ...withCloseout,
          status: 'cancelled' as const,
          holdUntil: undefined,
          holdReason: undefined,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      }
      if (e.status === 'pending') {
        return {
          ...e,
          status: 'cancelled' as const,
          holdUntil: undefined,
          holdReason: undefined,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      }
      return e;
    });
    await patchRigWithRollup(rig, updatedEngines, {
      cancelledAt: rig.cancelledAt ?? now,
    });
  }

  /**
   * Reject all pending input requests for a rig.
   */
  async function rejectPendingInputRequests(rigId: string): Promise<void> {
    const pendingRequests = await inputRequestsBook.find({
      where: [['rigId', '=', rigId], ['status', '=', 'pending']],
    });
    const now = new Date().toISOString();
    for (const req of pendingRequests) {
      await inputRequestsBook.patch(req.id, {
        status: 'rejected',
        rejectionReason: 'Rig cancelled',
        updatedAt: now,
      });
    }
  }

  /**
   * Phase 1 — collect.
   *
   * Find the first running engine whose attempts[-1].sessionId's session
   * has reached a terminal state. Populate yields and advance the engine
   * (and possibly the rig) to completed or failed via the unified
   * failure handler or the patch-wrapper rollup.
   *
   * Rate-limit terminals route to the failure handler's `rateLimited`
   * branch — the engine returns to `pending` with
   * `holdReason='animator-paused'`; no budget is consumed.
   *
   * Legacy tolerance — rigs persisted with 'blocked' or 'stuck' predate
   * this commission and are intentionally NOT fed into the crawl loop:
   * they have no engine that the new dispatcher can reason about, and
   * resurrecting them would risk double-dispatching sessions that already
   * terminated. They remain visible for operator inspection (`rig show`,
   * dashboard) and are reachable by explicit operator cancel via the
   * writ-cancel CDC path or `api.cancel()` (both have legacy-tolerant
   * branches). The `trySpawn` double-dispatch guard includes 'blocked'
   * in its "active" set so the writ doesn't spawn a replacement rig
   * while the legacy one still exists.
   */
  async function tryCollect(): Promise<CrawlResult | null> {
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
    for (const rig of runningRigs) {
      for (const engine of rig.engines) {
        if (engine.status !== 'running') continue;
        const tail = latestAttempt(engine);
        const sessionId = tail?.sessionId;
        if (!sessionId) continue;

        const session = await sessionsBook.get(sessionId);
        // Both 'pending' and 'running' are non-terminal — keep waiting.
        if (!session || session.status === 'running' || session.status === 'pending') continue;

        // Terminal session found — collect.
        const now = new Date().toISOString();

        if (session.status === 'failed' || session.status === 'timeout') {
          // Session-side terminal failure (crash / timeout) — transient by
          // nature: the next attempt runs a fresh session.
          const sessionDetail = session.error ?? `Session ${session.status}`;
          const outcome = await handleEngineFailure(rig, engine.id, sessionDetail, {
            retryable: true,
            detail: `Session ${session.status}: ${sessionDetail}`,
          });
          if (outcome.kind === 'retryable-within-budget') {
            return {
              action: 'engine-retrying',
              rigId: rig.id,
              engineId: engine.id,
              attemptCount: outcome.attemptCount,
            };
          }
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        if (session.status === 'rate-limited') {
          // Provider-reported rate-limit terminal: rate-limit hold path.
          // The unified failure handler transitions the engine to
          // `pending` + `holdReason='rate-limit'` and does not increment
          // the retry budget. The dispatch predicate's external-gate
          // check (via the `animator-paused` BlockType) clears the hold
          // once the pause window ends.
          await handleEngineFailure(rig, engine.id, session.error ?? 'Anima provider is rate limited', {
            retryable: false,
            rateLimited: true,
            rateLimitSessionId: sessionId,
          });
          // The persisted holdReason is `'animator-paused'` (see
          // handleEngineFailure); surface the same id here so
          // observers see a consistent gate identity.
          return { action: 'engine-held', rigId: rig.id, engineId: engine.id, holdReason: 'animator-paused' };
        }

        if (session.status === 'cancelled') {
          await cancelEngine(rig, engine.id, session.error ?? 'Session cancelled');
          await rejectPendingInputRequests(rig.id);
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'cancelled' };
        }

        // Completed session — assemble yields via engine's collect() or generic default.
        const design = fabricator.getEngineDesign(engine.designId);
        let yields: unknown;
        let collectGraft: RigTemplateEngine[] | undefined;
        let collectGraftTail: string | undefined;
        if (design?.collect) {
          const upstream = buildUpstreamMap(rig);
          const givens = resolveYieldRefs(engine.givensSpec, upstream);
          const context = { rigId: rig.id, engineId: engine.id, upstream };
          // Treat a collect() throw the same way tryRun() treats a run() throw:
          // fail the engine transient-retryable.
          let collectResult: unknown;
          try {
            collectResult = await design.collect(sessionId, givens, context);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const outcome = await handleEngineFailure(rig, engine.id, errorMessage, {
              retryable: true,
              detail: `Engine "${engine.id}" collect() threw: ${errorMessage}`,
            });
            if (outcome.kind === 'retryable-within-budget') {
              return {
                action: 'engine-retrying',
                rigId: rig.id,
                engineId: engine.id,
                attemptCount: outcome.attemptCount,
              };
            }
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
          }
          if (
            collectResult !== null &&
            collectResult !== undefined &&
            typeof collectResult === 'object' &&
            Array.isArray((collectResult as Record<string, unknown>).graft)
          ) {
            const scr = collectResult as SpiderCollectResult;
            yields = scr.yields;
            collectGraft = scr.graft;
            collectGraftTail = scr.graftTail;
          } else {
            yields = collectResult;
          }
        } else {
          yields = {
            sessionId: session.id,
            sessionStatus: session.status,
            ...(session.output !== undefined ? { output: session.output } : {}),
            ...(session.conversationId !== undefined ? { conversationId: session.conversationId } : {}),
          };
        }

        if (!isJsonSerializable(yields)) {
          // Definitional — the collect() wiring returned a value that
          // cannot round-trip through JSON.
          const outcome = await handleEngineFailure(rig, engine.id, 'Session yields are not JSON-serializable', {
            retryable: false,
            detail: `Engine "${engine.id}" collect() produced non-JSON-serializable yields`,
          });
          if (outcome.kind === 'retryable-within-budget') {
            return {
              action: 'engine-retrying',
              rigId: rig.id,
              engineId: engine.id,
              attemptCount: outcome.attemptCount,
            };
          }
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        const updatedEngines = rig.engines.map((e) => {
          if (e.id !== engine.id) return e;
          const finalized = finalizeAttempt(e, {
            endedAt: now,
            status: 'completed',
            yields,
            sessionId,
          });
          return { ...finalized, status: 'completed' as const };
        });

        if (collectGraft !== undefined && collectGraft.length > 0) {
          pendingGrafts.set(rig.id, { engineId: engine.id, graft: collectGraft, writId: rig.writId, graftTail: collectGraftTail });
          await patchRigWithRollup(rig, updatedEngines, {}, { pendingGraft: true });
          return { action: 'engine-completed', rigId: rig.id, engineId: engine.id };
        }

        const newStatus = await patchRigWithRollup(rig, updatedEngines);
        if (newStatus === 'completed') {
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
        }
        if (newStatus === 'failed') {
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }
        return { action: 'engine-completed', rigId: rig.id, engineId: engine.id };
      }
    }
    return null;
  }

  /**
   * Phase 1.5 — processGrafts.
   *
   * Process any pending graft requests stored by tryCollect or tryRun.
   * Validates grafted engines, appends them to the rig, and returns engine-grafted.
   * If validation fails, fails the originating engine.
   */
  async function tryProcessGrafts(): Promise<CrawlResult | null> {
    if (pendingGrafts.size === 0) return null;

    const [rigId, { engineId, graft, writId, graftTail }] = pendingGrafts.entries().next().value!;
    pendingGrafts.delete(rigId);

    // Re-fetch the rig to get the latest state
    const rig = await rigsBook.get(rigId);
    if (!rig) return null;

    // Look up the writ by its primary key
    const writ = await writsBook.get(writId);
    if (!writ) return null;

    const maxEngines = spiderConfig.maxEnginesPerRig ?? 50;
    const validationError = validateGraft(rig, graft, fabricator, maxEngines);
    if (validationError !== null) {
      // Definitional — the graft the engine produced is structurally
      // invalid; the same engine code would emit the same bad graft again.
      const outcome = await handleEngineFailure(rig, engineId, `Graft validation failed: ${validationError}`, {
        retryable: false,
        detail: `Graft validation failed in engine "${engineId}": ${validationError}`,
      });
      if (outcome.kind === 'retryable-within-budget') {
        return { action: 'engine-retrying', rigId: rig.id, engineId, attemptCount: outcome.attemptCount };
      }
      return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
    }

    // Convert grafted RigTemplateEngine entries to EngineInstance
    const graftedInstances: EngineInstance[] = graft.map((entry) => ({
      id: entry.id,
      designId: entry.designId,
      status: 'pending' as const,
      upstream: entry.upstream ?? [],
      givensSpec: resolveGivens(entry.givens, { writ, spiderConfig }),
      ...(entry.when !== undefined ? { when: entry.when } : {}),
    }));

    let updatedEngines = [...rig.engines, ...graftedInstances];

    if (graftTail) {
      const graftedIds = new Set(graftedInstances.map((e) => e.id));
      if (!graftedIds.has(graftTail)) {
        const outcome = await handleEngineFailure(
          rig,
          engineId,
          `Graft validation failed: graftTail "${graftTail}" is not a grafted engine id`,
          {
            retryable: false,
            detail: `Graft validation failed in engine "${engineId}": graftTail "${graftTail}" is not a grafted engine id`,
          },
        );
        if (outcome.kind === 'retryable-within-budget') {
          return { action: 'engine-retrying', rigId: rig.id, engineId, attemptCount: outcome.attemptCount };
        }
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }
      updatedEngines = updatedEngines.map((e) => {
        if (!graftedIds.has(e.id) && e.upstream.includes(engineId)) {
          return { ...e, upstream: [...e.upstream, graftTail] };
        }
        return e;
      });
    }

    await patchRigWithRollup(rig, updatedEngines);

    return {
      action: 'engine-grafted',
      rigId: rig.id,
      engineId,
      graftedEngineIds: graftedInstances.map((e) => e.id),
    };
  }

  /**
   * The dispatch predicate — the single source of truth for whether a
   * pending engine may run this tick.
   *
   * Composes four checks:
   *   1. status === 'pending'
   *   2. every upstream engine is terminal-success (`completed`/`skipped`)
   *   3. holdUntil is either absent or in the past
   *   4. if `holdReason` is set, the registered BlockType's `check()`
   *      returns `'cleared'` (honouring `pollIntervalMs` against the
   *      engine's `lastCheckedAt` stamp)
   *
   * Returns one of:
   *   - `{ dispatchable: true, priorBlock? }` — engine is ready; caller
   *     consumes `priorBlock` for EngineRunContext and clears the hold.
   *   - `{ dispatchable: false, reason, updatedEngine? }` — engine stays
   *     pending. `updatedEngine` carries a lastCheckedAt patch when the
   *     predicate actually invoked `check()` and observed `'pending'`.
   *   - `{ dispatchable: false, reason: 'gate-failed', message }` — the
   *     BlockType reported `'failed'`; the caller routes to the unified
   *     failure handler as a definitional failure.
   */
  type DispatchPredicateResult =
    | { dispatchable: true; priorBlock?: { type: string; condition: unknown; blockedAt: string; message?: string; lastCheckedAt?: string } }
    | { dispatchable: false; reason: 'not-pending' | 'upstream-incomplete' | 'hold-window' | 'hold-gate-pending'; updatedEngine?: EngineInstance }
    | { dispatchable: false; reason: 'hold-gate-failed'; message: string };

  async function evaluateDispatchPredicate(
    rig: RigDoc,
    engine: EngineInstance,
  ): Promise<DispatchPredicateResult> {
    // 1. Must be pending.
    if (engine.status !== 'pending') {
      return { dispatchable: false, reason: 'not-pending' };
    }

    // 2. Upstream must be terminal-success.
    const upstreamReady = engine.upstream.every((upId) => {
      const dep = rig.engines.find((e) => e.id === upId);
      return dep !== undefined && TERMINAL_SUCCESS_ENGINE_STATUSES.has(dep.status);
    });
    if (!upstreamReady) {
      return { dispatchable: false, reason: 'upstream-incomplete' };
    }

    // 3. holdUntil gate — if set and in the future, defer.
    if (engine.holdUntil) {
      const untilMs = new Date(engine.holdUntil).getTime();
      if (untilMs > Date.now()) {
        return { dispatchable: false, reason: 'hold-window' };
      }
    }

    // 4. External-gate check via BlockType, if holdReason is set.
    if (engine.holdReason) {
      const blockType = blockTypeRegistry.get(engine.holdReason);
      // Internal hold reasons (e.g. 'retry-backoff') are not registered
      // in the BlockType registry — they are purely timer-driven and
      // clear once `holdUntil` elapses. Pass-through if the reason has
      // no registered block type.
      if (blockType) {
        // Honour pollIntervalMs against the engine's lastCheckedAt stamp.
        // If the interval hasn't elapsed, return pending without
        // re-invoking check() — avoids per-tick hammering.
        if (blockType.pollIntervalMs !== undefined && engine.lastCheckedAt) {
          const elapsed = Date.now() - new Date(engine.lastCheckedAt).getTime();
          if (elapsed < blockType.pollIntervalMs) {
            return { dispatchable: false, reason: 'hold-gate-pending' };
          }
        }

        let result: CheckResult;
        try {
          result = await blockType.check(engine.holdCondition);
        } catch (err) {
          console.warn(
            `Block checker "${engine.holdReason}" threw for engine "${engine.id}" in rig "${rig.id}":`,
            err,
          );
          // Throwing check() → keep held. Update lastCheckedAt so the
          // poll-interval throttle still applies.
          const now = new Date().toISOString();
          return {
            dispatchable: false,
            reason: 'hold-gate-pending',
            updatedEngine: { ...engine, lastCheckedAt: now },
          };
        }

        if (result.status === 'failed') {
          const message = result.reason
            ? `Block "${engine.holdReason}" failed: ${result.reason}`
            : `Block "${engine.holdReason}" failed permanently`;
          return { dispatchable: false, reason: 'hold-gate-failed', message };
        }

        if (result.status !== 'cleared') {
          const now = new Date().toISOString();
          return {
            dispatchable: false,
            reason: 'hold-gate-pending',
            updatedEngine: { ...engine, lastCheckedAt: now },
          };
        }
      }

      // Cleared — surface the hold snapshot to tryRun via priorBlock.
      const priorBlock = {
        type: engine.holdReason,
        condition: engine.holdCondition,
        blockedAt: engine.holdUntil ?? (engine.lastCheckedAt ?? new Date().toISOString()),
        lastCheckedAt: engine.lastCheckedAt,
      };
      return { dispatchable: true, priorBlock };
    }

    return { dispatchable: true };
  }

  /**
   * Phase 2/3 — check holds + run.
   *
   * Walks every running rig's pending engines and routes each through
   * the dispatch predicate. When the predicate returns dispatchable,
   * executes the engine design's run(). When it returns a hold update,
   * writes the lastCheckedAt stamp. When it returns a gate failure,
   * routes to the unified failure handler.
   *
   * Throttling (global + per-rig concurrency) is applied OUTSIDE the
   * predicate — the predicate answers "is this engine ready?", not
   * "may we dispatch another engine this tick?".
   */
  async function tryRun(): Promise<CrawlResult | null> {
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });

    // Throttle: compute system-wide running engine count
    const maxGlobal = spiderConfig.maxConcurrentEngines ?? 3;
    const maxPerRig = spiderConfig.maxConcurrentEnginesPerRig ?? 1;
    let systemRunning = countRunningEngines(runningRigs);

    for (const rig of runningRigs) {
      // Find the first pending engine that passes the dispatch predicate.
      // Note we may walk past engines returning hold-gate-pending — those
      // don't block the next candidate, they just don't dispatch.
      let runnable: { engine: EngineInstance; priorBlock?: { type: string; condition: unknown; blockedAt: string; message?: string; lastCheckedAt?: string } } | null = null;
      let workingEngines = rig.engines;

      for (const engine of rig.engines) {
        if (engine.status !== 'pending') continue;

        // Throttle: compute once outside this loop so all candidates are
        // evaluated uniformly against the current concurrency limits.
        const result = await evaluateDispatchPredicate(
          { ...rig, engines: workingEngines },
          workingEngines.find((e) => e.id === engine.id) ?? engine,
        );

        if (result.dispatchable) {
          runnable = { engine: workingEngines.find((e) => e.id === engine.id) ?? engine, priorBlock: result.priorBlock };
          break;
        }

        if (result.reason === 'hold-gate-failed') {
          const outcome = await handleEngineFailure(
            { ...rig, engines: workingEngines },
            engine.id,
            result.message,
            {
              retryable: false,
              detail: result.message,
            },
          );
          if (outcome.kind === 'retryable-within-budget') {
            return { action: 'engine-retrying', rigId: rig.id, engineId: engine.id, attemptCount: outcome.attemptCount };
          }
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        if (result.reason === 'hold-gate-pending' && result.updatedEngine) {
          // Record lastCheckedAt patch in our working copy; flush once
          // per tick at most if no dispatch occurs.
          workingEngines = workingEngines.map((e) => (e.id === engine.id ? result.updatedEngine! : e));
        }
      }

      // If the predicate surfaced hold-gate-pending + a lastCheckedAt
      // update but no engine is dispatchable, flush the updated engines
      // so the poll-interval throttle actually advances.
      if (!runnable && workingEngines !== rig.engines) {
        await patchRigWithRollup(rig, workingEngines);
      }

      if (!runnable) continue;

      // Throttle: check system-wide and per-rig limits.
      if (systemRunning >= maxGlobal || countRunningEnginesInRig({ ...rig, engines: workingEngines }) >= maxPerRig) {
        continue;
      }

      const pending = runnable.engine;
      const priorBlock = runnable.priorBlock;
      const now = new Date().toISOString();
      const upstream = buildUpstreamMap({ ...rig, engines: workingEngines });

      // Evaluate `when` condition before running the engine
      if (pending.when !== undefined) {
        const shouldRun = evaluateWhen(pending.when, upstream);
        if (!shouldRun) {
          const mutableEngines = workingEngines.map((e) =>
            e.id === pending.id
              ? { ...e, status: 'skipped' as const, holdUntil: undefined, holdReason: undefined, holdCondition: undefined, lastCheckedAt: undefined }
              : { ...e },
          );
          const cascaded = cascadeSkip(mutableEngines, upstream);
          const newStatus = await patchRigWithRollup(rig, mutableEngines);
          if (newStatus === 'completed') {
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
          }
          if (newStatus === 'failed') {
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
          }
          return {
            action: 'engine-skipped',
            rigId: rig.id,
            engineId: pending.id,
            ...(cascaded.length > 0 ? { cascadeSkipped: cascaded } : {}),
          };
        }
      }

      const design = fabricator.getEngineDesign(pending.designId);
      if (!design) {
        const outcome = await handleEngineFailure({ ...rig, engines: workingEngines }, pending.id, `No engine design found for "${pending.designId}"`, {
          retryable: false,
          detail: `Engine "${pending.id}" references unknown design "${pending.designId}"`,
        });
        if (outcome.kind === 'retryable-within-budget') {
          return { action: 'engine-retrying', rigId: rig.id, engineId: pending.id, attemptCount: outcome.attemptCount };
        }
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }

      const givens = resolveYieldRefs(pending.givensSpec, upstream);

      const context = {
        rigId: rig.id,
        engineId: pending.id,
        upstream,
        ...(priorBlock ? { priorBlock } : {}),
      };

      // Dispatch: transition to running and append-on-start a new
      // attempts[] row carrying the startedAt timestamp. Clear hold
      // metadata (the engine is leaving the hold window). We patch
      // this state before calling design.run() so the rig reflects the
      // running engine to any concurrent observer.
      const startedEngines = workingEngines.map((e) => {
        if (e.id !== pending.id) return e;
        const appended = appendAttemptStart(e, now);
        return {
          ...appended,
          status: 'running' as const,
          holdUntil: undefined,
          holdReason: undefined,
          holdCondition: undefined,
          lastCheckedAt: undefined,
        };
      });
      await patchRigWithRollup(rig, startedEngines);
      systemRunning++;

      const updatedRig: RigDoc = { ...rig, engines: startedEngines };

      let engineResult: Awaited<ReturnType<EngineDesign['run']>>;
      try {
        engineResult = await design.run(givens, context);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const outcome = await handleEngineFailure(updatedRig, pending.id, errorMessage, {
          retryable: true,
          detail: `Engine "${pending.id}" run() threw: ${errorMessage}`,
        });
        if (outcome.kind === 'retryable-within-budget') {
          return { action: 'engine-retrying', rigId: rig.id, engineId: pending.id, attemptCount: outcome.attemptCount };
        }
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }

      if (engineResult.status === 'launched') {
        // Quick engine — patch the tail attempt with sessionId; leave engine running.
        const { sessionId } = engineResult;
        const launchedEngines = updatedRig.engines.map((e) => {
          if (e.id !== pending.id) return e;
          return patchTailAttempt(e, { sessionId });
        });
        await patchRigWithRollup(updatedRig, launchedEngines);
        return { action: 'engine-started', rigId: rig.id, engineId: pending.id };
      }

      if (engineResult.status === 'blocked') {
        const { blockType: blockTypeId, condition, message } = engineResult;

        const blockType = blockTypeRegistry.get(blockTypeId);
        if (!blockType) {
          // Definitional — the engine asked to block on a type the
          // registry does not know. Retrying would fail the same lookup.
          const outcome = await handleEngineFailure(updatedRig, pending.id, `Unknown block type: "${blockTypeId}"`, {
            retryable: false,
            detail: `Engine "${pending.id}" requested unknown block type "${blockTypeId}"`,
          });
          if (outcome.kind === 'retryable-within-budget') {
            return { action: 'engine-retrying', rigId: rig.id, engineId: pending.id, attemptCount: outcome.attemptCount };
          }
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        try {
          blockType.conditionSchema.parse(condition);
        } catch (zodErr) {
          const zodMessage = zodErr instanceof Error ? zodErr.message : String(zodErr);
          const outcome = await handleEngineFailure(
            updatedRig,
            pending.id,
            `Block type "${blockTypeId}" rejected condition: ${zodMessage}`,
            {
              retryable: false,
              detail: `Engine "${pending.id}" produced invalid condition for block type "${blockTypeId}": ${zodMessage}`,
            },
          );
          if (outcome.kind === 'retryable-within-budget') {
            return { action: 'engine-retrying', rigId: rig.id, engineId: pending.id, attemptCount: outcome.attemptCount };
          }
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        // Transition the engine into the held-pending state. The
        // in-flight attempts[] row gets a close-out without error (the
        // attempt's run() succeeded by returning a blocked result —
        // it's the hold gate, not a failure of the attempt). On hold
        // clear, the dispatch predicate surfaces this as a priorBlock
        // and tryRun starts a fresh attempt row.
        const finalizeNow = new Date().toISOString();
        const blockedEngines = updatedRig.engines.map((e) => {
          if (e.id !== pending.id) return e;
          const finalized = finalizeAttempt(e, {
            endedAt: finalizeNow,
            status: 'completed',
          });
          return {
            ...finalized,
            status: 'pending' as const,
            holdReason: blockTypeId,
            holdCondition: condition,
            // Block types don't generally declare an inherent holdUntil;
            // the gate is consulted via check(). Leave holdUntil undefined.
            holdUntil: undefined,
            lastCheckedAt: undefined,
            ...(message !== undefined ? {} : {}),
          };
        });
        await patchRigWithRollup(updatedRig, blockedEngines);
        return { action: 'engine-held', rigId: rig.id, engineId: pending.id, holdReason: blockTypeId };
      }

      // Clockwork engine — validate and store yields
      const { yields } = engineResult;
      if (!isJsonSerializable(yields)) {
        const outcome = await handleEngineFailure(updatedRig, pending.id, 'Engine yields are not JSON-serializable', {
          retryable: false,
          detail: `Engine "${pending.id}" run() produced non-JSON-serializable yields`,
        });
        if (outcome.kind === 'retryable-within-budget') {
          return { action: 'engine-retrying', rigId: rig.id, engineId: pending.id, attemptCount: outcome.attemptCount };
        }
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }

      const engineResultRecord = engineResult as Record<string, unknown>;
      const runGraft = engineResultRecord.graft as RigTemplateEngine[] | undefined;
      const runGraftTail = engineResultRecord.graftTail as string | undefined;

      const completedAt = new Date().toISOString();
      const completedEngines = updatedRig.engines.map((e) => {
        if (e.id !== pending.id) return e;
        const finalized = finalizeAttempt(e, {
          endedAt: completedAt,
          status: 'completed',
          yields,
        });
        return { ...finalized, status: 'completed' as const };
      });

      if (runGraft !== undefined && runGraft.length > 0) {
        pendingGrafts.set(rig.id, { engineId: pending.id, graft: runGraft, writId: rig.writId, graftTail: runGraftTail });
        await patchRigWithRollup(updatedRig, completedEngines, {}, { pendingGraft: true });
        return { action: 'engine-completed', rigId: rig.id, engineId: pending.id };
      }

      const newStatus = await patchRigWithRollup(updatedRig, completedEngines);
      if (newStatus === 'completed') {
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
      }
      if (newStatus === 'failed') {
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }
      return { action: 'engine-completed', rigId: rig.id, engineId: pending.id };
    }
    return null;
  }

  /**
   * Phase 4 — spawn.
   *
   * Find the oldest open writ with no existing rig. Create a rig for it.
   */
  // ── spider.follows gate evaluation ──────────────────────────────────
  //
  // These are the terminal phase-categories the gate cares about. A blocker
  // in a terminal-success state (completed or cancelled) releases its edge;
  // a blocker that has `failed` cascades the dependent into stuck; any
  // non-terminal phase (new/open/stuck) holds the gate.
  const TERMINAL_SUCCESS_PHASES = new Set(['completed', 'cancelled']);

  /**
   * Gate evaluation result for a single candidate writ. The walk inspects
   * the candidate's outbound `spider.follows` links and transitively
   * follows further outbound links on those targets only to the extent
   * needed for cycle detection. Phase-category decisions (ready / gated /
   * failed-blocker) are scoped to the candidate's *direct* outbound
   * edges per D14 (stick only the direct dependent; transitive cascade
   * happens across polls).
   */
  type GateOutcome =
    | { kind: 'ready' }
    | { kind: 'gated'; blockerIds: string[] }
    | { kind: 'failed-blocker'; blockerIds: string[] }
    | { kind: 'cycle'; members: string[] };

  /** Fetch outbound `spider.follows` target ids for a given writ id. */
  async function getSpiderFollowsTargets(writId: string): Promise<string[]> {
    const { outbound } = await clerk.links(writId);
    return outbound
      .filter((l) => l.kind === 'spider.follows')
      .map((l) => l.targetId);
  }

  /**
   * Walk the candidate's outbound `spider.follows` edges.
   *
   * Decisions about the candidate's gate state come from the **direct**
   * outbound edges only (per D14). Cycle detection, however, runs an
   * iterative DFS over the full transitive closure so back-edges that
   * only reveal themselves two or more hops out still fire.
   *
   * Per D3: `visiting` (in-stack) distinguishes back-edges from forward
   * re-visits. `visited` (fully explored) keeps diamonds from being
   * mistaken for cycles — a node reachable through two paths but never
   * appearing on the current DFS stack is a diamond, not a cycle.
   */
  async function evaluateGate(candidateId: string): Promise<GateOutcome> {
    const directTargets = await getSpiderFollowsTargets(candidateId);

    // Fast path: no outbound spider.follows at all → nothing to gate on.
    if (directTargets.length === 0) return { kind: 'ready' };

    // First: run a DFS for cycle detection over the transitive closure.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    // Parent tracker: at the time we add `child` to visiting, we record
    // parent[child] = current node. We use it to reconstruct the cycle
    // path when a back-edge fires.
    const parent = new Map<string, string | null>();

    // Work item: either "enter" a node or "leave" it.
    type Frame = { kind: 'enter' | 'leave'; id: string; parent: string | null };
    const stack: Frame[] = [{ kind: 'enter', id: candidateId, parent: null }];

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'leave') {
        visiting.delete(frame.id);
        visited.add(frame.id);
        continue;
      }

      // enter
      if (visited.has(frame.id)) continue; // diamond — not a cycle
      if (visiting.has(frame.id)) {
        // Back-edge: frame.id is already on the current DFS stack. Walk
        // up via `parent` from the discovering node (frame.parent) until
        // we hit frame.id, then include frame.id itself. These are the
        // cycle members.
        const members: string[] = [];
        let cursor: string | null = frame.parent;
        while (cursor !== null && cursor !== frame.id) {
          members.push(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        members.push(frame.id);
        return { kind: 'cycle', members };
      }

      visiting.add(frame.id);
      parent.set(frame.id, frame.parent);

      // Schedule leave *before* enqueuing children so they run first (LIFO).
      stack.push({ kind: 'leave', id: frame.id, parent: frame.parent });

      const outboundTargets = await getSpiderFollowsTargets(frame.id);
      for (const t of outboundTargets) {
        stack.push({ kind: 'enter', id: t, parent: frame.id });
      }
    }

    // No cycle — classify the direct blockers by target phase.
    const failedBlockers: string[] = [];
    const nonTerminalBlockers: string[] = [];
    for (const targetId of directTargets) {
      const target = await writsBook.get(targetId);
      if (!target) {
        // Dangling reference — treat as non-terminal hold. The link was
        // created against a live target, so a missing target is an
        // operator/data-integrity condition better surfaced as "still
        // gated" than as "ready".
        nonTerminalBlockers.push(targetId);
        continue;
      }
      const phase = target.phase;
      if (phase === 'failed') {
        failedBlockers.push(targetId);
      } else if (TERMINAL_SUCCESS_PHASES.has(phase)) {
        // Released — no-op.
      } else {
        nonTerminalBlockers.push(targetId);
      }
    }

    if (failedBlockers.length > 0) {
      return { kind: 'failed-blocker', blockerIds: failedBlockers };
    }
    if (nonTerminalBlockers.length > 0) {
      return { kind: 'gated', blockerIds: nonTerminalBlockers };
    }
    return { kind: 'ready' };
  }

  /**
   * Stick a writ because its gate evaluation produced a stuck condition.
   * Writes both the phase transition (via Clerk) and the provenance slot
   * (via setWritStatus) — the load-bearing `status.spider.stuckCause` is
   * the signal `autoUnstick` uses to re-evaluate later.
   */
  async function stuckFromGate(
    writId: string,
    cause: SpiderStuckCause,
    blockerIds: string[],
    resolution: string,
  ): Promise<void> {
    await clerk.transition(writId, 'stuck', { resolution });
    const status: SpiderWritStatus = {
      stuckCause: cause,
      blockerIds,
      observedAt: new Date().toISOString(),
    };
    await clerk.setWritStatus(writId, 'spider', status);
  }

  /**
   * Phase: autoUnstick.
   *
   * Re-evaluate every writ Spider previously stuck through the gating
   * path. Writs without `status.spider?.stuckCause` are skipped entirely
   * — that signals an operator-stuck writ Spider never touched.
   *
   * Only dependency-recovery causes (`failed-blocker`, `cycle`) participate
   * here. The engine-cascade cause (`engine-failure`) is written by
   * `failEngine` for observability and retry-clockwork consumption — it is
   * a different recovery axis (attempt-shaped, not graph-shaped), so this
   * loop skips it and leaves those writs stuck until retry clockwork
   * (a separate commission) acts on them.
   *
   * Release conditions (D15):
   *   - `failed-blocker`: every recorded blocker id is now in a
   *     terminal-success phase. (If any are still failed or
   *     non-terminal, keep the writ stuck.)
   *   - `cycle`: any recorded cycle member has moved out of the cycle
   *     (non-open phase, or no longer has the originally-observed
   *     outbound `spider.follows` edge — the simplest proxy is that at
   *     least one member is no longer in `open`). The next poll's
   *     trySpawn pass will re-evaluate the gate; if the cycle remains,
   *     it re-sticks.
   *
   * Returns the first successful unstick as a CrawlResult so callers
   * can observe progress; returns null when nothing was unsticked.
   */
  async function autoUnstick(): Promise<CrawlResult | null> {
    const stuckWrits = await writsBook.find({
      where: [['phase', '=', 'stuck']],
    });

    for (const writ of stuckWrits) {
      const spiderStatus = writ.status?.spider as SpiderWritStatus | undefined;
      const cause = spiderStatus?.stuckCause;
      if (!cause) continue; // operator-stuck — not ours

      // Only the dependency-recovery causes participate here. `engine-failure`
      // is left for the retry clockwork to act on (or not).
      if (cause !== 'failed-blocker' && cause !== 'cycle') continue;

      const blockerIds = spiderStatus?.blockerIds ?? [];

      if (cause === 'failed-blocker') {
        // Every blocker must now be in a terminal-success state.
        let allResolved = true;
        for (const blockerId of blockerIds) {
          const blocker = await writsBook.get(blockerId);
          if (!blocker) {
            // Blocker disappeared — treat as resolved (no longer a gate).
            continue;
          }
          if (!TERMINAL_SUCCESS_PHASES.has(blocker.phase)) {
            allResolved = false;
            break;
          }
        }
        if (!allResolved) continue;
      } else if (cause === 'cycle') {
        // Release if any cycle member has moved out of `open` — the
        // cycle can only persist while every member is still open.
        let brokenByAnyMember = false;
        for (const memberId of blockerIds) {
          const member = await writsBook.get(memberId);
          if (!member) {
            brokenByAnyMember = true;
            break;
          }
          if (member.id === writ.id) continue; // self is currently stuck
          if (member.phase !== 'open' && member.phase !== 'stuck') {
            brokenByAnyMember = true;
            break;
          }
        }
        if (!brokenByAnyMember) continue;
      }

      // Release: stuck → open. Clear the spider sub-slot (so future
      // `autoUnstick` passes don't revisit this writ).
      await clerk.transition(writ.id, 'open');
      await clerk.setWritStatus(writ.id, 'spider', {});
      return { action: 'writ-unstuck', writId: writ.id };
    }

    return null;
  }

  async function trySpawn(): Promise<CrawlResult | null> {
    // Throttle: do not spawn new rigs if system-wide engine limit is reached.
    // Spawned rigs would just sit with their first engine in pending, cluttering the rig list.
    const maxGlobal = spiderConfig.maxConcurrentEngines ?? 3;
    const allRunningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
    if (countRunningEngines(allRunningRigs) >= maxGlobal) return null;

    // Only consider writ types that have a rig template mapping. Rig dispatch
    // is opt-in per writ type; filtering at the query level (rather than
    // inside the loop) prevents head-of-line blocking when non-dispatchable
    // writ types accumulate in `open` older than dispatchable ones
    // and fill the page of 10.
    const dispatchableTypes = Object.keys(rigTemplateRegistry.listTemplateMappings());
    if (dispatchableTypes.length === 0) return null;

    // Find open writs of dispatchable types, ordered by creation time (oldest first)
    const openWrits = await writsBook.find({
      where: [
        ['phase', '=', 'open'],
        ['type', 'IN', dispatchableTypes],
      ],
      orderBy: ['createdAt', 'asc'],
      limit: 10,
    });

    for (const writ of openWrits) {
      // Check for an active rig. With engine-level retry the rig
      // reshapes don't accumulate across retries — the same rig retries
      // in place — but legacy rigs in 'stuck'/'blocked' may still exist
      // alongside terminal rigs. The invariant is "no two rigs for the
      // same writ are active at the same time" — 'running' is the only
      // non-terminal status the new model writes. Legacy 'blocked' and
      // 'stuck' strings are tolerated here so operators don't see
      // phantom duplicate rigs when legacy docs linger.
      //
      // Active statuses (new model): 'running'. Legacy docs may still
      // carry 'blocked' — treat those as active for dispatch purposes
      // too so the writ doesn't double-spawn around them.
      const activeForWrit = await rigsBook.count([
        ['writId', '=', writ.id],
        ['status', 'IN', ['running', 'blocked']],
      ]);
      if (activeForWrit > 0) continue;

      // Gate on outbound spider.follows links before dispatch. Evaluation
      // produces one of four outcomes — see `evaluateGate`. The walk also
      // runs cycle detection; back-edges surface as a `cycle` outcome.
      const gate = await evaluateGate(writ.id);

      if (gate.kind === 'gated') {
        // Non-terminal blockers — hold dispatch. Nothing is written to
        // status (D1: the gate-but-not-stuck state is not persisted).
        // Continue to the next candidate so a later, unblocked writ can
        // still dispatch this tick.
        continue;
      }

      if (gate.kind === 'failed-blocker') {
        const shortIds = gate.blockerIds.map(shortId);
        const resolution = gate.blockerIds.length === 1
          ? `Blocked by failed dependency: ${shortIds[0]}`
          : `Blocked by failed dependencies: ${shortIds.join(', ')}`;
        await stuckFromGate(writ.id, 'failed-blocker', gate.blockerIds, resolution);
        // Writ is now `stuck` and out of the open-writs query on future
        // ticks; continue scanning the current candidate page so a later,
        // unblocked writ can still dispatch this tick.
        continue;
      }

      if (gate.kind === 'cycle') {
        // Stick every member of the cycle with stuckCause='cycle'. Only
        // members still in `open` are transitioned — a member already
        // in another phase (e.g. stuck from a prior detection) just gets
        // its provenance slot rewritten with the fresh observedAt.
        for (const memberId of gate.members) {
          const member = await writsBook.get(memberId);
          if (!member) continue;
          if (member.phase === 'open') {
            await stuckFromGate(
              memberId,
              'cycle',
              gate.members,
              'Cycle detected in spider.follows graph',
            );
          }
        }
        // Cycle members are now `stuck`; continue scanning other
        // candidates so a later, unblocked writ can still dispatch.
        continue;
      }

      // gate.kind === 'ready' — fall through to dispatch.

      // The query-level type filter above guarantees this lookup succeeds.
      // A null here would mean the registry's mappings diverged from what
      // listTemplateMappings() returned mid-crawl — an invariant violation.
      const template = rigTemplateRegistry.lookup(writ.type);
      if (!template) {
        throw new Error(
          `[spider] trySpawn: writ type "${writ.type}" passed the dispatchable-types filter but has no rig template mapping. ` +
          `This is an invariant violation in rigTemplateRegistry.`,
        );
      }

      const rigId = generateId('rig', 4);
      const { engines, resolutionEngineId } = buildFromTemplate(template, {
        writ,
        spiderConfig,
      });

      const rig: RigDoc = {
        id: rigId,
        writId: writ.id,
        status: 'running',
        engines,
        createdAt: new Date().toISOString(),
        ...(resolutionEngineId !== undefined ? { resolutionEngineId } : {}),
      };

      await rigsBook.put(rig);

      return { action: 'rig-spawned', rigId, writId: writ.id };
    }

    return null;
  }

  // ── SpiderApi ─────────────────────────────────────────────────────

  /**
   * Pause-gate predicate (D14 / D24).
   *
   * Returns true when the Animator is currently paused AND the persisted
   * `pausedUntil` window has not yet elapsed — the combined check that
   * governs dispatchability across the system. The crawl loop uses
   * this to short-circuit `tryRun` and `trySpawn` while keeping the
   * collect / graft / checkBlocked / autoUnstick phases running
   * (the first so we still ingest the triggering rate-limit signals;
   * the third so the block-type checker can clear engines).
   */
  async function isAnimatorPaused(): Promise<boolean> {
    try {
      const status = await animator.getStatus();
      if (status.state !== 'paused') return false;
      if (!status.pausedUntil) return false;
      return new Date(status.pausedUntil).getTime() > Date.now();
    } catch {
      // Animator unavailable → treat as not-paused. Dispatch can then
      // surface its own errors on the normal path.
      return false;
    }
  }

  const api: SpiderApi = {
    async crawl(): Promise<CrawlResult | null> {
      const collected = await tryCollect();
      if (collected) return collected;

      const grafted = await tryProcessGrafts();
      if (grafted) return grafted;

      const ran = await tryRun();
      if (ran) return ran;

      // Before trySpawn: re-evaluate writs Spider previously stuck via the
      // gating path. `autoUnstick` skips writs without
      // `status.spider?.stuckCause` so operator-stuck writs are untouched.
      const unstuck = await autoUnstick();
      if (unstuck) return unstuck;

      // Pause gate (D22). Keep `isAnimatorPaused` guarding `trySpawn`
      // only — `tryRun` is handled uniformly by the dispatch predicate
      // per-engine. Spawning new rigs while the Animator is paused
      // would just clutter the rig list with pending engines, so the
      // top-level gate is preserved here.
      const paused = await isAnimatorPaused();
      if (paused) {
        return null;
      }

      const spawned = await trySpawn();
      if (spawned) return spawned;

      return null;
    },

    async show(id: string): Promise<RigDoc> {
      const results = await rigsBook.find({ where: [['id', '=', id]], limit: 1 });
      if (results.length === 0) {
        throw new Error(`Rig "${id}" not found.`);
      }
      return results[0];
    },

    async list(filters?: RigFilters): Promise<RigDoc[]> {
      const where: WhereClause = [];
      if (filters?.status !== undefined) {
        where.push(['status', '=', filters.status]);
      }
      const limit = filters?.limit ?? 20;
      return rigsBook.find({
        where,
        orderBy: ['createdAt', 'desc'],
        limit,
        ...(filters?.offset !== undefined ? { offset: filters.offset } : {}),
      });
    },

    async forWrit(writId: string): Promise<RigDoc | null> {
      const results = await rigsBook.find({
        where: [['writId', '=', writId]],
        orderBy: ['createdAt', 'desc'],
        limit: 1,
      });
      return results[0] ?? null;
    },

    /**
     * Clear a hold on a specific pending engine, forcing the dispatch
     * predicate to re-evaluate it on the next crawl tick. Throws when
     * the engine is not pending or has no hold set.
     */
    async resume(rigId: string, engineId: string): Promise<void> {
      const rig = await api.show(rigId);
      const engine = rig.engines.find((e) => e.id === engineId);
      if (!engine) {
        throw new Error(`Engine "${engineId}" not found in rig "${rigId}".`);
      }
      if (engine.status !== 'pending') {
        throw new Error(
          `Engine "${engineId}" in rig "${rigId}" is not pending (status: ${engine.status}).`,
        );
      }
      if (!engine.holdUntil && !engine.holdReason) {
        throw new Error(
          `Engine "${engineId}" in rig "${rigId}" has no hold to resume.`,
        );
      }

      // Surface the cleared hold snapshot as a priorBlock so the next
      // dispatch's EngineRunContext carries the same advisory payload
      // the old block-record path used to carry.
      if (engine.holdReason) {
        pendingPriorBlocks.set(`${rigId}:${engineId}`, {
          type: engine.holdReason,
          condition: engine.holdCondition,
          blockedAt: engine.holdUntil ?? (engine.lastCheckedAt ?? new Date().toISOString()),
          lastCheckedAt: engine.lastCheckedAt,
        });
      }

      const updatedEngines = rig.engines.map((e) =>
        e.id === engineId
          ? {
              ...e,
              holdUntil: undefined,
              holdReason: undefined,
              holdCondition: undefined,
              lastCheckedAt: undefined,
            }
          : e,
      );

      await patchRigWithRollup(rig, updatedEngines);
    },

    async cancel(rigId: string, options?: { reason?: string }): Promise<RigDoc> {
      const rig = await api.show(rigId);

      // Idempotent for terminal rigs.
      if (
        rig.status === 'completed' ||
        rig.status === 'failed' ||
        rig.status === 'cancelled'
      ) {
        return rig;
      }

      // Legacy tolerance: rigs persisted with 'stuck' / 'blocked' predate
      // this commission but can still be cancelled by an operator. Treat
      // them as having no active session to cancel — any legacy 'blocked'
      // engine rows get flipped to 'cancelled' so the rollup can reach
      // terminal cleanly, then the rollup wrapper (which honours
      // cancelledAt) writes the rig-level 'cancelled' status. We pass
      // the rig through with a writable projection of 'running' so the
      // wrapper's change detection accepts the transition.
      const legacyDead =
        (rig.status as string) === 'stuck' || (rig.status as string) === 'blocked';
      const now = new Date().toISOString();

      if (legacyDead) {
        const sanitizedEngines = rig.engines.map((e) => {
          if ((e.status as string) === 'blocked') {
            return {
              ...e,
              status: 'cancelled' as const,
              holdUntil: undefined,
              holdReason: undefined,
              holdCondition: undefined,
              lastCheckedAt: undefined,
            };
          }
          return e;
        });
        await patchRigWithRollup(
          { ...rig, status: 'running' as RigStatus }, // feed the rollup a writable projection
          sanitizedEngines,
          { cancelledAt: rig.cancelledAt ?? now },
        );
        await rejectPendingInputRequests(rig.id);
        return api.show(rigId);
      }

      // Find the active engine to cancel.
      let targetEngineId: string | undefined;

      // 1. Running engine with an in-flight sessionId — cancel the session first.
      const runningWithSession = rig.engines.find((e) => {
        if (e.status !== 'running') return false;
        const tail = latestAttempt(e);
        return !!tail?.sessionId;
      });
      if (runningWithSession) {
        targetEngineId = runningWithSession.id;
        const sessionId = latestAttempt(runningWithSession)?.sessionId;
        if (sessionId) {
          try {
            await animator.cancel(sessionId, { reason: options?.reason });
          } catch (err) {
            console.error('[spider] Failed to cancel animator session:', err);
          }
        }
      }

      // 2. Running engine without sessionId
      if (!targetEngineId) {
        const runningNoSession = rig.engines.find((e) => e.status === 'running');
        if (runningNoSession) targetEngineId = runningNoSession.id;
      }

      // 3. Pending engine (including held)
      if (!targetEngineId) {
        const pendingEngine = rig.engines.find((e) => e.status === 'pending');
        if (pendingEngine) targetEngineId = pendingEngine.id;
      }

      if (targetEngineId) {
        await cancelEngine(rig, targetEngineId, options?.reason);
      } else {
        // No active engines — mark rig cancelled via the rollup.
        await patchRigWithRollup(rig, rig.engines, { cancelledAt: rig.cancelledAt ?? now });
      }

      await rejectPendingInputRequests(rig.id);

      return api.show(rigId);
    },

    getBlockType(id: string): BlockType | undefined {
      return blockTypeRegistry.get(id);
    },

    listBlockTypes(): BlockTypeInfo[] {
      return blockTypeRegistry.list();
    },

    listTemplates(): RigTemplateInfo[] {
      return rigTemplateRegistry.listTemplates();
    },

    listTemplateMappings(): Record<string, string> {
      return rigTemplateRegistry.listTemplateMappings();
    },
  };

  // ── Apparatus ─────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks', 'clerk', 'fabricator'],
      // 'loom' is recommended (not required) so Spider still boots in guilds
      // that do not install the Loom. When Loom is absent the mender role
      // registration is simply inert — the manual-merge engine will fail at
      // summon time if a rig ever tries to invoke it without Loom, which is
      // the same failure mode as every other role-based quick engine.
      recommends: ['oculus', 'loom'],
      consumes: ['blockTypes', 'rigTemplates', 'rigTemplateMappings'],

      supportKit: {
        books: {
          rigs: {
            indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
          },
          'input-requests': {
            indexes: ['status', 'rigId', 'engineId', 'createdAt', ['rigId', 'engineId', 'status']],
          },
        },
        linkKinds: [
          {
            id: 'spider.follows',
            description:
              'The source writ is a precedence-successor of the target: source cannot be dispatched until the target reaches a terminal state. Consumers define their own policy for what happens on each terminal state.',
          },
        ],
        engines: {
          'anima-session': animaSessionEngine,
          draft:     draftEngine,
          implement: implementEngine,
          'implement-loop': implementLoopEngine,
          'manual-merge': manualMergeEngine,
          'piece-session': pieceSessionEngine,
          review:    reviewEngine,
          revise:    reviseEngine,
          seal:      sealEngine,
        },
        roles: {
          // Mender — the anima the seal engine's recovery tail summons to
          // reconcile rebase conflicts in a draft worktree. Push is
          // explicitly NOT granted; the retry seal engine handles the push
          // itself. See packages/plugins/spider/loom-roles/mender.md.
          'mender': {
            permissions: [],
            strict: false,
            instructionsFile: 'loom-roles/mender.md',
          },
        } satisfies Record<string, KitRoleDefinition>,
        blockTypes: {
          'writ-phase':     writPhaseBlockType,
          'scheduled-time': scheduledTimeBlockType,
          'book-updated':   bookUpdatedBlockType,
          'patron-input':   patronInputBlockType,
          'animator-paused': animatorPausedBlockType,
        },
        rigTemplates: {
          default: defaultRigTemplate,
        },
        pages: [
          { id: 'spider', title: 'Spider', dir: 'src/static' },
          { id: 'feedback', title: 'Feedback', dir: 'src/static/feedback' },
        ],
        routes: spiderRoutes,
        tools: [
          crawlOneTool,
          crawlContinualTool,
          rigShowTool,
          rigListTool,
          rigForWritTool,
          rigResumeTool,
          inputRequestListTool,
          inputRequestShowTool,
          inputRequestAnswerTool,
          inputRequestCompleteTool,
          inputRequestRejectTool,
          inputRequestExportTool,
          inputRequestImportTool,
          engineDesignsTool,
          blockTypesTool,
          rigCancelTool,
        ],
      },

      provides: api,

      start(ctx: StartupContext): void {
        const g = guild();
        spiderConfig = g.guildConfig().spider ?? {};

        stacks = g.apparatus<StacksApi>('stacks');
        clerk = g.apparatus<ClerkApi>('clerk');
        fabricator = g.apparatus<FabricatorApi>('fabricator');
        animator = g.apparatus<AnimatorApi>('animator');

        // 1. Build designId → pluginId map from all engine contributions
        rigTemplateRegistry.buildDesignSourceMap(ctx.kits('engines'));

        // 2. Validate and register config templates
        if (spiderConfig.rigTemplates) {
          validateTemplates(spiderConfig.rigTemplates, fabricator);
          rigTemplateRegistry.registerConfigTemplates(spiderConfig.rigTemplates);
        }

        // 3. Register config mappings
        if (spiderConfig.rigTemplateMappings) {
          rigTemplateRegistry.registerConfigMappings(spiderConfig.rigTemplateMappings);
        }

        // 4. Register all block types via Wire-phase snapshot
        for (const entry of ctx.kits('blockTypes')) {
          blockTypeRegistry.registerFromEntry(entry);
        }

        // 5. Register all kit-contributed rig templates via Wire-phase snapshot
        for (const entry of ctx.kits('rigTemplates')) {
          rigTemplateRegistry.registerFromEntry(entry);
        }

        // 6. Register all kit-contributed rig template mappings
        for (const entry of ctx.kits('rigTemplateMappings')) {
          rigTemplateRegistry.registerFromEntry(entry);
        }

        // 7. Validate all mappings (single pass — no late arrivals)
        rigTemplateRegistry.validateDeferredMappings();

        rigsBook = stacks.book<RigDoc>('spider', 'rigs');
        inputRequestsBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
        sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
        writsBook = stacks.readBook<WritDoc>('clerk', 'writs');

        // CDC — Phase 1 cascade on writs book.
        // When a writ is cancelled, cancel the associated rig.
        // Silent no-op when no rig exists or the rig is already terminal/stuck.
        // Only cancelled triggers cascade — completed/failed writs leave the rig alone.
        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          async (event) => {
            if (event.type !== 'update') return;

            const writ = event.entry;
            const prev = event.prev;

            // Only act when phase changes to cancelled
            if (writ.phase === prev.phase) return;
            if (writ.phase !== 'cancelled') return;

            const rig = await api.forWrit(writ.id);
            if (!rig) return; // No rig for this writ — silent no-op

            // Already terminal — silent no-op (avoids redundant cancel cycle).
            // Legacy rigs persisted with 'stuck' or 'blocked' are NOT
            // treated as terminal here — they are non-terminal in the
            // legacy shape and must cascade to cancel so operators who
            // cancel a writ whose rig predates this commission still see
            // the rig cleaned up. `api.cancel` contains the legacy-tolerant
            // path that handles these statuses.
            if (rig.status === 'completed' || rig.status === 'failed' || rig.status === 'cancelled') return;

            await api.cancel(rig.id, { reason: `Writ ${writ.id} cancelled` });
          },
          { failOnError: true },
        );

        // CDC — Phase 1 cascade on rigs book.
        // When a rig reaches a terminal state, transition the associated writ.
        // The engine-failure path now routes through `rig.status='failed'`
        // directly (no intermediate stuck), so the writ transitions
        // straight to `phase='failed'`.
        stacks.watch<RigDoc>(
          'spider',
          'rigs',
          async (event) => {
            if (event.type !== 'update') return;

            const rig = event.entry;
            const prev = event.prev;

            if (rig.status === prev.status) return;

            const writ = await writsBook.get(rig.writId);
            const writAlreadyTerminal = writ && (
              writ.phase === 'completed' || writ.phase === 'failed' || writ.phase === 'cancelled'
            );

            if (rig.status === 'completed') {
              let resolutionYields: unknown;

              // 1. Try the declared resolution engine
              if (rig.resolutionEngineId) {
                const declared = rig.engines.find((e) => e.id === rig.resolutionEngineId);
                const tail = declared ? latestAttempt(declared) : undefined;
                if (tail?.yields !== undefined) {
                  resolutionYields = tail.yields;
                }
              }

              // 2. Fall back to seal engine (backwards compat)
              if (resolutionYields === undefined) {
                const seal = rig.engines.find((e) => e.id === 'seal');
                const tail = seal ? latestAttempt(seal) : undefined;
                if (tail?.yields !== undefined) {
                  resolutionYields = tail.yields;
                }
              }

              // 3. Fall back to last completed engine in array order
              if (resolutionYields === undefined) {
                const lastCompleted = [...rig.engines]
                  .reverse()
                  .find((e) => e.status === 'completed' && latestAttempt(e)?.yields !== undefined);
                if (lastCompleted) {
                  resolutionYields = latestAttempt(lastCompleted)?.yields;
                }
              }

              const resolution = resolutionYields !== undefined
                ? JSON.stringify(resolutionYields)
                : 'Rig completed';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'completed', { resolution });
              }
            } else if (rig.status === 'failed') {
              // Engine-failure terminal: writ goes directly to phase='failed'
              // (no intermediate stuck). Resolution mirrors the failed
              // engine's last attempt error. When no failed engine is
              // locatable (defensive — the rollup only writes 'failed' if
              // at least one engine is terminal-failed), we surface the
              // generic fallback rather than dereferencing a missing engine.
              const failedEngine = rig.engines.find((e) => e.status === 'failed');
              const tail = failedEngine ? latestAttempt(failedEngine) : undefined;
              const resolution = failedEngine
                ? `Engine "${failedEngine.id}" failed${tail?.error ? `: ${tail.error}` : ''}`
                : 'Engine failure';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'failed', { resolution });
              }
            } else if (rig.status === 'cancelled') {
              const cancelledEngine = rig.engines.find((e) => {
                if (e.status !== 'cancelled') return false;
                const tail = latestAttempt(e);
                return !!tail?.error;
              });
              const tail = cancelledEngine ? latestAttempt(cancelledEngine) : undefined;
              const resolution = tail?.error ?? 'Rig cancelled';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'cancelled', { resolution });
              }
            }
            // 'running' — no CDC action (rig is still working).
          },
          { failOnError: true },
        );

        // Note: spider does not reap zombie sessions. Liveness is owned by
        // the animator heartbeat reconciler, which marks stale sessions as
        // failed based on `lastActivityAt` silence. Spider picks up the
        // failed session via tryCollect on the next crawl and fails the
        // engine accordingly — a single-path, host-agnostic flow with no
        // local-PID coupling.
      },
    },
  };
}
