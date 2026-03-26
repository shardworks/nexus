import { createCommand } from 'commander';
import { VERSION, registerSessionProvider } from '@shardworks/nexus-core';
import { claudeCodeProvider } from '@shardworks/claude-code-session-provider';
import { makeInitCommand } from './commands/init.ts';
import { makeToolCommand } from './commands/tool.ts';
import { makeRestoreCommand } from './commands/rehydrate.ts';
import { makeCommissionCommand } from './commands/commission.ts';
import { makeStatusCommand } from './commands/status.ts';
import { makeConsultCommand } from './commands/consult.ts';
import { makeSignalCommand } from './commands/signal.ts';
import { makeClockCommand } from './commands/clock.ts';
import { makeWorkshopCommand } from './commands/workshop.ts';
import { makeAnimaCommand } from './commands/anima.ts';
import { makeSessionCommand } from './commands/session.ts';
import { makeEventCommand } from './commands/event.ts';
import { makeDispatchCommand } from './commands/dispatch.ts';
import { makeAuditCommand } from './commands/audit.ts';
import { makeDashboardCommand } from './commands/dashboard.ts';
import { makeUpgradeCommand } from './commands/upgrade.ts';
import { makeConversationCommand } from './commands/conversation.ts';
import { makeConveneCommand } from './commands/convene.ts';
import { makeUpgradeBooksCommand } from './commands/upgrade-books.ts';

// Register the Claude Code session provider so core's session funnel
// can launch claude sessions.
registerSessionProvider(claudeCodeProvider);

export const program = createCommand('nsg')
  .description('Nexus Mk 2.1 — experimental multi-agent AI system')
  .version(VERSION)
  .option('--guild-root <path>', 'Path to guild root (default: auto-detect from cwd)');

// ── Top-level commands (special operations, not noun-verb) ─────────────
program.addCommand(makeInitCommand());
program.addCommand(makeConsultCommand());
program.addCommand(makeConveneCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeSignalCommand());

// ── Noun groups ────────────────────────────────────────────────────────

// nsg guild [restore]
const guildGroup = createCommand('guild')
  .description('Guild-wide operations');
guildGroup.addCommand(makeRestoreCommand());
guildGroup.addCommand(makeUpgradeBooksCommand());
program.addCommand(guildGroup);

// nsg workshop [create|register|list|show|remove]
program.addCommand(makeWorkshopCommand());

// nsg tool [install|remove|list]
program.addCommand(makeToolCommand());

// nsg anima [create|list|show|update|remove|manifest]
program.addCommand(makeAnimaCommand());

// nsg commission [create|list|show|update]
program.addCommand(makeCommissionCommand());

// nsg clock [list|tick|run|start|stop|status]
program.addCommand(makeClockCommand());

// nsg session [list|show]
program.addCommand(makeSessionCommand());

// nsg event [list|show]
program.addCommand(makeEventCommand());

// nsg dispatch [list]
program.addCommand(makeDispatchCommand());

// nsg audit [list]
program.addCommand(makeAuditCommand());

// nsg conversation [list|show|end]
program.addCommand(makeConversationCommand());

// nsg dashboard
program.addCommand(makeDashboardCommand());

// nsg upgrade [--dry-run]
program.addCommand(makeUpgradeCommand());
