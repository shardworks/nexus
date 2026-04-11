/**
 * The Oculus — web dashboard apparatus.
 *
 * Serves a web dashboard via Hono. Plugins contribute pages as static asset
 * directories and custom API routes through kit contributions. Guild tools are
 * automatically exposed as REST endpoints.
 */

import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { z } from "zod";

import type { Plugin, StartupContext } from "@shardworks/nexus-core";
import { guild, VERSION } from "@shardworks/nexus-core";
import type { InstrumentariumApi } from "@shardworks/tools-apparatus";
import { tool, isToolDefinition } from "@shardworks/tools-apparatus";

import type {
  OculusApi,
  OculusConfig,
  OculusKit,
  PageContribution,
  RouteContribution,
} from "./types.ts";

// ── MIME types ────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ── Tool→REST mapping helpers ─────────────────────────────────────────

export function toolNameToRoute(name: string): string {
  const idx = name.indexOf("-");
  if (idx === -1) return `/api/${name}`;
  return `/api/${name.slice(0, idx)}/${name.slice(idx + 1)}`;
}

export function permissionToMethod(
  permission: string | undefined,
): "GET" | "POST" | "DELETE" {
  if (permission === undefined) return "GET";
  const level = permission.includes(":")
    ? permission.slice(permission.lastIndexOf(":") + 1)
    : permission;
  if (level === "read") return "GET";
  if (level === "write" || level === "admin") return "POST";
  if (level === "delete") return "DELETE";
  return "POST";
}

// ── Query param coercion ──────────────────────────────────────────────

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
    if (typeof value !== "string") continue;
    if (isNumberSchema(schema)) {
      result[key] = Number(value);
    } else if (isBooleanSchema(schema)) {
      result[key] = value === "true";
    }
  }
  return result;
}

// ── Chrome injection ─────────────────────────────────────────────────

export function injectChrome(
  html: string,
  stylesheetPath: string,
  navHtml: string,
): string {
  // Check for </head> case-insensitively
  const headCloseMatch = html.match(/<\/head>/i);
  const bodyOpenMatch = html.match(/<body[^>]*>/i);

  // If neither tag present, return unmodified
  if (!headCloseMatch && !bodyOpenMatch) return html;

  let result = html;

  // Insert stylesheet link before </head>
  if (headCloseMatch && headCloseMatch.index !== undefined) {
    const idx = headCloseMatch.index;
    result =
      result.slice(0, idx) +
      `<link rel="stylesheet" href="${stylesheetPath}">` +
      result.slice(idx);
  }

  // Insert nav after <body...>
  // Need to recalculate position after potential head insertion
  const bodyMatch = result.match(/<body[^>]*>/i);
  if (bodyMatch && bodyMatch.index !== undefined) {
    const idx = bodyMatch.index + bodyMatch[0].length;
    result = result.slice(0, idx) + navHtml + result.slice(idx);
  }

  return result;
}

function buildNavHtml(pages: PageContribution[]): string {
  const pageLinks = pages
    .map((p) => `<a href="/pages/${p.id}/">${p.title}</a>`)
    .join("\n  ");
  return `<nav id="oculus-nav">
  <a href="/">Guild</a>
  ${pageLinks}
</nav>`;
}

// ── HTML escaping ─────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Tool param extraction (reimplemented from tools-show) ────────────

interface ParamInfo {
  type: string;
  description: string | null;
  optional: boolean;
}

function zodTypeToJsonType(zodType: z.ZodType): string {
  if (zodType instanceof z.ZodString) return "string";
  if (zodType instanceof z.ZodNumber) return "number";
  if (zodType instanceof z.ZodBoolean) return "boolean";
  if (zodType instanceof z.ZodArray) return "array";
  if (zodType instanceof z.ZodObject) return "object";
  if (zodType instanceof z.ZodEnum) return "string";
  if (zodType instanceof z.ZodLiteral) return typeof zodType._def.values[0];
  if (zodType instanceof z.ZodUnion) return "union";
  if (zodType instanceof z.ZodNullable)
    return zodTypeToJsonType(zodType.unwrap() as z.ZodType);
  return "unknown";
}

function extractSingleParam(zodType: z.ZodType): ParamInfo {
  let isOptional = false;
  let inner: z.ZodType = zodType;

  if (inner instanceof z.ZodOptional) {
    isOptional = true;
    inner = inner.unwrap() as z.ZodType;
  }
  if (inner instanceof z.ZodDefault) {
    isOptional = true;
    inner = inner.unwrap() as z.ZodType;
  }

  return {
    type: zodTypeToJsonType(inner),
    description: inner.description ?? null,
    optional: isOptional,
  };
}

function extractParams(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, ParamInfo> {
  const shape = schema.shape;
  const result: Record<string, ParamInfo> = {};
  for (const [key, zodType] of Object.entries(shape)) {
    result[key] = extractSingleParam(zodType as z.ZodType);
  }
  return result;
}

// ── Apparatus factory ─────────────────────────────────────────────────

export function createOculus(): Plugin {
  let serverPort = 7470;
  let server: Server | null = null;
  let honoApp: Hono | null = null;

  const api: OculusApi = {
    port(): number {
      return serverPort;
    },
    startServer(): Promise<void> {
      return startServer();
    },
    stopServer(): Promise<void> {
      return stopServer();
    },
  };

  /** Start the HTTP server (called explicitly via the oculus tool). */
  async function startServer(): Promise<void> {
    if (server) return; // already running
    if (!honoApp)
      throw new Error(
        "[oculus] Cannot start server — apparatus not initialized",
      );

    const app = honoApp;
    const port = serverPort;
    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, port }, () => {
        console.log(`[oculus] Listening on http://localhost:${port}`);
        resolve();
      }) as Server;
      server.on("error", reject);
    });
  }

  /** Stop the HTTP server gracefully. Idempotent. */
  async function stopServer(): Promise<void> {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return {
    apparatus: {
      requires: ["tools"],
      consumes: ["pages", "routes"],
      provides: api,

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        const oculusConfig: OculusConfig = g.guildConfig().oculus ?? {};
        serverPort = oculusConfig.port ?? 7470;

        const app = new Hono();
        honoApp = app;

        // Track registered pages and custom route paths
        const pages: PageContribution[] = [];
        const customRouteKeys = new Set<string>();
        const mappedToolRoutes = new Set<string>();

        // ── Custom route registration helper ─────────────────────────
        function registerCustomRoute(
          route: RouteContribution,
          pluginId: string,
        ): void {
          if (!route.path.startsWith("/api/")) {
            console.warn(
              `[oculus] Custom route "${route.path}" from "${pluginId}" must start with /api/ — skipped`,
            );
            return;
          }
          const method = route.method.toLowerCase() as keyof typeof app;
          (
            app[method] as (
              path: string,
              handler: (c: unknown) => unknown,
            ) => void
          )(route.path, route.handler as (c: unknown) => unknown);
          customRouteKeys.add(`${route.method.toUpperCase()} ${route.path}`);
        }

        // ── Page serving helper ───────────────────────────────────────
        function resolveDirForPackage(
          packageName: string,
          dir: string,
        ): string {
          return path.join(g.home, "node_modules", packageName, dir);
        }

        function registerPage(
          page: PageContribution,
          resolvedDir: string,
        ): void {
          pages.push({ ...page });

          app.get(`/pages/${page.id}/*`, async (c) => {
            const requestPath = c.req.path;
            const prefix = `/pages/${page.id}/`;
            const filePath = requestPath.slice(prefix.length) || "index.html";

            // Prevent directory traversal
            if (filePath.includes("..")) {
              return c.text("Not found", 404);
            }

            const absolutePath = path.join(resolvedDir, filePath);

            // Ensure file is within resolved dir
            if (!absolutePath.startsWith(resolvedDir)) {
              return c.text("Not found", 404);
            }

            try {
              const content = fs.readFileSync(absolutePath);
              const mimeType = getMimeType(absolutePath);

              // Only inject chrome for the root index.html
              const isIndexHtml = filePath === "index.html" || filePath === "";
              if (isIndexHtml && mimeType.startsWith("text/html")) {
                const html = content.toString("utf-8");
                const navHtml = buildNavHtml(pages);
                const injected = injectChrome(
                  html,
                  "/static/style.css",
                  navHtml,
                );
                return new Response(injected, {
                  headers: { "Content-Type": "text/html; charset=utf-8" },
                });
              }

              return new Response(content, {
                headers: { "Content-Type": mimeType },
              });
            } catch {
              return c.text("Not found", 404);
            }
          });
        }

        // ── Tool route registration helper ───────────────────────────
        function registerToolRoute(
          toolDef: import("@shardworks/tools-apparatus").ToolDefinition,
        ): void {
          const routePath = toolNameToRoute(toolDef.name);
          const method = permissionToMethod(toolDef.permission);

          if (mappedToolRoutes.has(routePath)) return;

          if (customRouteKeys.has(`${method} ${routePath}`)) {
            console.warn(
              `[oculus] Tool route ${method} ${routePath} conflicts with custom route from plugin — skipped`,
            );
            return;
          }

          const shape = toolDef.params.shape as Record<string, z.ZodTypeAny>;

          if (method === "GET") {
            app.get(routePath, async (c) => {
              try {
                const rawQuery = c.req.query();
                const coerced = coerceParams(shape, rawQuery);
                const validated = toolDef.params.parse(coerced);
                const result = await toolDef.handler(validated);
                return c.json(result);
              } catch (err) {
                if (err instanceof z.ZodError) {
                  return c.json(
                    { error: err.message, details: err.issues },
                    400,
                  );
                }
                const message =
                  err instanceof Error ? err.message : String(err);
                return c.json({ error: message }, 500);
              }
            });
          } else if (method === "DELETE") {
            app.delete(routePath, async (c) => {
              try {
                const body = await c.req.json();
                const validated = toolDef.params.parse(body);
                const result = await toolDef.handler(validated);
                return c.json(result);
              } catch (err) {
                if (err instanceof z.ZodError) {
                  return c.json(
                    { error: err.message, details: err.issues },
                    400,
                  );
                }
                const message =
                  err instanceof Error ? err.message : String(err);
                return c.json({ error: message }, 500);
              }
            });
          } else {
            app.post(routePath, async (c) => {
              try {
                const body = await c.req.json();
                const validated = toolDef.params.parse(body);
                const result = await toolDef.handler(validated);
                return c.json(result);
              } catch (err) {
                if (err instanceof z.ZodError) {
                  return c.json(
                    { error: err.message, details: err.issues },
                    400,
                  );
                }
                const message =
                  err instanceof Error ? err.message : String(err);
                return c.json({ error: message }, 500);
              }
            });
          }

          mappedToolRoutes.add(routePath);
        }

        // ── Register pages from all kit contributions ────────────────────
        for (const entry of ctx.kits("pages")) {
          for (const page of entry.value as PageContribution[]) {
            const resolvedDir = resolveDirForPackage(
              entry.packageName,
              page.dir,
            );
            registerPage(page, resolvedDir);
          }
        }

        // ── Register custom routes from all kit contributions ────────────
        for (const entry of ctx.kits("routes")) {
          for (const route of entry.value as RouteContribution[]) {
            registerCustomRoute(route, entry.pluginId);
          }
        }

        // ── Register tool routes from all kit contributions ──────────
        for (const entry of ctx.kits("tools")) {
          const rawTools = entry.value;
          if (!Array.isArray(rawTools)) continue;
          for (const t of rawTools) {
            if (
              isToolDefinition(t) &&
              (!t.callableBy || t.callableBy.includes("patron"))
            ) {
              registerToolRoute(t);
            }
          }
        }

        // ── GET /api/_status ─────────────────────────────────────────
        app.get("/api/_status", (c) => {
          const config = g.guildConfig();
          return c.json({
            guild: config.name,
            nexus: VERSION,
            home: g.home,
            model: config.settings?.model ?? "(not set)",
            port: serverPort,
            apparatuses: g
              .apparatuses()
              .map((a) => ({ id: a.id, version: a.version })),
            kits: g.kits().map((k) => ({ id: k.id, version: k.version })),
            failedPlugins: g
              .failedPlugins()
              .map((f) => ({ id: f.id, reason: f.reason })),
            warnings: g.startupWarnings(),
            config: config,
          });
        });

        // ── GET /api/_tools ──────────────────────────────────────────
        app.get("/api/_tools", (c) => {
          const instrumentarium = g.apparatus<InstrumentariumApi>("tools");
          const tools = instrumentarium
            .list()
            .filter(
              (r) =>
                !r.definition.callableBy ||
                r.definition.callableBy.includes("patron"),
            );

          const entries = tools.map((r) => ({
            name: r.definition.name,
            route: toolNameToRoute(r.definition.name),
            method: permissionToMethod(r.definition.permission),
            description: r.definition.description,
            params: extractParams(r.definition.params),
          }));

          return c.json(entries);
        });

        // ── Static assets ────────────────────────────────────────────
        // In dev: import.meta.dirname = /packages/plugins/oculus/src
        // In prod: import.meta.dirname = /node_modules/@pkg/dist
        // Static files are always at src/static relative to package root
        const staticDir = path.resolve(import.meta.dirname, "../src/static");

        app.get("/static/*", (c) => {
          const requestPath = c.req.path;
          const filePath = requestPath.slice("/static/".length);

          if (filePath.includes("..")) {
            return c.text("Not found", 404);
          }

          const absolutePath = path.join(staticDir, filePath);
          try {
            const content = fs.readFileSync(absolutePath);
            const mimeType = getMimeType(absolutePath);
            return new Response(content, {
              headers: { "Content-Type": mimeType },
            });
          } catch {
            return c.text("Not found", 404);
          }
        });

        // ── Home page ────────────────────────────────────────────────
        app.get("/", (c) => {
          const config = g.guildConfig();
          const guildName = config.name;
          const navHtml = buildNavHtml(pages);
          const model = config.settings?.model ?? "(not set)";

          // ── Identity card ──────────────────────────────────────────
          const identityCard = `<div class="card" style="margin-bottom: 16px;">
    <h2>Identity</h2>
    <table class="data-table">
      <tbody>
        <tr><td>Guild</td><td>${escapeHtml(guildName)}</td></tr>
        <tr><td>Nexus</td><td>${escapeHtml(VERSION)}</td></tr>
        <tr><td>Home</td><td>${escapeHtml(g.home)}</td></tr>
        <tr><td>Model</td><td>${escapeHtml(model)}</td></tr>
        <tr><td>Port</td><td>${serverPort}</td></tr>
      </tbody>
    </table>
  </div>`;

          // ── Warnings card (conditional) ────────────────────────────
          const warnings = g.startupWarnings();
          const warningsCard =
            warnings.length > 0
              ? `<div class="card" style="margin-bottom: 16px;">
    <h2>Warnings</h2>
    <ul>
      ${warnings.map((w) => `<li><span class="badge badge--warning">${escapeHtml(w)}</span></li>`).join("\n      ")}
    </ul>
  </div>`
              : "";

          // ── Plugins table ──────────────────────────────────────────
          const apparatuses = g.apparatuses();
          const kits = g.kits();
          const failedPlugins = g.failedPlugins();

          let pluginRows = "";
          if (
            apparatuses.length === 0 &&
            kits.length === 0 &&
            failedPlugins.length === 0
          ) {
            pluginRows = `<tr><td colspan="4" class="empty-state">No plugins loaded.</td></tr>`;
          } else {
            pluginRows += apparatuses
              .map(
                (a) =>
                  `<tr>
          <td>${escapeHtml(a.id)}</td>
          <td>apparatus</td>
          <td>${escapeHtml(a.version)}</td>
          <td><span class="badge badge--success">apparatus</span></td>
        </tr>`,
              )
              .join("\n");
            pluginRows += kits
              .map(
                (k) =>
                  `<tr>
          <td>${escapeHtml(k.id)}</td>
          <td>kit</td>
          <td>${escapeHtml(k.version)}</td>
          <td><span class="badge badge--info">kit</span></td>
        </tr>`,
              )
              .join("\n");
            pluginRows += failedPlugins
              .map(
                (f) =>
                  `<tr>
          <td>${escapeHtml(f.id)}</td>
          <td>—</td>
          <td>—</td>
          <td><span class="badge badge--error" title="${escapeHtml(f.reason)}">failed</span> <span style="color: var(--text-dim); font-size: 11px;">${escapeHtml(f.reason)}</span></td>
        </tr>`,
              )
              .join("\n");
          }

          const pluginsCard = `<div class="card" style="margin-bottom: 16px;">
    <h2>Plugins</h2>
    <table class="data-table">
      <thead>
        <tr><th>Id</th><th>Type</th><th>Version</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${pluginRows}
      </tbody>
    </table>
  </div>`;

          // ── Configuration card ─────────────────────────────────────
          let rawConfig = "";
          try {
            rawConfig = fs.readFileSync(
              path.join(g.home, "guild.json"),
              "utf-8",
            );
          } catch {
            rawConfig = "(unable to read guild.json)";
          }

          const configCard = `<div class="card">
    <details>
      <summary>guild.json</summary>
      <pre class="config-block"><code>${escapeHtml(rawConfig)}</code></pre>
    </details>
  </div>`;

          const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(guildName)} — Guild Dashboard</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
${navHtml}
<main style="padding: 24px;">
  <h1>${escapeHtml(guildName)}</h1>
  ${identityCard}
  ${warningsCard}
  ${pluginsCard}
  ${configCard}
</main>
</body>
</html>`;

          return c.html(html);
        });

        // Server is NOT started here — use the `oculus` tool to start it explicitly.
      },

      async stop(): Promise<void> {
        await stopServer();
      },

      supportKit: {
        tools: [
          tool({
            name: "oculus",
            description: "Start the Oculus web dashboard and keep it running",
            callableBy: ["patron"],
            params: {},
            handler: async () => {
              await api.startServer();

              const port = api.port();
              console.log(
                `\n  Oculus is running at http://localhost:${port}/\n`,
              );
              console.log("  Press Ctrl+C to stop.\n");

              // Block until the process is interrupted.
              await new Promise<void>((resolve) => {
                const onSignal = () => {
                  void api.stopServer().then(
                    () => resolve(),
                    () => resolve(),
                  );
                };
                process.once("SIGINT", onSignal);
                process.once("SIGTERM", onSignal);
              });

              return "Oculus stopped.";
            },
          }),
        ],
      },
    },
  };
}
