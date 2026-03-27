/**
 * conversation command group
 *
 * Manage conversations — multi-turn interactions with animas.
 *
 * Subcommands:
 *   nsg conversation list    — list conversations
 *   nsg conversation show    — show conversation detail with turns
 *   nsg conversation end     — end an active conversation
 */
import { createCommand } from 'commander';
import {
  listConversations,
  showConversation,
  endConversation,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeConversationCommand() {
  const cmd = createCommand('conversation')
    .description('Manage conversations (multi-turn interactions)')
    .alias('conv');

  // ── list ───────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('List conversations')
    .option('--status <status>', 'Filter by status (active, concluded, abandoned)')
    .option('--kind <kind>', 'Filter by kind (consult, convene)')
    .option('--limit <n>', 'Maximum results', parseInt)
    .action((options, command) => {
      const home = resolveHome(command);

      const conversations = listConversations(home, {
        status: options.status,
        kind: options.kind,
        limit: options.limit,
      });

      if (conversations.length === 0) {
        console.log('No conversations found.');
        return;
      }

      // Table output
      console.log(
        'ID'.padEnd(16) +
        'Kind'.padEnd(10) +
        'Status'.padEnd(12) +
        'Turns'.padEnd(8) +
        'Cost'.padEnd(10) +
        'Participants'.padEnd(30) +
        'Created',
      );
      console.log('─'.repeat(100));

      for (const c of conversations) {
        const participants = c.participants.map(p => p.name).join(', ');
        const cost = c.totalCostUsd > 0 ? `$${c.totalCostUsd.toFixed(4)}` : '—';
        const turns = c.turnLimit
          ? `${c.turnCount}/${c.turnLimit}`
          : String(c.turnCount);

        console.log(
          c.id.padEnd(16) +
          c.kind.padEnd(10) +
          c.status.padEnd(12) +
          turns.padEnd(8) +
          cost.padEnd(10) +
          participants.slice(0, 28).padEnd(30) +
          c.createdAt.slice(0, 19),
        );
      }
    });

  // ── show ───────────────────────────────────────────────────────────

  cmd
    .command('show <id>')
    .description('Show conversation detail with turns')
    .action((id, _options, command) => {
      const home = resolveHome(command);

      const detail = showConversation(home, id);
      if (!detail) {
        console.error(`Conversation "${id}" not found.`);
        process.exitCode = 1;
        return;
      }

      console.log(`Conversation: ${detail.id}`);
      console.log(`Kind:         ${detail.kind}`);
      console.log(`Status:       ${detail.status}`);
      if (detail.topic) {
        console.log(`Topic:        ${detail.topic.slice(0, 80)}${detail.topic.length > 80 ? '...' : ''}`);
      }
      console.log(`Turn Limit:   ${detail.turnLimit ?? 'none'}`);
      console.log(`Turns:        ${detail.turnCount}`);
      console.log(`Total Cost:   ${detail.totalCostUsd > 0 ? `$${detail.totalCostUsd.toFixed(4)}` : '—'}`);
      console.log(`Created:      ${detail.createdAt}`);
      if (detail.endedAt) {
        console.log(`Ended:        ${detail.endedAt}`);
      }

      console.log(`\nParticipants:`);
      for (const p of detail.participants) {
        console.log(`  ${p.name} (${p.kind})`);
      }

      if (detail.turns.length > 0) {
        console.log(`\nTurns:`);
        console.log(
          '  #'.padEnd(5) +
          'Participant'.padEnd(20) +
          'Cost'.padEnd(10) +
          'Duration'.padEnd(10) +
          'Exit'.padEnd(6) +
          'Session',
        );
        console.log('  ' + '─'.repeat(70));

        for (const t of detail.turns) {
          const cost = t.costUsd != null ? `$${t.costUsd.toFixed(4)}` : '—';
          const duration = t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : '—';
          const exit = t.exitCode != null ? String(t.exitCode) : '—';

          console.log(
            `  ${String(t.turnNumber).padEnd(3)}` +
            t.participant.padEnd(20) +
            cost.padEnd(10) +
            duration.padEnd(10) +
            exit.padEnd(6) +
            t.sessionId,
          );

          // Show the prompt (human's message in a consult) if available
          if (t.prompt) {
            const preview = t.prompt.slice(0, 72).replace(/\n/g, ' ');
            console.log(`      → ${preview}${t.prompt.length > 72 ? '...' : ''}`);
          }
        }
      }
    });

  // ── end ────────────────────────────────────────────────────────────

  cmd
    .command('end <id>')
    .description('End an active conversation')
    .option('--reason <reason>', 'Reason: concluded or abandoned', 'concluded')
    .action((id, options, command) => {
      const home = resolveHome(command);

      const reason = options.reason as 'concluded' | 'abandoned';
      if (reason !== 'concluded' && reason !== 'abandoned') {
        console.error('Error: --reason must be "concluded" or "abandoned".');
        process.exitCode = 1;
        return;
      }

      try {
        endConversation(home, id, reason);
        console.log(`Conversation ${id} ${reason}.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
