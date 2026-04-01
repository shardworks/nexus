/**
 * Clockworks daemon — the long-running process that polls the event queue.
 *
 * Spawned by clockStart() (daemon-ctrl.ts) as a detached child process.
 *
 * Arguments:
 *   process.argv[2] — guild home path
 *   process.argv[3] — polling interval in milliseconds (default: 2000)
 *
 * Logs to stdout/stderr (redirected to clock.log by the parent process).
 * Handles SIGTERM for graceful shutdown: finishes the current processing
 * cycle before exiting.
 *
 * The session provider is loaded dynamically so the daemon can dispatch
 * anima sessions for summon/brief standing orders. It's not a compile-time
 * dependency of this package.
 */

import { clockRun } from './lib/runner.ts';

// Load the session provider so the daemon can dispatch anima sessions.
// The provider isn't a compile-time dependency — it's always available
// at runtime via the CLI package but we don't want to hard-depend on it here.
try {
  const { registerSessionProvider } = await import('@shardworks/nexus-core');
  // @ts-expect-error — runtime-only package not in our declared deps
  const mod = await import('@shardworks/claude-code-apparatus');
  const provider = mod.claudeCodeProvider ?? mod.default;
  if (provider) registerSessionProvider(provider);
} catch {
  // Session provider not available — anima dispatches will be skipped.
}

const home = process.argv[2];
const interval = parseInt(process.argv[3] ?? '2000', 10);

if (!home) {
  process.stderr.write('Usage: clock-daemon <guild-home> [interval-ms]\n');
  process.exit(1);
}

let shuttingDown = false;
let processing = false;

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  shuttingDown = true;
  if (!processing) {
    log('Daemon stopped.');
    process.exit(0);
  }
});

log(`Clockworks daemon started (PID ${process.pid}, interval ${interval}ms, home: ${home})`);

while (!shuttingDown) {
  try {
    processing = true;
    const result = await clockRun(home);
    processing = false;

    if (result.processed.length > 0) {
      const summary = result.processed
        .map(t => `${t.eventName} (${t.dispatches.length} dispatch${t.dispatches.length === 1 ? '' : 'es'})`)
        .join(', ');
      log(`Processed ${result.processed.length} event${result.processed.length === 1 ? '' : 's'}: ${summary}`);
    }
    // Idle cycles are silent — don't spam the log.
  } catch (err) {
    processing = false;
    log(`Error during clock run: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (shuttingDown) break;
  await new Promise<void>(resolve => setTimeout(resolve, interval));
}

log('Daemon stopped.');
process.exit(0);
