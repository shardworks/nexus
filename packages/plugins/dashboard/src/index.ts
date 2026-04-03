/**
 * @shardworks/dashboard-apparatus — The Dashboard.
 *
 * Web-based guild operations dashboard. Exposes the `dashboard-start` CLI
 * tool which launches a local web server with a live operations UI including
 * tabs for Overview, Clerk, Walker, Animator, and Codexes.
 *
 * Usage:
 *   nsg dashboard start
 *   nsg dashboard start --port 8080
 *   nsg dashboard start --no-open
 */

import { createDashboard } from './dashboard.ts';

export { createDashboard } from './dashboard.ts';

// ── Default export: the apparatus plugin ──────────────────────────

export default createDashboard();
