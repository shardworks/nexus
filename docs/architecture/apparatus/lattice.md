# The Lattice — API Contract

Status: **Draft**

Package: `@shardworks/lattice-apparatus` · Plugin id: `lattice`

> **⚠️ MVP scope.** MVP covers the pulse book, the `latticeChannels` kit
> vocabulary, a Phase 2 CDC dispatcher, the startup-scan recovery path, and
> a two-tool CLI surface (`nsg pulse list` / `nsg pulse show`).
> Rate-limiting, digesting, quiet-hours, ack/dismiss/resolve semantics,
> retention/GC, Oculus surfaces, and `linkUrl` synthesis are all deferred.

---

## Purpose

The Lattice is the guild's notification substrate. It owns a single book
(`lattice/pulses`) that persists pulse records — immutable notification events
emitted by observer apparatuses when something worth telling the patron
happens. Once a pulse is written, the Lattice fans it out to every configured
channel (Discord webhook, CLI inbox, future push surfaces) via a Phase 2 CDC
watcher on its own book.

The Lattice is designed to outlive this MVP's single consumer (the Reckoner).
Future emitters — coinmaster balance alerts, anima completion, vision-keeper —
slot into the same substrate by calling `LatticeApi.emit()`; future push
surfaces attach as new `latticeChannels` factories. The pulse record is the
durable event; delivery is best-effort.

The Lattice does **not** decide *when* to notify. That is the emitter's
responsibility. The Lattice also does not decide what "notification" looks
like for a given surface; channels own their own rendering. The Lattice
arbitrates the middle layer: it stores events and routes them.

---

## Dependencies

```
requires:   ['stacks']
recommends: ['oculus']
consumes:   ['latticeChannels']
```

- **The Stacks** (required) — persists pulses in the `pulses` book and is the
  CDC substrate the dispatcher watches.
- **Oculus** (recommended) — future patron-facing page for pulse inspection.
  The Lattice declares the recommendation but runs fine without it.
- **`latticeChannels` kit contribution** (consumed) — delivery surfaces
  contributed by external kits. Registering as a consumer of this vocabulary
  means the framework will *not* emit an "unconsumed contribution" warning
  when a kit like `@shardworks/lattice-discord-kit` ships channel factories.

---

## Kit Interface

The Lattice consumes a single contribution type: **`latticeChannels`**.
Each contributing kit exports an array of `LatticeChannelFactory` values; at
startup the Lattice scans every kit, builds a type-keyed registry, and then
materializes one `LatticeChannel` instance per entry in `lattice.channels`.

```typescript
// Example: what the Discord kit's export looks like.
import type { LatticeKit } from '@shardworks/lattice-apparatus';

const kit: LatticeKit & { requires?: string[] } = {
  requires: ['lattice'],
  latticeChannels: [createDiscordWebhookFactory()],
};

export default { kit };
```

A factory has shape `{ type: string; create(instanceConfig): LatticeChannel }`.
The `type` field is the key operators use in `lattice.channels[i].type` to
select which factory builds a given instance. The `create()` method receives
the full instance-config object (including `type`) and returns a channel
object whose `send(pulse)` does the actual delivery.

Channels must never throw from `send()`: any error must surface as
`{ ok: false, error }`. This keeps the dispatcher defensive — the pulse is the
durable record, and a channel crash must not corrupt that record's delivery
state.

---

## Support Kit

```typescript
supportKit: {
  books: {
    pulses: {
      indexes: [
        'triggerType', 'source', 'createdAt', 'deliveryState', 'writId',
        ['deliveryState', 'createdAt'],
        ['triggerType', 'createdAt'],
      ],
    },
  },
  tools: [pulseList, pulseShow],
}
```

### `pulse-list` tool

List pulses emitted on the Lattice. Returns raw `PulseDoc[]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `live` | `boolean` | no | When true, exclude drain pulses entirely and exclude writ-scoped pulses whose referent writ is no longer in `stuck` or `failed`. |
| `all` | `boolean` | no | Disable the default 24h window and return every pulse. |
| `since` | `string` | no | Lower bound (ISO) — overrides the default 24h window. |
| `limit` | `number` | no | Max results. Default 20. |
| `offset` | `number` | no | Skip count. Default 0. |

Default sort: `createdAt` descending, tie-broken by `id` descending (so
same-millisecond emissions produce a stable order). Default window: last 24h.

Permission: `lattice:read`.

### `pulse-show` tool

Return a single `PulseDoc` by id. Accepts a full id or a unique prefix
(resolved via `LatticeApi.resolveId`). Throws on missing or ambiguous prefix.

Permission: `lattice:read`.

---

## `LatticeApi` Interface (`provides`)

Pulses are immutable from the consumer's perspective. The only mutable field
is `deliveryState`, and the Lattice itself is the only writer. Accordingly,
`LatticeApi` has no `update` or `delete` — if an emitter wants to correct an
earlier pulse, it emits a new one.

```typescript
interface LatticeApi {
  /** Write a new pulse in `deliveryState: 'pending'`. Dispatch is async. */
  emit(request: EmitPulseRequest): Promise<PulseDoc>;

  /** Show a pulse by id. Throws if not found. */
  show(id: string): Promise<PulseDoc>;

  /** Resolve a unique prefix to the full id. Throws on missing / ambiguous. */
  resolveId(prefix: string): Promise<string>;

  /** List pulses ordered by createdAt desc. Default limit 20, default 24h window. */
  list(filters?: PulseFilters): Promise<PulseDoc[]>;

  /** Count pulses matching filters. */
  count(filters?: PulseFilters): Promise<number>;
}
```

Supporting types:

```typescript
type PulseDeliveryState = 'pending' | 'delivered' | 'failed';

interface PulseDoc {
  id: string;                  // p-{base36_ts}-{hex}
  source: string;              // emitter plugin id
  triggerType: string;         // {pluginId}.{kebab-suffix}
  writId: string | null;       // null when not writ-scoped
  title: string;
  summary: string;             // plain text
  linkUrl: string | null;      // always null in MVP
  context: Record<string, unknown>;
  deliveryState: PulseDeliveryState;
  deliveryError?: string;      // set when deliveryState is 'failed'
  createdAt: string;
  updatedAt: string;
}
```

### Decisions (from the commission brief)

- **D3** — `triggerType` uses the `{pluginId}.{kebab-suffix}` grammar (e.g.
  `reckoner.writ-stuck`), keeping source-of-emission and trigger as
  independent axes.
- **D4** — `linkUrl` is always `null` in MVP. No public base URL exists yet.
- **D5** — The channel kit contribution is richer than Clerk's descriptor
  shapes: a factory carries a `create()` function, not just data. Per-guild
  instance config belongs at creation time.
- **D8** — Delivery policy is best-effort one-shot. Any channel error marks
  the pulse `failed`; no retries. Failures remain visible in the CLI.
- **D9** — CDC dispatch is Phase 2 (`failOnError: false`). A notification
  failure must not void the underlying emit transaction.
- **D10** — Dispatch is async via the Phase 2 watcher + a startup scan that
  mops up any `deliveryState === 'pending'` rows across restarts.
- **D14** — Pulse ids use the `p-` prefix, matching the guild's single-letter
  prefix convention (`w-`, `c-`, `rig-`).
- **D21** — `pulse.source` is the emitter plugin id, stamped by the emitter.
  The Lattice trusts emitters (same trust model as Stacks books' owner keys).
- **D22** — `summary` is plain text for graceful degradation across channel
  backends. Structured payloads live on `context`.
- **D28** — Tools return raw `PulseDoc` objects. Rendering is a channel /
  CLI concern, not the tool's.
- **D29** — `LatticeApi` is read-only aside from `emit`; no update or delete.

---

## Configuration

```json
{
  "lattice": {
    "channels": [
      { "type": "discord-webhook", "webhookUrlEnvVar": "DISCORD_WEBHOOK_URL" }
    ]
  }
}
```

Each `channels[i]` is a `LatticeChannelInstanceConfig`: a plain object whose
`type` field names a registered factory. Remaining fields are opaque to the
Lattice and passed through verbatim to the factory's `create()`. Secrets are
never written to `guild.json` — channels that need one (Discord, Slack, etc.)
follow the same pattern Copilot uses for `tokenEnvVar`: config names an
environment variable, and the secret is resolved from `process.env` at send
time.

Operators can repeat the same `type` with different instance config — e.g.
two Discord webhooks pointing at different channels.

---

## Pulse Lifecycle

```
├─ 1. emit()                 → PulseDoc persisted with deliveryState = 'pending'.
├─ 2. Phase 2 CDC watcher    → reacts to the create event (or a pending update
│                              carried through a restart).
├─ 3. dispatch(pulse)        → re-reads the row, bails if already terminal,
│                              iterates configured channels, calls send() on
│                              each, never throws.
├─ 4. outcome aggregation    → all ok  → patch deliveryState = 'delivered'
│                              any err → patch deliveryState = 'failed' and
│                                         join errors into deliveryError.
└─ 5. no retries             → operators inspect `pulse show` for failures.
```

### Startup scan

The dispatcher's second entry point is a startup scan: immediately after
registering the CDC watcher, the Lattice queries `deliveryState === 'pending'`
ordered by `createdAt asc` and dispatches each row. This covers two cases:

1. The process crashed after the pulse was written but before the Phase 2
   watcher fired.
2. A channel failure at dispatch time left the pulse as `failed` — but
   `failed` is terminal, so the startup scan intentionally skips those rows
   (dispatch re-reads and bails on non-pending state).

There is no dedupe across the Phase 2 path and the startup scan — both call
the same `dispatch()`, which re-reads the row before acting. A pulse already
in a terminal delivery state is a no-op.

### Phase 2 is deliberate

- Channel I/O is a side effect layered on the pulse. Phase 1 would re-enter
  the CDC dispatch (the dispatcher patches `deliveryState` on the same book
  it watches) and risk infinite recursion.
- Notification failure is non-fatal: the emit-time write must survive.

---

## Channel Abstraction

A channel has a single responsibility: turn a `PulseDoc` into a delivery on
one backend. The shape is intentionally minimal:

```typescript
interface LatticeChannel {
  readonly type: string;
  send(pulse: PulseDoc): Promise<DeliveryOutcome>;
}

type DeliveryOutcome = { ok: true } | { ok: false; error: string };
```

Channels are stateless with respect to the pulse stream — they do not
accumulate state across dispatches and do not receive lifecycle hooks.
Factories may hold closed-over state (parsed instance config, a pre-built
HTTP agent, …) but must not assume anything about the ordering or
completeness of the pulse stream.

The first-party Discord channel lives in a separate package
(`@shardworks/lattice-discord-kit`, D6). Keeping the Lattice core free of
channel-specific dependencies is deliberate: it exercises the kit
contribution boundary end-to-end with an external contributor, and it lets
operators install only the channels they actually use.

---

## Failure Behaviour Matrix

| Situation | Effect |
|-----------|--------|
| Emit with missing fields | Throws synchronously; no row written. |
| Channel `send()` returns `ok: false` | Pulse marked `failed`; error joined into `deliveryError`; other channels still attempted. |
| Channel `send()` throws | Same as `ok: false` — the dispatcher catches the throw. |
| All channels succeed | Pulse marked `delivered`. |
| No channels configured | Pulse marked `delivered` trivially. |
| Process crash before dispatch | Row remains `pending`; startup scan re-dispatches. |
| Process crash mid-dispatch | Same as above — whichever channel completed its HTTP call may double-deliver on restart; this is an accepted MVP cost. |

---

## Open Questions

- **Retention.** Unbounded growth is accepted for MVP; a future commission
  will define a retention policy (age-based? count-based?).
- **Delivery backoff.** All-or-nothing dispatch means a single slow channel
  penalizes every subsequent pulse. A future refactor may split dispatch per
  channel so one wedge does not block the rest.
- **Dedupe on drain.** Rapid bursts can produce multiple `queue-drained`
  pulses; see the Reckoner spec for the known window.

---

## Implementation Notes

- Pulse ids include a random suffix, so `resolveId()` does more than a
  startsWith: for full ids it falls back to an exact `get()` to avoid a
  LIKE scan.
- `list()` tie-breaks on `id` descending (the id's base36-timestamp prefix
  sorts consistently with `createdAt` for same-ms emissions). This keeps
  tool output stable across repeated calls.
- The startup scan intentionally swallows individual dispatch errors so one
  bad pulse does not stop the scan.
