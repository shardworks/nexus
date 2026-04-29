/**
 * Barrel re-exporting cartograph's 16 patron-facing CLI tools.
 *
 * The cartograph apparatus pulls these in via `supportKit.tools` so the
 * framework auto-builder (in `@shardworks/nsg`) discovers them at startup
 * and groups them by hyphen prefix automatically — three groups
 * (`vision-`, `charge-`, `piece-`) become
 * `nsg {vision,charge,piece} {create,show,list,patch,transition}` with
 * `nsg vision apply` joining the vision group as the on-disk authoring
 * surface.
 */

export { default as visionCreate } from './vision-create.ts';
export { default as visionShow } from './vision-show.ts';
export { default as visionList } from './vision-list.ts';
export { default as visionPatch } from './vision-patch.ts';
export { default as visionTransition } from './vision-transition.ts';
export { default as visionApply } from './vision-apply.ts';

export { default as chargeCreate } from './charge-create.ts';
export { default as chargeShow } from './charge-show.ts';
export { default as chargeList } from './charge-list.ts';
export { default as chargePatch } from './charge-patch.ts';
export { default as chargeTransition } from './charge-transition.ts';

export { default as pieceCreate } from './piece-create.ts';
export { default as pieceShow } from './piece-show.ts';
export { default as pieceList } from './piece-list.ts';
export { default as piecePatch } from './piece-patch.ts';
export { default as pieceTransition } from './piece-transition.ts';
