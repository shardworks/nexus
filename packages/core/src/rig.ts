/**
 * Superseded by the Kit/Apparatus/Plugin model in plugin.ts.
 * Re-exported here for import-path continuity during transition.
 *
 * See: docs/architecture/plugins.md
 */
export type { Kit as Rig } from './plugin.ts';
export { isKit as isRig } from './plugin.ts';
export type { BookOptions } from './books.ts';
