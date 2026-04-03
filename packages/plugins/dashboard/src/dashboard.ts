/**
 * The Dashboard — web-based guild operations dashboard apparatus.
 *
 * Contributes the `dashboard-start` CLI tool which launches a web server
 * serving a live operations UI. The apparatus itself is passive — no
 * background server runs at guild startup. The server only runs when
 * the operator explicitly invokes `nsg dashboard start`.
 *
 * See: docs/architecture/apparatus/dashboard.md
 */

import type { Plugin } from '@shardworks/nexus-core';
import { dashboardStart } from './tool.ts';

export function createDashboard(): Plugin {
  return {
    apparatus: {
      recommends: ['clerk', 'stacks', 'animator', 'spider', 'codexes'],

      supportKit: {
        tools: [dashboardStart],
      },

      start(): void {
        // Nothing to start — the dashboard server is launched on demand
        // via the dashboard-start CLI tool.
      },
    },
  };
}
