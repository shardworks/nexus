# `@shardworks/lattice-apparatus`

The Lattice — the guild's notification substrate. Emitters call
`LatticeApi.emit()`; the Lattice persists an immutable `PulseDoc` and fans
it out to every channel contributed through the `latticeChannels` kit
vocabulary. First-party channels (Discord, future CLI inbox, future
webhooks) ship as separate kit packages.

See also: [`docs/architecture/apparatus/lattice.md`](../../../docs/architecture/apparatus/lattice.md).

---

## Installation

```sh
pnpm add @shardworks/lattice-apparatus
```

Register the apparatus in `guild.json`:

```json
{
  "plugins": [
    "@shardworks/lattice-apparatus"
  ],
  "lattice": {
    "channels": [
      { "type": "discord-webhook", "webhookUrlEnvVar": "DISCORD_WEBHOOK_URL" }
    ]
  }
}
```

At least one channel kit must also be installed (e.g.
`@shardworks/lattice-discord-kit`) for pulses to reach an external
surface. With no channels configured the Lattice still persists pulses and
marks them `delivered` trivially — the CLI inbox is always available.

---

## API

```typescript
interface LatticeApi {
  /** Write a new pulse in `deliveryState: 'pending'`. Dispatch is async. */
  emit(request: EmitPulseRequest): Promise<PulseDoc>;

  /** Show a pulse by id. Throws if not found. */
  show(id: string): Promise<PulseDoc>;

  /** Resolve a unique prefix to the full id. Throws on missing / ambiguous. */
  resolveId(prefix: string): Promise<string>;

  /** Default limit 20, default 24h window, ordered by createdAt desc. */
  list(filters?: PulseFilters): Promise<PulseDoc[]>;

  /** Count pulses matching filters. */
  count(filters?: PulseFilters): Promise<number>;
}
```

### Emitting a pulse

```typescript
import { guild } from '@shardworks/nexus-core';
import type { LatticeApi } from '@shardworks/lattice-apparatus';

const lattice = guild().apparatus<LatticeApi>('lattice');
await lattice.emit({
  source: 'reckoner',                              // your plugin id
  triggerType: 'reckoner.writ-stuck',              // {pluginId}.{kebab}
  writId: 'w-abc123-deadbeef',                     // null for non-writ-scoped
  title: 'Writ stuck: build the widget',
  summary: 'w-abc123 is stuck. Cause: engine-failure.',
  context: { writShortId: 'w-abc123', retryable: false },
});
```

The Lattice assigns the id (prefixed `p-`), stamps `createdAt` / `updatedAt`,
sets `deliveryState: 'pending'`, and returns the persisted document.
Dispatch happens asynchronously on a Phase 2 CDC watcher.

### Pulse document

```typescript
interface PulseDoc {
  id: string;                  // p-{base36_ts}-{hex}
  source: string;              // emitter plugin id
  triggerType: string;         // {pluginId}.{kebab-suffix}
  writId: string | null;
  title: string;
  summary: string;             // plain text
  linkUrl: string | null;      // always null in MVP
  context: Record<string, unknown>;
  deliveryState: 'pending' | 'delivered' | 'failed';
  deliveryError?: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## Configuration

```json
{
  "lattice": {
    "channels": [
      { "type": "<factory-type>", /* factory-specific fields */ }
    ]
  }
}
```

Each entry in `channels` is a `LatticeChannelInstanceConfig`: the `type`
field selects a registered channel factory, and any remaining fields are
passed to that factory's `create()` method. Operators can list the same
`type` more than once to create multiple instances (e.g. two Discord
webhooks pointing at different channels).

**Secrets never live in `guild.json`.** Channels that need one follow the
same pattern Copilot uses for `tokenEnvVar`: config names an environment
variable, and the secret is read from `process.env` at send time.

---

## Kit Interface

The Lattice consumes a single contribution type: `latticeChannels`. A kit
that contributes one or more channel factories looks like this:

```typescript
import type { LatticeKit } from '@shardworks/lattice-apparatus';

const kit: LatticeKit & { requires?: string[] } = {
  requires: ['lattice'],
  latticeChannels: [
    {
      type: 'my-channel',
      create(instanceConfig) {
        return {
          type: 'my-channel',
          async send(pulse) {
            // ...
            return { ok: true };
          },
        };
      },
    },
  ],
};

export default { kit };
```

`send()` must **never throw across the boundary**. Any error — network
drop, bad config, unexpected exception — must surface as
`{ ok: false, error }`. The Lattice catches throws defensively but the
contract is explicit.

---

## Support Kit

### Books

- `lattice/pulses` — one `PulseDoc` per emission.

### Tools

- `pulse-list` (`lattice:read`) — list pulses with `--live`, `--since`,
  `--all`, `--limit`, `--offset`. Default window: last 24h. Default
  limit: 20.
- `pulse-show` (`lattice:read`) — return one `PulseDoc` by id; accepts a
  prefix via `LatticeApi.resolveId`.

Both tools return raw `PulseDoc` objects (or arrays) — no pre-rendering.
They can be imported from the package's public entry point:

```typescript
import { pulseList, pulseShow } from '@shardworks/lattice-apparatus';
```

---

## Exports

- `.` — default export is the apparatus plugin. Re-exports types, the
  factory (`createLattice`), and the two CLI tools.
