# Decisions (part 1)

## D1
**Question:** How is the StandingOrder TypeScript type extended to model the `on` XOR `schedule` rule?
**Scope refs:** S1
**Selected:** loose-optional
**Patron override:** (none)
**Rationale:** Matches the existing precedent set when `summon:`/`brief:` were dropped (validator owns canonical-shape rules, type stays loose). Discriminated union creates ergonomic friction at every standing-order literal in tests and documentation; the brief shows literals like `{ schedule: '*/5 * * * *', run: '...' }` that are most readable when both fields are TS-optional.
**Options:**
- loose-optional: Make `on?: string` and `schedule?: string` both optional in the TS type; encode the XOR rule purely in the validator. Mirrors how dropped sugar (`summon`/`brief`) was handled.
- discriminated-union: Define `StandingOrder = EventTriggered | ScheduleTriggered` with each variant requiring one and only one of the two trigger fields. Stronger type checks at construction sites.
- mandatory-validator-only-with-comment: Same as loose-optional but add an explicit JSDoc warning naming the runtime invariant.

## D2
**Question:** What payload shape carries on the synthesized `schedule.fired` event?
**Scope refs:** S4
**Selected:** full-order-and-index
**Patron override:** (none)
**Rationale:** Mirrors the `standing-order.failed` payload precedent, which also embeds the full verbatim order plus a triggering descriptor. Relays that want to inspect the order's `with:` block (e.g. for debugging or correlation) get it without re-reading config. `orderIndex` makes log lines and SOF correlation easy.
**Options:**
- full-order-and-index: `{ standingOrder: <verbatim from guild.json>, orderIndex: number, fireTime: ISO string }`. Mirrors SOF payload precedent.
- index-only: `{ orderIndex: number, fireTime: ISO string }`. Caller can re-look up the order from guild config.
- schedule-expression-only: `{ schedule: string, fireTime: ISO string }`. Minimal — order identity is implicit in schedule expression.

## D3
**Question:** Does the scheduler pass live as a separate `processSchedules()` API method, or as a pre-pass inside `processEvents()`?
**Scope refs:** S3
**Selected:** separate-api-method
**Patron override:** (none)
**Rationale:** Keeps the contract for `processEvents()` unchanged — every existing caller (CLI `tick`, CLI `run`, daemon, tests) keeps its single-purpose semantics. A separate `processSchedules()` is independently testable, has its own observer plumbing, and matches the apparatus's existing pattern of one-purpose methods. The brief's 'scheduler pass before event-processing pass' language naturally maps to two daemon calls per tick.
**Options:**
- separate-api-method: Add `processSchedules()` to ClockworksApi as a sibling of `processEvents()`. Daemon calls schedule-then-events each tick.
- embedded-pre-pass: Extend `processEvents()` so each call fires due schedules first, then processes the events queue. No new public method.
- scheduler-only-in-daemon: Skip the public API. Build a private scheduler primitive only the daemon invokes; no programmatic surface for `nsg clock tick` or tests.

## D4
**Question:** Where does the in-memory schedule table live and who owns its lifecycle?
**Scope refs:** S3
**Selected:** apparatus-closure
**Patron override:** (none)
**Rationale:** Matches the existing `relays` Map idiom — built fresh in `start()`, lives in the factory closure, accessible from the api methods. This makes `processSchedules()` testable without a daemon, and lets future surfaces (e.g. an inspector tool) read the table. The brief explicitly excludes persistent schedule state ('runtime state ... is in-memory only'), so the Stacks-book option is out of scope.
**Options:**
- apparatus-closure: Apparatus factory keeps a closure-scoped `Map<orderIndex, ScheduleEntry>` rebuilt in `start()` — same idiom as the relays Map.
- daemon-local: The schedule table is built inside `runForegroundDaemon` and lives only for that daemon's lifetime. Not exposed via the API surface.
- stacks-book: Persist schedule state (nextFireTime) into a new Stacks book so it survives restart.

## D5
**Question:** Is the synthesized `schedule.fired` event written to the `clockworks/events` book before dispatch, or only the `event_dispatches` row?
**Scope refs:** S3, S4
**Selected:** persist-event-with-processed-true
**Patron override:** (none)
**Rationale:** Operator visibility is non-trivial: `nsg clock list --include-processed` is the single observability surface for what fired and why. Persisting the event with `processed: true` (set immediately, since the scheduler is doing the dispatching itself, not the event sweep) gives operators full history while preventing double-dispatch. The dispatch row's `eventId` references a real row, matching the schema's FK semantics. Stacks' CDC auto-wiring on the events book carves out `clockworks/events` (clockworks.ts line 338) so this does not infinite-loop.
**Options:**
- persist-event: Scheduler calls `api.emit('schedule.fired', payload, 'framework')` first, then synthesizes the GuildEvent (with the persisted id), invokes the relay, and writes the dispatch row. Events show up in `nsg clock list --include-processed`.
- skip-event-persist: Scheduler generates an event id but never writes an events row; only the dispatch row is persisted. Lighter on book writes; events list does not show scheduled fires.
- persist-event-with-processed-true: Scheduler writes the events row with `processed: true` immediately so the regular dispatcher does NOT pick it up (no double-fire), but operators can still see the row.

## D6
**Question:** How is cron expression parsing implemented?
**Scope refs:** S2
**Selected:** cron-parser
**Patron override:** (none)
**Rationale:** Cron parsing is well-trodden territory; reinventing it for an MVP is mostly a way to ship subtle bugs. `cron-parser` is the de-facto standard (used by Vercel, BullMQ, and many others), MIT-licensed, mature, has zero runtime deps. The brief says 'standard 5-field unix cron' which matches `cron-parser`'s default mode exactly. The Three Defaults call for extending the API at the right layer — adding a vetted dependency is the right layer here, not 'route around it' by hand-rolling.
**Options:**
- cron-parser: Add `cron-parser` as a dependency of `@shardworks/clockworks-apparatus`. Use its `CronExpression.next()` to compute nextFireTime.
- croner: Add `croner`. Smaller and also popular; similar API.
- hand-rolled: Implement a 5-field parser inside the package. Roughly ~200 LOC of careful code; full test coverage required.
- subset-only: Hand-roll a strict subset (only `* / N / a-b / a,b` per field; reject names like 'mon', 'jan'). Minimal scope; document the subset in the validator's error message.

## D7
**Question:** How is the `@every <duration>` form parsed?
**Scope refs:** S2
**Selected:** regex-and-units-table
**Patron override:** (none)
**Rationale:** Brief is explicit about the supported syntax: `@every Ns | @every Nm | @every Nh` only. Wider tolerance breeds inconsistency between operators and undermines the validator's load-time clarity. The Three Defaults call for fail-loud — strict regex rejection with a clear error message naming the supported forms is exactly that. ~10 LOC for the parser.
**Options:**
- regex-and-units-table: Match `^@every (\d+)([smh])$` and look up the unit in `{s: 1000, m: 60000, h: 3600000}`. Reject anything else.
- ms-or-similar-library: Pull in a duration-parsing library like `ms`. More flexibility (accepts '1.5h', '90s') at the cost of tolerating shapes not in the brief.
- permissive-positive-integer-units: Accept fractional values, plural units (`@every 30sec`, `@every 1.5h`), case-insensitive. Friendlier for operators.

## D8
**Question:** On daemon restart, how is the initial `nextFireTime` computed for an `@every <duration>` order?
**Scope refs:** S6
**Selected:** from-now
**Patron override:** (none)
**Rationale:** Brief explicitly says 'fires every 30 seconds from the daemon's start' — this is option `from-now`. Immediate first fire is unintuitive (operators don't expect a fresh daemon to immediately invoke every scheduled relay). Wall-clock alignment is closer to cron's semantics but the brief's example phrasing ('from the daemon's start') rules it out for `@every`.
**Options:**
- from-now: On startup, set initial `nextFireTime = now + duration`. First fire happens one full duration after daemon start.
- fire-immediately: On startup, set `nextFireTime = now` so the relay fires on the first tick. Subsequent fires are `+ duration`.
- wall-clock-aligned: Round `nextFireTime` to the next wall-clock boundary divisible by the duration. `@every 5m` fires at :00/:05/:10.

## D9
**Question:** On daemon restart, how is the initial `nextFireTime` computed for a cron expression?
**Scope refs:** S6
**Selected:** next-cron-after-now
**Patron override:** (none)
**Rationale:** Matches cron's universal wall-clock semantics — every other cron implementation in production behaves this way. Brief's behavioral case 'fires every 5 minutes on the 5-minute marks' implies natural-boundary alignment, which option `next-cron-after-now` delivers. Combined with D8 (`@every` is from-now), this gives operators predictable behavior: cron means clock marks, `@every` means relative cadence.
**Options:**
- next-cron-after-now: Initial nextFireTime = `cronExpression.next(now)`. First fire happens at the next natural cron boundary; on a fresh daemon at 12:03:42 with `*/5 * * * *`, first fire is 12:05:00.
- fire-immediately-then-next: Initial nextFireTime = `now`, fire on first tick, then advance to next cron boundary. Wastes a fire cycle on startup but ensures every relay runs at least once at boot.
- next-after-startup-or-from-last-fire: Same as next-cron-after-now for fresh daemons; for daemons restarting with a stored last-fire time (out of scope per brief), use that anchor.

## D10
**Question:** On daemon restart, what does 'fire once if nextFireTime is in the past' mean for `@every` orders specifically?
**Scope refs:** S3, S6
**Selected:** treat-restart-as-cold-start
**Patron override:** (none)
**Rationale:** Without persistent state, there's no 'last fire' anchor against which to compute 'missed' fires. The brief says 'runtime state (next fire time, last fire time) is in-memory only' — this is the load-bearing constraint. The 'fire once on restart' clause in the brief is best read as 'if nextFireTime is in the past at the moment we evaluate' — which can only happen during a single daemon's lifetime if the daemon's tick stalls for longer than an interval. Documenting this in the spec keeps operator expectations aligned with the implementation.
**Options:**
- no-special-restart-logic: Since runtime state is in-memory only, every daemon restart is a fresh start. nextFireTime is always set per D8/D9 from the new start time. No 'catch-up' logic exists because there's nothing to catch up from.
- treat-restart-as-cold-start: Same as above but document the implication: an `@every 5m` order that was down for 20 minutes simply has its first post-restart fire 5 minutes after restart. No 'fire once on restart' because we have no record of when the last fire was.
- wall-clock-anchored-attempt: For cron (which has wall-clock semantics), check if any cron boundary was missed during downtime; fire once if so. This requires the daemon to know its own startup time vs. the last expected boundary. For `@every`, the brief's no-state-persisted constraint makes this moot.

## D11
**Question:** Is the schedule table reconciled on hot-edits to guild.json (existing event-trigger pattern), or built once on daemon startup (brief language)?
**Scope refs:** S3
**Selected:** build-once-no-reconcile
**Patron override:** (none)
**Rationale:** Brief is explicit: 'On daemon startup ... build an in-memory schedule table.' Per the brief-overrides-precedent rule, the existing event-trigger hot-edit pattern is precedent that does not silently override the brief's prescription. The simplification keeps MVP-1 small; hot-edit support for schedules can ship later if operator pain is real. The divergence from event-trigger behavior should be documented in the new architecture-doc Scheduled Standing Orders section.
**Options:**
- build-once-no-reconcile: Schedule table is built only in apparatus `start()`. Hot-edits to scheduled orders require daemon restart. Matches brief's literal language.
- reconcile-per-tick: Each tick, the scheduler re-reads `standingOrders`, identifies adds/removes/changes by orderIndex+expression, and reconciles the table. Preserves nextFireTime for unchanged entries.
- reconcile-on-explicit-signal: Provide a `reloadSchedules()` API method or framework event (`guild.config-changed`) that triggers reconciliation. Avoids per-tick overhead while supporting hot-edit.

## D12
**Question:** Should `schedule.` be added as a new reserved namespace prefix, or only `schedule.fired` as a specific name?
**Scope refs:** S5
**Selected:** namespace-prefix
**Patron override:** (none)
**Rationale:** Every existing reserved namespace is a prefix; adding `schedule.` as a single-element addition matches that precedent exactly (one-line change). Reserving the full namespace gives the framework headroom for future variants like `schedule.skipped` or `schedule.error` without re-litigating reservation rules. Single-name rejection introduces a new code path and a new mental model for operators; the consistency cost is real.
**Options:**
- namespace-prefix: Add `'schedule.'` to `RESERVED_EVENT_NAMESPACES`. Reserves the entire `schedule.*` family for framework use.
- single-name-rejection: Add a `RESERVED_EVENT_NAMES` (singular) list and put `schedule.fired` in it. Allows operators to use `schedule.something-else` if they want.
- tagged-as-writ-pattern: Reuse the existing writ-lifecycle-suffix mechanism — add a third validator layer for explicit framework-only event names.

## D13
**Question:** When multiple scheduled orders are due at the same wall-clock moment, in what order do they fire, and how does the scheduler interact with the dispatcher's loop guard?
**Scope refs:** S3
**Selected:** array-order-sequential
**Patron override:** (none)
**Rationale:** Brief explicitly prescribes 'guild.json array order, sequentially' — this is option `array-order-sequential`. Concurrent firing breaks that ordering guarantee. Sequential firing also matches the existing event-trigger dispatcher's per-handler-isolation pattern (one throw never blocks siblings).
**Options:**
- array-order-sequential: Iterate the schedule table in `orderIndex` ascending order. For each due entry, await the relay handler, advance nextFireTime, then move to the next.
- concurrent-with-promise-all: Fire all due orders in parallel via `Promise.all`. Faster when many are due simultaneously.
- by-nextfiretime: Sort due entries by nextFireTime ascending (oldest-due first). Acts more like a priority queue.

## D14
**Question:** How is the time source injected for testability?
**Scope refs:** S2, S3
**Selected:** single-date-source
**Patron override:** (none)
**Rationale:** A single Date factory captures both shapes without coordinating two injected functions to return consistent values (an easy bug source). The allocation overhead is negligible. The dispatcher's existing `now: () => string` was a narrower shape because the dispatcher only needs ISO; the scheduler's needs are broader so the slightly different injection shape is justified. Internally derive both `dt.getTime()` and `dt.toISOString()` as needed.
**Options:**
- two-injected-functions: Accept both `now: () => string` (ISO) and `nowMs: () => number` (millis) as separate injected dependencies.
- single-date-source: Accept `now: () => Date` and derive both shapes from it. Slightly more allocation per call but simpler.
- single-ms-source-and-derive-iso: Accept `nowMs: () => number` only; derive ISO via `new Date(nowMs()).toISOString()`.

## D15
**Question:** How is per-fire failure surfaced — does the scheduler emit `standing-order.failed` events the same way the dispatcher does?
**Scope refs:** S3
**Selected:** reuse-sof-callback
**Patron override:** (none)
**Rationale:** Standing orders are a uniform abstraction; failures should be uniform too. An operator writing `{ on: 'standing-order.failed', run: 'notify-patron' }` expects to be notified when ANY standing order fails, not just event-triggered ones. This is the simplest design (zero new code in the SOF path; just wire the callback) and it preserves the architecture's principle that the trigger source is incidental once dispatch starts.
**Options:**
- reuse-sof-callback: Scheduler accepts the same `signalStandingOrderFailed` callback as the dispatcher; emits SOF on relay throw / unresolved relay. Operators can wire `{ on: 'standing-order.failed', run: ... }` to react to scheduled-fire failures.
- no-sof-for-schedules: Scheduler logs the failure (and writes the error dispatch row) but does NOT emit SOF. Operators must read the dispatches book to detect failures.
- new-event-type: Scheduler emits a separate `schedule.failed` event for scheduled failures only. Distinguishes from event-trigger failures.

## D16
**Question:** Where do per-fire log lines emit, and does `formatDispatchLogLine` need extension?
**Scope refs:** S3
**Selected:** reuse-existing-formatter
**Patron override:** (none)
**Rationale:** Brief explicitly rejects 'a dedicated scheduled-fire log' and says 'each fire writes an event_dispatches row through the normal dispatcher path — that is the history.' One uniform log shape across all dispatches keeps the operator's grep/parse story simple. The orderIndex is in the synthesized event payload and the dispatch row's eventId already correlates to it for anyone who needs to drill in.
**Options:**
- reuse-existing-formatter: Use `formatDispatchLogLine` unchanged. The line will include `schedule.fired` as the event name and the relay's name as the handler.
- add-orderindex-to-formatter: Extend the formatter to optionally include `[order #N]` for scheduled fires. Helpful when many scheduled orders share the same relay.
- separate-scheduler-log-line: Emit a distinct log shape for scheduled fires: `<ISO> [schedule] order#<N> [<handlerName>] <status> ...`.

## D17
**Question:** Does the validator perform a parse-check of `schedule:` values, or only a structural string-shape check?
**Scope refs:** S2
**Selected:** full-parse-check
**Patron override:** (none)
**Rationale:** Brief is explicit: 'every schedule: value is parsed and validated' at guild.json load time. The Three Defaults call for fail-loud — invalid cron at load time gives operators the index and the message immediately, instead of crashing the daemon at first tick. Coupling the validator to the cron-parser is acceptable because both are in the same package.
**Options:**
- full-parse-check: Validator imports the cron parser and the @every parser; runs each schedule: value through them; aggregates parse errors with index info. Single source of truth.
- regex-prevalidation-only: Validator does only a regex-shape check (5 fields separated by spaces, OR `@every Nu`); the runtime catches deeper invalid forms at scheduler-build time.
- delegate-to-runtime: Validator accepts any non-empty string; the scheduler at startup throws on invalid expressions. Simpler validator, later failure.

