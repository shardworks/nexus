/**
 * Mainspring built-in tools — framework commands that ship with mainspring itself.
 *
 * These are modeled as regular ToolDefinitions so they appear alongside
 * rig-contributed tools in mainspring.listTools(). The CLI doesn't distinguish
 * between mainspring built-ins and rig tools.
 */

import init from './init.ts';
import version from './version.ts';
import status from './status.ts';
import upgrade from './upgrade.ts';
import { rigList, rigInstall, rigRemove, rigUpgrade } from './rig.ts';

/** All mainspring built-in tools. */
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
