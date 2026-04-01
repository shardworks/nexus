/**
 * The Stacks — apparatus implementation.
 *
 * Wires together the backend, CDC registry, and transaction model
 * to provide the StacksApi `provides` object. All core read/write/
 * transaction logic lives in stacks-core.ts.
 *
 * See: docs/specification.md
 */

import type {
  StartupContext,
  LoadedPlugin,
  Plugin,
} from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';

import type {
  BookSchema,
  StacksApi,
} from './types.ts';

import type { StacksBackend } from './backend.ts';

import { StacksCore } from './stacks-core.ts';
import { SqliteBackend } from './sqlite-backend.ts';

// ── Apparatus wrapper ────────────────────────────────────────────────

class StacksApparatus {
  private readonly core: StacksCore;

  constructor(backend: StacksBackend) {
    this.core = new StacksCore(backend);
  }

  // ── Startup ───────────────────────────────────────────────────────

  start(_: StartupContext): void {
    const g = guild();
    const config = g.guildConfig().stacks ?? {};
    const autoMigrate = config.autoMigrate ?? true;

    this.core.backend.open({ home: g.home });

    if (autoMigrate) {
      const allPlugins = [...g.kits(), ...g.apparatuses()];
      this.reconcileSchemas(allPlugins);
    }
  }

  stop(): void {
    this.core.backend.close();
  }

  createApi(): StacksApi {
    return this.core.createApi();
  }

  // ── Schema reconciliation ─────────────────────────────────────────

  private reconcileSchemas(plugins: LoadedPlugin[]): void {
    for (const plugin of plugins) {
      const books = this.extractBooks(plugin);
      for (const [bookName, schema] of Object.entries(books)) {
        this.core.backend.ensureBook({ ownerId: plugin.id, book: bookName }, schema);
      }
    }
  }

  private extractBooks(
    plugin: LoadedPlugin,
  ): Record<string, BookSchema> {
    // Kits have a `kit` property, apparatuses have an `apparatus` property
    const source = 'kit' in plugin
      ? plugin.kit
      : 'apparatus' in plugin && plugin.apparatus.supportKit
        ? plugin.apparatus.supportKit
        : null;

    if (!source) return {};
    return ((source as Record<string, unknown>).books ?? {}) as Record<string, BookSchema>;
  }
}

// ── Apparatus export ──────────────────────────────────────────────────

export function createStacksApparatus(
  backend?: StacksBackend,
): Plugin {
  const impl = new StacksApparatus(backend ?? new SqliteBackend());
  // Placeholder api — populated during start()
  let api: StacksApi;

  return {
    apparatus: {
      requires: [],
      consumes: ['books'],

      get provides() { return api; },

      start(ctx: StartupContext): void {
        impl.start(ctx);
        api = impl.createApi();
      },

      stop(): void {
        impl.stop();
      },
    },
  };
}
