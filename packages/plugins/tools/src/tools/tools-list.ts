/**
 * tools-list — administrative view of all tools installed in the guild.
 *
 * Lists the full registry with optional filters for caller type, permission
 * level, and contributing plugin. This is an inventory tool, not a
 * permission-resolved view — use MCP native tool listing for that.
 *
 * Requires `tools:read` permission.
 */

import { z } from 'zod';

import { tool } from '../tool.ts';
import type { InstrumentariumApi } from '../instrumentarium.ts';

/** Summary returned for each tool in the list. */
interface ToolSummary {
  name: string;
  description: string;
  pluginId: string;
  permission: string | null;
  callableBy: string[] | null;
}

export function createToolsList(getApi: () => InstrumentariumApi) {
  return tool({
    name: 'tools-list',
    description:
      'List all tools installed in the guild. Administrative view — shows the full registry, not a permission-resolved set.',
    permission: 'read',
    params: {
      caller: z
        .enum(['patron', 'anima', 'library'])
        .optional()
        .describe('Filter to tools callable by this caller type.'),
      permission: z
        .string()
        .optional()
        .describe(
          'Filter to tools requiring this permission level (e.g. "read", "write").',
        ),
      plugin: z
        .string()
        .optional()
        .describe('Filter to tools contributed by this plugin id.'),
    },
    handler: async ({ caller, permission, plugin }) => {
      const api = getApi();
      let tools = api.list();

      // Filter by contributing plugin
      if (plugin) {
        tools = tools.filter((t) => t.pluginId === plugin);
      }

      // Filter by permission level
      if (permission) {
        tools = tools.filter(
          (t) => t.definition.permission === permission,
        );
      }

      // Filter by caller type (callableBy gate)
      if (caller) {
        tools = tools.filter(
          (t) =>
            !t.definition.callableBy ||
            t.definition.callableBy.includes(caller),
        );
      }

      return tools.map(
        (t): ToolSummary => ({
          name: t.definition.name,
          description: t.definition.description,
          pluginId: t.pluginId,
          permission: t.definition.permission ?? null,
          callableBy: t.definition.callableBy ?? null,
        }),
      );
    },
  });
}
