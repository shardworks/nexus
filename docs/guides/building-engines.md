# Building Engines

This guide explains how to build clockwork engines — event-driven handlers that respond to guild events via standing orders. For building interactive tools that animas wield, see [Building Tools](building-tools.md).

## What engines are

Engines are automated processes with no AI involvement. They run deterministic logic in response to events: rolling up completion status, dispatching work, transforming data, enforcing policies. They don't have instruction documents because no anima wields them — they're guild infrastructure.

Engines are wired to events through **standing orders** in `guild.json`. When an event fires, the Clockworks runner finds matching standing orders and calls the engine's handler with the event.

## Quick start

An engine is a package with these files:

```
my-engine/
  package.json              ← npm package metadata
  nexus-engine.json         ← Nexus descriptor
  src/
    handler.ts              ← the engine handler (default export)
```

### The handler

Use the `engine()` factory from `@shardworks/nexus-core`:

```typescript
import { engine } from '@shardworks/nexus-core';

export default engine({
  name: 'my-engine',
  handler: async (event, { home, params }) => {
    // event  — the GuildEvent that triggered this engine (or null for direct invocation)
    // home   — absolute path to the guild root
    // params — extra keys from the standing order that invoked this engine

    if (!event) return; // nothing to do without an event

    console.log(`Handling ${event.name}`, event.payload);

    // Do your work here...
  }
});
```

### Key rules

1. **Default export.** The engine must be the default export. The Clockworks runner does `import(modulePath)` and reads `.default`.
2. **Async handler.** Engine handlers must return `Promise<void>`. The runner `await`s the handler.
3. **Event may be null.** When invoked directly (not via a standing order), `event` is `null`. Guard accordingly.
4. **Throw for errors.** If the handler throws, the Clockworks runner catches the error, records a failed dispatch, and signals `standing-order.failed`.
5. **Use `home` for everything.** The guild root is your entry point to all guild state — database, config, file system.
6. **Params are untyped.** `params` is `Record<string, unknown>` — cast to expected types in your handler. Provide sensible defaults.

### `nexus-engine.json`

```json
{
  "entry": "src/handler.ts",
  "version": "0.1.0",
  "description": "What this engine does"
}
```

Fields:
- `entry` — (required) path to the handler module
- `version` — informational, recorded in guild.json `upstream`
- `description` — human-readable

### `package.json`

```json
{
  "name": "@shardworks/engine-my-engine",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/handler.ts"
  },
  "dependencies": {
    "@shardworks/nexus-core": "workspace:*"
  }
}
```

Engines don't need `zod` (no parameter validation) or instruction files (no anima interaction).

## Standing order wiring

Engines are connected to events through standing orders in `guild.json`:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "session.ended", "run": "my-engine" },
      { "on": "task.completed", "run": "my-engine" }
    ]
  }
}
```

An engine can respond to multiple events. Multiple engines can respond to the same event — they execute in declaration order.

### Passing params to engines

Any key on a standing order that isn't `on` or `run` is passed to the engine as a param:

```json
{ "on": "deploy.requested", "run": "deploy", "environment": "staging", "dryRun": true }
```

The engine receives these in `params`:

```typescript
handler: async (event, { home, params }) => {
  const environment = (params.environment as string) ?? 'production';
  const dryRun = (params.dryRun as boolean) ?? false;
}
```

This lets the same engine serve multiple standing orders with different configurations. Params default to `{}` when no extra keys are present.

The engine must also be registered in guild.json's `engines` registry:

```json
{
  "engines": {
    "my-engine": {
      "upstream": "@shardworks/engine-my-engine@0.1.0",
      "installedAt": "2026-03-25T00:00:00.000Z",
      "package": "@shardworks/engine-my-engine"
    }
  }
}
```

This happens automatically when installed via `nsg tool install`.

## Reading guild state from an engine

Engines have full access to `@shardworks/nexus-core`. Common patterns:

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

### Querying the database

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

### Writing to the database

```typescript
import { completeWrit, signalEvent } from '@shardworks/nexus-core';

handler: async (event, { home }) => {
  // Complete a writ — this automatically signals {type}.completed
  completeWrit(home, writId);
}
```

## Signaling follow-on events

Engines can signal events to trigger further automation (event chaining):

```typescript
import { signalEvent } from '@shardworks/nexus-core';

handler: async (event, { home }) => {
  // Do some work...

  // Signal a custom event for downstream processing
  signalEvent(home, 'deploy.ready', { version: '1.2.3' }, 'my-engine');
}
```

**Important:** Writ lifecycle events (like `task.completed`) are signaled automatically by `completeWrit()` and `failWrit()`. Don't double-signal — just call the appropriate function and the event fires.

For custom events, you must declare them in `guild.json` first if animas need to signal them. Engines can signal framework events directly (they call `signalEvent()`, which doesn't go through `validateCustomEvent()`).

## Error handling

### The `standing-order.failed` safety net

When an engine handler throws, the Clockworks runner:

1. Catches the error
2. Records a failed dispatch in `event_dispatches` (with the error message)
3. Signals `standing-order.failed` with the original event, the standing order, and the error

You can wire a standing order to `standing-order.failed` for alerting:

```json
{ "on": "standing-order.failed", "brief": "steward" }
```

**Loop guard:** If processing a `standing-order.failed` event itself fails, the runner stops — it won't cascade infinitely.

### Best practices

- **Fail fast.** Throw with a clear error message. Don't swallow errors silently.
- **Idempotency.** Design handlers to be safe to retry. The same event might be processed again if the runner is restarted.
- **Guard against missing data.** Event payloads may be incomplete. Check for null/undefined before accessing fields.

## Engine collections

A single package can export multiple engines:

```typescript
import { engine } from '@shardworks/nexus-core';

export default [
  engine({
    name: 'writ-notify',
    handler: async (event, { home }) => { /* ... */ }
  }),
  engine({
    name: 'writ-audit',
    handler: async (event, { home }) => { /* ... */ }
  }),
];
```

Each engine in the array is resolved by name. Register each one separately in guild.json with the same `package` but different names.

## Installing engines

Same as tools — use `nsg tool install`:

```bash
nsg tool install @shardworks/engine-my-engine
```

The installer detects `nexus-engine.json` and registers in the `engines` section of guild.json (not `tools`). All five install types work: registry, git-url, workshop, tarball, link.

## Testing engines

Engine handlers can be called directly in tests:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initGuild, createWrit, completeWrit, showWrit } from '@shardworks/nexus-core';
import myEngine from './handler.ts';

describe('my-engine', () => {
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
    await myEngine.handler(
      {
        id: 'evt-test',
        name: 'task.completed',
        payload: { writId: writ.id },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      },
      { home, params: {} }
    );

    // Verify the result
    const updated = showWrit(home, writ.id);
    assert.equal(updated?.status, 'completed');
  });
});
```

For integration testing with the full Clockworks, use `clockTick()`:

```typescript
import { clockTick, signalEvent } from '@shardworks/nexus-core';

// Signal an event
signalEvent(home, 'task.completed', { writId: 'wrt-test' }, 'test');

// Process it through the Clockworks (requires standing orders in guild.json)
const result = await clockTick(home);
assert.equal(result?.eventName, 'task.completed');
```

## Reference implementation: notification engine

A concrete engine that sends a notification when a mandate completes — a simple pattern for post-completion automation.

```typescript
import { engine, showWrit, readCommission } from '@shardworks/nexus-core';

export default engine({
  name: 'mandate-notify',
  handler: async (event, { home }) => {
    if (!event) return;

    // This engine responds to mandate.completed events
    const payload = event.payload as { writId?: string; commissionId?: string } | null;
    if (!payload?.writId) return;

    const writ = showWrit(home, payload.writId);
    if (!writ) return;

    // Look up the commission for context
    const commission = payload.commissionId
      ? readCommission(home, payload.commissionId)
      : null;

    console.log(`Mandate "${writ.title}" completed for commission ${commission?.id ?? 'unknown'}`);
    // In a real engine: send a Slack message, write a summary, etc.
  }
});
```

Wire it in guild.json:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "mandate.completed", "run": "mandate-notify" }
    ]
  }
}
```

**Note:** Completion rollup for writs is handled automatically by the framework. When all children of a writ complete, the parent transitions from `pending` → `ready` (or auto-completes). You don't need a custom engine for rollup — the framework does it internally when `completeWrit()` or `failWrit()` is called.

## Further reading

- [Core API Reference](../reference/core-api.md) — full function signatures for all imports
- [Event Catalog](../reference/event-catalog.md) — every framework event, payload shapes, standing order types
- [Schema Reference](../reference/schema.md) — database tables, status lifecycles, entity relationships
- [The Clockworks](../architecture/clockworks.md) — architectural overview of the event processing system
