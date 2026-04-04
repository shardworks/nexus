/**
 * The Loom — session context composition apparatus.
 *
 * The Loom owns system prompt assembly. Given a role name, it produces
 * an AnimaWeave — the composed identity context that The Animator uses
 * to launch a session. The work prompt (what the anima should do) is
 * not the Loom's concern; it bypasses the Loom and goes directly to
 * the Animator.
 *
 * The Loom resolves the role's permission grants from guild.json, then
 * calls the Instrumentarium to resolve the permission-gated tool set.
 * Tools are returned on the AnimaWeave so the Animator can pass them
 * to the session provider for MCP server configuration.
 *
 * See: docs/specification.md (loom)
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { InstrumentariumApi, ResolvedTool } from '@shardworks/tools-apparatus';
import fs from 'node:fs';
import path from 'node:path';

// ── Public types ──────────────────────────────────────────────────────

export interface WeaveRequest {
  /**
   * The role to weave context for (e.g. 'artificer', 'scribe').
   *
   * When provided, the Loom resolves role → permissions from guild.json,
   * then calls the Instrumentarium to resolve the permission-gated tool set.
   * Tools are returned on the AnimaWeave.
   *
   * When omitted, no tool resolution occurs — the AnimaWeave has no tools.
   */
  role?: string;
}

/**
 * The output of The Loom's weave() — the composed anima identity context.
 *
 * Contains the system prompt (produced by the Loom from the anima's
 * identity layers) and the resolved tool set for the role. The work
 * prompt is not part of the weave — it goes directly to the Animator.
 */
export interface AnimaWeave {
  /**
   * The system prompt for the AI process. Composed from guild charter,
   * tool instructions, and role instructions. Undefined when no
   * composition layers produce content.
   */
  systemPrompt?: string;
  /** The resolved tool set for this role. Undefined when no role is specified or no tools match. */
  tools?: ResolvedTool[];
  /** Environment variables derived from role identity (e.g. git author/committer). */
  environment?: Record<string, string>;
}

/** The Loom's public API, exposed via `provides`. */
export interface LoomApi {
  /**
   * Weave an anima's session context.
   *
   * Given a role name, produces an AnimaWeave containing the composed
   * system prompt and the resolved tool set. The system prompt is assembled
   * from the guild charter, tool instructions (for the resolved tool set),
   * and role instructions — in that order.
   *
   * Tool resolution is active: if a role is provided and the Instrumentarium
   * is installed, the Loom resolves role → permissions → tools.
   */
  weave(request: WeaveRequest): Promise<AnimaWeave>;
}

// ── Config types ─────────────────────────────────────────────────────

/** Role definition in guild.json under the Loom's plugin section. */
export interface RoleDefinition {
  /** Permission grants in `plugin:level` format. */
  permissions: string[];
  /**
   * When true, permissionless tools are excluded unless the role grants
   * `plugin:*` or `*:*` for the tool's plugin. Default: false.
   */
  strict?: boolean;
}

/** Loom configuration from guild.json. */
export interface LoomConfig {
  /** Role definitions keyed by role name. */
  roles?: Record<string, RoleDefinition>;
}

// ── Apparatus factory ─────────────────────────────────────────────────

/**
 * Create the Loom apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: ['tools']` — needs the Instrumentarium for tool resolution
 * - `provides: LoomApi` — the context composition API
 */
export function createLoom(): Plugin {
  let config: LoomConfig = {};
  let charterContent: string | undefined;
  let roleInstructions: Map<string, string> = new Map();

  const api: LoomApi = {
    async weave(request: WeaveRequest): Promise<AnimaWeave> {
      const weave: AnimaWeave = {};

      // Resolve tools if a role is provided and has a definition.
      if (request.role && config.roles) {
        const roleDef = config.roles[request.role];
        if (roleDef) {
          try {
            const instrumentarium = guild().apparatus<InstrumentariumApi>('tools');
            weave.tools = instrumentarium.resolve({
              permissions: roleDef.permissions,
              strict: roleDef.strict,
              caller: 'anima',
            });
          } catch {
            // Instrumentarium not installed — no tools.
            // This shouldn't happen since we require 'tools', but
            // fail gracefully rather than crash the session.
          }
        }
      }

      // Derive git identity from role name.
      if (request.role) {
        const displayName = request.role.charAt(0).toUpperCase() + request.role.slice(1);
        weave.environment = {
          GIT_AUTHOR_NAME: displayName,
          GIT_AUTHOR_EMAIL: `${request.role}@nexus.local`,
        };
      }

      // Compose system prompt from available layers: charter → tool instructions → role instructions.
      const layers: string[] = [];

      if (charterContent) {
        layers.push(charterContent);
      }

      if (weave.tools && weave.tools.length > 0) {
        for (const resolvedTool of weave.tools) {
          const instructions = resolvedTool.definition.instructions;
          if (instructions) {
            layers.push(`## Tool: ${resolvedTool.definition.name}\n\n${instructions}`);
          }
        }
      }

      if (request.role && roleInstructions.has(request.role)) {
        layers.push(roleInstructions.get(request.role)!);
      }

      if (layers.length > 0) {
        weave.systemPrompt = layers.join('\n\n');
      }

      return weave;
    },
  };

  return {
    apparatus: {
      requires: ['tools'],
      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        config = g.guildConfig().loom ?? {};
        const home = g.home;

        // Read charter content at startup and cache it.
        charterContent = undefined;
        const charterFilePath = path.join(home, 'charter.md');
        try {
          charterContent = fs.readFileSync(charterFilePath, 'utf-8');
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // No charter.md — check for charter/ directory.
          const charterDir = path.join(home, 'charter');
          try {
            const stat = fs.statSync(charterDir);
            if (stat.isDirectory()) {
              const mdFiles = fs.readdirSync(charterDir)
                .filter(f => f.endsWith('.md'))
                .sort();
              if (mdFiles.length > 0) {
                charterContent = mdFiles
                  .map(f => fs.readFileSync(path.join(charterDir, f), 'utf-8'))
                  .join('\n\n');
              }
            }
          } catch {
            // No charter/ directory either — silently omit.
          }
        }

        // Read role instruction files at startup for all configured roles.
        roleInstructions = new Map();
        if (config.roles) {
          for (const roleName of Object.keys(config.roles)) {
            const rolePath = path.join(home, 'roles', `${roleName}.md`);
            try {
              const content = fs.readFileSync(rolePath, 'utf-8');
              if (content) {
                roleInstructions.set(roleName, content);
              }
            } catch {
              // File doesn't exist — silently omit.
            }
          }
        }
      },
    },
  };
}
