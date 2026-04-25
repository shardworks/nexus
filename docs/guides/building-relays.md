# Building Relays

This guide explains how to build relays — event-driven handlers the Clockworks dispatches to in response to guild events (and on cron-like schedules) via standing orders. For building interactive tools that animas wield, see [Building Tools](building-tools.md).

## What relays are

Relays are automated, named handler functions with no AI involvement. They run deterministic logic in response to events: rolling up completion status, dispatching work, transforming data, enforcing policies. They have no instruction document because no anima wields them — they are guild infrastructure.

Relays are wired to events through **standing orders** in `guild.json`. When an event fires, the Clockworks dispatcher finds matching standing orders and calls each named relay's handler with the event.

## Quick start

A relay is a package with these files:

```
my-relay/
  package.json              ← npm package metadata
  nexus-relay.json          ← Nexus descriptor
  src/
    handler.ts              ← the kit (default export)
```

### The handler

Use the `relay()` factory from `@shardworks/clockworks-apparatus`:

```typescript
import { relay } from '@shardworks/clockworks-apparatus';

export default {
  recommends: ['nexus-clockworks'],
  relays: [
    relay({
      name: 'my-relay',
      description: 'What this relay does.',
      handler: async (event, { home, params }) => {
        // event  — the GuildEvent that triggered this relay (or null for direct invocation)
        // home   — absolute path to the guild root
        // params — the standing order's `with:` block (empty object when absent)

        if (!event) return; // nothing to do without an event

        console.log(`Handling ${event.name}`, event.payload);

        // Do your work here...
      },
    }),
  ],
};
```

### Key rules

1. **Default export is a kit.** The default export must be an object with a `relays` array. The Clockworks apparatus reads each kit's `relays` contribution at startup and registers each relay by name.
2. **Sync or async.** Handlers can be sync or async. The dispatcher always `await`s the call.
3. **Event may be null.** When invoked directly (not via a standing order), `event` is `null`. Guard accordingly.
4. **Throw for errors.** If the handler throws, the Clockworks dispatcher catches the error, records a failed dispatch row, and signals `standing-order.failed`.
5. **Use `home` for everything.** The guild root is your entry point to all guild state — books, config, file system.
6. **Params are untyped.** `params` is `Record<string, unknown>` — cast to expected types in your handler. Provide sensible defaults.
7. **Names are unique, first-writer-wins.** Two kits cannot register a relay under the same name. The dispatcher logs a warning and keeps the first-registered handler. User kits are wired ahead of stdlib kits, so a user kit can override a stdlib relay by reusing its name.

### `nexus-relay.json`

```json
{
  "entry": "src/handler.ts",
  "version": "0.1.0",
  "description": "What this relay does"
}
```

Fields:
- `entry` — (required) path to the kit module
- `version` — informational, recorded in guild.json `upstream`
- `description` — human-readable

### `package.json`

```json
{
  "name": "@shardworks/relay-my-relay",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/handler.ts"
  },
  "dependencies": {
    "@shardworks/clockworks-apparatus": "workspace:*"
  },
  "peerDependencies": {
    "@shardworks/nexus-core": "workspace:*"
  }
}
```

Relays don't need `zod` (no parameter validation surface) or instruction files (no anima interaction).

### Type-safe kit declaration

To get `ClockworksKit` type checking on your default export, import the kit type from the apparatus package and use a `satisfies` clause:

```typescript
import { relay, type ClockworksKit } from '@shardworks/clockworks-apparatus';

export default {
  recommends: ['nexus-clockworks'],
  relays: [
    relay({ name: 'my-relay', handler: async () => {} }),
  ],
} satisfies ClockworksKit;
```

## Standing order wiring

Relays are connected to events through standing orders in `guild.json`:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "session.ended", "run": "my-relay" },
      { "on": "task.completed", "run": "my-relay" }
    ]
  }
}
```

A relay can respond to multiple events. Multiple relays can respond to the same event — they execute in registration order.

### Passing params with `with:`

The standing order's optional `with:` block is forwarded verbatim to the relay as `RelayContext.params`:

```json
{
  "on": "deploy.requested",
  "run": "deploy",
  "with": { "environment": "staging", "dryRun": true }
}
```

The relay reads its inputs off `params`:

```typescript
handler: async (event, { home, params }) => {
  const environment = (params.environment as string) ?? 'production';
  const dryRun = (params.dryRun as boolean) ?? false;
}
```

This lets a single relay serve multiple standing orders with different configurations. Params default to `{}` when no `with:` block is present.

### Scheduled standing orders

A standing order can swap its `on:` trigger for a `schedule:` expression to fire on a wall-clock cadence:

```json
{ "schedule": "*/5 * * * *", "run": "reckoner-tick" }
{ "schedule": "@every 1h", "run": "tech-debt-scan", "with": { "depth": "full" } }
```

Two syntaxes are accepted: standard 5-field unix cron (`m h dom mon dow`) and `@every <N><s|m|h>`. The relay receives a synthesized `schedule.fired` event as its `event` argument; everything else (params, error semantics, dispatch rows) is shared with the event-driven path. See [The Clockworks → Scheduled Standing Orders](../architecture/clockworks.md#scheduled-standing-orders).

### Registration in `guild.json`

The relay must also be registered in `guild.json`'s `relays` registry:

```json
{
  "relays": {
    "my-relay": {
      "upstream": "@shardworks/relay-my-relay@0.1.0",
      "installedAt": "2026-03-25T00:00:00.000Z",
      "package": "@shardworks/relay-my-relay"
    }
  }
}
```

This happens automatically when installed via `nsg tool install`.

## Reading guild state from a relay

Relays have full access to `@shardworks/nexus-core`. Common patterns:

### Reading event payloads

```typescript
handler: async (event, { home }) => {
  if (!event) return;

  // Event payloads are typed as `unknown` — cast based on the event name
  const payload = event.payload as { writId: string } | null;
  if (!payload?.writId) return;

  // Now use the writId...
}
```

### Querying the books

```typescript
import { showWrit, listWrits, readGuildConfig } from '@shardworks/nexus-core';

handler: async (event, { home }) => {
  const writ = showWrit(home, writId);
  if (!writ) return;

  const children = listWrits(home, { parentId: writ.id });
  const config = readGuildConfig(home);
  // ...
}
```

### Writing to the books

```typescript
import { completeWrit } from '@shardworks/nexus-core';

handler: async (event, { home }) => {
  // Complete a writ — this automatically signals {type}.completed
  completeWrit(home, writId);
}
```

## Signaling follow-on events

Relays can signal events to trigger further automation (event chaining):

```typescript
import { signalEvent } from '@shardworks/nexus-core';

handler: async (event, { home }) => {
  // Do some work...

  // Signal a custom event for downstream processing
  signalEvent(home, 'deploy.ready', { version: '1.2.3' }, 'my-relay');
}
```

**Important:** Writ lifecycle events (like `task.completed`) are signaled automatically by `completeWrit()` and `failWrit()`. Don't double-signal — just call the appropriate function and the event fires.

For custom events, you must declare them in `guild.json` first if animas need to signal them. Relays can signal framework events directly (they call `signalEvent()`, which doesn't go through `validateCustomEvent()`).

## Error handling

### The `standing-order.failed` safety net

When a relay handler throws, the Clockworks dispatcher:

1. Catches the error
2. Records a failed dispatch row in the `event_dispatches` book (with the error message)
3. Signals `standing-order.failed` with the original event, the standing order, and the error

You can wire a standing order to `standing-order.failed` for alerting:

```json
{ "on": "standing-order.failed", "run": "notify-patron" }
```

**Loop guard:** If a relay invoked in response to a `standing-order.failed` event itself fails, the dispatcher suppresses the second-order failure (the dispatch row is recorded with `status: 'skipped'` and a `loop-guard:` reason) — error handlers handling errors do not cascade.

### Best practices

- **Fail fast.** Throw with a clear error message. Don't swallow errors silently.
- **Idempotency.** Design handlers to be safe to retry. The same event might be processed again if the dispatcher is restarted.
- **Guard against missing data.** Event payloads may be incomplete. Check for null/undefined before accessing fields.

## Multi-relay kits

A single package can contribute multiple relays — each entry in the `relays` array is registered independently under its own `name`:

```typescript
import { relay } from '@shardworks/clockworks-apparatus';

export default {
  recommends: ['nexus-clockworks'],
  relays: [
    relay({
      name: 'writ-notify',
      handler: async (event, { home }) => { /* ... */ },
    }),
    relay({
      name: 'writ-audit',
      handler: async (event, { home }) => { /* ... */ },
    }),
  ],
};
```

Each relay can be named independently in `run:` standing orders.

## Installing relays

Same as tools — use `nsg tool install`:

```bash
nsg tool install @shardworks/relay-my-relay
```

The installer detects `nexus-relay.json` and registers the package in the `relays` section of `guild.json` (not `tools`). All five install types work: registry, git-url, workshop, tarball, link.

## Testing relays

Relay handlers can be called directly in tests — pull the registered relay off your default-exported kit and invoke its `handler`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initGuild, createWrit, completeWrit, showWrit } from '@shardworks/nexus-core';
import myKit from './handler.ts';

const myRelay = myKit.relays[0]; // or find by name

describe('my-relay', () => {
  let home: string;

  beforeEach(() => {
    home = '/tmp/test-guild-' + Date.now();
    initGuild(home, 'test-guild', 'test-model');
  });

  it('processes a completed writ event', async () => {
    // Set up test data
    const writ = createWrit(home, { type: 'task', title: 'Test task' });
    completeWrit(home, writ.id);

    // Simulate the event
    await myRelay.handler(
      {
        id: 'evt-test',
        name: 'task.completed',
        payload: { writId: writ.id },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      },
      { home, params: {} },
    );

    // Verify the result
    const updated = showWrit(home, writ.id);
    assert.equal(updated?.status, 'completed');
  });
});
```

For integration testing through the full Clockworks dispatcher, signal an event and call `processEvents()` on the apparatus API:

```typescript
import { guild, signalEvent } from '@shardworks/nexus-core';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

// Signal an event
signalEvent(home, 'task.completed', { writId: 'wrt-test' }, 'test');

// Drain the event queue through the dispatcher (requires standing orders in guild.json)
const clockworks = guild().apparatus<ClockworksApi>('clockworks');
const result = await clockworks.processEvents();
assert.ok(result.processedEvents >= 1);
```

## Reference implementation: notification relay

A concrete relay that sends a notification when a mandate completes — a simple pattern for post-completion automation.

```typescript
import { relay, type ClockworksKit } from '@shardworks/clockworks-apparatus';
import { showWrit, readCommission } from '@shardworks/nexus-core';

export default {
  recommends: ['nexus-clockworks'],
  relays: [
    relay({
      name: 'mandate-notify',
      description: 'Log a notification when a mandate completes.',
      handler: async (event, { home }) => {
        if (!event) return;

        // This relay responds to mandate.completed events
        const payload = event.payload as { writId?: string; commissionId?: string } | null;
        if (!payload?.writId) return;

        const writ = showWrit(home, payload.writId);
        if (!writ) return;

        // Look up the commission for context
        const commission = payload.commissionId
          ? readCommission(home, payload.commissionId)
          : null;

        console.log(`Mandate "${writ.title}" completed for commission ${commission?.id ?? 'unknown'}`);
        // In a real relay: send a Slack message, write a summary, etc.
      },
    }),
  ],
} satisfies ClockworksKit;
```

Wire it in `guild.json`:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "mandate.completed", "run": "mandate-notify" }
    ]
  }
}
```

**Note:** Completion rollup for writs is handled automatically by the framework. When all children of a writ complete, the parent transitions from `pending` → `ready` (or auto-completes). You don't need a custom relay for rollup — the framework does it internally when `completeWrit()` or `failWrit()` is called.

## Further reading

- [The Clockworks](../architecture/clockworks.md) — architectural overview of the event substrate, standing orders, and the dispatcher
- [Core API Reference](../reference/core-api.md) — full function signatures for `signalEvent`, writ CRUD, guild config, and other helpers a relay handler may call
- [Event Catalog](../reference/event-catalog.md) — every framework event, payload shapes, standing order semantics
- [Schema Reference](../reference/schema.md) — book documents, status lifecycles, entity relationships
- [Building Tools](building-tools.md) — adjacent guide for building interactive tools animas wield
