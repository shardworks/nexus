/**
 * The Instrumentarium — guild tool registry apparatus.
 *
 * Scans installed tools from kit contributions and apparatus supportKits,
 * resolves permission-gated tool sets on demand, and serves as the single
 * source of truth for "what tools exist and who can use them."
 *
 * The Instrumentarium is role-agnostic — it receives an already-resolved
 * permissions array from the Loom and returns the matching tool set.
 * Role definitions and permission grants are owned by the Loom.
 */

import type {
  StartupContext,
  LoadedPlugin,
  LoadedKit,
  LoadedApparatus,
  Plugin,
} from '@shardworks/nexus-core';
import {
  guild,
  isLoadedKit,
  isLoadedApparatus,
} from '@shardworks/nexus-core';

import type { ToolDefinition, ToolCaller } from './tool.ts';
import { isToolDefinition } from './tool.ts';

// ── Public types ──────────────────────────────────────────────────────

/** A resolved tool with provenance metadata. */
export interface ResolvedTool {
  /** The tool definition (name, description, params schema, handler). */
  definition: ToolDefinition;
  /** Plugin id of the kit or apparatus that contributed this tool. */
  pluginId: string;
}

/** Options for resolving a permission-gated tool set. */
export interface ResolveOptions {
  /**
   * Permission grants in `plugin:level` format.
   * Supports wildcards: `plugin:*`, `*:level`, `*:*`.
   */
  permissions: string[];
  /**
   * When true, permissionless tools are excluded unless the role grants
   * `plugin:*` or `*:*` for the tool's plugin. When false (default),
   * permissionless tools are included unconditionally.
   */
  strict?: boolean;
  /** Filter by invocation channel. Tools with no callableFrom pass all channels. */
  channel?: ToolCaller;
}

/** The Instrumentarium's public API, exposed via `provides`. */
export interface InstrumentariumApi {
  /**
   * Resolve the tool set for a given set of permissions.
   *
   * Evaluates each registered tool against the permission grants:
   * - Tools with a `permission` field: included if any grant matches
   * - Permissionless tools: always included (default) or gated by `strict`
   * - Channel filtering applied last
   */
  resolve(options: ResolveOptions): ResolvedTool[];

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null;

  /**
   * List all installed tools, regardless of permissions.
   */
  list(): ResolvedTool[];
}

// ── Permission matching ──────────────────────────────────────────────

/** A parsed permission grant. */
interface ParsedGrant {
  plugin: string;
  level: string;
}

/** Parse a grant string like "plugin:level" into its components. */
function parseGrant(grant: string): ParsedGrant | null {
  const colonIdx = grant.indexOf(':');
  if (colonIdx === -1) return null;
  return {
    plugin: grant.slice(0, colonIdx),
    level: grant.slice(colonIdx + 1),
  };
}

/**
 * Check if a tool with the given permission level from the given plugin
 * is matched by any of the parsed grants.
 */
function matchesPermission(
  pluginId: string,
  permission: string,
  grants: ParsedGrant[],
): boolean {
  for (const grant of grants) {
    // Exact match: plugin:level
    if (grant.plugin === pluginId && grant.level === permission) return true;
    // Plugin wildcard: plugin:*
    if (grant.plugin === pluginId && grant.level === '*') return true;
    // Level wildcard: *:level
    if (grant.plugin === '*' && grant.level === permission) return true;
    // Superuser: *:*
    if (grant.plugin === '*' && grant.level === '*') return true;
  }
  return false;
}

/**
 * Check if a permissionless tool from the given plugin should be included
 * in strict mode. Only `plugin:*` or `*:*` opts in permissionless tools.
 */
function strictAllowsPermissionless(
  pluginId: string,
  grants: ParsedGrant[],
): boolean {
  for (const grant of grants) {
    if (grant.plugin === pluginId && grant.level === '*') return true;
    if (grant.plugin === '*' && grant.level === '*') return true;
  }
  return false;
}

// ── Implementation ────────────────────────────────────────────────────

/**
 * The tool registry — accumulates tools from plugin contributions
 * and resolves permission-gated tool sets.
 */
class ToolRegistry {
  /** Map from tool name → ResolvedTool. Last-write-wins for duplicates. */
  private readonly tools = new Map<string, ResolvedTool>();

  /** Register all tools from a loaded plugin. */
  register(plugin: LoadedPlugin): void {
    const pluginId = plugin.id;

    if (isLoadedKit(plugin)) {
      this.registerToolsFromKit(pluginId, plugin.kit);
    } else if (isLoadedApparatus(plugin)) {
      if (plugin.apparatus.supportKit) {
        this.registerToolsFromKit(pluginId, plugin.apparatus.supportKit);
      }
    }
  }

  /** Extract and register tools from a kit (or supportKit) contribution. */
  private registerToolsFromKit(
    pluginId: string,
    kit: Record<string, unknown>,
  ): void {
    const rawTools = kit.tools;
    if (!Array.isArray(rawTools)) return;

    for (const t of rawTools) {
      if (isToolDefinition(t)) {
        this.tools.set(t.name, { definition: t, pluginId });
      }
    }
  }

  /** Find a tool by name. */
  find(name: string): ResolvedTool | null {
    return this.tools.get(name) ?? null;
  }

  /** List all installed tools. */
  list(): ResolvedTool[] {
    return [...this.tools.values()];
  }

  /**
   * Resolve a permission-gated tool set.
   *
   * 1. Parse each grant into (plugin, level) pairs
   * 2. For each registered tool:
   *    a. If tool has no permission:
   *       - If NOT strict → include
   *       - If strict → include only if grants contain <tool's plugin>:* or *:*
   *    b. If tool has a permission:
   *       - Match against grants: exact, plugin wildcard, level wildcard, or superuser
   *       - Include if any grant matches
   * 3. Filter by channel (callableFrom)
   */
  resolve(options: ResolveOptions): ResolvedTool[] {
    const grants = options.permissions
      .map(parseGrant)
      .filter((g): g is ParsedGrant => g !== null);
    const strict = options.strict ?? false;

    const result: ResolvedTool[] = [];

    for (const resolved of this.tools.values()) {
      const { definition, pluginId } = resolved;
      const permission = definition.permission;

      // Permission check
      if (permission === undefined) {
        // Permissionless tool
        if (strict && !strictAllowsPermissionless(pluginId, grants)) {
          continue;
        }
        // In default mode, permissionless tools are always included
      } else {
        // Tool has a permission — must match against grants
        if (!matchesPermission(pluginId, permission, grants)) {
          continue;
        }
      }

      // Channel filter
      if (
        options.channel &&
        definition.callableFrom &&
        !definition.callableFrom.includes(options.channel)
      ) {
        continue;
      }

      result.push(resolved);
    }

    return result;
  }
}

// ── Apparatus factory ─────────────────────────────────────────────────

/**
 * Create the Instrumentarium apparatus plugin.
 *
 * Returns a Plugin with:
 * - `consumes: ['tools']` — scans kit/supportKit contributions
 * - `provides: InstrumentariumApi` — the tool registry API
 */
export function createInstrumentarium(): Plugin {
  const registry = new ToolRegistry();

  const api: InstrumentariumApi = {
    resolve(options: ResolveOptions): ResolvedTool[] {
      return registry.resolve(options);
    },

    find(name: string): ResolvedTool | null {
      return registry.find(name);
    },

    list(): ResolvedTool[] {
      return registry.list();
    },
  };

  return {
    apparatus: {
      requires: [],
      consumes: ['tools'],
      provides: api,

      start(ctx: StartupContext): void {
        const g = guild();

        // Scan all already-loaded kits. These fired plugin:initialized before
        // any apparatus started, so we can't catch them via events.
        for (const kit of g.kits()) {
          registry.register(kit);
        }

        // Subscribe to plugin:initialized for apparatus supportKits that
        // fire after us in the startup sequence.
        ctx.on('plugin:initialized', (plugin: unknown) => {
          const loaded = plugin as LoadedPlugin;
          // Skip kits — we already scanned them above.
          if (isLoadedApparatus(loaded)) {
            registry.register(loaded);
          }
        });
      },
    },
  };
}
