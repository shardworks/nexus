/**
 * Spider — custom Oculus API routes.
 *
 * Contributes:
 * - GET /api/spider/config — aggregated snapshot of Spider config
 * - GET /api/spider/session-transcript — session transcript and status
 * - GET /api/spider/session-stream — SSE stream of real-time session chunks
 *
 * Does NOT import from @shardworks/oculus-apparatus to avoid a circular
 * package dependency. The route shape is compatible with RouteContribution
 * from the Oculus types.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { guild } from '@shardworks/nexus-core';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc, AnimatorApi } from '@shardworks/animator-apparatus';
import type { SpiderApi } from './types.ts';

/** Minimal inline type for transcript documents (avoids adding a full animator import for a type). */
interface TranscriptEntry {
  id: string;
  messages: Record<string, unknown>[];
  [key: string]: unknown;
}

export const spiderRoutes = [
  {
    method: 'GET',
    path: '/api/spider/config',
    handler: (c: Context) => {
      const g = guild();
      const fabricator = g.apparatus<FabricatorApi>('fabricator');
      const spider = g.apparatus<SpiderApi>('spider');

      return c.json({
        templates: spider.listTemplates(),
        templateMappings: spider.listTemplateMappings(),
        engineDesigns: fabricator.listEngineDesigns(),
        blockTypes: spider.listBlockTypes(),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/spider/session-transcript',
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
    path: '/api/spider/session-stream',
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
        // The session is marked running in Stacks but has no in-memory broadcaster
        // (e.g. a server restart happened). Return an empty stream so the UI can
        // show a meaningful "no data" state and fall back gracefully.
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

          // All chunks consumed — session has ended. Fetch and emit final transcript.
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
