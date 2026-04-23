/**
 * The Lattice — notification substrate apparatus.
 *
 * The Lattice owns the `lattice/pulses` book, exposes a small `LatticeApi`
 * for emitters, consumes a new `latticeChannels` kit contribution type
 * (channel factories), and fans newly-emitted pulses out via a Phase 2 CDC
 * watcher on its own pulses book.
 *
 * Phase 2 dispatch is deliberate:
 *
 *   1. Channel I/O is a side effect layered on top of a persistent event
 *      record. A `send()` failure (HTTP 5xx, network drop, etc.) must not
 *      roll back the underlying pulse write — the pulse is the durable
 *      record; dispatch is best-effort.
 *   2. The dispatcher patches `deliveryState` on the same book it watches.
 *      Phase 1 would re-enter the CDC dispatch and risk recursion; Phase 2
 *      runs post-commit, so the delivery-state update fires cleanly on the
 *      next cycle (and is ignored by the dispatcher, which only reacts to
 *      create events and to update events that move a pulse off `pending`
 *      are no-ops — see the handler body).
 *
 * Pulses are immutable from the public API's perspective. The Lattice itself
 * writes `deliveryState` transitions (pending → delivered/failed). `show`,
 * `list`, `count`, and `resolveId` round out the read surface.
 *
 * See: docs/architecture/apparatus/lattice.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type { Book, StacksApi, WhereClause } from '@shardworks/stacks-apparatus';

import type {
  EmitPulseRequest,
  LatticeApi,
  LatticeChannel,
  LatticeChannelFactory,
  LatticeChannelInstanceConfig,
  LatticeConfig,
  PulseDoc,
  PulseFilters,
} from './types.ts';

import { pulseList, pulseShow } from './tools/index.ts';

// ── Kit contribution vocabulary ─────────────────────────────────────

const LATTICE_CHANNELS_KIT = 'latticeChannels';

// ── Factory registration ────────────────────────────────────────────

interface RegisteredFactory {
  pluginId: string;
  factory: LatticeChannelFactory;
}

export function createLattice(): Plugin {
  let stacks: StacksApi;
  let pulses: Book<PulseDoc>;

  // Registered channel factories keyed by `type` — first writer wins, with
  // a warning for duplicates.
  const factories = new Map<string, RegisteredFactory>();

  // Materialized channel instances drawn from guild config, in the order
  // they appear in `lattice.channels`. One entry per configured instance.
  const channels: LatticeChannel[] = [];

  /**
   * Build a where clause from PulseFilters. Shared between list() and
   * count().
   */
  function buildWhereClause(filters?: PulseFilters): WhereClause | undefined {
    const conditions: WhereClause = [];
    if (filters?.triggerType) {
      const types = Array.isArray(filters.triggerType) ? filters.triggerType : [filters.triggerType];
      if (types.length === 1) {
        conditions.push(['triggerType', '=', types[0]!]);
      } else if (types.length > 1) {
        conditions.push(['triggerType', 'IN', types]);
      }
    }
    if (filters?.source) {
      conditions.push(['source', '=', filters.source]);
    }
    if (filters?.since) {
      conditions.push(['createdAt', '>=', filters.since]);
    }
    if (filters?.until) {
      conditions.push(['createdAt', '<=', filters.until]);
    }
    if (filters?.deliveryState) {
      const states = Array.isArray(filters.deliveryState) ? filters.deliveryState : [filters.deliveryState];
      if (states.length === 1) {
        conditions.push(['deliveryState', '=', states[0]!]);
      } else if (states.length > 1) {
        conditions.push(['deliveryState', 'IN', states]);
      }
    }
    return conditions.length > 0 ? conditions : undefined;
  }

  // ── API ────────────────────────────────────────────────────────

  const api: LatticeApi = {
    async emit(request: EmitPulseRequest): Promise<PulseDoc> {
      if (!request.source) {
        throw new Error('LatticeApi.emit: request.source is required.');
      }
      if (!request.triggerType) {
        throw new Error('LatticeApi.emit: request.triggerType is required.');
      }
      if (typeof request.title !== 'string' || request.title.length === 0) {
        throw new Error('LatticeApi.emit: request.title must be a non-empty string.');
      }
      if (typeof request.summary !== 'string') {
        throw new Error('LatticeApi.emit: request.summary must be a string.');
      }

      const now = new Date().toISOString();
      const pulse: PulseDoc = {
        id: generateId('p', 6),
        source: request.source,
        triggerType: request.triggerType,
        writId: request.writId ?? null,
        title: request.title,
        summary: request.summary,
        linkUrl: request.linkUrl ?? null,
        context: request.context ?? {},
        deliveryState: 'pending',
        createdAt: now,
        updatedAt: now,
      };

      await pulses.put(pulse);
      return pulse;
    },

    async show(id: string): Promise<PulseDoc> {
      const pulse = await pulses.get(id);
      if (!pulse) {
        throw new Error(`Pulse "${id}" not found.`);
      }
      return pulse;
    },

    async resolveId(prefix: string): Promise<string> {
      const exact = await pulses.get(prefix);
      if (exact) return exact.id;

      const results = await pulses.find({ where: [['id', 'LIKE', prefix + '%']] });
      if (results.length === 0) {
        throw new Error(`No pulse found matching prefix "${prefix}".`);
      }
      if (results.length > 1) {
        throw new Error(`Ambiguous prefix "${prefix}": matches ${results.length} pulses.`);
      }
      return results[0]!.id;
    },

    async list(filters?: PulseFilters): Promise<PulseDoc[]> {
      // Default `since` to 24h before now when the caller supplies no
      // lower bound — the brief prescribes a 24h window for `pulse list`.
      const effectiveFilters: PulseFilters = { ...(filters ?? {}) };
      if (effectiveFilters.since === undefined) {
        effectiveFilters.since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }
      const where = buildWhereClause(effectiveFilters);
      const limit = effectiveFilters.limit ?? 20;
      const offset = effectiveFilters.offset;

      return pulses.find({
        where,
        // Tie-break on `id` so same-ms emissions produce a deterministic order.
        // Pulse ids carry a base36 timestamp prefix and a random suffix; sorting
        // them desc after createdAt desc yields a total order that is stable
        // across repeated calls.
        orderBy: [['createdAt', 'desc'], ['id', 'desc']],
        limit,
        ...(offset !== undefined ? { offset } : {}),
      });
    },

    async count(filters?: PulseFilters): Promise<number> {
      const where = buildWhereClause(filters);
      return pulses.count(where);
    },
  };

  // ── Channel registration ─────────────────────────────────────

  function registerKitChannels(entry: { pluginId: string; value: unknown }): void {
    const { pluginId } = entry;
    const raw = entry.value;
    if (!Array.isArray(raw)) {
      console.warn(
        `[lattice] Kit "${pluginId}" latticeChannels: expected an array, got ${typeof raw} — skipped.`,
      );
      return;
    }

    for (const candidate of raw) {
      if (typeof candidate !== 'object' || candidate === null) {
        console.warn(
          `[lattice] Kit "${pluginId}" latticeChannels: entry is not an object — skipped.`,
        );
        continue;
      }
      const factory = candidate as Partial<LatticeChannelFactory>;
      if (typeof factory.type !== 'string' || factory.type.length === 0) {
        console.warn(
          `[lattice] Kit "${pluginId}" latticeChannels: entry is missing a non-empty "type" string — skipped.`,
        );
        continue;
      }
      if (typeof factory.create !== 'function') {
        console.warn(
          `[lattice] Kit "${pluginId}" latticeChannels: entry "${factory.type}" is missing a "create" function — skipped.`,
        );
        continue;
      }
      if (factories.has(factory.type)) {
        const existing = factories.get(factory.type)!;
        console.warn(
          `[lattice] Kit "${pluginId}" latticeChannels: factory type "${factory.type}" is already registered by kit "${existing.pluginId}" — duplicate skipped.`,
        );
        continue;
      }
      factories.set(factory.type, {
        pluginId,
        factory: factory as LatticeChannelFactory,
      });
    }
  }

  function materializeChannels(config: LatticeConfig | undefined): void {
    channels.length = 0;
    const entries = config?.channels ?? [];
    for (const instance of entries) {
      if (typeof instance !== 'object' || instance === null) {
        console.warn(`[lattice] lattice.channels: entry is not an object — skipped.`);
        continue;
      }
      const typed = instance as LatticeChannelInstanceConfig;
      const factoryEntry = factories.get(typed.type);
      if (!factoryEntry) {
        console.warn(
          `[lattice] lattice.channels: no factory registered for type "${typed.type}" — skipped. ` +
            `Known types: ${factories.size === 0 ? '(none)' : [...factories.keys()].join(', ')}.`,
        );
        continue;
      }
      try {
        const channel = factoryEntry.factory.create(typed);
        channels.push(channel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lattice] lattice.channels: factory "${typed.type}" failed to create a channel: ${msg} — skipped.`,
        );
      }
    }
  }

  // ── Dispatch ────────────────────────────────────────────────

  /**
   * Deliver a single pulse to every configured channel.
   *
   * Per D8 (best-effort one-shot): the pulse's deliveryState moves to
   * `delivered` only if every channel returned ok=true; a single failure
   * (ok=false or a thrown error) marks the pulse `failed`. Errors are
   * captured as text on `deliveryError`; no retry is attempted.
   *
   * If no channels are configured we still patch deliveryState so pulses
   * do not sit as `pending` forever — with no channels, "delivered" is
   * the best available status ("nothing failed"). Operators can always
   * see the emission in `nsg pulse list` regardless.
   */
  async function dispatch(pulse: PulseDoc): Promise<void> {
    // Re-read in case it was already dispatched (startup scan races,
    // duplicated CDC deliveries from the backend, etc.).
    const current = await pulses.get(pulse.id);
    if (!current) return;
    if (current.deliveryState !== 'pending') return;

    const errors: string[] = [];
    for (const channel of channels) {
      try {
        const outcome = await channel.send(current);
        if (!outcome.ok) {
          errors.push(`${channel.type}: ${outcome.error}`);
        }
      } catch (err) {
        // A well-behaved channel never throws, but defence in depth —
        // we do not allow channel errors to bubble past the dispatcher.
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${channel.type}: ${msg}`);
      }
    }

    const now = new Date().toISOString();
    if (errors.length === 0) {
      await pulses.patch(pulse.id, {
        deliveryState: 'delivered',
        updatedAt: now,
      });
    } else {
      await pulses.patch(pulse.id, {
        deliveryState: 'failed',
        deliveryError: errors.join('; '),
        updatedAt: now,
      });
    }
  }

  return {
    apparatus: {
      requires: ['stacks'],
      // Oculus is only a soft dependency for a future patron-facing page;
      // the Lattice runs fine without it.
      recommends: ['oculus'],
      consumes: [LATTICE_CHANNELS_KIT],

      provides: api,

      supportKit: {
        books: {
          pulses: {
            indexes: [
              'triggerType',
              'source',
              'createdAt',
              'deliveryState',
              'writId',
              ['deliveryState', 'createdAt'],
              ['triggerType', 'createdAt'],
            ],
          },
        },
        tools: [pulseList, pulseShow],
      },

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        pulses = stacks.book<PulseDoc>('lattice', 'pulses');

        // Scan all kit-contributed channel factories.
        factories.clear();
        for (const entry of ctx.kits(LATTICE_CHANNELS_KIT)) {
          registerKitChannels(entry);
        }

        // Materialize channels from guild config.
        const config = g.guildConfig().lattice;
        materializeChannels(config);

        // Phase 2 (post-commit) CDC watcher on the pulses book. See the
        // file comment for why Phase 2 is deliberate. The handler only
        // reacts to create events and to updates that re-enter `pending`
        // (which should not happen in practice — deliveryState is
        // monotonic once it leaves `pending` — but we guard anyway).
        stacks.watch<PulseDoc>(
          'lattice',
          'pulses',
          async (event) => {
            if (event.type === 'delete') return;
            const pulse = event.entry;
            if (pulse.deliveryState !== 'pending') return;
            if (event.type === 'update' && event.prev.deliveryState === 'pending') {
              // An in-place update that left the pulse `pending` — e.g. a
              // future editor re-wrote summary. Do not re-dispatch.
              return;
            }
            await dispatch(pulse);
          },
          { failOnError: false },
        );

        // Startup scan — any pulse left in `pending` across a restart gets
        // another dispatch pass. Runs out-of-band from the CDC handler so
        // the usual post-commit path handles new emissions while we
        // mop up the backlog.
        const pending = await pulses.find({
          where: [['deliveryState', '=', 'pending']],
          orderBy: ['createdAt', 'asc'],
        });
        for (const pulse of pending) {
          // Swallow errors individually — one bad pulse must not stop
          // the scan.
          try {
            await dispatch(pulse);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[lattice] startup scan: dispatch of "${pulse.id}" failed: ${msg}`);
          }
        }
      },
    },
  };
}
