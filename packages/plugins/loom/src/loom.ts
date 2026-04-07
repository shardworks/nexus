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

import type { Plugin, StartupContext, LoadedPlugin } from '@shardworks/nexus-core';
import { guild, isLoadedApparatus } from '@shardworks/nexus-core';
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

/** Role definition contributed by a kit or apparatus supportKit. */
export interface KitRoleDefinition {
  /** Permission grants in `plugin:level` format. */
  permissions: string[];
  /**
   * When true, permissionless tools are excluded unless the role grants
   * `plugin:*` or `*:*` for the tool's plugin. Default: false.
   */
  strict?: boolean;
  /** Inline role instructions injected into the system prompt. */
  instructions?: string;
  /**
   * Path to an instructions file, relative to the kit's npm package root.
   * Resolved at registration time. Mutually exclusive with `instructions`
   * (if both are present, `instructions` wins).
   */
  instructionsFile?: string;
}

/** Kit contribution interface for role definitions. */
export interface LoomKit {
  roles?: Record<string, KitRoleDefinition>;
}

// ── Apparatus factory ─────────────────────────────────────────────────

/**
 * Create the Loom apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: ['tools']` — needs the Instrumentarium for tool resolution
 * - `consumes: ['roles']` — declares that the Loom consumes kit role contributions
 * - `provides: LoomApi` — the context composition API
 */
export function createLoom(): Plugin {
  let config: LoomConfig = {};
  let charterContent: string | undefined;
  let roleInstructions: Map<string, string> = new Map();
  let kitRoles: Map<string, RoleDefinition> = new Map();

  function registerKitRoles(
    pluginId: string,
    packageName: string,
    kit: Record<string, unknown>,
    home: string,
  ): void {
    const rawRoles = kit.roles;
    if (typeof rawRoles !== 'object' || rawRoles === null || Array.isArray(rawRoles)) return;

    // Compute allowed plugin IDs for dependency-scoped validation
    const allowedPlugins = new Set<string>([
      pluginId,
      ...((kit.requires as string[] | undefined) ?? []),
      ...((kit.recommends as string[] | undefined) ?? []),
    ]);

    for (const [roleName, rawDef] of Object.entries(rawRoles as Record<string, unknown>)) {
      // Skip non-object entries silently
      if (typeof rawDef !== 'object' || rawDef === null || Array.isArray(rawDef)) continue;

      const def = rawDef as Record<string, unknown>;

      // Validate permissions field exists and is an array
      if (!Array.isArray(def.permissions)) {
        console.warn(
          `[loom] Kit "${pluginId}" role "${roleName}" is missing required "permissions" array — skipped`,
        );
        continue;
      }

      const qualifiedName = `${pluginId}.${roleName}`;

      // Guild override check at registration time — skip if guild defines this role
      if (config.roles && config.roles[qualifiedName]) continue;

      // Dependency-scoped permission filtering
      const validPermissions: string[] = [];
      for (const perm of def.permissions as string[]) {
        if (typeof perm !== 'string') continue;
        const colonIdx = perm.indexOf(':');
        if (colonIdx === -1) {
          console.warn(
            `[loom] Kit "${pluginId}" role "${roleName}" permission "${perm}" has no colon separator — dropped`,
          );
          continue;
        }
        const permPluginId = perm.slice(0, colonIdx);
        if (permPluginId === '*' || !allowedPlugins.has(permPluginId)) {
          console.warn(
            `[loom] Kit "${pluginId}" role "${roleName}" permission "${perm}" references undeclared plugin "${permPluginId}" — dropped`,
          );
          continue;
        }
        validPermissions.push(perm);
      }

      // Register the role
      kitRoles.set(qualifiedName, {
        permissions: validPermissions,
        ...(def.strict === true ? { strict: true } : {}),
      });

      // Resolve instructions — inline takes precedence over file
      if (typeof def.instructions === 'string' && def.instructions) {
        roleInstructions.set(qualifiedName, def.instructions);
      } else if (typeof def.instructionsFile === 'string' && def.instructionsFile) {
        const filePath = path.join(home, 'node_modules', packageName, def.instructionsFile);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content) {
            roleInstructions.set(qualifiedName, content);
          }
        } catch {
          console.warn(
            `[loom] Could not read instructions file for kit "${pluginId}" role "${roleName}": ${filePath}`,
          );
        }
      }
    }
  }

  const api: LoomApi = {
    async weave(request: WeaveRequest): Promise<AnimaWeave> {
      const weave: AnimaWeave = {};

      // Resolve tools if a role is provided and has a definition.
      // Guild-defined roles take precedence over kit-contributed roles.
      if (request.role) {
        const roleDef = config.roles?.[request.role] ?? kitRoles.get(request.role);
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
      consumes: ['roles'],
      provides: api,

      start(ctx: StartupContext): void {
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

        // Read role instruction files at startup for all configured (guild) roles.
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

        // ── Kit role scanning ──────────────────────────────────────────
        kitRoles = new Map();

        // Phase 1a: Scan all already-loaded standalone kits.
        for (const kit of g.kits()) {
          registerKitRoles(kit.id, kit.packageName, kit.kit, home);
        }

        // Phase 1b: Scan already-started apparatus for supportKit roles.
        // The Loom requires ['tools'], so apparatus that started before it
        // (e.g. Instrumentarium) have already fired plugin:initialized.
        for (const app of g.apparatuses()) {
          if (app.apparatus.supportKit) {
            registerKitRoles(app.id, app.packageName, app.apparatus.supportKit, home);
          }
        }

        // Phase 2: Subscribe to plugin:initialized for apparatus supportKits
        // that start after the Loom in the dependency order.
        ctx.on('plugin:initialized', (plugin: unknown) => {
          const loaded = plugin as LoadedPlugin;
          if (isLoadedApparatus(loaded) && loaded.apparatus.supportKit) {
            registerKitRoles(loaded.id, loaded.packageName, loaded.apparatus.supportKit, home);
          }
        });
      },
    },
  };
}
