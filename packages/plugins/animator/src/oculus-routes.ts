/**
 * Animator — custom Oculus API routes.
 *
 * Contributes:
 * - GET /api/animator/sessions — enriched session list with role, writ title, token usage
 * - GET /api/animator/session-transcript — session transcript and status
 * - GET /api/animator/session-stream — SSE stream of real-time session chunks
 *
 * Does NOT import from @shardworks/oculus-apparatus to avoid a circular
 * package dependency. The route shape is compatible with RouteContribution
 * from the Oculus types.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi, WhereCondition } from '@shardworks/stacks-apparatus';
import type { SessionDoc, AnimatorApi } from './types.ts';

/** Minimal inline type for transcript documents (avoids a full type import). */
interface TranscriptEntry {
  id: string;
  messages: Record<string, unknown>[];
  [key: string]: unknown;
}

/** Minimal inline type for writ documents (avoids importing from clerk). */
interface WritEntry {
  id: string;
  title: string;
  [key: string]: unknown;
}

export const animatorRoutes = [
  {
    method: 'GET',
    path: '/api/animator/sessions',
    handler: async (c: Context) => {
      const status = c.req.query('status');
      const from = c.req.query('from');
      const to = c.req.query('to');
      const limitStr = c.req.query('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : 50;

      const g = guild();
      const stacks = g.apparatus<StacksApi>('stacks');
      const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');

      const where: WhereCondition[] = [];
      if (status) where.push(['status', '=', status]);
      if (from) where.push(['startedAt', '>=', from]);
      if (to) where.push(['startedAt', '<=', to]);

      const sessions = await sessionsBook.find({
        where: where.length > 0 ? where : undefined,
        orderBy: ['startedAt', 'desc'],
        limit: Number.isFinite(limit) ? limit : 50,
      });

      // Collect unique writIds for batch resolution
      const writIds = new Set<string>();
      for (const s of sessions) {
        const writId = (s.metadata as Record<string, unknown> | undefined)?.writId;
        if (typeof writId === 'string') writIds.add(writId);
      }

      // Resolve writ titles gracefully — if clerk book is unavailable, skip
      const writTitles = new Map<string, string>();
      if (writIds.size > 0) {
        try {
          const writsBook = stacks.readBook<WritEntry>('clerk', 'writs');
          await Promise.all(
            [...writIds].map(async (id) => {
              try {
                const writ = await writsBook.get(id);
                if (writ) writTitles.set(id, writ.title);
              } catch {
                // Individual writ lookup failure — skip gracefully
              }
            }),
          );
        } catch {
          // Clerk book unavailable — all writTitles remain undefined
        }
      }

      const entries = sessions.map((s) => {
        const meta = s.metadata as Record<string, unknown> | undefined;
        const role = typeof meta?.role === 'string' ? meta.role : undefined;
        const writId = typeof meta?.writId === 'string' ? meta.writId : undefined;

        return {
          id: s.id,
          status: s.status,
          provider: s.provider,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          durationMs: s.durationMs,
          exitCode: s.exitCode,
          costUsd: s.costUsd,
          role,
          writId,
          writTitle: writId ? writTitles.get(writId) : undefined,
          tokenUsage: s.tokenUsage,
        };
      });

      return c.json(entries);
    },
  },
  {
    method: 'GET',
    path: '/api/animator/session-transcript',
    handler: async (c: Context) => {
      const sessionId = c.req.query('sessionId');

      if (!sessionId) {
        return c.json({ error: 'sessionId is required' }, 400);
      }

      const g = guild();
      const stacks = g.apparatus<StacksApi>('stacks');

      const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
      const session = await sessionsBook.get(sessionId);

      if (!session) {
        return c.json({ error: 'Session not found' }, 404);
      }

      if (session.status === 'running') {
        return c.json({ messages: [], sessionStatus: 'running' });
      }

      const transcriptsBook = stacks.readBook<TranscriptEntry>('animator', 'transcripts');
      const transcript = await transcriptsBook.get(sessionId);

      return c.json({
        messages: transcript?.messages ?? [],
        sessionStatus: session.status,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/animator/session-stream',
    handler: async (c: Context) => {
      const sessionId = c.req.query('sessionId');

      if (!sessionId) {
        return c.json({ error: 'sessionId is required' }, 400);
      }

      const g = guild();
      const stacks = g.apparatus<StacksApi>('stacks');

      const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
      const session = await sessionsBook.get(sessionId);

      if (!session) {
        return c.json({ error: 'Session not found' }, 404);
      }

      // For already-completed sessions, stream the full transcript and close.
      if (session.status !== 'running') {
        const transcriptsBook = stacks.readBook<TranscriptEntry>('animator', 'transcripts');
        const transcript = await transcriptsBook.get(sessionId);

        return streamSSE(c, async (stream) => {
          await stream.writeSSE({
            event: 'transcript',
            data: JSON.stringify({ messages: transcript?.messages ?? [] }),
          });
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ status: session.status }),
          });
        });
      }

      // For running sessions, subscribe to the Animator's in-process broadcaster.
      const animator = g.apparatus<AnimatorApi>('animator');
      const chunkStream = animator.subscribeToSession(sessionId);

      if (!chunkStream) {
        // No in-memory broadcaster (e.g. server restart). Return empty stream
        // so the UI can show a meaningful "no data" state.
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ status: 'running', noStream: true }),
          });
        });
      }

      return streamSSE(c, async (stream) => {
        try {
          for await (const chunk of chunkStream) {
            await stream.writeSSE({
              event: 'chunk',
              data: JSON.stringify(chunk),
            });
          }

          // All chunks consumed — session ended. Fetch and emit final transcript.
          const transcriptsBook = stacks.readBook<TranscriptEntry>('animator', 'transcripts');
          const transcript = await transcriptsBook.get(sessionId);
          await stream.writeSSE({
            event: 'transcript',
            data: JSON.stringify({ messages: transcript?.messages ?? [] }),
          });

          const finalSession = await sessionsBook.get(sessionId);
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ status: finalSession?.status ?? 'completed' }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: message }),
          });
        }
      });
    },
  },
];
