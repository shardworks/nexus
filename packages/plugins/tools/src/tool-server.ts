/**
 * Tool HTTP Server — serves all registered tools over HTTP.
 *
 * This is the foundation layer for detached sessions: session babysitters
 * proxy tool calls through this HTTP API back to the guild.
 *
 * Features:
 * - Maps tool names to REST routes (toolNameToRoute)
 * - Maps permission levels to HTTP methods (permissionToMethod)
 * - Session-scoped authorization for anima-callable tools, via an injected
 *   `authorize(sessionId, toolName)` resolver. The daemon wires this up
 *   to read the sessions book in The Stacks; tests can pass a mock.
 * - Zod param validation with error details
 *
 * There is no in-memory session registry. Authorization is delegated to
 * the caller-supplied `authorize` function — typically backed by the
 * Animator's sessions book in The Stacks.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { z } from 'zod';

import type { ToolDefinition } from './tool.ts';
import type { InstrumentariumApi } from './instrumentarium.ts';

// ── Public types ─────────────────────────────────────────────────────

/** Handle returned by startToolServer(), used to manage server lifecycle. */
export interface ToolServerHandle {
  /** The port the server is listening on. */
  port: number;
  /** The full URL of the server. */
  url: string;
  /** Gracefully close the server. */
  close(): Promise<void>;
}

/**
 * Authorize a tool call from a session-authenticated caller.
 *
 * Returns true if the session is allowed to call the given tool.
 * If not provided, the tool server allows any request that presents
 * a non-empty session id (useful for tests).
 */
export type ToolAuthorizer = (sessionId: string, toolName: string) => Promise<boolean> | boolean;

/** Options for startToolServer(). */
export interface ToolServerOptions {
  /** Port to listen on. Defaults to guild.json tools.serverPort or 7471. */
  port?: number;
  /** Authorization resolver for session-scoped tool calls. */
  authorize?: ToolAuthorizer;
}

/** Configuration block in guild.json under 'tools'. */
export interface ToolsConfig {
  serverPort?: number;
}

// ── Tool→REST mapping helpers ────────────────────────────────────────

/**
 * Convert a tool name to an HTTP route path.
 *
 * Splits on the first hyphen: 'writ-list' → '/api/writ/list'.
 * Single-segment names: 'signal' → '/api/signal'.
 */
export function toolNameToRoute(name: string): string {
  const idx = name.indexOf('-');
  if (idx === -1) return `/api/${name}`;
  return `/api/${name.slice(0, idx)}/${name.slice(idx + 1)}`;
}

/**
 * Map a permission level to an HTTP method.
 *
 * - read → GET
 * - write, admin → POST
 * - delete → DELETE
 * - undefined → GET
 * - unknown → POST
 */
export function permissionToMethod(permission: string | undefined): 'GET' | 'POST' | 'DELETE' {
  if (permission === undefined) return 'GET';
  const level = permission.includes(':')
    ? permission.slice(permission.lastIndexOf(':') + 1)
    : permission;
  if (level === 'read') return 'GET';
  if (level === 'write' || level === 'admin') return 'POST';
  if (level === 'delete') return 'DELETE';
  return 'POST';
}

// ── Query param coercion ─────────────────────────────────────────────

function isNumberSchema(schema: z.ZodTypeAny): boolean {
  let inner: z.ZodTypeAny = schema;
  if (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
  if (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodTypeAny;
  if (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
  return inner instanceof z.ZodNumber;
}

function isBooleanSchema(schema: z.ZodTypeAny): boolean {
  let inner: z.ZodTypeAny = schema;
  if (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
  if (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodTypeAny;
  if (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
  return inner instanceof z.ZodBoolean;
}

export function coerceParams(
  shape: Record<string, z.ZodTypeAny>,
  params: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...params };
  for (const [key, schema] of Object.entries(shape)) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    if (isNumberSchema(schema)) {
      result[key] = Number(value);
    } else if (isBooleanSchema(schema)) {
      result[key] = value === 'true';
    }
  }
  return result;
}

/**
 * Override the default format for HTTP-context tool calls.
 *
 * Tools that expose a `format` enum (typically `'text' | 'json'`) generally
 * default to `'text'` for human CLI consumption. HTTP callers — Oculus pages,
 * detached-session proxies, anything reading the REST surface — always want
 * structured JSON. This helper injects `format: 'json'` when the caller did
 * not supply an explicit value AND the tool's schema both declares a `format`
 * field and accepts `'json'` as a valid option.
 *
 * The check is intentionally conservative: if the tool's `format` enum does
 * not include `'json'`, or the caller already passed a value, the params are
 * returned unchanged. Tools without a `format` field are unaffected.
 *
 * Without this override, every REST consumer of a text-defaulted tool would
 * have to remember to append `?format=json`, and forgetting silently returns
 * a CLI-rendered string in place of a structured object — a regression class
 * that has bitten the Oculus writs/spider/astrolabe pages historically.
 */
export function applyHttpFormatDefault(
  shape: Record<string, z.ZodTypeAny>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (params.format !== undefined) return params;
  const formatSchema = shape.format;
  if (!formatSchema) return params;

  let inner: z.ZodTypeAny = formatSchema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  if (!(inner instanceof z.ZodEnum)) return params;

  const options = inner.options as readonly string[];
  if (!options.includes('json')) return params;

  return { ...params, format: 'json' };
}

// ── Session authorization header ─────────────────────────────────────

const SESSION_ID_HEADER = 'x-session-id';

// ── Tool server ──────────────────────────────────────────────────────

/**
 * Determine if a tool requires session authorization.
 *
 * Patron-callable tools (or tools with no callableBy restriction) do NOT
 * require session auth. Only tools exclusively callable by non-patron callers
 * (e.g., anima-only) require a session ID.
 */
function requiresSessionAuth(definition: ToolDefinition): boolean {
  if (!definition.callableBy) return false; // unrestricted → no session auth
  if (definition.callableBy.includes('patron')) return false; // patron-accessible → no session auth
  return true; // anima-only, library-only, etc. → requires session auth
}

/**
 * Create a Hono app that serves all registered tools over HTTP.
 *
 * Exported for testing — the public API is startToolServer() on InstrumentariumApi.
 *
 * Session authorization is delegated to the optional `authorize` callback.
 * When no `authorize` is provided, any request that presents an `X-Session-Id`
 * header is allowed (useful for tests). Requests to session-scoped tools
 * without an `X-Session-Id` header are always rejected with 401.
 */
export function createToolServerApp(
  api: InstrumentariumApi,
  authorize?: ToolAuthorizer,
): Hono {
  const app = new Hono();

  // ── Tool routes ───────────────────────────────────────────────────

  const allTools = api.list();
  const registeredRoutes = new Set<string>();

  for (const resolved of allTools) {
    const { definition } = resolved;
    const routePath = toolNameToRoute(definition.name);
    const method = permissionToMethod(definition.permission);
    const routeKey = `${method} ${routePath}`;

    // Skip duplicates (last-write-wins already handled by registry)
    if (registeredRoutes.has(routeKey)) continue;
    registeredRoutes.add(routeKey);

    const needsAuth = requiresSessionAuth(definition);
    const shape = definition.params.shape as Record<string, z.ZodTypeAny>;

    const handler = async (c: import('hono').Context) => {
      // Session authorization check
      if (needsAuth) {
        const sessionId = c.req.header(SESSION_ID_HEADER);
        if (!sessionId) {
          return c.json({ error: 'X-Session-Id header required for this tool' }, 401);
        }
        if (authorize) {
          let allowed: boolean;
          try {
            allowed = await authorize(sessionId, definition.name);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: `Authorization check failed: ${message}` }, 500);
          }
          if (!allowed) {
            return c.json({ error: 'Session not authorized to call this tool' }, 403);
          }
        }
      }

      try {
        let params: unknown;
        if (method === 'GET') {
          const rawQuery = c.req.query();
          const coerced = coerceParams(shape, rawQuery);
          const withJsonDefault = applyHttpFormatDefault(shape, coerced);
          params = definition.params.parse(withJsonDefault);
        } else {
          const body = await c.req.json();
          const withJsonDefault = applyHttpFormatDefault(
            shape,
            (body ?? {}) as Record<string, unknown>,
          );
          params = definition.params.parse(withJsonDefault);
        }
        const result = await definition.handler(params as Record<string, unknown>);
        return c.json(result as object);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: err.message, details: err.issues }, 400);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    };

    if (method === 'GET') {
      app.get(routePath, handler);
    } else if (method === 'POST') {
      app.post(routePath, handler);
    } else if (method === 'DELETE') {
      app.delete(routePath, handler);
    }
  }

  return app;
}

/**
 * Start the tool HTTP server.
 *
 * Binds to 127.0.0.1 on the specified port. Returns a handle for
 * lifecycle management.
 */
export async function startToolServer(
  api: InstrumentariumApi,
  port: number,
  authorize?: ToolAuthorizer,
): Promise<ToolServerHandle> {
  const app = createToolServerApp(api, authorize);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, port, hostname: '127.0.0.1' },
      () => resolve(s as unknown as Server),
    ) as unknown as Server;
    s.on('error', reject);
  });

  // Read the actual port (important when port 0 is passed for OS-assigned ports)
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
