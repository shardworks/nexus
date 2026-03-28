/**
 * Clockworks daemon — the long-running process that polls the event queue.
 *
 * Spawned by clockStart() as a detached child process. Accepts two arguments:
 *   argv[2] = guild home path
 *   argv[3] = polling interval in ms
 *
 * Logs to stdout/stderr, which clockStart() redirects to the log file.
 * Handles SIGTERM for graceful shutdown.
 */
import { clockRun } from './clockworks.ts';
import { registerSessionProvider } from './session.ts';

// Dynamically load the session provider so the daemon can dispatch anima sessions
// (summon/brief standing orders). The provider package is not a compile-time
// dependency of core, but it's always installed at runtime via the CLI package.
try {
  // @ts-expect-error — dynamic import of a package not in core's dependencies
  const mod = await import('@shardworks/claude-code-session-provider');
  registerSessionProvider(mod.claudeCodeProvider ?? mod.default);
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
  const timestamp = new Date().toISOString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
}

// Graceful shutdown: finish current processing, then exit.
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  shuttingDown = true;
  if (!processing) {
    log('Daemon stopped.');
    process.exit(0);
  }
  // If processing, the loop will exit after the current cycle.
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
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error during clock run: ${msg}`);
  }

  if (shuttingDown) break;

  // Wait for the next poll interval
  await new Promise(resolve => setTimeout(resolve, interval));
}

log('Daemon stopped.');
process.exit(0);
