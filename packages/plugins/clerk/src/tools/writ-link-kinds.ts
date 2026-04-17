import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, LinkKindDoc } from '../types.ts';

/**
 * Format a list of LinkKindDocs as a three-column text table with headers
 * `ID`, `OWNER`, `DESCRIPTION`. Columns are space-padded to the widest row
 * (including the header) and separated by two spaces.
 */
function formatTable(kinds: LinkKindDoc[]): string {
  if (kinds.length === 0) {
    return 'No link kinds registered.';
  }

  const rows: Array<[string, string, string]> = [
    ['ID', 'OWNER', 'DESCRIPTION'],
    ...kinds.map((k) => [k.id, k.ownerPlugin, k.description] as [string, string, string]),
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
  name: 'writ-link-kinds',
  description: 'List registered link kinds',
  instructions:
    'Returns the kit-contributed link kind registry. Each kind has a ' +
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
    const kinds = await clerk.listKinds();
    if (params.json) return kinds;
    return formatTable(kinds);
  },
});
