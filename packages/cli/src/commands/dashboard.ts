import { createCommand } from 'commander';
import { resolveHome } from '../resolve-home.ts';

export function makeDashboardCommand() {
  return createCommand('dashboard')
    .description('Start the guild monitor web dashboard')
    .option('-p, --port <number>', 'Port to serve on', '4200')
    .action(async (opts, cmd) => {
      let home: string;
      try {
        home = resolveHome(cmd);
      } catch {
        console.error('Not inside a guild. Run `nsg init` to create one, or use --guild-root.');
        process.exit(1);
      }

      const port = parseInt(opts.port, 10);
      if (isNaN(port)) {
        console.error(`Invalid port: ${opts.port}`);
        process.exit(1);
      }

      // Lazy-load guild-monitor so a broken/outdated version doesn't
      // take down every CLI command at import time.
      let startMonitor: (opts: { home: string; port: number }) => Promise<void>;
      try {
        ({ startMonitor } = await import('@shardworks/guild-monitor'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to load @shardworks/guild-monitor: ${msg}`);
        console.error('Try updating: npm install -g @shardworks/nexus@latest');
        process.exit(1);
      }

      await startMonitor({ home, port });
    });
}
