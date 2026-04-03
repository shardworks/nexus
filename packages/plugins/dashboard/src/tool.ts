/**
 * dashboard-start tool — CLI-only.
 *
 * Starts the web dashboard server and opens the browser.
 * Runs until the process is interrupted (Ctrl+C).
 */

import { execSync } from 'node:child_process';
import process from 'node:process';
import { z } from 'zod';
import { tool } from '@shardworks/tools-apparatus';
import { startServer } from './server.ts';

export const dashboardStart = tool({
  name: 'dashboard-start',
  description: 'Start the guild web dashboard. Opens a browser and serves a live operations UI.',
  callableBy: ['cli'],
  params: {
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe('Port to listen on (default: 4242)'),
    'no-open': z
      .boolean()
      .optional()
      .describe('Skip opening the browser automatically'),
  },
  handler: async ({ port: portArg, 'no-open': noOpen }) => {
    const port = portArg ?? 4242;
    const server = await startServer(port);
    const url = server.url;

    console.log('');
    console.log('  Guild Dashboard running at:');
    console.log('');
    console.log('    ' + url);
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    if (!noOpen) {
      try {
        const platform = process.platform;
        if (platform === 'darwin')  execSync('open ' + url,   { stdio: 'ignore' });
        else if (platform === 'win32') execSync('start "" ' + url, { stdio: 'ignore', shell: 'cmd.exe' });
        else execSync('xdg-open ' + url + ' 2>/dev/null; true', { stdio: 'ignore', shell: '/bin/sh' });
      } catch {
        // Browser open is best-effort; ignore errors
      }
    }

    // Keep the process alive until Ctrl+C
    await new Promise<void>(resolve => {
      process.once('SIGINT',  async () => { await server.close(); resolve(); });
      process.once('SIGTERM', async () => { await server.close(); resolve(); });
    });

    return { status: 'stopped', url };
  },
});
