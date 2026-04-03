/**
 * Dashboard HTTP server.
 *
 * Serves the web UI at / and REST API endpoints at /api/*.
 * Uses only Node built-ins — no express or other dependencies.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { guild } from '@shardworks/nexus-core';
import type { ClerkApi, WritDoc, WritStatus } from '@shardworks/clerk-apparatus';
import type { StacksApi, WhereClause } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from './types.ts';
import type { RigDoc } from './rig-types.ts';
import { getDashboardHtml } from './html.ts';

// ── Types for codexes (optional apparatus) ────────────────────────

interface CodexRecord {
  name: string;
  remoteUrl: string;
  cloneStatus: string;
  activeDrafts: number;
}

interface DraftRecord {
  id: string;
  codexName: string;
  branch: string;
  path: string;
  createdAt: string;
  associatedWith?: string;
}

interface ScriptoriumApi {
  list(): Promise<CodexRecord[]>;
  listDrafts(codexName?: string): Promise<DraftRecord[]>;
}

// ── Helpers ───────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function error(res: ServerResponse, msg: string, status = 500): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseQS(url: string): Record<string, string> {
  const qm = url.indexOf('?');
  if (qm < 0) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(qm + 1)));
}

function pathname(url: string): string {
  const qm = url.indexOf('?');
  return qm < 0 ? url : url.slice(0, qm);
}

function tryApparatus<T>(name: string): T | null {
  try { return guild().apparatus<T>(name); }
  catch { return null; }
}

// ── Request router ────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path   = pathname(req.url ?? '/');
  const qs     = parseQS(req.url ?? '');

  // ── Web UI ──────────────────────────────────────────────────────
  if (path === '/' || path === '/index.html') {
    const html = getDashboardHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  // ── API: Overview ───────────────────────────────────────────────
  if (path === '/api/overview' && method === 'GET') {
    try {
      const g = guild();
      const config = g.guildConfig();
      const plugins = [
        ...g.kits().map(k => ({ id: k.id, version: k.version, type: 'kit' as const })),
        ...g.apparatuses().map(a => ({ id: a.id, version: a.version, type: 'apparatus' as const })),
      ].sort((a, b) => a.id.localeCompare(b.id));

      const counts: Record<string, unknown> = {};

      const clerk = tryApparatus<ClerkApi>('clerk');
      if (clerk) {
        counts.writs    = await clerk.count();
        counts.ready    = await clerk.count({ status: 'ready' });
        counts.active   = await clerk.count({ status: 'active' });
      }

      const stacks = tryApparatus<StacksApi>('stacks');
      if (stacks) {
        try {
          const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
          counts.sessions        = await sessions.count();
          counts.runningSessions = await sessions.count([['status', '=', 'running']]);
        } catch { /* animator not installed */ }

        try {
          const rigs = stacks.readBook<RigDoc>('spider', 'rigs');
          counts.rigs        = await rigs.count();
          counts.runningRigs = await rigs.count([['status', '=', 'running']]);
        } catch { /* spider not installed */ }
      }

      const scriptorium = tryApparatus<ScriptoriumApi>('codexes');
      if (scriptorium) {
        const codexList = await scriptorium.list();
        counts.codexes     = codexList.length;
        counts.codexNames  = codexList.map(c => c.name);
      }

      json(res, { guild: config, plugins, counts });
    } catch (e) {
      error(res, (e as Error).message);
    }
    return;
  }

  // ── API: Writs ──────────────────────────────────────────────────
  if (path === '/api/writs' && method === 'GET') {
    const clerk = tryApparatus<ClerkApi>('clerk');
    if (!clerk) { error(res, 'Clerk apparatus not installed', 404); return; }
    try {
      const filters: { status?: WritStatus; type?: string; limit?: number; offset?: number } = {};
      if (qs.status) filters.status = qs.status as WritStatus;
      if (qs.type)   filters.type   = qs.type;
      filters.limit  = qs.limit  ? parseInt(qs.limit,  10) : 20;
      filters.offset = qs.offset ? parseInt(qs.offset, 10) : 0;

      const [writs, total] = await Promise.all([
        clerk.list(filters),
        clerk.count({ status: filters.status, type: filters.type }),
      ]);

      // Derive declared types from guild config
      const clerkConfig = guild().guildConfig().clerk;
      const types = ['mandate', ...(clerkConfig?.writTypes?.map(t => t.name) ?? [])];

      json(res, { writs, total, types });
    } catch (e) {
      error(res, (e as Error).message);
    }
    return;
  }

  if (path === '/api/writs' && method === 'POST') {
    const clerk = tryApparatus<ClerkApi>('clerk');
    if (!clerk) { error(res, 'Clerk apparatus not installed', 404); return; }
    try {
      const body = await readBody(req) as { title: string; body: string; type?: string; codex?: string };
      const writ = await clerk.post({
        title: body.title,
        body:  body.body,
        ...(body.type  ? { type:  body.type  } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
      });
      json(res, writ, 201);
    } catch (e) {
      error(res, (e as Error).message, 400);
    }
    return;
  }

  // ── API: Writ transition ─────────────────────────────────────────
  const transMatch = path.match(/^\/api\/writs\/([^/]+)\/transition$/);
  if (transMatch && method === 'POST') {
    const clerk = tryApparatus<ClerkApi>('clerk');
    if (!clerk) { error(res, 'Clerk apparatus not installed', 404); return; }
    try {
      const id = transMatch[1];
      const body = await readBody(req) as { to: WritStatus; resolution?: string };
      const fields: Partial<WritDoc> = {};
      if (body.resolution) fields.resolution = body.resolution;
      const writ = await clerk.transition(id, body.to, Object.keys(fields).length ? fields : undefined);
      json(res, writ);
    } catch (e) {
      error(res, (e as Error).message, 400);
    }
    return;
  }

  // ── API: Sessions ────────────────────────────────────────────────
  if (path === '/api/sessions' && method === 'GET') {
    const stacks = tryApparatus<StacksApi>('stacks');
    if (!stacks) { json(res, { sessions: [], total: 0 }); return; }
    try {
      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const limit  = qs.limit  ? parseInt(qs.limit,  10) : 20;
      const offset = qs.offset ? parseInt(qs.offset, 10) : 0;
      const where: WhereClause | undefined = qs.status
        ? [['status', '=', qs.status]]
        : undefined;
      const [rows, total] = await Promise.all([
        sessions.find({ where, orderBy: ['startedAt', 'desc'], limit, offset }),
        sessions.count(where),
      ]);
      json(res, { sessions: rows, total });
    } catch (e) {
      json(res, { sessions: [], total: 0 });
    }
    return;
  }

  // ── API: Rigs ────────────────────────────────────────────────────
  if (path === '/api/rigs' && method === 'GET') {
    const stacks = tryApparatus<StacksApi>('stacks');
    if (!stacks) { json(res, { rigs: [] }); return; }
    try {
      const rigs = stacks.readBook<RigDoc>('spider', 'rigs');
      const where: WhereClause | undefined = qs.status
        ? [['status', '=', qs.status]]
        : undefined;
      const rows = await rigs.find({
        where,
        orderBy: ['id', 'desc'],
        limit: 100,
      });
      json(res, { rigs: rows });
    } catch (e) {
      json(res, { rigs: [] });
    }
    return;
  }

  // ── API: Codexes ─────────────────────────────────────────────────
  if (path === '/api/codexes' && method === 'GET') {
    const scriptorium = tryApparatus<ScriptoriumApi>('codexes');
    if (!scriptorium) { json(res, { codexes: [], drafts: [] }); return; }
    try {
      const [codexes, drafts] = await Promise.all([
        scriptorium.list(),
        scriptorium.listDrafts(),
      ]);
      json(res, { codexes, drafts });
    } catch (e) {
      error(res, (e as Error).message);
    }
    return;
  }

  // ── 404 ──────────────────────────────────────────────────────────
  error(res, 'Not found', 404);
}

// ── Server factory ────────────────────────────────────────────────

export interface DashboardServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(port: number): Promise<DashboardServer> {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) {
        error(res, (e as Error).message ?? 'Internal error');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const addr = server.address() as { port: number };
  const actualPort = addr.port;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }),
  };
}
