/**
 * convene command
 *
 * Start a multi-turn dialogue between animas. Each anima takes turns
 * responding, seeing what the others said. Runs to completion.
 *
 * Usage:
 *   nsg convene steward artificer --topic "discuss X" --turns 10
 */
import { createCommand } from 'commander';
import {
  createConversation,
  takeTurn,
  nextParticipant,
  formatConveneMessage,
  showConversation,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeConveneCommand() {
  return createCommand('convene')
    .description('Start a multi-turn dialogue between animas')
    .argument('<animas...>', 'Anima names to participate (at least 2)')
    .option('--topic <text>', 'Topic or prompt to seed the conversation')
    .option('--turns <n>', 'Maximum number of turns', parseInt)
    .action(async (animaNames: string[], options: { topic?: string; turns?: number }, cmd) => {
      const home = resolveHome(cmd);

      if (animaNames.length < 2) {
        console.error('Error: convene requires at least 2 anima names.');
        process.exitCode = 1;
        return;
      }

      if (!options.topic) {
        console.error('Error: --topic is required.');
        process.exitCode = 1;
        return;
      }

      const turnLimit = options.turns ?? 10;

      // Create the conversation
      const { conversationId, participants } = createConversation(home, {
        kind: 'convene',
        topic: options.topic,
        turnLimit,
        participants: animaNames.map(name => ({ kind: 'anima' as const, name })),
      });

      console.log(`Convene ${conversationId} started`);
      console.log(`Participants: ${participants.map(p => p.name).join(', ')}`);
      console.log(`Topic: ${options.topic}`);
      console.log(`Turn limit: ${turnLimit}`);
      console.log('─'.repeat(60));
      console.log();

      // Run the dialogue
      let turnCount = 0;
      while (true) {
        const next = nextParticipant(home, conversationId);
        if (!next) break;

        const message = formatConveneMessage(home, conversationId, next.participantId);

        console.log(`[Turn ${turnCount + 1}] ${next.name}:`);
        console.log();

        let responseText = '';
        for await (const chunk of takeTurn(home, conversationId, next.participantId, message)) {
          if (chunk.type === 'text') {
            process.stdout.write(chunk.text);
            responseText += chunk.text;
          } else if (chunk.type === 'turn_complete') {
            const cost = chunk.costUsd ? ` ($${chunk.costUsd.toFixed(4)})` : '';
            console.log();
            console.log(`  [turn ${chunk.turnNumber} complete${cost}]`);
          }
        }

        console.log();
        console.log('─'.repeat(60));
        console.log();
        turnCount++;
      }

      // Summary
      const detail = showConversation(home, conversationId);
      if (detail) {
        console.log(`Convene complete: ${detail.turnCount} turns, $${detail.totalCostUsd.toFixed(4)} total cost`);
      }
    });
}
