# `@shardworks/oculus-apparatus`

The Oculus is the guild's web dashboard apparatus. It serves an HTTP dashboard via Hono where plugins contribute static pages and custom API routes through kit contributions. Guild tools are automatically exposed as REST endpoints. It requires `tools` and consumes `pages` and `routes` kit contributions.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/oculus-apparatus": "workspace:*"
  }
}
```

The Oculus requires the `tools` apparatus and consumes `pages` and `routes` kit contributions.

## API

The Oculus exposes an `OculusApi` via `provides`, accessible at runtime via `guild().apparatus<OculusApi>('oculus')`.

```typescript
import type { OculusApi } from '@shardworks/oculus-apparatus';

const oculus = guild().apparatus<OculusApi>('oculus');

// Check configured port
const port = oculus.port(); // default: 7470

// Start the HTTP server (no-op if already running)
await oculus.startServer();

// Gracefully stop the HTTP server (idempotent, no-op if not running)
await oculus.stopServer();
```

### `OculusApi`

```typescript
interface OculusApi {
  /** The port the server will listen on (or is listening on). */
  port(): number;
  /** Start the HTTP server. No-op if already running. */
  startServer(): Promise<void>;
  /** Stop the HTTP server gracefully. Idempotent — no-op if not running. */
  stopServer(): Promise<void>;
}
```

## Configuration

Configure the Oculus in `guild.json` under the `oculus` key:

```json
{
  "oculus": {
    "port": 7470
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `7470` | Port the HTTP server listens on. |

## Kit Interface

### `pages`

Plugins contribute pages as static asset directories. Each page gets a URL at `/pages/{id}/` with automatic chrome injection (navigation bar, shared stylesheet, shared cost/token formatter, and shared URL-state helper).

The chrome injection includes `/static/nexus-format.js`, which exposes `window.NexusFormat` to every contributed page. Dashboards should use the shared helpers rather than implementing their own:

| Helper | Behavior |
|--------|----------|
| `window.NexusFormat.formatCostUsd(n)` | Formats a USD cost as `$x.yy` (two decimals). Non-finite input falls back to `$0.00`. |
| `window.NexusFormat.formatTokenCount(n)` | Formats a token count with US-locale comma grouping (e.g. `1,234,567`). |
| `window.NexusFormat.formatCostWithTokens(c, i, o)` | Renders `$x.yy (I input, O output)`; omits the parenthetical when either token count is `undefined`. |

Using the shared helpers keeps cost and token precision consistent across every plugin's dashboard.

### Deep-linkable UI state — `window.NexusUrl`

The chrome injection also includes `/static/nexus-url.js`, which exposes `window.NexusUrl` for reading and writing deep-linkable UI state. **Pages MUST use this helper rather than rolling their own** — the duplicated `currentUrlParams` / `updateUrl` pattern that previously appeared in every list page is collapsed into this single namespace, and new pages should not reintroduce inline copies.

Filter, sort, search, date-range, and view-toggle state on a list page is required to round-trip through the URL, so refreshing the page or copy-pasting the URL into a fresh tab reproduces the filtered view exactly. Pagination offset and per-row tree-collapse state are excluded — pagination resets to the first page on share, and tree collapse is unbounded ephemeral state.

| Helper | Behavior |
|--------|----------|
| `window.NexusUrl.read()` | Returns a fresh `URLSearchParams` snapshot of `window.location.search`. Always live — never cached. |
| `window.NexusUrl.update(changes, opts?)` | Applies a key→value patch to the current querystring. Defaults to `replaceState`. Pass `{ push: true }` to use `pushState`. |
| `window.NexusUrl.onChange(cb)` | Registers a popstate-driven subscriber. The callback receives the fresh `URLSearchParams`. Returns an unsubscribe function. |
| `window.NexusUrl.getString(key, default?)` | Reads a single string value, returning the supplied default when the key is absent. |
| `window.NexusUrl.getAll(key)` | Reads all values for a repeated-key array. Returns `[]` when the key is absent. |
| `window.NexusUrl.getBool(key, default?)` | Reads a boolean, accepting `true`/`false` (and `1`/`0` for compatibility). Falls back to the supplied default for unknown encodings. |
| `window.NexusUrl.getInt(key, default?)` | Reads an integer, returning the supplied default when the value is absent or non-numeric. |
| `window.NexusUrl.has(key)` | Returns whether the key is present in the current querystring. |

#### Conventions

- **Push vs replace.** `update()` defaults to `replaceState` so that filter changes do not clutter browser history. Navigation events — opening a detail view, for example — must explicitly opt into `{ push: true }` so the browser's Back button returns to the list.
- **Repeated keys for arrays.** Multi-valued filters like `?type=mandate&type=bug` use repeated keys, parsed via `getAll()`. This matches the server-side `parseQueryParams` convention so the same URL is hand-editable and round-trips through any GET endpoint.
- **Omit defaults.** Passing `null`, `undefined`, an empty string, or an empty array to `update()` deletes the key. URLs stay clean for the common case; the page treats absent-key as default-value, preserving round-trip fidelity.
- **Boolean encoding.** Booleans round-trip as `?key=true` / `?key=false` strings. The `getBool` helper accepts both forms (and the legacy `1`/`0` for compatibility).
- **Fail-loud on invalid values.** Pages MUST surface an error banner when a URL filter value does not validate against the page's known set (e.g. `?classification=bogus`). Silent fallback to a default is forbidden — operators copy-pasting URLs need honest feedback rather than a quietly different view.
- **Server-key alignment.** When a filter value is also sent to a `/api` endpoint, the URL key matches the server's parameter name exactly (e.g. `?type=`, `?status=`, `?classification=`). New keys for client-only filter state pick natural short names (`?q=` for search, `?sort=` + `?dir=` for sort, `?from=` / `?to=` for dates).
- **Page-author contract.** Pages must read URL state on first paint *before* fetching the list (and *after* any dynamic filter UI is built so default-fill does not clobber URL-restored selections); the page's existing popstate handler must restore filter state in addition to detail-id state. Pages must not reintroduce inline `currentUrlParams` / `updateUrl` definitions — every page consumes `window.NexusUrl`.

```typescript
interface PageContribution {
  /** Unique page ID — becomes the URL segment: /pages/{id}/ */
  id: string;
  /** Human-readable title used in navigation. */
  title: string;
  /** Path to the static assets directory, relative to the package root. Must contain an index.html. */
  dir: string;
}
```

### `routes`

Plugins contribute custom API routes. Routes must start with `/api/`.

```typescript
interface RouteContribution {
  /** HTTP method (uppercase): 'GET', 'POST', 'DELETE', etc. */
  method: string;
  /** Hono path pattern. Must begin with /api/. */
  path: string;
  /** Hono handler function. */
  handler: (c: Context) => Response | Promise<Response>;
}
```

## Support Kit

The Oculus provides a single tool:

### `oculus`

Starts the Oculus web dashboard and blocks until interrupted (SIGINT/SIGTERM). On signal, gracefully stops the server before returning. Callable by patrons only.

## Built-in Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Guild home page — identity, warnings, plugins, config |
| `/api/_status` | GET | JSON status of the guild (name, version, plugins, config) |
| `/api/_tools` | GET | JSON index of all patron-callable tools with routes and params |
| `/static/*` | GET | Static assets (stylesheets, shared `nexus-format.js` and `nexus-url.js` helpers) |
| `/pages/{id}/*` | GET | Contributed page assets |

Guild tools are automatically mapped to REST routes based on their name and permission level.
