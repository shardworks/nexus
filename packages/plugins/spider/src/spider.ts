/**
 * The Spider — rig execution engine apparatus.
 *
 * The Spider drives writ-to-completion by managing rigs: ordered pipelines
 * of engine instances. Each crawl() call performs one unit of work:
 *
 *   collect > checkBlocked > run > spawn   (priority order)
 *
 * collect      — check running engines for terminal session results
 * checkBlocked — poll registered block type checkers; unblock engines when cleared
 * run          — execute the next pending engine (clockwork inline, quick → launch)
 * spawn        — create a new rig for a ready writ with no existing rig
 *
 * CDC on the rigs book (Phase 1 cascade) transitions the associated writ
 * when a rig reaches a terminal state (completed or failed).
 * The blocked status does NOT trigger the CDC handler.
 *
 * See: docs/architecture/apparatus/spider.md
 */

import type { Plugin, StartupContext, LoadedPlugin } from '@shardworks/nexus-core';
import { guild, generateId, isLoadedKit, isLoadedApparatus } from '@shardworks/nexus-core';
import type { StacksApi, Book, ReadOnlyBook, WhereClause } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { SessionDoc } from '@shardworks/animator-apparatus';

import type {
  RigDoc,
  RigFilters,
  EngineInstance,
  SpiderApi,
  CrawlResult,
  SpiderConfig,
  BlockRecord,
  BlockType,
  RigTemplate,
} from './types.ts';

import {
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
} from './block-types/index.ts';

import {
  crawlOneTool,
  crawlContinualTool,
  rigShowTool,
  rigListTool,
  rigForWritTool,
  rigResumeTool,
} from './tools/index.ts';

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
 * Find the first pending engine whose entire upstream is completed.
 * Returns null if no runnable engine exists.
 */
function findRunnableEngine(rig: RigDoc): EngineInstance | null {
  for (const engine of rig.engines) {
    if (engine.status !== 'pending') continue;
    const allUpstreamDone = engine.upstream.every((upstreamId) => {
      const dep = rig.engines.find((e) => e.id === upstreamId);
      return dep?.status === 'completed';
    });
    if (allUpstreamDone) return engine;
  }
  return null;
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
 * Look up the rig template for a given writ type.
 * Falls back to 'default' template if no exact match.
 * Throws if no matching template is found.
 */
function lookupTemplate(writType: string, config: SpiderConfig): RigTemplate {
  const templates = config.rigTemplates;
  if (templates) {
    if (writType in templates) return templates[writType];
    if ('default' in templates) return templates['default'];
  }
  throw new Error(
    `[spider] No rig template found for writ type "${writType}" and no "default" template configured.`
  );
}

/**
 * Resolve a template engine's givens map using a variables context.
 * '$writ' → WritDoc, '$vars.<key>' → spiderConfig.variables[key].
 * Keys resolving to undefined are omitted from the output.
 * Non-'$' prefixed values are passed through as literals.
 */
function resolveGivens(
  givens: Record<string, unknown> | undefined,
  context: { writ: WritDoc; spiderConfig: SpiderConfig },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(givens ?? {})) {
    if (typeof value !== 'string' || !value.startsWith('$')) {
      result[key] = value;
    } else if (value === '$writ') {
      result[key] = context.writ;
    } else if (/^\$vars\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      const varKey = value.slice('$vars.'.length);
      const resolved = (context.spiderConfig.variables ?? {})[varKey];
      if (resolved !== undefined) {
        result[key] = resolved;
      }
      // undefined → omit key entirely
    }
    // Unrecognized $-prefixed strings are caught at validation time
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
  }));
  return { engines, resolutionEngineId: template.resolutionEngine };
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
      for (const value of Object.values(engine.givens ?? {})) {
        if (typeof value === 'string' && value.startsWith('$')) {
          if (
            value === '$writ' ||
            /^\$vars\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
          ) {
            continue; // valid
          }
          throw new Error(
            `[spider] rigTemplates.${templateKey}: engine "${engine.id}" has unrecognized variable "${value}"`
          );
        }
      }
    }
  }
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

  register(plugin: LoadedPlugin): void {
    if (isLoadedKit(plugin)) {
      this.registerFromKit(plugin.kit);
    } else if (isLoadedApparatus(plugin)) {
      if (plugin.apparatus.supportKit) {
        this.registerFromKit(plugin.apparatus.supportKit);
      }
    }
  }

  private registerFromKit(kit: Record<string, unknown>): void {
    const raw = kit.blockTypes;
    if (typeof raw !== 'object' || raw === null) return;
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (isBlockType(value)) {
        this.types.set(value.id, value);
      }
    }
  }

  get(id: string): BlockType | undefined {
    return this.types.get(id);
  }
}

// ── Apparatus factory ──────────────────────────────────────────────────

export function createSpider(): Plugin {
  let rigsBook: Book<RigDoc>;
  let sessionsBook: ReadOnlyBook<SessionDoc>;
  let writsBook: ReadOnlyBook<WritDoc>;
  let clerk: ClerkApi;
  let fabricator: FabricatorApi;
  let spiderConfig: SpiderConfig = {};

  const blockTypeRegistry = new BlockTypeRegistry();

  /**
   * In-memory store for block records that have been cleared.
   * Key: "rigId:engineId". Written when an engine is unblocked (via checker or resume()).
   * Read and deleted in tryRun() when building EngineRunContext.
   */
  const pendingPriorBlocks = new Map<string, BlockRecord>();

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
        if (!session || session.status === 'running') continue;

        // Terminal session found — collect.
        const now = new Date().toISOString();

        if (session.status === 'failed' || session.status === 'timeout') {
          await failEngine(rig, engine.id, session.error ?? `Session ${session.status}`);
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
        }

        // Completed session — assemble yields via engine's collect() or generic default.
        const design = fabricator.getEngineDesign(engine.designId);
        let yields: unknown;
        if (design?.collect) {
          const givens = { ...engine.givensSpec };
          const upstream = buildUpstreamMap(rig);
          const context = { engineId: engine.id, upstream };
          yields = await design.collect(engine.sessionId!, givens, context);
        } else {
          yields = {
            sessionId: session.id,
            sessionStatus: session.status,
            ...(session.output !== undefined ? { output: session.output } : {}),
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

        const allCompleted = updatedEngines.every((e) => e.status === 'completed');

        if (allCompleted) {
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

        let cleared: boolean;
        try {
          cleared = await blockType.check(engine.block.condition);
        } catch (err) {
          // Log warning, skip — engine stays blocked, retry next cycle
          console.warn(
            `Block checker "${engine.block.type}" threw for engine "${engine.id}" in rig "${rig.id}":`,
            err,
          );
          continue;
        }

        if (!cleared) {
          // Update lastCheckedAt and continue checking other engines
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
    for (const rig of runningRigs) {
      const pending = findRunnableEngine(rig);
      if (!pending) continue;

      const design = fabricator.getEngineDesign(pending.designId);
      if (!design) {
        await failEngine(rig, pending.id, `No engine design found for "${pending.designId}"`);
        return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'failed' };
      }

      const now = new Date().toISOString();
      const upstream = buildUpstreamMap(rig);
      const givens = { ...pending.givensSpec };

      // Check for a prior block record (engine was previously blocked and unblocked)
      const priorBlockKey = `${rig.id}:${pending.id}`;
      const priorBlock = pendingPriorBlocks.get(priorBlockKey);
      if (priorBlock) pendingPriorBlocks.delete(priorBlockKey);

      const context = {
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

        const completedAt = new Date().toISOString();
        const completedEngines = updatedRig.engines.map((e) =>
          e.id === pending.id
            ? { ...e, status: 'completed' as const, yields, completedAt }
            : e,
        );
        const allCompleted = completedEngines.every((e) => e.status === 'completed');
        await rigsBook.patch(rig.id, {
          engines: completedEngines,
          status: allCompleted ? 'completed' : 'running',
        });

        if (allCompleted) {
          return { action: 'rig-completed', rigId: rig.id, writId: rig.writId, outcome: 'completed' };
        }
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
   * Find the oldest ready writ with no existing rig. Create a rig and
   * transition the writ to active so the Clerk tracks it as in-progress.
   */
  async function trySpawn(): Promise<CrawlResult | null> {
    // Find ready writs ordered by creation time (oldest first)
    const readyWrits = await writsBook.find({
      where: [['status', '=', 'ready']],
      orderBy: ['createdAt', 'asc'],
      limit: 10,
    });

    for (const writ of readyWrits) {
      // Check for existing rig
      const existing = await rigsBook.find({
        where: [['writId', '=', writ.id]],
        limit: 1,
      });
      if (existing.length > 0) continue;

      const rigId = generateId('rig', 4);
      const template = lookupTemplate(writ.type, spiderConfig);
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

      // Transition writ to active so Clerk tracks it
      try {
        await clerk.transition(writ.id, 'active');
      } catch (err) {
        // Only swallow state-transition conflicts (writ already moved past 'ready')
        if (err instanceof Error && err.message.includes('transition')) {
          // Race condition — another spider got here first. The rig is already created,
          // so we continue. The writ is already active or beyond.
        } else {
          throw err;
        }
      }

      return { action: 'rig-spawned', rigId, writId: writ.id };
    }

    return null;
  }

  // ── SpiderApi ─────────────────────────────────────────────────────

  const api: SpiderApi = {
    async crawl(): Promise<CrawlResult | null> {
      const collected = await tryCollect();
      if (collected) return collected;

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

    getBlockType(id: string): BlockType | undefined {
      return blockTypeRegistry.get(id);
    },
  };

  // ── Apparatus ─────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks', 'clerk', 'fabricator'],
      consumes: ['blockTypes'],

      supportKit: {
        books: {
          rigs: {
            indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
          },
        },
        engines: {
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
        },
        tools: [crawlOneTool, crawlContinualTool, rigShowTool, rigListTool, rigForWritTool, rigResumeTool],
      },

      provides: api,

      start(ctx: StartupContext): void {
        const g = guild();
        spiderConfig = g.guildConfig().spider ?? {};

        const stacks = g.apparatus<StacksApi>('stacks');
        clerk = g.apparatus<ClerkApi>('clerk');
        fabricator = g.apparatus<FabricatorApi>('fabricator');

        // Validate templates before any rig operations can occur
        if (spiderConfig.rigTemplates) {
          validateTemplates(spiderConfig.rigTemplates, fabricator);
        }

        rigsBook = stacks.book<RigDoc>('spider', 'rigs');
        sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
        writsBook = stacks.readBook<WritDoc>('clerk', 'writs');

        // Scan all already-loaded kits for block types.
        // These fired plugin:initialized before any apparatus started.
        for (const kit of g.kits()) {
          blockTypeRegistry.register(kit);
        }

        // Subscribe to plugin:initialized for apparatus supportKits that
        // fire after us in the startup sequence.
        ctx.on('plugin:initialized', (plugin: unknown) => {
          const loaded = plugin as LoadedPlugin;
          if (isLoadedApparatus(loaded)) {
            blockTypeRegistry.register(loaded);
          }
        });

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
              await clerk.transition(rig.writId, 'completed', { resolution });
            } else if (rig.status === 'failed') {
              const failedEngine = rig.engines.find((e) => e.status === 'failed');
              const resolution = failedEngine?.error ?? 'Engine failure';
              await clerk.transition(rig.writId, 'failed', { resolution });
            }
            // 'blocked' status — no CDC action, writ stays in current state
          },
          { failOnError: true },
        );
      },
    },
  };
}
