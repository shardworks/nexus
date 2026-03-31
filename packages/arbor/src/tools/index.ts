/**
 * Arbor built-in tools — framework commands that ship with the arbor itself.
 *
 * These are modeled as regular ToolDefinitions so they appear alongside
 * rig-contributed tools in arbor.listTools(). The CLI doesn't distinguish
 * between arbor built-ins and rig tools.
 */

import init from './init.ts';
import version from './version.ts';
import status from './status.ts';
import upgrade from './upgrade.ts';
import { rigList, rigInstall, rigRemove, rigUpgrade } from './rig.ts';

/** All arbor built-in tools. */
export const builtinTools = [
  init,
  version,
  status,
  upgrade,
  rigList,
  rigInstall,
  rigRemove,
  rigUpgrade,
];
