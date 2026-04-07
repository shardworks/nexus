import type { Context } from 'hono';

/** A page contributed by a plugin kit or apparatus supportKit. */
export interface PageContribution {
  /** Unique page ID — becomes the URL segment: /pages/{id}/ */
  id: string;
  /** Human-readable title used in navigation. */
  title: string;
  /**
   * Path to the directory containing the page's static assets,
   * relative to the contributing package's root in node_modules.
   * Must contain an index.html entry point.
   */
  dir: string;
}

/** A custom route contributed by a plugin kit or apparatus supportKit. */
export interface RouteContribution {
  /** HTTP method (uppercase): 'GET', 'POST', 'DELETE', etc. */
  method: string;
  /** Hono path pattern. Must begin with /api/. */
  path: string;
  /** Hono handler function. */
  handler: (c: Context) => Response | Promise<Response>;
}

/** Kit contribution interface — consumed by the Oculus. */
export interface OculusKit {
  pages?: PageContribution[];
  routes?: RouteContribution[];
}

/** The Oculus configuration from guild.json under 'oculus'. */
export interface OculusConfig {
  /** Port to listen on. Default: 7470. */
  port?: number;
}

/** The Oculus's public API, exposed via provides. */
export interface OculusApi {
  /** The port the server will listen on (or is listening on). */
  port(): number;
  /** Start the HTTP server. No-op if already running. */
  startServer(): Promise<void>;
}
