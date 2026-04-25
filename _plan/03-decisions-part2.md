# Decisions (part 2)

## D18
**Question:** What happens if the scheduler-pass relay handler emits a new event during its execution?
**Scope refs:** S3
**Selected:** no-special-handling
**Patron override:** (none)
**Rationale:** Brief prescribes this exact behavior, and the implementation falls out of the architecture naturally: `await relay.handler(event, context)` synchronously persists any emitted events via `api.emit`, then `processEvents()` is called next. No new buffering layer needed. Disallowing emits from scheduled handlers would break expected uses (e.g. a scheduled health probe that emits an alert event on degradation).
**Options:**
- no-special-handling: The scheduler awaits each relay handler. Any `api.emit()` calls inside the handler land in the events book. The subsequent event-sweep call processes them. No code path required.
- explicit-buffer-and-flush: Scheduler buffers emit calls during a fire and flushes them after all due fires complete. Tighter control over ordering.
- block-emits-during-schedule: Disallow `emit()` from inside scheduled-fire handlers. Forces relays to schedule fire-and-forget work elsewhere.

## D19
**Question:** Should this commission update `docs/reference/event-catalog.md` and `docs/reference/core-api.md`, or defer those edits to the sibling architecture-doc-refresh commission?
**Scope refs:** S7
**Selected:** include-in-this-commission
**Patron override:** (none)
**Rationale:** The reference docs are operator-facing — operators reading event-catalog.md will not see `schedule.fired` and may infer it's invalid. Deferring leaves a documentation gap with no clear owner. Both updates are small and mechanical (one row, two list additions); the cost of including them is low and the cost of deferring (operator confusion, drift accumulating) is real.
**Options:**
- include-in-this-commission: This commission updates the Clockworks Events table in `event-catalog.md` (add `schedule.fired`), the reserved-namespace listing there, and the `isFrameworkEvent` description in `core-api.md`.
- create-followup-observation: Defer the doc updates to a follow-up. Generates an observation that becomes a draft mandate.
- split-by-touch-cost: Update the reserved-namespaces list in both docs (small, mechanical) but defer the new event-row addition to a follow-up commission.

## D20
**Question:** What is the minimum daemon poll interval relative to the smallest `@every` duration the system should support?
**Scope refs:** S3
**Selected:** no-explicit-floor
**Patron override:** (none)
**Rationale:** Coupling the validator to runtime daemon configuration is a layering violation — `guild.json` validation runs in many contexts (init, lint, every dispatcher sweep) where the daemon's tick is unknown. The pragmatic answer is documentation: state in the new Scheduled Standing Orders section of the architecture doc that `@every` durations less than the daemon's `--interval` are not reliably honored. This matches how cron systems generally treat sub-tick scheduling — the operator is expected to align tick to schedule.
**Options:**
- no-explicit-floor: Accept any positive `@every Ns` value. Operators using `@every 1s` with a 2s tick will see undefined behavior; document the implication in the architecture doc.
- reject-below-tick: Validator inspects daemon's intervalMs (somehow) and rejects schedules whose duration < intervalMs. Coupling the validator to runtime config is awkward.
- warn-but-accept: Accept `@every` < default tick but emit a warning in the load-time validation message recommending the operator increase tick frequency.

