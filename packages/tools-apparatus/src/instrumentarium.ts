/**
 * The Instrumentarium — guild tool registry apparatus.
 *
 * Scans installed tools from kit contributions and apparatus supportKits,
 * resolves role-gated tool sets on demand, and serves as the single source
 * of truth for "what tools exist and who can use them."
 *
 * See: docs/architecture/apparatus/instrumentarium.md
 */

import type {
  StartupContext,
  LoadedPlugin,
  LoadedKit,
  LoadedApparatus,
  Plugin,
  ToolDefinition,
  ToolCaller,
} from '@shardworks/nexus-core';
import {
  guild,
  isToolDefinition,
  isLoadedKit,
  isLoadedApparatus,
} from '@shardworks/nexus-core';

// ── Public types ──────────────────────────────────────────────────────

/** A resolved tool with provenance metadata. */
export interface ResolvedTool {
  /** The tool definition (name, description, params schema, handler). */
  definition: ToolDefinition;
  /** Plugin id of the kit or apparatus that contributed this tool. */
  pluginId: string;
}

/** Options for resolving a role-gated tool set. */
export interface ResolveOptions {
  /** Roles to resolve tools for. Tools are the union across all roles + baseTools. */
  roles: string[];
  /** Filter by invocation channel. Tools with no callableFrom pass all channels. */
  channel?: ToolCaller;
}

/** The Instrumentarium's public API, exposed via `provides`. */
export interface InstrumentariumApi {
  /**
   * Resolve the tool set for a given set of roles.
   *
   * Returns tools from baseTools + the union of each role's tool list,
   * filtered by the provided channel (mcp, cli, or import).
   */
  resolve(options: ResolveOptions): ResolvedTool[];

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null;

  /**
   * List all installed tools, regardless of role assignment.
   */
  list(): ResolvedTool[];
}

// ── Configuration ─────────────────────────────────────────────────────

/** Plugin configuration stored at guild.json["tools"]. */
export interface InstrumentariumConfig {
  /** Tool names available to all animas regardless of role. */
  baseTools?: string[];
  /** Role → tool names mapping. */
  roles?: Record<string, string[]>;
}

// ── Implementation ────────────────────────────────────────────────────

/**
 * The tool registry — accumulates tools from plugin contributions
 * and resolves role-gated tool sets.
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
   * Resolve a role-gated tool set.
   *
   * 1. Collect tool names from baseTools
   * 2. For each role, collect tool names from config
   * 3. Union all collected names
   * 4. Match against installed tools
   * 5. Filter by channel if specified
   */
  resolve(
    options: ResolveOptions,
    config: InstrumentariumConfig,
  ): ResolvedTool[] {
    const toolNames = new Set<string>(config.baseTools ?? []);

    for (const role of options.roles) {
      const roleTools = config.roles?.[role];
      if (roleTools) {
        for (const name of roleTools) {
          toolNames.add(name);
        }
      }
    }

    const result: ResolvedTool[] = [];
    for (const name of toolNames) {
      const tool = this.tools.get(name);
      if (tool) {
        if (
          options.channel &&
          tool.definition.callableFrom &&
          !tool.definition.callableFrom.includes(options.channel)
        ) {
          continue;
        }
        result.push(tool);
      }
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
  let config: InstrumentariumConfig = {};

  const api: InstrumentariumApi = {
    resolve(options: ResolveOptions): ResolvedTool[] {
      return registry.resolve(options, config);
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
        config = g.config<InstrumentariumConfig>('tools');

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
