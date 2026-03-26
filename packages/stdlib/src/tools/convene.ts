import { tool, createConversation, takeTurn, nextParticipant, formatConveneMessage, showConversation } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'convene',
  description: 'Start a multi-turn dialogue between animas and run it to completion',
  instructions: `Convenes a conversation between two or more animas on a given topic. Each anima takes turns responding in round-robin order, seeing what the others said. The conversation runs to completion (up to the turn limit) and returns the full dialogue.

Use this when you need multiple perspectives on a problem, want animas to collaborate on a decision, or need to gather input from several roles.

The calling anima is NOT automatically included — list all intended participants explicitly.`,
  params: {
    participants: z.array(z.string()).min(2).describe('Anima names to participate (at least 2)'),
    topic: z.string().describe('Topic or prompt to seed the conversation'),
    turnLimit: z.number().optional().default(10).describe('Maximum number of turns'),
  },
  handler: async (params, { home }) => {
    const { conversationId } = createConversation(home, {
      kind: 'convene',
      topic: params.topic,
      turnLimit: params.turnLimit,
      participants: params.participants.map(name => ({ kind: 'anima' as const, name })),
    });

    // Run the dialogue to completion
    const dialogue: Array<{ turn: number; participant: string; response: string }> = [];

    while (true) {
      const next = nextParticipant(home, conversationId);
      if (!next) break;

      const message = formatConveneMessage(home, conversationId, next.participantId);

      let responseText = '';
      for await (const chunk of takeTurn(home, conversationId, next.participantId, message)) {
        if (chunk.type === 'text') {
          responseText += chunk.text;
        }
      }

      dialogue.push({
        turn: dialogue.length + 1,
        participant: next.name,
        response: responseText,
      });
    }

    const detail = showConversation(home, conversationId);

    return {
      conversationId,
      totalTurns: dialogue.length,
      totalCostUsd: detail?.totalCostUsd ?? 0,
      dialogue,
    };
  },
});
