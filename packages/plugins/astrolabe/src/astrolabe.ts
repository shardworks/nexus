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
import type { KitRoleDefinition } from '@shardworks/loom-apparatus';
import type { RigTemplate } from '@shardworks/spider-apparatus';
import { z } from 'zod';

import type {
  AstrolabeApi,
  AstrolabeConfig,
  PlanDoc,
  PlanFilters,
} from './types.ts';

// DecisionAnalysis Zod schema — mirrors the DecisionAnalysis interface in types.ts.
const decisionAnalysisSchema = z.object({
  category: z.enum(['product', 'api', 'implementation']).optional(),
  observable: z.boolean().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  stakes: z.enum(['low', 'high']).optional(),
});

import {
  createPlanInitEngine,
  createInventoryCheckEngine,
  createDecisionReviewEngine,
  createSpecPublishEngine,
} from './engines/index.ts';

// ── Config resolver ──────────────────────────────────────────────────

function resolveAstrolabeConfig(): AstrolabeConfig {
  return guild().guildConfig().astrolabe ?? {};
}

// ── Rig template ─────────────────────────────────────────────────────

const planningTemplate: RigTemplate = {
  engines: [
    {
      id: 'plan-init',
      designId: 'astrolabe.plan-init',
      upstream: [],
      givens: { writ: '${writ}' },
    },
    {
      id: 'draft',
      designId: 'draft',
      upstream: ['plan-init'],
      givens: { writ: '${writ}' },
    },
    {
      id: 'reader',
      designId: 'anima-session',
      upstream: ['draft'],
      givens: {
        role: 'astrolabe.sage',
        prompt:
          'MODE: READER\n\nPlan ID: ${yields.plan-init.planId}\n\n' +
          'You are beginning a new planning session. Use plan-show to read the plan, ' +
          'then inventory the codebase and write the inventory using inventory-write.',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
      },
    },
    {
      id: 'inventory-check',
      designId: 'astrolabe.inventory-check',
      upstream: ['reader'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'analyst',
      designId: 'anima-session',
      upstream: ['inventory-check'],
      givens: {
        role: 'astrolabe.sage',
        prompt:
          'MODE: ANALYST\n\nPlan ID: ${yields.plan-init.planId}\n\n' +
          'You are continuing the reader conversation. Use plan-show to read the current ' +
          'plan state, then produce scope, decisions, and observations using the write tools.',
        cwd: '${yields.draft.path}',
        conversationId: '${yields.reader.conversationId}',
        writ: '${writ}',
      },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['analyst'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'spec-writer',
      designId: 'anima-session',
      upstream: ['decision-review'],
      givens: {
        role: 'astrolabe.sage',
        prompt:
          'MODE: WRITER\n\nPlan ID: ${yields.plan-init.planId}\n\n' +
          'You are continuing the analyst conversation. Use plan-show to read the full ' +
          'plan including patron-reviewed decisions, then write the specification using spec-write.' +
          '\n\nDecision summary:\n${yields.decision-review.decisionSummary}',
        cwd: '${yields.draft.path}',
        conversationId: '${yields.analyst.conversationId}',
        writ: '${writ}',
      },
    },
    {
      id: 'spec-publish',
      designId: 'astrolabe.spec-publish',
      upstream: ['spec-writer'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'seal',
      designId: 'seal',
      upstream: ['spec-publish'],
      givens: { abandon: true },
    },
  ],
  resolutionEngine: 'spec-writer',
};

// ── Factory ──────────────────────────────────────────────────────────

export function createAstrolabe(): Plugin {
  let plansBook: Book<PlanDoc>;

  // ── Engines ────────────────────────────────────────────────────

  const planInitEngine = createPlanInitEngine(() => plansBook);
  const inventoryCheckEngine = createInventoryCheckEngine(() => plansBook);
  const decisionReviewEngine = createDecisionReviewEngine(() => plansBook);
  const specPublishEngine = createSpecPublishEngine(() => plansBook);

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
      'observations, and spec fields. The planId is the brief writ ID.',
    params: {
      planId: z.string().describe('Plan id (same as the brief writ id)'),
    },
    permission: 'astrolabe:read',
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
    permission: 'astrolabe:read',
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
    permission: 'astrolabe:write',
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
    permission: 'astrolabe:write',
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
            analysis: decisionAnalysisSchema.optional(),
          }),
        )
        .describe('Decision items'),
    },
    permission: 'astrolabe:write',
    handler: async ({ planId, decisions }) => {
      return plansBook.patch(planId, { decisions, updatedAt: new Date().toISOString() });
    },
  });

  const observationsWriteTool = tool({
    name: 'observations-write',
    description: 'Write analyst observations for a plan',
    instructions:
      'Writes or replaces the observations field. The observations should be a markdown ' +
      'document noting refactoring opportunities, risks, and conventions.',
    params: {
      planId: z.string().describe('Plan id'),
      observations: z.string().describe('Observations content (markdown)'),
    },
    permission: 'astrolabe:write',
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
    permission: 'astrolabe:write',
    handler: async ({ planId, spec }) => {
      return plansBook.patch(planId, { spec, updatedAt: new Date().toISOString() });
    },
  });

  // ── Apparatus ──────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks', 'clerk'],
      recommends: ['spider', 'loom', 'fabricator', 'oculus'],

      supportKit: {
        books: {
          plans: { indexes: ['status', 'codex', 'createdAt'] },
        },

        writTypes: [
          { name: 'brief', description: 'A patron brief triggering the planning pipeline' },
        ],

        roles: {
          sage: {
            permissions: ['astrolabe:read', 'astrolabe:write', 'clerk:read'],
            strict: true,
            instructionsFile: 'sage.md',
          },
        } satisfies Record<string, KitRoleDefinition>,

        engines: {
          'astrolabe.plan-init': planInitEngine,
          'astrolabe.inventory-check': inventoryCheckEngine,
          'astrolabe.decision-review': decisionReviewEngine,
          'astrolabe.spec-publish': specPublishEngine,
        },

        rigTemplates: {
          planning: planningTemplate,
        },

        rigTemplateMappings: {
          brief: 'astrolabe.planning',
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
      },
    },
  };
}

// Export resolveAstrolabeConfig for external use (lazy config access)
export { resolveAstrolabeConfig };
