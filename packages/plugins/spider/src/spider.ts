/**
 * The Spider — rig execution engine apparatus.
 *
 * The Spider drives writ-to-completion by managing rigs: ordered pipelines
 * of engine instances. Each crawl() call performs one unit of work:
 *
 *   reapZombies > collect > processGrafts > checkBlocked > run > spawn   (priority order)
 *
 * reapZombies  — detect and fail engines whose underlying process has died
 * collect      — check running engines for terminal session results
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
import { guild, generateId } from '@shardworks/nexus-core';
import type { StacksApi, Book, ReadOnlyBook, WhereClause } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { SessionDoc, AnimatorApi } from '@shardworks/animator-apparatus';

import type {
  RigDoc,
  RigFilters,
  EngineInstance,
  SpiderApi,
  CrawlResult,
  SpiderConfig,
  BlockRecord,
  BlockType,
  BlockTypeInfo,
  CheckResult,
  RigTemplate,
  RigTemplateEngine,
  RigTemplateInfo,
  SpiderCollectResult,
  InputRequestDoc,
} from './types.ts';

import {
  animaSessionEngine,
  draftEngine,
  implementEngine,
  reviewEngine,
  reviseEngine,
  sealEngine,
} from './engines/index.ts';

import {
  writStatusBlockType,
  scheduledTimeBlockType,
  bookUpdatedBlockType,
  patronInputBlockType,
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
 * Build the upstream yields map for a rig: all completed engine yields
 * keyed by engine id. Passed as context.upstream to the engine's run().
 */
function buildUpstreamMap(rig: RigDoc): Record<string, unknown> {
  const upstream: Record<string, unknown> = {};
  for (const engine of rig.engines) {
    if (engine.status === 'completed' && engine.yields !== undefined) {
      upstream[engine.id] = engine.yields;
    }
  }
  return upstream;
}

/**
 * Find the first pending engine whose entire upstream is completed or skipped.
 * Returns null if no runnable engine exists.
 */
function findRunnableEngine(rig: RigDoc): EngineInstance | null {
  for (const engine of rig.engines) {
    if (engine.status !== 'pending') continue;
    const allUpstreamDone = engine.upstream.every((upstreamId) => {
      const dep = rig.engines.find((e) => e.id === upstreamId);
      return dep?.status === 'completed' || dep?.status === 'skipped';
    });
    if (allUpstreamDone) return engine;
  }
  return null;
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
 * Check if a process with the given PID is alive.
 * Uses process.kill(pid, 0) which sends signal 0 (no-op) to check existence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the process exists but we can't signal it — treat as alive.
    return true;
  }
}

/**
 * Determine whether a rig should enter the blocked state.
 *
 * A rig is blocked when:
 * - No engine is currently running
 * - No engine is runnable (pending with all upstream completed)
 * - At least one engine is blocked
 */
function isRigBlocked(engines: EngineInstance[]): boolean {
  const hasRunning = engines.some((e) => e.status === 'running');
  if (hasRunning) return false;
  const hasBlocked = engines.some((e) => e.status === 'blocked');
  if (!hasBlocked) return false;
  // Check runnability by constructing a minimal RigDoc-like object
  const syntheticRig = { engines } as RigDoc;
  return findRunnableEngine(syntheticRig) === null;
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
 * Check whether all engines in the list have reached a terminal state
 * (completed or skipped) and at least one is completed.
 */
function isRigComplete(engines: EngineInstance[]): boolean {
  const allTerminal = engines.every(
    (e) => e.status === 'completed' || e.status === 'skipped',
  );
  if (!allTerminal) return false;
  return engines.some((e) => e.status === 'completed');
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
      if (isBlockType(value)) {
        this.types.set(value.id, value);
        this.provenance.set(value.id, pluginId);
      }
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
  /** Kit-contributed mappings (first-registered wins) */
  readonly kitMappings = new Map<string, string>();
  /** Config-declared template names (for override checking) */
  private configTemplateNames = new Set<string>();
  /** designId → pluginId that contributed it */
  private designSourceMap = new Map<string, string>();

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

      // Config override: skip silently
      if (this.configMappings.has(writType)) continue;

      // Duplicate kit mapping: first-registered wins
      if (this.kitMappings.has(writType)) {
        console.warn(
          `[spider] Kit "${pluginId}" rigTemplateMappings.${writType}: mapping for "${writType}" already registered by another kit — skipped`
        );
        continue;
      }

      this.kitMappings.set(writType, templateName);
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

    // Kit mappings — warn and remove on dangling
    for (const [writType, templateName] of [...this.kitMappings]) {
      if (!this.templates.has(templateName)) {
        console.warn(
          `[spider] Kit mapping "${writType}" → "${templateName}": template not found — removed`
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
    for (const [writType, templateName] of [...this.kitMappings]) {
      if (!this.templates.has(templateName)) {
        console.warn(
          `[spider] Kit mapping "${writType}" → "${templateName}": template not found — removed`
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
   * leaving the writ for non-dispatch handling (e.g. quest writs tracked
   * for inquiry rather than execution).
   *
   * Precedence: config mapping → kit mapping → undefined.
   */
  lookup(writType: string): RigTemplate | undefined {
    // Step 1: Config mapping for this specific writ type
    const configMapped = this.configMappings.get(writType);
    if (configMapped !== undefined) {
      const t = this.templates.get(configMapped);
      if (t) return t;
      // Config points to nonexistent template — validated at startup, should not happen at runtime
    }

    // Step 2: Kit mapping for this specific writ type
    const kitMapped = this.kitMappings.get(writType);
    if (kitMapped !== undefined) {
      const t = this.templates.get(kitMapped);
      if (t) return t;
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
   */
  listTemplateMappings(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [writType, templateName] of this.kitMappings) {
      result[writType] = templateName;
    }
    for (const [writType, templateName] of this.configMappings) {
      result[writType] = templateName;
    }
    return result;
  }
}

// ── Apparatus factory ──────────────────────────────────────────────────

export function createSpider(): Plugin {
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
   * In-memory store for block records that have been cleared.
   * Key: "rigId:engineId". Written when an engine is unblocked (via checker or resume()).
   * Read and deleted in tryRun() when building EngineRunContext.
   */
  const pendingPriorBlocks = new Map<string, BlockRecord>();

  /**
   * In-memory queue of pending grafts.
   * Key: rigId. Value: { engineId, graft, writId }.
   * Written by tryCollect/tryRun when a completed engine has a graft.
   * Consumed by tryProcessGrafts.
   */
  const pendingGrafts = new Map<string, { engineId: string; graft: RigTemplateEngine[]; writId: string }>();

  // ── Internal crawl operations ─────────────────────────────────────

  /**
   * Mark an engine failed and propagate failure to the rig (same update).
   * Cancels all pending and blocked engines.
   */
  async function failEngine(
    rig: RigDoc,
    engineId: string,
    errorMessage: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updatedEngines = rig.engines.map((e) => {
      if (e.id === engineId) {
        return { ...e, status: 'failed' as const, error: errorMessage, completedAt: now };
      }
      if (e.status === 'pending' || e.status === 'blocked') {
        return { ...e, status: 'cancelled' as const, block: undefined };
      }
      return e;
    });
    await rigsBook.patch(rig.id, {
      engines: updatedEngines,
      status: 'failed',
    });
  }

  /**
   * Mark an engine cancelled and propagate cancellation to the rig (same update).
   * Cancels all pending and blocked engines. Does NOT call Animator.cancel() —
   * that is the caller's responsibility.
   */
  async function cancelEngine(
    rig: RigDoc,
    engineId: string,
    reason?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updatedEngines = rig.engines.map((e) => {
      if (e.id === engineId) {
        return { ...e, status: 'cancelled' as const, error: reason ?? undefined, completedAt: now, block: undefined };
      }
      if (e.status === 'pending' || e.status === 'blocked') {
        return { ...e, status: 'cancelled' as const, block: undefined };
      }
      return e;
    });
    await rigsBook.patch(rig.id, {
      engines: updatedEngines,
      status: 'cancelled',
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
   * Phase 0 — reapZombies.
   *
   * Detect engines marked 'running' whose underlying process is dead.
   * Only examines engines older than `zombieThresholdMs` (default 5 min)
   * to avoid false positives on engines still starting.
   */
  async function tryReapZombies(): Promise<CrawlResult | null> {
    const zombieThresholdMs = spiderConfig.zombieThresholdMs ?? 300_000;
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });

    for (const rig of runningRigs) {
      for (const engine of rig.engines) {
        if (engine.status !== 'running') continue;
        // R14: skip engines with no sessionId
        if (!engine.sessionId) continue;
        // Skip engines with no startedAt — cannot evaluate age
        if (!engine.startedAt) continue;

        const age = Date.now() - new Date(engine.startedAt).getTime();
        if (age < zombieThresholdMs) continue;

        const session = await sessionsBook.get(engine.sessionId);
        // Session missing — skip; tryCollect already handles missing sessions
        if (!session) continue;
        // Session in terminal state — skip; tryCollect will handle it
        if (session.status === 'completed' || session.status === 'failed' ||
            session.status === 'timeout' || session.status === 'cancelled') continue;

        const pid = (session.cancelMetadata as Record<string, unknown> | undefined)?.pid;

        // R7: live PID — legitimately running
        if (typeof pid === 'number' && isProcessAlive(pid)) continue;

        // R5: dead PID — zombie
        if (typeof pid === 'number' && !isProcessAlive(pid)) {
          console.log(`[spider] Reaped zombie engine "${engine.id}" in rig "${rig.id}" — process dead`);
          await failEngine(rig, engine.id, 'Engine process died unexpectedly (zombie reaped)');
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        // R6: no PID and session still pending/running — zombie
        if (typeof pid !== 'number' && (session.status === 'pending' || session.status === 'running')) {
          console.log(`[spider] Reaped zombie engine "${engine.id}" in rig "${rig.id}" — process dead`);
          await failEngine(rig, engine.id, 'Engine session has no process ID after threshold (zombie reaped)');
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }
      }
    }

    return null;
  }

  /**
   * Phase 1 — collect.
   *
   * Find the first running engine with a sessionId whose session has
   * reached a terminal state. Populate yields and advance the engine
   * (and possibly the rig) to completed or failed.
   *
   * After collecting a completed engine, check whether the rig has
   * become blocked (no running engines, no runnable engines, some blocked).
   */
  async function tryCollect(): Promise<CrawlResult | null> {
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
    for (const rig of runningRigs) {
      for (const engine of rig.engines) {
        if (engine.status !== 'running' || !engine.sessionId) continue;

        const session = await sessionsBook.get(engine.sessionId);
        // Both 'pending' and 'running' are non-terminal — keep waiting.
        // 'pending' was added when launchDetached started pre-writing the
        // SessionDoc before spawning the babysitter; without this check we
        // would treat freshly-pre-written sessions as already-completed and
        // mark engines done with no actual work performed.
        if (!session || session.status === 'running' || session.status === 'pending') continue;

        // Terminal session found — collect.
        const now = new Date().toISOString();

        if (session.status === 'failed' || session.status === 'timeout') {
          await failEngine(rig, engine.id, session.error ?? `Session ${session.status}`);
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
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
        if (design?.collect) {
          const upstream = buildUpstreamMap(rig);
          const givens = resolveYieldRefs(engine.givensSpec, upstream);
          const context = { rigId: rig.id, engineId: engine.id, upstream };
          const collectResult = await design.collect(engine.sessionId!, givens, context);
          // Check for SpiderCollectResult shape (duck-typing)
          if (
            collectResult !== null &&
            collectResult !== undefined &&
            typeof collectResult === 'object' &&
            Array.isArray((collectResult as Record<string, unknown>).graft)
          ) {
            const scr = collectResult as SpiderCollectResult;
            yields = scr.yields;
            collectGraft = scr.graft;
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
          await failEngine(rig, engine.id, 'Session yields are not JSON-serializable');
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        const updatedEngines = rig.engines.map((e) =>
          e.id === engine.id
            ? { ...e, status: 'completed' as const, yields, completedAt: now }
            : e,
        );

        // Store graft for processing in tryProcessGrafts phase.
        // Graft takes priority over rig-completion: even if the rig would be complete,
        // we must queue the graft first and return engine-completed so the graft
        // is processed on the next crawl step.
        if (collectGraft !== undefined && collectGraft.length > 0) {
          pendingGrafts.set(rig.id, { engineId: engine.id, graft: collectGraft, writId: rig.writId });
          await rigsBook.patch(rig.id, { engines: updatedEngines, status: 'running' });
          return { action: 'engine-completed', rigId: rig.id, engineId: engine.id };
        }

        if (isRigComplete(updatedEngines)) {
          await rigsBook.patch(rig.id, { engines: updatedEngines, status: 'completed' });
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
        }

        // Check whether completing this engine has caused the rig to become blocked
        if (isRigBlocked(updatedEngines)) {
          await rigsBook.patch(rig.id, { engines: updatedEngines, status: 'blocked' });
          return { action: 'rig-blocked', rigId: rig.id, writId: rig.writId };
        }

        await rigsBook.patch(rig.id, { engines: updatedEngines, status: 'running' });
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

    const [rigId, { engineId, graft, writId }] = pendingGrafts.entries().next().value!;
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
      await failEngine(rig, engineId, `Graft validation failed: ${validationError}`);
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

    const updatedEngines = [...rig.engines, ...graftedInstances];
    await rigsBook.patch(rig.id, { engines: updatedEngines });

    return {
      action: 'engine-grafted',
      rigId: rig.id,
      engineId,
      graftedEngineIds: graftedInstances.map((e) => e.id),
    };
  }

  /**
   * Phase 2 — checkBlocked.
   *
   * Query rigs with status 'running' or 'blocked'. For each blocked engine,
   * run the registered checker (respecting pollIntervalMs). If cleared,
   * transition the engine back to pending and restore the rig to running.
   * If not cleared, update lastCheckedAt and continue to the next engine.
   */
  async function tryCheckBlocked(): Promise<CrawlResult | null> {
    // Fetch both running rigs (may have blocked engines) and blocked rigs
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
    const blockedRigs = await rigsBook.find({ where: [['status', '=', 'blocked']] });
    const rigs = [...runningRigs, ...blockedRigs];

    for (const rig of rigs) {
      for (const engine of rig.engines) {
        if (engine.status !== 'blocked' || !engine.block) continue;

        const blockType = blockTypeRegistry.get(engine.block.type);
        if (!blockType) continue; // Type was unregistered after block was created; skip

        // Poll interval throttle
        if (blockType.pollIntervalMs !== undefined && engine.block.lastCheckedAt) {
          const elapsed = Date.now() - new Date(engine.block.lastCheckedAt).getTime();
          if (elapsed < blockType.pollIntervalMs) continue;
        }

        let result: CheckResult;
        try {
          result = await blockType.check(engine.block.condition);
        } catch (err) {
          // Log warning, skip — engine stays blocked, retry next cycle
          console.warn(
            `Block checker "${engine.block.type}" threw for engine "${engine.id}" in rig "${rig.id}":`,
            err,
          );
          continue;
        }

        if (result.status === 'failed') {
          // Permanent failure — fail the engine and rig immediately
          const message = result.reason
            ? `Block "${engine.block.type}" failed: ${result.reason}`
            : `Block "${engine.block.type}" failed permanently`;
          await failEngine(rig, engine.id, message);
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        if (result.status !== 'cleared') {
          // Pending (or any unexpected status) — update lastCheckedAt and continue checking other engines
          const now = new Date().toISOString();
          const updatedEngines = rig.engines.map((e) =>
            e.id === engine.id
              ? { ...e, block: { ...e.block!, lastCheckedAt: now } }
              : e,
          );
          await rigsBook.patch(rig.id, { engines: updatedEngines });
          continue; // Check next engine
        }

        // Cleared — store block record in memory for priorBlock, then transition engine to pending
        const priorBlockRecord = engine.block;
        pendingPriorBlocks.set(`${rig.id}:${engine.id}`, priorBlockRecord);

        const updatedEngines = rig.engines.map((e) =>
          e.id === engine.id
            ? { ...e, status: 'pending' as const, block: undefined }
            : e,
        );

        // Restore rig to running if it was blocked; use isRigBlocked on updatedEngines
        // (always false after unblocking, but keeps call sites consistent per R13)
        const stillBlocked = isRigBlocked(updatedEngines);
        const rigStatus = stillBlocked ? 'blocked' : 'running';

        await rigsBook.patch(rig.id, {
          engines: updatedEngines,
          status: rigStatus,
        });

        return { action: 'engine-unblocked', rigId: rig.id, engineId: engine.id };
      }
    }
    return null;
  }

  /**
   * Phase 3 — run.
   *
   * Find the first pending engine in any running rig whose upstream is
   * all completed. Execute it:
   * - Clockwork ('completed') → store yields, mark engine completed,
   *   check for rig completion.
   * - Quick ('launched') → store sessionId, mark engine running.
   * - Blocked ('blocked') → validate block type and condition, persist
   *   block record, check whether rig should enter blocked state.
   */
  async function tryRun(): Promise<CrawlResult | null> {
    const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });

    // Throttle: compute system-wide running engine count
    const maxGlobal = spiderConfig.maxConcurrentEngines ?? 3;
    const maxPerRig = spiderConfig.maxConcurrentEnginesPerRig ?? 1;
    const systemRunning = countRunningEngines(runningRigs);

    for (const rig of runningRigs) {
      const pending = findRunnableEngine(rig);
      if (!pending) continue;

      // Throttle: check system-wide and per-rig limits.
      // Deferred engines stay in pending; the next crawl tick will re-evaluate.
      if (systemRunning >= maxGlobal || countRunningEnginesInRig(rig) >= maxPerRig) {
        continue;
      }

      const now = new Date().toISOString();
      const upstream = buildUpstreamMap(rig);

      // Evaluate `when` condition before running the engine
      if (pending.when !== undefined) {
        const shouldRun = evaluateWhen(pending.when, upstream);
        if (!shouldRun) {
          // Skip this engine and cascade-skip downstream conditionals
          const mutableEngines = rig.engines.map((e) =>
            e.id === pending.id ? { ...e, status: 'skipped' as const } : { ...e },
          );
          const cascaded = cascadeSkip(mutableEngines, upstream);

          if (isRigComplete(mutableEngines)) {
            await rigsBook.patch(rig.id, { engines: mutableEngines, status: 'completed' });
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
          }

          if (isRigBlocked(mutableEngines)) {
            await rigsBook.patch(rig.id, { engines: mutableEngines, status: 'blocked' });
            return { action: 'rig-blocked', rigId: rig.id, writId: rig.writId };
          }

          await rigsBook.patch(rig.id, { engines: mutableEngines });
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
        await failEngine(rig, pending.id, `No engine design found for "${pending.designId}"`);
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }

      const givens = resolveYieldRefs(pending.givensSpec, upstream);

      // Check for a prior block record (engine was previously blocked and unblocked)
      const priorBlockKey = `${rig.id}:${pending.id}`;
      const priorBlock = pendingPriorBlocks.get(priorBlockKey);
      if (priorBlock) pendingPriorBlocks.delete(priorBlockKey);

      const context = {
        rigId: rig.id,
        engineId: pending.id,
        upstream,
        ...(priorBlock ? { priorBlock } : {}),
      };

      let engineResult: Awaited<ReturnType<typeof design.run>>;
      try {
        // Mark engine as running before executing
        const startedEngines = rig.engines.map((e) =>
          e.id === pending.id ? { ...e, status: 'running' as const, startedAt: now } : e,
        );
        await rigsBook.patch(rig.id, { engines: startedEngines });

        // Re-fetch to get the up-to-date engines list (with startedAt set)
        const updatedRig = { ...rig, engines: startedEngines };

        engineResult = await design.run(givens, context);

        if (engineResult.status === 'launched') {
          // Quick engine — store sessionId, leave engine in 'running'
          const { sessionId } = engineResult;
          const launchedEngines = updatedRig.engines.map((e) =>
            e.id === pending.id
              ? { ...e, status: 'running' as const, sessionId }
              : e,
          );
          await rigsBook.patch(rig.id, { engines: launchedEngines });
          return { action: 'engine-started', rigId: rig.id, engineId: pending.id };
        }

        if (engineResult.status === 'blocked') {
          const { blockType: blockTypeId, condition, message } = engineResult;

          // Look up the block type
          const blockType = blockTypeRegistry.get(blockTypeId);
          if (!blockType) {
            await failEngine(updatedRig, pending.id, `Unknown block type: "${blockTypeId}"`);
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
          }

          // Validate the condition against the block type's schema
          try {
            blockType.conditionSchema.parse(condition);
          } catch (zodErr) {
            const zodMessage = zodErr instanceof Error ? zodErr.message : String(zodErr);
            await failEngine(
              updatedRig,
              pending.id,
              `Block type "${blockTypeId}" rejected condition: ${zodMessage}`,
            );
            return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
          }

          // Build the block record and persist the blocked engine
          const blockRecord: BlockRecord = {
            type: blockTypeId,
            condition,
            blockedAt: new Date().toISOString(),
            ...(message !== undefined ? { message } : {}),
          };

          const blockedEngines = updatedRig.engines.map((e) =>
            e.id === pending.id
              ? { ...e, status: 'blocked' as const, block: blockRecord }
              : e,
          );

          // Determine whether the rig should also enter blocked state
          if (isRigBlocked(blockedEngines)) {
            await rigsBook.patch(rig.id, { engines: blockedEngines, status: 'blocked' });
            return { action: 'rig-blocked', rigId: rig.id, writId: rig.writId };
          }

          await rigsBook.patch(rig.id, { engines: blockedEngines });
          return { action: 'engine-blocked', rigId: rig.id, engineId: pending.id, blockType: blockTypeId };
        }

        // Clockwork engine — validate and store yields
        const { yields } = engineResult;
        if (!isJsonSerializable(yields)) {
          await failEngine(updatedRig, pending.id, 'Engine yields are not JSON-serializable');
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        // Check for graft (SpiderEngineRunResult extension — duck-typing)
        const runGraft = (engineResult as Record<string, unknown>).graft as RigTemplateEngine[] | undefined;

        const completedAt = new Date().toISOString();
        const completedEngines = updatedRig.engines.map((e) =>
          e.id === pending.id
            ? { ...e, status: 'completed' as const, yields, completedAt }
            : e,
        );

        // Store graft for processing in tryProcessGrafts phase.
        // Graft takes priority over rig-completion: even if the rig would be complete,
        // we must queue the graft first and return engine-completed so the graft
        // is processed on the next crawl step.
        if (runGraft !== undefined && runGraft.length > 0) {
          pendingGrafts.set(rig.id, { engineId: pending.id, graft: runGraft, writId: rig.writId });
          await rigsBook.patch(rig.id, {
            engines: completedEngines,
            status: 'running',
          });
          return { action: 'engine-completed', rigId: rig.id, engineId: pending.id };
        }

        if (isRigComplete(completedEngines)) {
          await rigsBook.patch(rig.id, {
            engines: completedEngines,
            status: 'completed',
          });
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
        }

        await rigsBook.patch(rig.id, {
          engines: completedEngines,
          status: 'running',
        });

        return { action: 'engine-completed', rigId: rig.id, engineId: pending.id };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await failEngine(rig, pending.id, errorMessage);
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }
    }
    return null;
  }

  /**
   * Phase 4 — spawn.
   *
   * Find the oldest open writ with no existing rig. Create a rig for it.
   */
  async function trySpawn(): Promise<CrawlResult | null> {
    // Throttle: do not spawn new rigs if system-wide engine limit is reached.
    // Spawned rigs would just sit with their first engine in pending, cluttering the rig list.
    const maxGlobal = spiderConfig.maxConcurrentEngines ?? 3;
    const allRunningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
    if (countRunningEngines(allRunningRigs) >= maxGlobal) return null;

    // Only consider writ types that have a rig template mapping. Rig dispatch
    // is opt-in per writ type; filtering at the query level (rather than
    // inside the loop) prevents head-of-line blocking when non-dispatchable
    // writs (e.g. quests) accumulate in `open` older than dispatchable ones
    // and fill the page of 10.
    const dispatchableTypes = Object.keys(rigTemplateRegistry.listTemplateMappings());
    if (dispatchableTypes.length === 0) return null;

    // Find open writs of dispatchable types, ordered by creation time (oldest first)
    const openWrits = await writsBook.find({
      where: [
        ['status', '=', 'open'],
        ['type', 'IN', dispatchableTypes],
      ],
      orderBy: ['createdAt', 'asc'],
      limit: 10,
    });

    for (const writ of openWrits) {
      // Check for existing rig
      const existing = await rigsBook.find({
        where: [['writId', '=', writ.id]],
        limit: 1,
      });
      if (existing.length > 0) continue;

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

  const api: SpiderApi = {
    async crawl(): Promise<CrawlResult | null> {
      const reaped = await tryReapZombies();
      if (reaped) return reaped;

      const collected = await tryCollect();
      if (collected) return collected;

      const grafted = await tryProcessGrafts();
      if (grafted) return grafted;

      const checked = await tryCheckBlocked();
      if (checked) return checked;

      const ran = await tryRun();
      if (ran) return ran;

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
      const results = await rigsBook.find({ where: [['writId', '=', writId]], limit: 1 });
      return results[0] ?? null;
    },

    async resume(rigId: string, engineId: string): Promise<void> {
      const rig = await api.show(rigId); // Throws if not found
      const engine = rig.engines.find((e) => e.id === engineId);
      if (!engine) {
        throw new Error(`Engine "${engineId}" not found in rig "${rigId}".`);
      }
      if (engine.status !== 'blocked') {
        throw new Error(
          `Engine "${engineId}" in rig "${rigId}" is not blocked (status: ${engine.status}).`,
        );
      }

      // Store prior block for priorBlock context on next run
      if (engine.block) {
        pendingPriorBlocks.set(`${rigId}:${engineId}`, engine.block);
      }

      const updatedEngines = rig.engines.map((e) =>
        e.id === engineId
          ? { ...e, status: 'pending' as const, block: undefined }
          : e,
      );

      const rigStatus = rig.status === 'blocked' ? 'running' : rig.status;

      await rigsBook.patch(rigId, {
        engines: updatedEngines,
        status: rigStatus,
      });
    },

    async cancel(rigId: string, options?: { reason?: string }): Promise<RigDoc> {
      const rig = await api.show(rigId); // Throws if not found

      // Idempotent for terminal rigs
      if (rig.status === 'completed' || rig.status === 'failed' || rig.status === 'cancelled') {
        return rig;
      }

      // Find the active engine to cancel
      let targetEngineId: string | undefined;

      // 1. Running engine with sessionId — cancel the session first
      const runningWithSession = rig.engines.find(
        (e) => e.status === 'running' && e.sessionId,
      );
      if (runningWithSession) {
        targetEngineId = runningWithSession.id;
        try {
          await animator.cancel(runningWithSession.sessionId!, { reason: options?.reason });
        } catch (err) {
          // Best-effort — log but don't propagate
          console.error('[spider] Failed to cancel animator session:', err);
        }
      }

      // 2. Running engine without sessionId
      if (!targetEngineId) {
        const runningNoSession = rig.engines.find((e) => e.status === 'running');
        if (runningNoSession) targetEngineId = runningNoSession.id;
      }

      // 3. Blocked engine
      if (!targetEngineId) {
        const blockedEngine = rig.engines.find((e) => e.status === 'blocked');
        if (blockedEngine) targetEngineId = blockedEngine.id;
      }

      // Fallback: use first non-terminal engine
      if (!targetEngineId) {
        const pending = rig.engines.find(
          (e) => e.status === 'pending',
        );
        if (pending) targetEngineId = pending.id;
      }

      if (targetEngineId) {
        await cancelEngine(rig, targetEngineId, options?.reason);
      } else {
        // No active engines — just mark rig cancelled
        await rigsBook.patch(rig.id, { status: 'cancelled' });
      }

      // Reject pending input requests
      await rejectPendingInputRequests(rig.id);

      // Re-fetch and return the updated rig
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
      recommends: ['oculus'],
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
        engines: {
          'anima-session': animaSessionEngine,
          draft:     draftEngine,
          implement: implementEngine,
          review:    reviewEngine,
          revise:    reviseEngine,
          seal:      sealEngine,
        },
        blockTypes: {
          'writ-status':    writStatusBlockType,
          'scheduled-time': scheduledTimeBlockType,
          'book-updated':   bookUpdatedBlockType,
          'patron-input':   patronInputBlockType,
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

        const stacks = g.apparatus<StacksApi>('stacks');
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
        // When a writ reaches a terminal state, cancel the associated rig.
        // Silent no-op when no rig exists or the rig is already terminal.
        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          async (event) => {
            if (event.type !== 'update') return;

            const writ = event.entry;
            const prev = event.prev;

            // Only act when status changes to a terminal state
            if (writ.status === prev.status) return;
            if (writ.status !== 'completed' && writ.status !== 'failed' && writ.status !== 'cancelled') return;

            const rig = await api.forWrit(writ.id);
            if (!rig) return; // No rig for this writ — silent no-op

            // Already terminal — silent no-op (avoids redundant cancel cycle)
            if (rig.status === 'completed' || rig.status === 'failed' || rig.status === 'cancelled') return;

            await api.cancel(rig.id);
          },
          { failOnError: true },
        );

        // CDC — Phase 1 cascade on rigs book.
        // When a rig reaches a terminal state, transition the associated writ.
        // The 'blocked' status intentionally falls through — no CDC action.
        stacks.watch<RigDoc>(
          'spider',
          'rigs',
          async (event) => {
            if (event.type !== 'update') return;

            const rig = event.entry;
            const prev = event.prev;

            // Only act when status changes to a terminal state
            if (rig.status === prev.status) return;

            // Skip writ transition when the writ is already in a terminal state.
            // This happens when a writ is cancelled/completed/failed out-of-band
            // (e.g. via the clerk directly) and the rig is cancelled afterwards.
            const writ = await writsBook.get(rig.writId);
            const writAlreadyTerminal = writ && (
              writ.status === 'completed' || writ.status === 'failed' || writ.status === 'cancelled'
            );

            if (rig.status === 'completed') {
              let resolutionYields: unknown;

              // 1. Try the declared resolution engine
              if (rig.resolutionEngineId) {
                const declared = rig.engines.find((e) => e.id === rig.resolutionEngineId);
                if (declared?.yields !== undefined) {
                  resolutionYields = declared.yields;
                }
              }

              // 2. Fall back to seal engine (backwards compat for pre-existing rigs)
              if (resolutionYields === undefined) {
                const seal = rig.engines.find((e) => e.id === 'seal');
                if (seal?.yields !== undefined) {
                  resolutionYields = seal.yields;
                }
              }

              // 3. Fall back to last completed engine in array order
              if (resolutionYields === undefined) {
                const lastCompleted = [...rig.engines]
                  .reverse()
                  .find((e) => e.status === 'completed' && e.yields !== undefined);
                if (lastCompleted) {
                  resolutionYields = lastCompleted.yields;
                }
              }

              const resolution = resolutionYields !== undefined
                ? JSON.stringify(resolutionYields)
                : 'Rig completed';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'completed', { resolution });
              }
            } else if (rig.status === 'failed') {
              const failedEngine = rig.engines.find((e) => e.status === 'failed');
              const resolution = failedEngine?.error ?? 'Engine failure';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'failed', { resolution });
              }
            } else if (rig.status === 'cancelled') {
              const cancelledEngine = rig.engines.find((e) => e.status === 'cancelled' && e.error);
              const resolution = cancelledEngine?.error ?? 'Rig cancelled';
              if (!writAlreadyTerminal) {
                await clerk.transition(rig.writId, 'cancelled', { resolution });
              }
            }
            // 'blocked' and 'cancelled' (handled above) — no further CDC action
          },
          { failOnError: true },
        );

        // Zombie recovery — reap engines left running from a previous daemon run.
        // Fire-and-forget async, matching animator's orphan recovery pattern.
        void (async () => {
          try {
            const runningRigs = await rigsBook.find({ where: [['status', '=', 'running']] });
            let reaped = 0;

            for (const rig of runningRigs) {
              for (const engine of rig.engines) {
                if (engine.status !== 'running' || !engine.sessionId) continue;

                const session = await sessionsBook.get(engine.sessionId);

                // At startup, any engine whose session is still pending is definitionally
                // orphaned — no babysitter can still be starting from the previous run.
                if (session && session.status === 'pending') {
                  await failEngine(rig, engine.id, 'Engine session stuck in pending at startup (zombie reaped)');
                  reaped++;
                  break; // failEngine sets rig to failed; move to next rig.
                }

                // Session running with a dead PID — zombie.
                if (session && session.status === 'running') {
                  const pid = (session.cancelMetadata as Record<string, unknown> | undefined)?.pid;
                  if (typeof pid === 'number' && !isProcessAlive(pid)) {
                    await failEngine(rig, engine.id, 'Engine process died unexpectedly (zombie reaped)');
                    reaped++;
                    break; // failEngine sets rig to failed; move to next rig.
                  }
                  // No PID at startup + session running = also orphaned (babysitter
                  // never registered its PID with the session before the crash).
                  if (typeof pid !== 'number') {
                    await failEngine(rig, engine.id, 'Engine session has no process ID at startup (zombie reaped)');
                    reaped++;
                    break;
                  }
                }

                // Session missing — skip; may have been cleaned up or never written.
                // Session in terminal state — tryCollect will handle it on first crawl.
              }
            }

            if (reaped > 0) {
              console.log(`[spider] Zombie recovery: reaped ${reaped} zombie engines`);
            }
          } catch (err) {
            console.error('[spider] Zombie recovery failed:', err instanceof Error ? err.message : String(err));
          }
        })();
      },
    },
  };
}
