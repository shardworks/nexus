/**
 * @shardworks/spider-apparatus — The Spider.
 *
 * Rig execution engine: spawns rigs for ready writs, drives engine pipelines
 * to completion, and transitions writs via the Clerk on rig completion/failure.
 *
 * Public types (RigDoc, EngineInstance, CrawlResult, SpiderApi, etc.) are
 * re-exported for consumers that inspect walk results or rig state.
 */

import { createSpider } from './spider.ts';

// ── Public types ──────────────────────────────────────────────────────

export type {
  EngineStatus,
  EngineInstance,
  RigStatus,
  RigDoc,
  RigView,
  RigCostSummary,
  EngineCostSummary,
  RigFilters,
  CrawlResult,
  SpiderApi,
  SpiderConfig,
  BlockRecord,
  BlockType,
  BlockTypeInfo,
  CheckResult,
  DraftYields,
  SealYields,
  RigTemplate,
  RigTemplateEngine,
  RigTemplateInfo,
  SpiderEngineRunResult,
  SpiderCollectResult,
  InputRequestStatus,
  InputRequestDoc,
  ChoiceQuestionSpec,
  BooleanQuestionSpec,
  TextQuestionSpec,
  QuestionSpec,
  ChoiceAnswer,
  AnswerValue,
  SpiderStuckCause,
  SpiderWritStatus,
} from './types.ts';

export type { SpiderKit } from './spider.ts';

// ── Named factory export ──────────────────────────────────────────────

/**
 * Create a fresh Spider apparatus plugin instance.
 *
 * Exposed so downstream test fixtures can instantiate a dedicated Spider
 * per-test without touching the module-level singleton produced by the
 * default export. Production callers should continue to use the default
 * export; this named export is for tests and harnesses that build their
 * own Guild out of a shared MemoryBackend/Stacks/Clerk substrate.
 */
export { createSpider } from './spider.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createSpider();
