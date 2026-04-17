import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, MeaningDoc } from '../types.ts';

/**
 * Format a list of MeaningDocs as a three-column text table with headers
 * `ID`, `OWNER`, `DESCRIPTION`. Columns are space-padded to the widest row
 * (including the header) and separated by two spaces.
 */
function formatTable(meanings: MeaningDoc[]): string {
  if (meanings.length === 0) {
    return 'No meanings registered.';
  }

  const rows: Array<[string, string, string]> = [
    ['ID', 'OWNER', 'DESCRIPTION'],
    ...meanings.map((m) => [m.id, m.ownerPlugin, m.description] as [string, string, string]),
  ];

  const widths = [0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < 3; i++) {
      if (row[i]!.length > widths[i]!) widths[i] = row[i]!.length;
    }
  }

  return rows
    .map((row) =>
      `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!}`.trimEnd(),
    )
    .join('\n');
}

export default tool({
  name: 'writ-link-meanings',
  description: 'List registered link meanings',
  instructions:
    'Returns the kit-contributed link meaning registry. Each meaning has a ' +
    'fully-qualified id (prefixed with the contributing plugin id), an owner ' +
    'plugin, and a human-readable description. By default the output is a ' +
    'human-readable table; pass --json for the raw array.',
  params: {
    json: z
      .boolean()
      .default(false)
      .describe('Emit the raw array as JSON instead of a formatted table'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const meanings = await clerk.listMeanings();
    if (params.json) return meanings;
    return formatTable(meanings);
  },
});
