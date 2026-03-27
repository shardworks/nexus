/**
 * Rig built-in tools — framework commands that ship with rig itself.
 *
 * These are modeled as regular ToolDefinitions so they appear alongside
 * plugin-contributed tools in rig.listTools(). The CLI doesn't distinguish
 * between rig built-ins and plugin tools.
 */

import version from './version.ts';
import status from './status.ts';
import upgrade from './upgrade.ts';
import { pluginList, pluginInstall, pluginRemove, pluginUpgrade } from './plugin.ts';

/** All rig built-in tools. */
export const builtinTools = [
  version,
  status,
  upgrade,
  pluginList,
  pluginInstall,
  pluginRemove,
  pluginUpgrade,
];
