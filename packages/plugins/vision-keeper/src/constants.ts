/**
 * Vision-keeper public constants.
 *
 * Cross-component contract anchors. Held in a leaf module so neither
 * the apparatus implementation nor the decline-relay handler need to
 * import them through the package's `index.ts` (which would create a
 * circular reference: `index.ts` re-exports the apparatus from
 * `vision-keeper.ts`, which would in turn import these constants
 * back through `index.ts`).
 *
 * Each constant's value comes verbatim from the petitioner-
 * registration contract document and the commission brief — see the
 * decision references on each declaration.
 */

/**
 * The petitioner source id stamped on `writ.ext.reckoner.source` for
 * every vision-keeper petition. Cross-component contract anchor —
 * downstream consumers (the Reckoner CDC handler, the keeper's own
 * decline-feedback relay) key on this string.
 */
export const VISION_KEEPER_SOURCE = 'vision-keeper.snapshot';

/**
 * The label key the keeper stamps onto every petition's
 * `ext.reckoner.labels` map to discriminate which vision the snapshot
 * pertains to. Multi-instance discrimination surface for downstream
 * consumers that observe more than one vision in flight.
 */
export const VISION_ID_LABEL_KEY = 'vision-keeper.io/vision-id';

/**
 * The registered name of the decline-feedback relay contributed via
 * the apparatus's `supportKit.relays`. Operators reference this name
 * in the `run:` field of the standing order they wire under
 * `clockworks.standingOrders` in `guild.json` (see the README).
 */
export const DECLINE_RELAY_NAME = 'vision-keeper-on-decline';
