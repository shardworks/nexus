/**
 * Spider — custom Oculus API routes.
 *
 * Contributes:
 * - GET /api/spider/config — aggregated snapshot of Spider config
 * - GET /api/spider/session-transcript — session transcript and status
 *
 * Does NOT import from @shardworks/oculus-apparatus to avoid a circular
 * package dependency. The route shape is compatible with RouteContribution
 * from the Oculus types.
 */

import type { Context } from 'hono';
import { guild } from '@shardworks/nexus-core';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '@shardworks/animator-apparatus';
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
];
