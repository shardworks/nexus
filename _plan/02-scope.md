# Scope

## S1 (included: true)
**Description:** Extend the standing-order shape with a `schedule:` top-level metadata key as an alternative trigger to `on:`. Update the shared standing-order validator to accept `schedule:`, enforce mutual exclusion with `on:`, and validate the schedule expression at guild.json load time.
**Rationale:** Brief Non-negotiable decision #1: the canonical `{ on, run, with? }` form grows a `schedule:` key. The validator is the load-time gate where invalid expressions (and on+schedule collisions) must be rejected.

## S2 (included: true)
**Description:** Parse and evaluate cron expressions and `@every <duration>` forms — compute next-fire times for both syntaxes. Standard 5-field unix cron (minute/hour/dom/month/dow) and `@every Ns|Nm|Nh` interval form.
**Rationale:** Brief specifies both syntaxes explicitly. This is the engine that powers the scheduler — independent from the validator (validator can call it for parse-check) and from the daemon loop (daemon calls it to compute nextFireTime).

## S3 (included: true)
**Description:** Scheduler pass inside the daemon — build the in-memory schedule table on startup, evaluate due fires on each tick, invoke the matching relay through the existing dispatcher contract, advance nextFireTime, and write event/dispatch rows for the synthesized `schedule.fired` event.
**Rationale:** Brief Non-negotiable decision #2: the daemon gains a parallel scheduler pass that runs before the event-processing pass each tick. This is the load-bearing runtime piece.

## S4 (included: true)
**Description:** Synthesize a `schedule.fired` framework event for each scheduled fire — payload identifies the standing order and fire time; relays receive the event via the standard `RelayHandler` contract.
**Rationale:** Brief Non-negotiable decision #3: scheduled fires deliver a synthetic event to relays so authoring stays uniform with event-triggered dispatch.

## S5 (included: true)
**Description:** Reserve `schedule.` (or specifically `schedule.fired`) as a framework namespace — anima `signal` tool and `nsg signal` CLI reject attempts to emit it.
**Rationale:** Brief Non-negotiable decision #3: `schedule.fired` is reserved in the framework namespace. Implementation is a one-line addition to `RESERVED_EVENT_NAMESPACES` plus tests.

## S6 (included: true)
**Description:** Missed-fire policy on daemon restart — fire once if nextFireTime is in the past, advance from current time forward, do not backfill missed cycles.
**Rationale:** Brief Non-negotiable decision #4: explicit fire-once-no-backfill semantics. Affects scheduler initialization logic and observability (log line should reflect the catch-up fire).

## S7 (included: true)
**Description:** Documentation cross-updates outside `docs/architecture/clockworks.md` — specifically the `schedule.fired` event row in `docs/reference/event-catalog.md`, the reserved-namespace list there and in `docs/reference/core-api.md`.
**Rationale:** Architecture doc refresh is owned by sibling commission `w-modf69vg`, but the event catalog and core-api reference are not in that commission's scope. Without these touches, the event/namespace docs lag the code.
