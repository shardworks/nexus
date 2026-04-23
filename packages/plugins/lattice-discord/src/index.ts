/**
 * @shardworks/lattice-discord-kit — Discord webhook channel for the Lattice.
 *
 * Contributes a single `latticeChannels` factory (`type: 'discord-webhook'`)
 * that the Lattice materializes from `guild.json`'s `lattice.channels`
 * array. The URL is read from an environment variable at send time; it is
 * never persisted to guild.json.
 *
 * This is a passive kit package — no start/stop lifecycle.
 *
 * See: docs/architecture/apparatus/lattice.md (channel contribution)
 */

import type { LatticeKit } from '@shardworks/lattice-apparatus';

import { createDiscordWebhookFactory } from './channel.ts';

export type { DiscordWebhookInstanceConfig } from './channel.ts';
export {
  createDiscordWebhookFactory,
  buildPayload,
  embedColorForTrigger,
  contextFields,
} from './channel.ts';

const kit: LatticeKit & { requires?: string[] } = {
  // Hard dependency on the Lattice — without it, this kit has no consumer.
  requires: ['lattice'],
  latticeChannels: [createDiscordWebhookFactory()],
};

export default { kit };
