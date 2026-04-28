/**
 * Shared fixture module for Spider unit tests.
 *
 * Houses the canonical `buildFixture` integration harness and its
 * module-scope helper dependencies, originally co-located with the
 * monolithic `spider.test.ts`. The split into per-feature test files
 * relocates these helpers here so each split file imports only the
 * helpers it actually uses.
 *
 * The file name does not match the `*.test.ts` glob, so the test runner
 * never picks it up directly. Production source is imported directly
 * from the original packages — this module deliberately does NOT
 * re-export production symbols (no barrel pattern).
 */

import assert from 'node:assert/strict';

import { setGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, EngineAttempt, RigTemplate } from './types.ts';

// ── Test bootstrap ────────────────────────────────────────────────────

/**
 * Return the latest attempt row (tail of `attempts[]`) for the given engine,
 * or undefined if the engine has never been dispatched. Tests read
 * session id / yields / error / timestamps from this row (the scalar
 * engine-level fields no longer exist).
 */
export function latestAttempt(engine: EngineInstance): EngineAttempt | undefined {
  return engine.attempts && engine.attempts.length > 0 ? engine.attempts[engine.attempts.length - 1] : undefined;
}

// Standard 5-engine template matching the original static pipeline behavior.
// Used as the default template in test fixtures.
export const STANDARD_TEMPLATE: RigTemplate = {
  engines: [
    { id: 'draft',     designId: 'draft',     givens: { writ: '${writ}' } },
    { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '${writ}', role: '${vars.role}' } },
    { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '${writ}', role: 'reviewer', buildCommand: '${vars.buildCommand}', testCommand: '${vars.testCommand}' } },
    { id: 'revise',    designId: 'revise',    upstream: ['review'],    givens: { writ: '${writ}', role: '${vars.role}' } },
    { id: 'seal',      designId: 'seal',      upstream: ['revise'],    givens: {} },
  ],
  resolutionEngine: 'seal',
};

export const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

export function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[]): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

/**
 * Build a minimal StartupContext that captures and fires events.
 */
export function buildCtx(kitEntries: KitEntry[] = []): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const ctx: StartupContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter(e => e.type === type)];
    },
  };
  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }
  return { ctx, fire };
}

/**
 * Splice test-supplied custom engines into a copy of Spider's apparatus
 * supportKit. Matching is by engine id — if `customEngines` contains an
 * engine whose id matches one of Spider's built-in engines, that built-in is
 * replaced rather than registered alongside (which would violate the
 * Fabricator's kit-vs-kit uniqueness rule). Engines with new ids are
 * appended. Returns the same apparatus object unmodified when there are no
 * custom engines.
 */
export function mergeCustomEnginesIntoSpider(
  spiderApparatus: LoadedApparatus['apparatus'],
  customEngines: Record<string, unknown> | undefined,
): LoadedApparatus['apparatus'] {
  if (!customEngines || Object.keys(customEngines).length === 0) {
    return spiderApparatus;
  }

  const spiderSupportKit = (spiderApparatus as { supportKit?: Record<string, unknown> }).supportKit ?? {};
  const spiderEngines = (spiderSupportKit.engines ?? {}) as Record<string, unknown>;

  // Collect the ids of custom engines so we can filter Spider's built-ins.
  const customIds = new Set<string>();
  for (const val of Object.values(customEngines)) {
    const id = (val as { id?: unknown }).id;
    if (typeof id === 'string') customIds.add(id);
  }

  // Rebuild Spider's engine record, dropping any built-in whose id collides
  // with a custom engine's id. The surviving built-ins are keyed by their
  // original record key (which may or may not match the engine id).
  const survivingBuiltins: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spiderEngines)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id !== 'string' || !customIds.has(id)) {
      survivingBuiltins[key] = value;
    }
  }

  return {
    ...spiderApparatus,
    supportKit: {
      ...spiderSupportKit,
      engines: { ...survivingBuiltins, ...customEngines },
    },
  } as LoadedApparatus['apparatus'];
}

/**
 * Full integration fixture: starts Stacks (memory), Clerk, Fabricator,
 * and Spider. Returns handles to each API plus mock animator controls.
 */
export function buildFixture(
  guildConfig: Partial<GuildConfig> = {},
  initialSessionOutcome: { status: 'completed' | 'failed'; error?: string; output?: string } = { status: 'completed' },
  extra: {
    kits?: LoadedKit[];
    apparatuses?: LoadedApparatus[];
    customEngines?: Record<string, unknown>;
    /**
     * Additional writ-type configs to register with the Clerk after its
     * `start()` returns. The legacy `clerk.writTypes` guild-config channel
     * and kit-channel scan have both been retired; tests that need
     * non-mandate writ types register them here. Each config is a full
     * `WritTypeConfig`; common test types (`triage`, `audit`) clone
     * mandate's six-state machine.
     */
    extraWritTypes?: WritTypeConfig[];
  } = {},
): {
  stacks: StacksApi;
  clerk: ClerkApi;
  realClerk: ClerkApi;
  fabricator: FabricatorApi;
  spider: SpiderApi;
  memBackend: InstanceType<typeof MemoryBackend>;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
  spiderFire: (event: string, ...args: unknown[]) => Promise<void>;
  summonCalls: SummonRequest[];
  cancelCalls: Array<{ sessionId: string; options?: { reason?: string } }>;
  setSessionOutcome: (outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) => void;
} {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator must be apparatus');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider must be apparatus');

  const stacksApparatus = stacksPlugin.apparatus;
  const clerkApparatus = clerkPlugin.apparatus;
  const fabricatorApparatus = fabricatorPlugin.apparatus;
  const spiderApparatus = spiderPlugin.apparatus;

  const apparatusMap = new Map<string, unknown>();

  const mergedSpider = {
    rigTemplates: { default: STANDARD_TEMPLATE } as Record<string, RigTemplate>,
    variables: { role: 'artificer' } as Record<string, unknown>,
    ...(guildConfig.spider ?? {}),
  };

  // Note: the fixture no longer auto-injects { mandate: 'default' } into
  // rigTemplateMappings. Spider's registry applies a narrow mandate-
  // builtin fallback inside `lookup()`/`listTemplateMappings()` — when
  // no config or kit mapping claims the `mandate` writ type, mandate
  // writs resolve to a `default` / `spider.default` template if one is
  // registered. Tests that post mandate writs against the
  // STANDARD_TEMPLATE (registered as config-level `default`) get the
  // same dispatch behaviour without test-fixture machinery. Tests that
  // exercise a non-default mapping declare their own config override
  // explicitly.

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...guildConfig,
    spider: mergedSpider,
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return extra.kits ?? []; },
    apparatuses(): LoadedApparatus[] { return extra.apparatuses ?? []; },
    startupWarnings() { return []; },
    failedPlugins() { return []; },
  };

  setGuild(fakeGuild);

  // Build Spider's LoadedApparatus, optionally splicing test-supplied custom
  // engines into Spider's supportKit.engines by engine id. This preserves the
  // decades-old test pattern of "stub out a Spider engine" while keeping the
  // Fabricator's kit-vs-kit uniqueness invariant intact — a stub and Spider's
  // real engine with the same id are never both registered. New engine ids
  // (with no matching Spider built-in) are simply appended.
  const spiderAsLoaded: LoadedApparatus = {
    packageName: '@shardworks/spider-apparatus',
    id: 'spider',
    version: '0.0.0',
    apparatus: mergeCustomEnginesIntoSpider(spiderApparatus, extra.customEngines),
  };

  const fabricatorKitEntries = buildKitEntries(
    extra.kits ?? [],
    [spiderAsLoaded, ...(extra.apparatuses ?? [])],
  );

  const spiderKitEntries = buildKitEntries(
    extra.kits ?? [],
    [spiderAsLoaded, ...(extra.apparatuses ?? [])],
  );

  // Start stacks with memory backend
  const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
  stacksApparatus.start(noopCtx);
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Manually ensure all books the Spider and Clerk need
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['status', 'rigId', 'engineId', 'createdAt', ['rigId', 'engineId', 'status']],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });

  // Mock animator — captures summon() calls and writes session docs to Stacks.
  // The session record is written eagerly (synchronous put, fire-and-forget)
  // so the Spider's collect step finds it on the next crawl() call. Engines
  // no longer await handle.result — they return immediately with handle.sessionId.
  let currentSessionOutcome = initialSessionOutcome;
  const summonCalls: SummonRequest[] = [];
  const cancelCalls: Array<{ sessionId: string; options?: { reason?: string } }> = [];
  const mockAnimatorApi: AnimatorApi = {
    summon(request: SummonRequest): AnimateHandle {
      summonCalls.push(request);
      const sessionId = generateId('ses', 4);
      const startedAt = new Date().toISOString();
      const outcome = currentSessionOutcome;

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      const endedAt = new Date().toISOString();
      const doc: SessionDoc = {
        id: sessionId,
        status: outcome.status,
        startedAt,
        endedAt,
        durationMs: 0,
        provider: 'mock',
        exitCode: outcome.status === 'completed' ? 0 : 1,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        metadata: request.metadata,
      };
      // Write eagerly — fire and forget. The in-memory backend is sync.
      void sessBook.put(doc);

      const result = Promise.resolve({
        id: sessionId,
        status: outcome.status,
        startedAt,
        endedAt,
        durationMs: 0,
        provider: 'mock',
        exitCode: outcome.status === 'completed' ? 0 : 1,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        metadata: request.metadata,
      } as SessionResult);

      async function* emptyChunks(): AsyncIterable<SessionChunk> {}
      return { sessionId, chunks: emptyChunks(), result };
    },
    animate(): AnimateHandle {
      throw new Error('animate() not used in Spider tests');
    },
    subscribeToSession(): AsyncIterable<SessionChunk> | null {
      return null;
    },
    async cancel(sessionId: string, options?: { reason?: string }): Promise<SessionDoc> {
      cancelCalls.push({ sessionId, options });
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      const session = await sessBook.get(sessionId);
      if (session) {
        const now = new Date().toISOString();
        await sessBook.patch(sessionId, {
          status: 'cancelled',
          endedAt: now,
          ...(options?.reason ? { error: options.reason } : {}),
        });
        return { ...session, status: 'cancelled', endedAt: now };
      }
      return { id: sessionId, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as SessionDoc;
    },
    async getSessionCosts() { return new Map(); },
    async getStatus() { return {} as never; },
  };
  apparatusMap.set('animator', mockAnimatorApi);

  // Start clerk. Clerk consumes `linkKinds` kit entries, so pass the full
  // kit-entry snapshot through its ctx — this is how `spider.follows`
  // (contributed by Spider's supportKit) gets registered in the kind
  // registry and becomes acceptable to `clerk.link(_, _, _, 'spider.follows')`.
  const { ctx: clerkCtx } = buildCtx(spiderKitEntries);
  clerkApparatus.start(clerkCtx);
  const realClerk = clerkApparatus.provides as ClerkApi;

  // Register any extra writ types this test needs. The harness never fires
  // `phase:started`, so the Clerk's registration window stays open.
  for (const config of extra.extraWritTypes ?? []) {
    realClerk.registerWritType(config);
  }

  // Fixture wrapper: most legacy spider tests post a writ and expect it to
  // be in `open` (dispatchable) immediately — that was the
  // pre-registry-refactor auto-publish semantics. The post-refactor
  // ClerkApi.post() lands the writ in its declared initial state (`new`).
  // The wrapper preserves the fixture's prior behaviour by auto-publishing
  // *any* writ that lands in the `new` state — every type used by spider
  // tests (mandate, triage, audit, custom-type, orphan-type, etc.) declares
  // `new → open` as a legal transition, so the auto-publish maps cleanly
  // onto the legacy `draft: false` semantics. This is a test-fixture
  // concession, not an API change. Tests that need a writ to stay in `new`
  // can call `realClerk.post(...)` directly via
  // `(fix as { realClerk: ClerkApi }).realClerk`.
  const clerk: ClerkApi = {
    ...realClerk,
    async post(request) {
      const writ = await realClerk.post(request);
      if (writ.phase === 'new') {
        return realClerk.transition(writ.id, 'open');
      }
      return writ;
    },
  };
  apparatusMap.set('clerk', clerk);

  // Start fabricator with kit entries from Spider's engines
  const { ctx: fabricatorCtx, fire } = buildCtx(fabricatorKitEntries);
  fabricatorApparatus.start(fabricatorCtx);
  const fabricator = fabricatorApparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  // Start spider with kit entries from Spider's supportKit
  const { ctx: spiderCtx, fire: spiderFire } = buildCtx(spiderKitEntries);
  spiderApparatus.start(spiderCtx);
  const spider = spiderApparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  return {
    stacks, clerk, realClerk, fabricator, spider, memBackend, fire, spiderFire,
    summonCalls,
    cancelCalls,
    setSessionOutcome(outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) {
      currentSessionOutcome = outcome;
    },
  };
}

/** Get the rigs book. */
export function rigsBook(stacks: StacksApi) {
  return stacks.book<RigDoc>('spider', 'rigs');
}

/**
 * Build a `WritTypeConfig` that clones mandate's six-state machine under a
 * different name. Used by tests that previously declared throwaway writ
 * types via the legacy `clerk.writTypes` guild-config channel.
 */
export function mandateLikeWritType(name: string): WritTypeConfig {
  return {
    name,
    states: [
      { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
      { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
      { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
      { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
      { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
      { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
    ],
  };
}

/**
 * Post a mandate writ. The fixture's clerk wrapper auto-publishes mandate
 * writs to `open`, so this helper is now a thin convenience that just sets
 * a default title and body. (The auto-publish lives in the wrapper, not
 * this helper, so callers that go through `fix.clerk.post(...)` directly
 * get the same `open`-on-arrival behaviour.)
 */
export async function postWrit(clerk: ClerkApi, title = 'Test writ', codex?: string): Promise<WritDoc> {
  return clerk.post({ title, body: 'Test body', codex });
}

/**
 * Assert that a rig's terminalAt field is a valid ISO timestamp. Used by
 * rig terminal-transition tests to pin the invariant that any rig reaching
 * a terminal status also records the terminal-event timestamp.
 */
export function assertTerminalAt(rig: { terminalAt?: string } | null | undefined, msg = 'rig.terminalAt should be a valid ISO timestamp'): void {
  assert.ok(rig, 'rig should be defined for terminalAt check');
  assert.ok(
    typeof rig!.terminalAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(rig!.terminalAt),
    `${msg} (got: ${JSON.stringify(rig!.terminalAt)})`,
  );
}
