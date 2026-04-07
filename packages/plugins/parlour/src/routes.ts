/**
 * Parlour custom API routes.
 *
 * Contributed to the Oculus via supportKit.routes.
 * Provides endpoints for the Parlour page:
 *   GET  /api/parlour/roles           — list all system roles
 *   GET  /api/parlour/conversations   — list conversations for a role
 *   POST /api/parlour/create          — create a conversation
 *   POST /api/parlour/turn            — take a turn (SSE streaming)
 *
 * No Oculus types are imported — the Oculus duck-types the supportKit
 * via `as OculusKit`. Route handlers receive Hono Context objects.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { guild } from '@shardworks/nexus-core';
import type { LoomApi } from '@shardworks/loom-apparatus';
import type { ParlourApi } from './types.ts';

// ── Type stubs ────────────────────────────────────────────────────────

/** Duck-typed RouteContribution — no import from Oculus needed. */
interface RouteContribution {
  method: string;
  path: string;
  handler: (c: Context) => Response | Promise<Response>;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Determine the cwd for a new conversation.
 * If codexName is provided and the codexes apparatus is available,
 * opens a draft worktree and returns its path.
 * Otherwise falls back to guild().home.
 */
async function resolveCwd(codexName?: string): Promise<string> {
  if (codexName) {
    try {
      // Conditionally access the codexes apparatus
      const scriptorium = guild().apparatus<{
        openDraft(req: { codexName: string }): Promise<{ path: string }>;
      }>('codexes');
      const draft = await scriptorium.openDraft({ codexName });
      return draft.path;
    } catch {
      // Codexes apparatus not installed or failed — fall back to guild home
    }
  }
  return guild().home;
}

// ── Route handlers ────────────────────────────────────────────────────

/** GET /api/parlour/roles — list all system roles */
function rolesRoute(): RouteContribution {
  return {
    method: 'GET',
    path: '/api/parlour/roles',
    handler: (c: Context) => {
      const loom = guild().apparatus<LoomApi>('loom');
      const roles = loom.listRoles();
      return c.json(roles);
    },
  };
}

/** GET /api/parlour/conversations — list conversations for a role */
function conversationsRoute(): RouteContribution {
  return {
    method: 'GET',
    path: '/api/parlour/conversations',
    handler: async (c: Context) => {
      const role = c.req.query('role');
      if (!role) {
        return c.json({ error: 'Missing required query param: role' }, 400);
      }
      const status = (c.req.query('status') as 'active' | 'concluded' | 'abandoned') ?? 'active';

      const parlour = guild().apparatus<ParlourApi>('parlour');
      const allConvs = await parlour.list({ status, kind: 'consult', limit: 50 });

      // Filter to conversations that have a participant with this role name
      const filtered = allConvs.filter((conv) =>
        conv.participants.some((p) => p.name === role),
      );

      // Determine display title for each conversation
      const results = await Promise.all(
        filtered.map(async (conv) => {
          let title: string;

          if (conv.topic && conv.topic.trim().length > 0) {
            title = conv.topic;
          } else {
            // Look for first human message
            const detail = await parlour.show(conv.id);
            const humanTurn = detail?.turns.find(
              (t) => t.sessionId === null && t.message !== null,
            );

            if (humanTurn?.message) {
              title = humanTurn.message.length > 60
                ? humanTurn.message.slice(0, 60) + '…'
                : humanTurn.message;
            } else {
              // Fall back to formatted date
              title = new Date(conv.createdAt).toLocaleString();
            }
          }

          return {
            id: conv.id,
            title,
            createdAt: conv.createdAt,
            turnCount: conv.turnCount,
            totalCostUsd: conv.totalCostUsd,
          };
        }),
      );

      return c.json(results);
    },
  };
}

/** POST /api/parlour/create — create a new consult conversation */
function createRoute(): RouteContribution {
  return {
    method: 'POST',
    path: '/api/parlour/create',
    handler: async (c: Context) => {
      const body = await c.req.json() as { role?: string; codexName?: string };
      const { role, codexName } = body;

      if (!role) {
        return c.json({ error: 'Missing required field: role' }, 400);
      }

      const cwd = await resolveCwd(codexName);
      const parlour = guild().apparatus<ParlourApi>('parlour');

      const result = await parlour.create({
        kind: 'consult',
        participants: [
          { kind: 'human', name: 'User' },
          { kind: 'anima', name: role },
        ],
        cwd,
      });

      return c.json({
        conversationId: result.conversationId,
        participants: result.participants,
      });
    },
  };
}

/** POST /api/parlour/turn — take a turn with SSE streaming */
function turnRoute(): RouteContribution {
  return {
    method: 'POST',
    path: '/api/parlour/turn',
    handler: async (c: Context) => {
      // Parse and validate body BEFORE entering the SSE stream so we can
      // return proper HTTP 400 responses for invalid input.
      let body: {
        conversationId?: string;
        role?: string;
        message?: string;
        codexName?: string;
      };

      try {
        body = await c.req.json() as typeof body;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      const { conversationId: reqConversationId, role, message, codexName } = body;

      if (!reqConversationId && !role) {
        return c.json({ error: 'Either conversationId or role is required' }, 400);
      }
      if (!message || message.trim() === '') {
        return c.json({ error: 'message is required and must not be empty' }, 400);
      }

      return streamSSE(c, async (stream) => {
        const parlour = guild().apparatus<ParlourApi>('parlour');

        let conversationId: string;
        let humanParticipantId: string;
        let animaParticipantId: string;

        try {
          if (reqConversationId) {
            // Use existing conversation
            conversationId = reqConversationId;
            const detail = await parlour.show(conversationId);
            if (!detail) {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({ error: `Conversation "${conversationId}" not found` }),
              });
              return;
            }
            const human = detail.participants.find((p) => p.kind === 'human');
            const anima = detail.participants.find((p) => p.kind === 'anima');
            if (!human || !anima) {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({ error: 'Conversation missing human or anima participant' }),
              });
              return;
            }
            humanParticipantId = human.id;
            animaParticipantId = anima.id;
          } else {
            // Create new conversation lazily
            const cwd = await resolveCwd(codexName);
            const created = await parlour.create({
              kind: 'consult',
              participants: [
                { kind: 'human', name: 'User' },
                { kind: 'anima', name: role! },
              ],
              cwd,
            });

            conversationId = created.conversationId;
            const human = created.participants.find((p) => p.kind === 'human');
            const anima = created.participants.find((p) => p.kind === 'anima');
            humanParticipantId = human!.id;
            animaParticipantId = anima!.id;

            // Emit conversation_created event
            await stream.writeSSE({
              event: 'conversation_created',
              data: JSON.stringify({
                conversationId,
                participants: created.participants,
              }),
            });
          }

          // Take human turn
          await parlour.takeTurn({
            conversationId,
            participantId: humanParticipantId,
            message: message.trim(),
          });

          // Take anima turn with streaming
          const { chunks, result } = parlour.takeTurnStreaming({
            conversationId,
            participantId: animaParticipantId,
            message: message.trim(),
          });

          // Stream chunks to client
          for await (const chunk of chunks) {
            await stream.writeSSE({
              event: 'chunk',
              data: JSON.stringify(chunk),
            });
          }

          // Await result to ensure turn recording completes
          await result;
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: errMessage }),
          });
        }
      });
    },
  };
}

// ── Exported routes array ─────────────────────────────────────────────

export const parlourRoutes: RouteContribution[] = [
  rolesRoute(),
  conversationsRoute(),
  createRoute(),
  turnRoute(),
];
