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

  start(ctx: StartupContext): void {
    const g = guild();
    const config = g.guildConfig().stacks ?? {};
    const autoMigrate = config.autoMigrate ?? true;

    this.core.backend.open({ home: g.home });

    if (autoMigrate) {
      this.reconcileSchemas(ctx);
    }

    // Seal the CDC registry once every apparatus has finished starting.
    // Doing this at `phase:started` (not on first write) means one
    // apparatus's startup writes don't lock out watch() registration in
    // a dependent apparatus that starts later in the topological order.
    ctx.on('phase:started', () => {
      this.core.sealCdc();
    });
  }

  stop(): void {
    this.core.backend.close();
  }

  createApi(): StacksApi {
    return this.core.createApi();
  }

  // ── Schema reconciliation ─────────────────────────────────────────

  private reconcileSchemas(ctx: StartupContext): void {
    for (const entry of ctx.kits('books')) {
      const books = entry.value;
      if (typeof books !== 'object' || books === null) continue;
      for (const [bookName, schema] of Object.entries(books as Record<string, BookSchema>)) {
        this.core.backend.ensureBook({ ownerId: entry.pluginId, book: bookName }, schema);
      }
    }
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
        impl.start(ctx);   // pass ctx through for ctx.kits('books')
        api = impl.createApi();
      },

      stop(): void {
        impl.stop();
      },
    },
  };
}
