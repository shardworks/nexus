/**
 * The Astrolabe — brief-to-specification planning apparatus.
 *
 * The Astrolabe transforms patron briefs into structured work specifications
 * by driving a multi-stage planning pipeline: inventory → analysis →
 * patron review → specification writing.
 *
 * See: docs/architecture/apparatus/astrolabe.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi, Book, WhereClause } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritTypeConfig } from '@shardworks/clerk-apparatus';
import type { KitRoleDefinition } from '@shardworks/loom-apparatus';
import { z } from 'zod';

import type {
  AstrolabeApi,
  AstrolabeConfig,
  PlanDoc,
  PlanFilters,
} from './types.ts';

import {
  createPlanInitEngine,
  createInventoryCheckEngine,
  createPatronAnimaEngine,
  createDecisionReviewEngine,
  createPlanFinalizeEngine,
  createObservationLiftEngine,
  createReaderAnalystEngine,
} from './engines/index.ts';

import { planAndShipRigTemplate } from './plan-and-ship.ts';

// ── Config resolver ──────────────────────────────────────────────────

function resolveAstrolabeConfig(): AstrolabeConfig {
  return guild().guildConfig().astrolabe ?? {};
}

/**
 * Resolves the configured Patron Anima role name to a trimmed string, or
 * returns the empty string when unset / whitespace-only. Callers branch on
 * `=== ''` to distinguish the "no patron configured" case from the normal
 * one. Shared by `astrolabe.patron-anima` (skip-when-unset no-op) and
 * `astrolabe.reader-analyst` (selects between the solo and attended primer
 * variants at engine-run time). Keeping the trim-and-check logic in one
 * place avoids silent drift between the two call sites.
 */
function resolvePatronRole(): string {
  const config = resolveAstrolabeConfig();
  return typeof config.patronRole === 'string' ? config.patronRole.trim() : '';
}

/**
 * Default predicted-files soft-warn threshold when `astrolabe
 * .predictedFilesThreshold` is unset on `guild.json`. The brief landed
 * on 15 as the v0 cliff: empirical analysis showed a 3.2× cost step at
 * 20 files, with 15 chosen as a soft-warn level a few steps below the
 * cliff so subscribers can act before the cost lands.
 */
const DEFAULT_PREDICTED_FILES_THRESHOLD = 15;

/**
 * Resolves the configured predicted-files-touched soft-warn threshold.
 * Returns the default of 15 when unset; throws a clear configuration
 * error when the value is present but malformed (wrong type, NaN,
 * non-integer, zero, or negative). Fail-loud per D5 — a typo in the
 * operator's threshold must not silently fall back to the default.
 */
function resolvePredictedFilesThreshold(): number {
  const config = resolveAstrolabeConfig();
  const raw = config.predictedFilesThreshold;
  if (raw === undefined || raw === null) {
    return DEFAULT_PREDICTED_FILES_THRESHOLD;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `astrolabe.predictedFilesThreshold must be a positive integer; got ${JSON.stringify(raw)} (${typeof raw}). ` +
      `Either remove the key from guild.json to use the default of ${DEFAULT_PREDICTED_FILES_THRESHOLD}, ` +
      `or supply an integer ≥ 1.`,
    );
  }
  return raw;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createAstrolabe(): Plugin {
  let plansBook: Book<PlanDoc>;

  // ── Engines ────────────────────────────────────────────────────

  const planInitEngine = createPlanInitEngine(() => plansBook);
  const inventoryCheckEngine = createInventoryCheckEngine(() => plansBook);
  const patronAnimaEngine = createPatronAnimaEngine(() => plansBook);
  const decisionReviewEngine = createDecisionReviewEngine(() => plansBook);
  const planFinalizeEngine = createPlanFinalizeEngine(() => plansBook);
  const observationLiftEngine = createObservationLiftEngine(() => plansBook);
  const readerAnalystEngine = createReaderAnalystEngine();

  // ── API ────────────────────────────────────────────────────────

  const api: AstrolabeApi = {
    async show(planId: string): Promise<PlanDoc> {
      const plan = await plansBook.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }
      return plan;
    },

    async list(filters?: PlanFilters): Promise<PlanDoc[]> {
      const conditions: WhereClause = [];
      if (filters?.status) conditions.push(['status', '=', filters.status]);
      if (filters?.codex) conditions.push(['codex', '=', filters.codex]);
      const limit = filters?.limit ?? 20;
      const offset = filters?.offset;

      return plansBook.find({
        where: conditions.length > 0 ? conditions : undefined,
        orderBy: ['createdAt', 'desc'],
        limit,
        ...(offset !== undefined ? { offset } : {}),
      });
    },

    async patch(planId: string, fields: Partial<Omit<PlanDoc, 'id'>>): Promise<PlanDoc> {
      return plansBook.patch(planId, fields);
    },
  };

  // ── Tools ──────────────────────────────────────────────────────

  const planShowTool = tool({
    name: 'plan-show',
    description: 'Show full detail for a plan',
    instructions:
      'Returns the complete plan document including inventory, scope, decisions, ' +
      'observations, and spec fields. The planId is the originating mandate writ ID.',
    params: {
      planId: z.string().describe('Plan id (same as the originating mandate writ id)'),
    },
    permission: 'read',
    handler: async ({ planId }) => {
      const plan = await plansBook.get(planId);
      if (!plan) throw new Error(`Plan "${planId}" not found.`);
      return plan;
    },
  });

  const planListTool = tool({
    name: 'plan-list',
    description: 'List plans with optional filters',
    instructions:
      'Returns plan summaries ordered by createdAt descending (newest first). ' +
      'Filter by status or codex to narrow results.',
    params: {
      status: z
        .enum(['reading', 'analyzing', 'reviewing', 'writing', 'completed', 'failed'])
        .optional()
        .describe('Filter by plan status'),
      codex: z.string().optional().describe('Filter by codex name'),
      limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
      offset: z.number().optional().describe('Number of results to skip'),
    },
    permission: 'read',
    handler: async (params) => {
      const where: WhereClause = [];
      if (params.status) where.push(['status', '=', params.status]);
      if (params.codex) where.push(['codex', '=', params.codex]);
      return plansBook.find({
        where: where.length > 0 ? where : undefined,
        orderBy: ['createdAt', 'desc'],
        limit: params.limit,
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
      });
    },
  });

  const inventoryWriteTool = tool({
    name: 'inventory-write',
    description: 'Write the codebase inventory for a plan',
    instructions:
      'Writes or replaces the inventory field on the plan. The inventory should be a ' +
      'markdown document describing affected files, types, interfaces, and patterns.',
    params: {
      planId: z.string().describe('Plan id'),
      inventory: z.string().describe('Inventory content (markdown)'),
    },
    permission: 'write',
    handler: async ({ planId, inventory }) => {
      return plansBook.patch(planId, { inventory, updatedAt: new Date().toISOString() });
    },
  });

  const scopeWriteTool = tool({
    name: 'scope-write',
    description: 'Write or replace the scope items for a plan',
    instructions:
      'Writes the full scope array. Each scope item has an id, description, rationale, ' +
      'and included flag.',
    params: {
      planId: z.string().describe('Plan id'),
      scope: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            rationale: z.string(),
            included: z.boolean(),
          }),
        )
        .describe('Scope items'),
    },
    permission: 'write',
    handler: async ({ planId, scope }) => {
      return plansBook.patch(planId, { scope, updatedAt: new Date().toISOString() });
    },
  });

  const decisionsWriteTool = tool({
    name: 'decisions-write',
    description: 'Write or replace the decisions for a plan',
    instructions:
      'Writes the full decisions array. Each decision has an id, scope references, question, ' +
      'options, and optional recommendation/rationale fields.',
    params: {
      planId: z.string().describe('Plan id'),
      decisions: z
        .array(
          z.object({
            id: z.string(),
            scope: z.array(z.string()),
            question: z.string(),
            context: z.string().optional(),
            options: z.record(z.string(), z.string()),
            recommendation: z.string().optional(),
            rationale: z.string().optional(),
            selected: z.string().optional(),
            patronOverride: z.string().optional(),
          }),
        )
        .describe('Decision items'),
    },
    permission: 'write',
    handler: async ({ planId, decisions }) => {
      return plansBook.patch(planId, { decisions, updatedAt: new Date().toISOString() });
    },
  });

  const observationsWriteTool = tool({
    name: 'observations-write',
    description: 'Write primer observations for a plan',
    instructions:
      'Writes or replaces the observations field. The observations array carries one record ' +
      'per atomic concern noticed during the planning pass. Each record has a plandoc-local ' +
      'id (convention: obs-1, obs-2, ...), a one-line commission-title style title, and a ' +
      'markdown body with tactical detail (file paths, symbols, preconditions). Downstream ' +
      'the astrolabe.observation-lift engine lifts each record into a draft top-level ' +
      'mandate writ (never a child of the originating mandate); each lifted writ carries an ' +
      'astrolabe.lifted-from provenance edge back to the originating mandate. When the plan ' +
      'yields two or more observations, the engine additionally groups them under a top-level ' +
      'observation-set container that parents the draft mandates. A curator then promotes ' +
      'each draft to open status.',
    params: {
      planId: z.string().describe('Plan id'),
      observations: z
        .array(
          z.object({
            id: z.string().min(1),
            title: z.string().min(1),
            body: z.string().min(1),
          }),
        )
        .describe('Observation records'),
    },
    permission: 'write',
    handler: async ({ planId, observations }) => {
      return plansBook.patch(planId, { observations, updatedAt: new Date().toISOString() });
    },
  });

  const specWriteTool = tool({
    name: 'spec-write',
    description: 'Write the generated specification for a plan',
    instructions:
      'Writes or replaces the spec field. The spec should be a markdown document ' +
      'containing the implementation specification.',
    params: {
      planId: z.string().describe('Plan id'),
      spec: z.string().describe('Specification content (markdown)'),
    },
    permission: 'write',
    handler: async ({ planId, spec }) => {
      return plansBook.patch(planId, { spec, updatedAt: new Date().toISOString() });
    },
  });

  // ── Apparatus ──────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks', 'clerk'],
      recommends: ['spider', 'loom', 'fabricator', 'oculus', 'ratchet', 'animator', 'clockworks'],

      supportKit: {
        books: {
          plans: { indexes: ['status', 'codex', 'createdAt'] },
        },

        linkKinds: [
          {
            id: 'astrolabe.lifted-from',
            description:
              'The source writ was lifted from the planning run of the target writ. Provenance edge: marks the originating mandate whose plan-and-ship rig produced this writ via the observation-lift engine.',
          },
        ],

        roles: {
          'sage-primer-reader': {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read'],
            strict: true,
            instructionsFile: 'sage-primer-reader.md',
          },
          'sage-primer-scoping': {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read'],
            strict: true,
            instructionsFile: 'sage-primer-scoping.md',
          },
          'sage-writer': {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read'],
            strict: true,
            instructionsFile: 'sage-writer.md',
          },
          'sage-primer-solo': {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read'],
            strict: true,
            instructionsFile: 'sage-primer-solo.md',
          },
          'sage-primer-attended': {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read'],
            strict: true,
            instructionsFile: 'sage-primer-attended.md',
          },
        } satisfies Record<string, KitRoleDefinition>,

        engines: {
          'astrolabe.plan-init': planInitEngine,
          'astrolabe.inventory-check': inventoryCheckEngine,
          'astrolabe.patron-anima': patronAnimaEngine,
          'astrolabe.decision-review': decisionReviewEngine,
          'astrolabe.plan-finalize': planFinalizeEngine,
          'astrolabe.observation-lift': observationLiftEngine,
          'astrolabe.reader-analyst': readerAnalystEngine,
        },

        rigTemplates: {
          'plan-and-ship': planAndShipRigTemplate,
        },

        rigTemplateMappings: {
          mandate: 'astrolabe.plan-and-ship',
        },

        tools: [
          planShowTool,
          planListTool,
          inventoryWriteTool,
          scopeWriteTool,
          decisionsWriteTool,
          observationsWriteTool,
          specWriteTool,
        ],

        pages: [
          { id: 'astrolabe', title: 'Astrolabe', dir: 'pages/astrolabe' },
        ],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const stacks = guild().apparatus<StacksApi>('stacks');
        plansBook = stacks.book<PlanDoc>('astrolabe', 'plans');

        // Register astrolabe's writ types with the Clerk's runtime registry.
        // Each config is an independent clone of mandate's six-state machine
        // (no shared helper) — `step` and `observation-set` carry the same
        // lifecycle as a built-in mandate. Registration must happen during
        // start() so the Clerk's startup-window seal does not slam shut on
        // us; the framework guarantees that astrolabe's start() runs after
        // the Clerk's start() because the apparatus declares
        // `requires: ['stacks', 'clerk']`.
        const clerk = guild().apparatus<ClerkApi>('clerk');

        const STEP_CONFIG: WritTypeConfig = {
          name: 'step',
          states: [
            { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
            { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
            { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
            { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
            { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
            { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
          ],
        };

        const OBSERVATION_SET_CONFIG: WritTypeConfig = {
          name: 'observation-set',
          states: [
            { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
            { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
            { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
            { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
            { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
            { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
          ],
        };

        clerk.registerWritType(STEP_CONFIG);
        clerk.registerWritType(OBSERVATION_SET_CONFIG);
      },
    },
  };
}

// Export resolveAstrolabeConfig / resolvePatronRole / resolvePredictedFilesThreshold
// for external use (lazy config access).
export { resolveAstrolabeConfig, resolvePatronRole, resolvePredictedFilesThreshold };
