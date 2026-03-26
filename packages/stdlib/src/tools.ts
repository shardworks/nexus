/**
 * Backward-compatible barrel export for tools.
 *
 * The canonical tool exports are in index.ts. This file re-exports the
 * legacy subset for any code that imports from './tools.ts' directly.
 * Prefer importing from the package root (@shardworks/nexus-stdlib).
 */
export { default as commissionCreate } from './tools/commission.ts';
export { default as signal } from './tools/signal.ts';
export { default as toolInstall } from './tools/install.ts';
export { default as toolRemove } from './tools/remove.ts';
export { default as animaCreate } from './tools/instantiate.ts';
export { default as nexusVersion } from './tools/nexus-version.ts';

import commissionCreate from './tools/commission.ts';
import signal from './tools/signal.ts';
import toolInstall from './tools/install.ts';
import toolRemove from './tools/remove.ts';
import animaCreate from './tools/instantiate.ts';
import nexusVersion from './tools/nexus-version.ts';

export default [commissionCreate, signal, toolInstall, toolRemove, animaCreate, nexusVersion];
