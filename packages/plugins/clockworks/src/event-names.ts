/**
 * Single source of truth for the Clockworks-intrinsic event-name literals.
 *
 * The dispatcher's loop-guard probe and the apparatus's emit lambdas must
 * read the same literal — two inlined copies of the same string across
 * call sites is exactly the cross-site drift to harden against (commission
 * decision D20). Every reader (apparatus emit lambdas, dispatcher
 * loop-guard probe, scheduler timer write, tests) imports from this
 * module.
 */

/**
 * Standing-order failure event. Emitted by the apparatus when the
 * dispatcher reports a thrown relay handler or an unresolved relay; also
 * the literal the dispatcher's loop-guard probe matches against to
 * suppress cascading SOF emissions.
 */
export const STANDING_ORDER_FAILED_EVENT = 'clockworks.standing-order.failed';

/**
 * Timer-tick event. The scheduler writes this event row directly into the
 * events book with `processed: true` per fire — preserving the
 * scheduler-direct-write semantic that keeps the dispatcher's event-sweep
 * from picking the row up.
 */
export const CLOCKWORKS_TIMER_EVENT = 'clockworks.timer';
