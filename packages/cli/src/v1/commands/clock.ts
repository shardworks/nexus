import { createCommand } from 'commander';
import {
  readPendingEvents,
  clockTick,
  clockRun,
  clockStart,
  clockStop,
  clockStatus,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

/**
 * Format milliseconds as a human-readable uptime string.
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Print a warning if the daemon is running, return true if it is.
 */
function warnIfDaemonRunning(home: string): boolean {
  const status = clockStatus(home);
  if (status.running) {
    console.warn(`Warning: Clockworks daemon is running (PID ${status.pid}). Events are being processed automatically.`);
    return true;
  }
  return false;
}

export function makeClockCommand() {
  const clock = createCommand('clock')
    .description('Clockworks — process the guild event queue');

  // nsg clock list
  clock.addCommand(
    createCommand('list')
      .description('Show all pending (unprocessed) events')
      .action((_, cmd) => {
        const home = resolveHome(cmd);

        try {
          const events = readPendingEvents(home);

          if (events.length === 0) {
            console.log('No pending events.');
            return;
          }

          console.log(`${events.length} pending event${events.length === 1 ? '' : 's'}:\n`);
          for (const event of events) {
            const payloadSummary = event.payload
              ? ` — ${JSON.stringify(event.payload).slice(0, 80)}`
              : '';
            console.log(`  #${event.id}  ${event.name}  (${event.emitter}, ${event.firedAt})${payloadSummary}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg clock tick [id]
  clock.addCommand(
    createCommand('tick')
      .description('Process the next pending event, or a specific event by id')
      .argument('[id]', 'Specific event id to process')
      .action(async (id: string | undefined, _, cmd) => {
        const home = resolveHome(cmd);

        try {
          if (warnIfDaemonRunning(home)) return;

          const result = await clockTick(home, id);

          if (!result) {
            console.log('No pending events to process.');
            return;
          }

          console.log(`Processed event #${result.eventId}: ${result.eventName}`);
          if (result.dispatches.length === 0) {
            console.log('  No matching standing orders.');
          } else {
            for (const d of result.dispatches) {
              const statusIcon = d.status === 'success' ? '✓' : d.status === 'skipped' ? '⊘' : '✗';
              console.log(`  ${statusIcon} ${d.handlerType}: ${d.handlerName}${d.error ? ` — ${d.error}` : ''}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg clock run
  clock.addCommand(
    createCommand('run')
      .description('Process all pending events until the queue is empty')
      .action(async (_, cmd) => {
        const home = resolveHome(cmd);

        try {
          if (warnIfDaemonRunning(home)) return;

          const result = await clockRun(home);

          if (result.processed.length === 0) {
            console.log('No pending events to process.');
            return;
          }

          console.log(`Processed ${result.processed.length} event${result.processed.length === 1 ? '' : 's'}:\n`);
          for (const tick of result.processed) {
            console.log(`  #${tick.eventId}  ${tick.eventName}`);
            if (tick.dispatches.length === 0) {
              console.log('    No matching standing orders.');
            } else {
              for (const d of tick.dispatches) {
                const statusIcon = d.status === 'success' ? '✓' : d.status === 'skipped' ? '⊘' : '✗';
                console.log(`    ${statusIcon} ${d.handlerType}: ${d.handlerName}${d.error ? ` — ${d.error}` : ''}`);
              }
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg clock start [--interval <ms>]
  clock.addCommand(
    createCommand('start')
      .description('Start the clockworks daemon (background process)')
      .option('--interval <ms>', 'Polling interval in milliseconds', '2000')
      .action((opts, cmd) => {
        const home = resolveHome(cmd);

        try {
          const interval = parseInt(opts.interval, 10);
          if (isNaN(interval) || interval < 100) {
            console.error('Error: Interval must be a number >= 100ms.');
            process.exitCode = 1;
            return;
          }

          const result = clockStart(home, { interval });
          console.log(`Clockworks daemon started (PID ${result.pid}).`);
          console.log(`Log file: ${result.logFile}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg clock stop
  clock.addCommand(
    createCommand('stop')
      .description('Stop the clockworks daemon')
      .action((_, cmd) => {
        const home = resolveHome(cmd);

        try {
          const result = clockStop(home);
          if (result.stopped) {
            console.log(`Clockworks daemon stopped (PID ${result.pid}).`);
          } else {
            console.log(`Clockworks daemon was not running (stale PID ${result.pid} cleaned up).`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg clock status
  clock.addCommand(
    createCommand('status')
      .description('Show clockworks daemon status')
      .action((_, cmd) => {
        const home = resolveHome(cmd);

        try {
          const status = clockStatus(home);
          if (status.running) {
            console.log(`Clockworks daemon is running.`);
            console.log(`  PID:     ${status.pid}`);
            console.log(`  Uptime:  ${formatUptime(status.uptime!)}`);
            console.log(`  Log:     ${status.logFile}`);
          } else {
            console.log('Clockworks daemon is not running.');
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return clock;
}
