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

Plugins contribute pages as static asset directories. Each page gets a URL at `/pages/{id}/` with automatic chrome injection (navigation bar, stylesheet).

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
| `/static/*` | GET | Static assets (stylesheets) |
| `/pages/{id}/*` | GET | Contributed page assets |

Guild tools are automatically mapped to REST routes based on their name and permission level.
