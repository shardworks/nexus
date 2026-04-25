# Animator complexity audit

A diagnosis of why animator-touching sessions cost roughly 1.8× the per-LOC
spend of the next-most-expensive package cohort (spider/clerk/astrolabe at
~$0.010/LOC) and roughly 3× the cheap cohort (ratchet/clockworks/lattice at
~$0.005–0.006/LOC). Three animator-focused sessions averaged $28.43 each —
the most expensive package-focused work measured. This audit identifies the
structural sources of that cost density and proposes three ranked refactor
candidates a future planner can lift into a single-commission seed.

The artifact is decision-supporting prose grounded in current source — every
file:line anchor below was verified against the working tree. No animator
code is changed; this audit is one new markdown file. A future planner
should be able to read it cold and write a refactor brief targeting one of
the three candidates without re-opening animator source.

The animator package today: 3,719 source LOC across 17 files (excluding
tests and `src/static/`), 5,941 test LOC across 8 test files, and a public
type surface of 724 LOC in `types.ts`.

## Structural inventory

Eight major behavioral concerns coexist inside `packages/plugins/animator/`.
For each, the file(s) it lives in, a paragraph on what the concern does, and
a calibration tag (legitimate / partly-accidental / accidental).

### 1. Lifecycle state machine — *legitimate, but the encoding is partly accidental*

The session document moves through the states declared on
`SessionDoc['status']` (`packages/plugins/animator/src/types.ts:518`):
`'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' |
'rate-limited'`. The state set itself is load-bearing — sessions really do
have those phases, the `'rate-limited'` discriminator drives the back-off
machine, and the terminal-state immutability rule is invariant across the
package. What is partly accidental is *where* the state set is encoded:
`SessionDoc['status']` is the type, but the runtime sets that classify
"terminal" are duplicated locally inside four different files (see hotspot
§1) instead of being exported once from `types.ts`.

### 2. Multi-writer SessionDoc — *partly accidental*

The same `animator/sessions` row is written from at least nine call sites
across six files: `animator.ts` (recordRunning at :388, recordSession
terminal at :318, cancel at :514), `session-record-handler.ts:192`,
`startup.ts` (orphan-recovery terminal at :245, lastActivityAt backfill
patch at :214), `tools/session-running.ts` (already-running refresh at :77,
pending → running normal path at :98), and `tools/session-heartbeat.ts:52`.
A tenth writer lives outside the package at
`packages/plugins/claude-code/src/detached.ts:374` (the `pending`
pre-write). Every writer reimplements its own merge logic — read-existing,
spread, conditionally preserve `metadata` / `cancelHandle` / `startedAt` /
`provider`, conditionally write `lastActivityAt`, branch on the existing
status. The number of writers is not accidental (the lifecycle has many
real entry points: in-process, detached pre-write, detached ready,
detached terminal, heartbeat, cancel, orphan reconciler), but the
*per-writer bespoke merge code* is.

### 3. Dual attached/detached paths — *partly accidental, with one
production-load-bearing piece*

Two distinct dispatch shapes live side-by-side. The in-process attached
path (`animator.ts:673` `dispatchAnimate`) consumes provider chunks
through an in-memory broadcaster and writes the SessionDoc inline. The
detached path (claude-code's `launchDetached` plus the
`session-running` / `session-heartbeat` / `session-record` tools)
pre-writes a `pending` row, spawns a babysitter, and reports lifecycle
back through tool calls. The detached path is the one production runs:
spider's review/step engines all dispatch detached. The attached path
exists primarily to back the in-process test harness (every
`animator.test.ts` happy-path uses it) and to back the SSE running-stream
broadcaster (`oculus-routes.ts:200`). The duplication of code paths is
accidental; whatever real consumer the broadcaster serves is legitimate
and must be preserved by any refactor that retires the path.

### 4. Rate-limit back-off state machine — *legitimate*

`rate-limit-backoff.ts` (452 LOC) owns the `'dispatch-status'` doc in the
shared `animator/state` book and translates terminal session outcomes
into pause / resume transitions. The machine encodes a real set of
invariants: the coalesce-vs-increment rule (a rate-limit hit during an
already-paused window must not bump the back-off level unless a resume
attempt has dispatched), the in-flight-straggler rule (a non-rate-limit
terminal from a session that started before the pause must not reset the
level), the cap-at-maxMs rule, the boot-time reconciliation rule (a
persisted paused doc whose window has elapsed must flip to running
*before* the first post-start `animate()` peeks the cache), and the
fail-loud config validation. The machine is small (452 LOC including
extensive comments and the dispatchability predicate) and well-isolated —
this is one of the cleanest concerns in the package. *Why it shows up in
the audit:* the per-rule comments are dense with `Dn` references that
require either inlining the rule or cross-referencing planning docs (see
hotspot §4).

### 5. Lifecycle event emission — *legitimate, with accidental fanout*

`session-emission.ts` emits six events to clockworks: `session.started`,
`session.ended`, `session.record-failed` (with three phase
discriminators), `commission.session.ended` (when the writ chain
resolves), `anima.manifested`, and `anima.session.ended` (gated on
`metadata.role`). The events are real — every consumer downstream of
animator branches on at least one of them. The accidental piece is the
*fanout pattern*: every terminal-write site (animator.ts, the cancel
path, session-record-handler.ts, startup.ts orphan recovery,
session-running.ts) calls the helpers at the call site, after the write
succeeds, with bespoke skip-on-write-failed guards. There are 13
emission call sites across 4 production files (see hotspot §5). A CDC
observer keyed on status transitions could centralize this.

### 6. In-process broadcaster + activeSessions registry — *partly
accidental*

`createSessionBroadcaster` (`animator.ts:81`) is a per-session pub/sub
that fans provider chunks out to the SSE route and to the
returned-handle subscriber, with full history replay for late
subscribers. `activeSessions` (`animator.ts:444`) keys the broadcasters
by session id, with a 30s deletion timer (`animator.ts:790`) so late
SSE subscribers can drain. The mechanism is legitimate *for whatever
consumer actually drives the SSE running-stream*; the accidental piece
is that one of its largest documented users — the Oculus session-detail
page — does not in fact reach the running-stream code path under normal
operation (see Doc/code discrepancy below).

### 7. Startup orchestration — *legitimate, with accidental sequencing
notes*

`start()` (`animator.ts:837–1000`) runs an ordered sequence:
config validation, books resolution, back-off machine creation, observer
hook registration, legacy status-book cleanup, eager `backoff.read()`,
then a fire-and-forget IIFE doing DLQ drain → boot reconciliation →
downtime-credit computation → guild_alive_at write → orphan recovery,
then two periodic timers (30s heartbeat, 30s reconciler). The ordering
constraints between these steps are real and load-bearing (DLQ drain
must precede orphan recovery — a DLQ'd terminal might resolve what the
reconciler would otherwise mark stale; boot reconciliation must precede
orphan recovery and the first `animate()` peek). The accidental piece
is the *amount of inline commentary* that explains the ordering — the
ordering rules require a planner to understand five rules at once
before they can read the code (see hotspot §7).

### 8. Type / API surface — *legitimate*

`types.ts` (724 LOC) is the public contract: `AnimatorApi`,
`SessionDoc`, `SessionResult`, `AnimateRequest`, `AnimatorSessionProvider`,
plus the `AnimatorStatusDoc` and `AnimatorRateLimitBackoffConfig`
shapes. The size is mostly justified by the breadth of consumers
(spider, parlour, astrolabe, copilot, claude-code, the CLI tools,
oculus). Most LOC are doc comments, not declarations. This concern does
not drive cost density on its own; it is included here for completeness.

### Static UI assets — explicitly out of scope

`packages/plugins/animator/src/static/` (animator.js 424 LOC,
animator.css 128 LOC, index.html 64 LOC, plus a 114-LOC UI test) hosts
the Animator's Oculus page. Cost-density framing points at behavioral
code: the UI assets are stable and decoupled from the dispatch /
recording / back-off machinery. They are acknowledged here for
completeness and explicitly carved out of every hotspot, candidate, and
yardstick comparison below.

## Per-concern hotspots

For each concern: file:line anchors, 1–3 line code excerpts, and 1–2
test pointers that codify current behavior.

### §1 hotspot — TERMINAL_STATUSES set duplication (concern 1, *partly
accidental*)

Four near-identical local definitions of the terminal-status set. The
type union is exported from `types.ts:518`; the set is not.

`packages/plugins/animator/src/animator.ts:411`:
```typescript
const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed', 'failed', 'timeout', 'cancelled', 'rate-limited',
]);
```

`packages/plugins/animator/src/session-record-handler.ts:122`:
```typescript
const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed', 'failed', 'timeout', 'cancelled', 'rate-limited',
]);
```

`packages/plugins/animator/src/tools/session-running.ts:52`:
```typescript
const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed', 'failed', 'timeout', 'cancelled', 'rate-limited',
]);
```

`packages/plugins/animator/src/tools/session-heartbeat.ts:18`: same
set, defined a fourth time. `rate-limit-backoff.ts:124` defines the
*inverse* `NON_RATE_LIMIT_TERMINAL_STATUSES` for the back-off reset
gate — also locally, so a fifth literal that must move in lockstep.

Tests covering current behavior:
`packages/plugins/animator/src/tools/session-lifecycle.test.ts` →
`describe('Terminal-state immutability', ...)` (line 900) and the four
"ready report against {completed,failed,cancelled,timeout}" tests
inside `describe('session-running tool', ...)` (lines 201–290).

### §2 hotspot — SessionDoc multi-writer merge fanout (concern 2,
*partly accidental*)

Each writer rebuilds the merge by hand. Two representative shapes:

`packages/plugins/animator/src/animator.ts:370` (recordRunning):
```typescript
const existing = await sessions.get(id);
const merged: SessionDoc = {
  ...(existing ?? {}), id, status: 'running',
  startedAt: existing?.startedAt ?? startedAt,
  provider: existing?.provider ?? providerName,
};
```

`packages/plugins/animator/src/tools/session-running.ts:82` (detached
ready report):
```typescript
const doc: SessionDoc = {
  ...(existing ?? {}), id: params.sessionId, status: 'running',
  startedAt: existing?.startedAt ?? params.startedAt,
  provider: existing?.provider ?? params.provider,
  lastActivityAt: new Date().toISOString(),
  ...(params.metadata ? { metadata: { ...(existing?.metadata ?? {}), ...params.metadata } } : {}),
};
```

`session-record-handler.ts:161` builds a third merge for the terminal
write; `startup.ts:235` builds a fourth for orphan-to-failed; the
operator-cancel path in `animator.ts:504` builds a fifth. Every merge
hand-codes the same invariants (preserve startedAt, provider on
existing; refresh lastActivityAt; merge metadata; merge cancelHandle;
guard against terminal regression).

Tests covering current behavior:
`packages/plugins/animator/src/animator.test.ts` →
`describe('cancel()', ...)` (line 1096, ~10 cases) for the operator-
cancel merge; `tools/session-lifecycle.test.ts` → `describe('session-
record tool', ...)` (line 292) and `describe('session-running tool',
...)` (line 97) for the detached merges.

### §3 hotspot — dispatchAnimate's success/error cancel-check
duplication (concern 3, *accidental*)

`dispatchAnimate` (`animator.ts:673–798`) handles the in-process
attached path. Both the success branch (`:730–760`) and the error
branch (`:766–781`) re-read the SessionDoc, re-check for `'cancelled'`,
and reconstruct a near-identical cancelled `SessionResult`:

`packages/plugins/animator/src/animator.ts:744` (success branch):
```typescript
sessionResult = {
  id, status: 'cancelled', startedAt,
  endedAt: currentDoc.endedAt ?? new Date().toISOString(),
  durationMs: currentDoc.durationMs ?? (Date.now() - new Date(startedAt).getTime()),
  ...
};
```

`packages/plugins/animator/src/animator.ts:769` (error branch): an
almost-identical literal, differing only in `exitCode: 1` and the
absence of `tokenUsage`/`output`/`providerSessionId`. The two branches
must stay in sync — any new field on `SessionResult` (e.g. the
hypothetical `terminationTag` field if it grew here) needs both
literals updated.

Tests covering current behavior:
`packages/plugins/animator/src/animator.test.ts` →
`it('result handler detects external cancellation and resolves (not
rejects)', ...)` at line 1221 and the parallel error-path test at
line 1267.

### §4 hotspot — rate-limit D-number invariants (concern 4,
*legitimate*)

`rate-limit-backoff.ts` cites D-numbers throughout — both in the
file-level comment block at lines 8–19 and inline at every transition
gate. To follow the code, a reader must understand each invariant:

`packages/plugins/animator/src/rate-limit-backoff.ts:255`:
```typescript
// D8: hits during an already-paused window coalesce (do not increment).
if (prev.state === 'paused' && !probe.hasDispatchedSinceLastPause()) {
```

`packages/plugins/animator/src/rate-limit-backoff.ts:340`:
```typescript
// D7: a non-rate-limit terminal resets the back-off level only when
// it counts as a successful resume probe — i.e. the session was
// dispatched AFTER the current pause opened.
```

The invariants are real and load-bearing (D7 — non-rate-limit-terminal
reset gate, D8 — coalesce-vs-increment, D10 — fail-loud config
validation, D11 — verbatim getStatus, D12 — top-of-animate
synthesized rejection, D13 — best-effort emit, D22 — eager boot
reconciliation, D24 — first-dispatch-flips-state). The cost density
problem is not the rules; it is the load on a reader who must hold all
of them in working memory because the names are abbreviated. (The
animator README does inline most of them, but the source comments
sometimes assume the reader already knows.)

Tests covering current behavior:
`packages/plugins/animator/src/rate-limit-backoff.test.ts` →
`describe('BackoffMachine', ...)` (line 108, exhaustive); the eager
boot reconciliation behavior is also covered end-to-end by
`packages/plugins/animator/src/animator.test.ts` →
`describe('animate() eager boot reconciliation (D22)', ...)` (line
1582).

### §5 hotspot — lifecycle emission call-site fanout (concern 5,
*accidental*)

Thirteen emission call sites in production source, each at a manual
"after the write" point with a bespoke skip-on-write-failed guard:

`packages/plugins/animator/src/animator.ts:348` (recordSession success):
```typescript
if (sessionDocWritten) {
  await emitSessionEnded(result);
}
```

`packages/plugins/animator/src/animator.ts:395` (recordRunning success
gated on the running-transition fence):
```typescript
if (existing?.status !== 'running') {
  await emitSessionStarted(merged);
}
```

`packages/plugins/animator/src/session-record-handler.ts:229` (detached
terminal):
```typescript
if (sessionDocWritten && emitter) {
  try { await emitter.emitSessionEnded(doc); } catch { /* best-effort */ }
}
```

The same gate (`sessionDocWritten`) is checked in five different files;
the same `try/catch /* best-effort */` boilerplate appears at every
call site. Plus two `setEmitter` / `setBackoffMachine` hook
registrations (`animator.ts:866`, `:887`) bridge the fact that
`session-record-handler.ts` runs from boot-time DLQ-drain *before* the
apparatus has fully started.

Tests covering current behavior:
`packages/plugins/animator/src/session-emission.integration.test.ts` →
end-to-end terminal sites (`describe` at line 242, six sub-blocks
covering attached, pre-check rejection, cancel, detached, orphan, and
clockworks-not-installed paths); `session-emission.test.ts` →
`describe('Animator — session emission helper', ...)` at line 169 for
the helper unit tests.

### §6 hotspot — broadcaster + activeSessions cleanup timer (concern
6, *partly accidental*)

`packages/plugins/animator/src/animator.ts:444`:
```typescript
const activeSessions = new Map<string, SessionBroadcaster>();
```

`packages/plugins/animator/src/animator.ts:790` (cleanup timer at the
end of `dispatchAnimate`'s result promise):
```typescript
setTimeout(() => activeSessions.delete(id), 30_000);
```

The 30s linger is tuned for "late SSE subscribers can drain buffered
chunks" — but as noted in the doc/code discrepancy below, the
running-stream subscriber path does not in fact fire under normal
production load.

Tests covering current behavior:
`packages/plugins/animator/src/animator.test.ts` →
`describe('subscribeToSession()', ...)` at line 701 (4 cases including
history replay and multiple-subscribers fanout);
`packages/plugins/animator/src/oculus-routes.test.ts` →
`describe('GET /api/animator/session-stream', ...)` at line 465.

### §7 hotspot — startup IIFE + ordering commentary (concern 7,
*legitimate*)

The boot IIFE (`animator.ts:926–974`) is a fire-and-forget that
sequences four steps with explicit ordering rules in comments:

`packages/plugins/animator/src/animator.ts:914`:
```typescript
// IMPORTANT: DLQ drain MUST complete before orphan recovery.
// DLQ files contain real terminal results from babysitters that couldn't
// reach the guild. If the reconciler runs first, it sees those sessions as
// stale (no recent heartbeat) and marks them failed — losing the real result.
```

`packages/plugins/animator/src/animator.ts:893` (eager backoff.read):
```typescript
try { await backoff.read(); }
```

The seven discrete pre-timer stages: cleanupLegacyStatusBook → eager
backoff.read → drainDlq → backoff.reconcileOnBoot → downtime-credit
computation → write initial guild_alive_at → recoverOrphans, then the
two periodic timers (heartbeat 30s, reconciler 30s). Each ordering
edge has a real reason; collectively they are five rules a reader must
load before they can edit `start()`.

Tests covering current behavior:
`packages/plugins/animator/src/animator.test.ts` →
`describe('animate() eager boot reconciliation (D22)', ...)` at line
1582 (covers the eager-read + reconcileOnBoot ordering invariant);
`packages/plugins/animator/src/tools/session-lifecycle.test.ts` →
`describe('DLQ-before-reconciler ordering', ...)` at line 624.

### §8 hotspot — public type surface (concern 8, *legitimate*)

`packages/plugins/animator/src/types.ts:518` (the canonical session
status union):
```typescript
status: 'pending' | 'running' | 'completed' | 'failed'
      | 'timeout' | 'cancelled' | 'rate-limited';
```

`packages/plugins/animator/src/types.ts:617`:
```typescript
export type AnimatorPauseReason = 'rate-limit';
```

`types.ts` runs to 724 LOC; the bulk is doc-comment for
`AnimatorApi` / `SessionDoc` / `AnimatorSessionProvider`. The size is
proportional to the number of consumers (spider, parlour, astrolabe,
copilot, oculus, claude-code, plus the CLI tools), and the type-level
declarations themselves are thin. Tests do not directly cover the type
surface; consumers exercise it indirectly. No hotspot pointer for this
concern.

## Cheap-cohort yardstick

What the cheap cohort (ratchet, lattice, clockworks) does differently —
narration with concrete numerical anchors. These contrasts are the
mechanism behind the cost-density gap, not a model of dollar cost.

**Single source of truth for status sets.** Ratchet's status type
(`packages/plugins/ratchet/src/types.ts:1`) is a four-value union
(`'live' | 'parked' | 'concluded' | 'dropped'`); its `TERMINAL_STATUSES`
constant lives in exactly one place
(`packages/plugins/ratchet/src/ratchet.ts:56`), referenced by every
status-driven branch. Lattice's `PulseDeliveryState`
(`packages/plugins/lattice/src/types.ts:30`) is a three-value union with
a single writer (the lattice apparatus itself) and three put/patch
sites total (`lattice.ts:135` create + `:304` and `:309` transitions).
The animator has the *type union* in one place but replicates the
runtime "is terminal" set across four files (see hotspot §1).

**Single-writer pattern.** The clockworks `events` book has one writer
(`emit()` in `clockworks.ts`); the dispatches book has one writer
(`writeDispatchRow` in `dispatcher.ts`). The lattice `pulses` book has
one writer (the lattice apparatus). The animator `sessions` book has
nine in-package writers across six files plus a tenth cross-package
writer (`packages/plugins/claude-code/src/detached.ts:374`). Each
writer reimplements the merge.

**D-number density.** The animator source carries 51 `Dn` references
across 7 files (15 in `rate-limit-backoff.ts` alone, 7 in
`session-emission.ts`). Ratchet has 18 across 3 files; lattice has 2
total. Clockworks has 197 across 21 files — the clockworks audit will
need to address this separately, but in the cheap cohort the structural
pattern is "one or two `Dn` references per file at most." Reading
animator code requires the reader to either inline the rules from the
README at every read or hold them in working memory.

**File count per concern.** Lattice's whole behavioral surface is 402
LOC in `lattice.ts` plus 265 LOC in `types.ts` (824 LOC including
tools). Ratchet's apparatus core is 818 LOC (`ratchet.ts`) plus its
13-file tool surface (each click tool is 20–50 LOC of plumbing). The
animator's lifecycle alone — concerns 1, 2, 3, 5 — is spread across
`animator.ts` (1,003 LOC), `session-emission.ts` (281 LOC),
`session-record-handler.ts` (252 LOC), `startup.ts` (268 LOC), and
five tools. A reader who needs to follow "what happens when a
detached session terminates" reads four files; the cheap cohort's
analogous flow lives in one.

**Test churn ratio.** Animator tests run to 5,941 LOC across 8 files,
~1.6× source. Ratchet tests are 2,065 LOC, ~2.5× source — but ratchet's
tests are concentrated in one file. The animator has eight test files
because the producers of state are spread across eight files, and each
producer's tests had to be written separately.

## Claude-code boundary aside

Several animator concerns terminate at the seam to
`packages/plugins/claude-code/`. The detached path (concern 3) is
*launched* by claude-code's `launchDetached` (which does the `pending`
SessionDoc pre-write at
`packages/plugins/claude-code/src/detached.ts:374`); the
`cancelHandle` interpretation (concern 2's tagged `kind: 'local-pgid'`
shape) is owned by the claude-code provider's `cancel()` method; the
rate-limit signal source (concern 4's `terminationTag.kind:
'rate-limit'`) is detected inside the claude-code stream parser and
flows back through `session-record`'s `terminationTag` parameter.
Claude-code itself has its own audit ahead. This audit names the
seam so a planner taking on any of the three candidates below
understands which animator-side code is genuinely owned by animator
versus where it terminates at the claude-code contract — but does not
analyze claude-code itself.

## Doc/code discrepancy — SSE running-stream

The animator README at line 301 documents `GET
/api/animator/session-stream` as "SSE stream — emits `chunk`,
`transcript`, and `done` events. Handles completed sessions, running
sessions with/without broadcaster." In practice, under detached
production dispatch the broadcaster is empty: the broadcaster is only
populated by the in-process attached path
(`packages/plugins/animator/src/animator.ts:688–705`), which production
dispatch (the spider's review/step engines, summon CLI in detached
mode) does not exercise. The route's "running session without
broadcaster" branch (`oculus-routes.ts:189–198`) is the path actually
hit, and it returns a `done` event with `noStream: true` immediately.
The completed-session branch (`oculus-routes.ts:169–183`) does fire on
a running session if the session has terminated by the time the route
is hit, but that is the transcript replay, not the live stream. This
discrepancy is load-bearing for refactor candidate B below — *if
nothing currently consumes the live broadcaster output, the entire
attached path can be retired.* (Two further README/code
discrepancies surfaced during planning are not cited here; they are
filed as primer observations for downstream cleanup.)

## Ranked refactor candidates

Three candidates, composite-ranked. Each lists effort + LOC anchor,
confidence, impact, and a "preserves" line listing the load-bearing
constraints the candidate must not break. The trio is shown so a
future planner can re-rank under different constraints.

### A. SessionDoc writeback reducer

**Change.** Replace the bespoke per-writer merge code at the nine
in-package SessionDoc write sites with a single discriminated-union
reducer — one function that takes `(existing, transition)` and returns
the next SessionDoc, with `transition` encoded as a tagged union
(`{ kind: 'attach-running', ... } | { kind: 'detached-ready', ... } |
{ kind: 'terminal', ... } | { kind: 'orphan-failed', ... } | { kind:
'cancel', ... } | { kind: 'heartbeat-touch' } | { kind: 'pending-pre-
write', ... }`). The reducer encodes the merge invariants (preserve
`startedAt`/`provider` from existing; refresh `lastActivityAt` on
lifecycle signals; deep-merge `metadata`/`cancelHandle`; reject
terminal-state regression). All call sites become `await
sessions.put(reduceSessionTransition(existing, transition))`.

**Concern addressed.** §2 multi-writer merge fanout, with downstream
relief on §1 (the reducer naturally exports the terminal-state set
once).

**Effort.** Small. Anchor: ~300 LOC of new code (one reducer module
+ tests), modifying 6 production files (`animator.ts`,
`session-record-handler.ts`, `startup.ts`,
`tools/session-running.ts`, `tools/session-heartbeat.ts`, plus the
cross-package `claude-code/src/detached.ts:374` if scope allows the
seam touch).

**Confidence.** High. The merge invariants are already implicitly
shared across all writers — the reducer just makes them explicit. No
behavior change required if the reducer faithfully reflects current
merges.

**Impact.** Medium. The audit traffic in the multi-writer fanout is
real (every animator-touching commission has had to re-derive a merge),
but the line count savings are modest (~150 LOC net) and the cognitive
relief is concentrated rather than broad.

**Preserves.** Terminal-state immutability (the reducer must reject
transitions out of a terminal state, matching the existing four
"ready report against terminal" tests at
`tools/session-lifecycle.test.ts:201–290`); the `lastActivityAt`
guild-wall-clock invariant (the guild writes its own time, never
host-supplied); the externally-cancelled guard in
`dispatchAnimate`'s success/error branches; the per-writer
`record-failed` phase tag (`'insert' | 'write-record' | 'update-row'`)
which the reducer must surface so emission gates stay correct.

### B. Eliminate the in-process attached path

**Change.** Retire `dispatchAnimate`'s in-process branch entirely.
Migrate the test harness to drive sessions through a detached-path
test fixture (mock babysitter calling the same `session-running` /
`session-heartbeat` / `session-record` tools production uses); decide
on and migrate the SSE running-stream consumer to whatever replacement
the audit's discrepancy section points at (likely a CDC observer on
the sessions book that emits chunks via a different mechanism, or
acknowledgement that the live-stream path serves no current consumer
and can be retired with the broadcaster). Once retired, delete
`createSessionBroadcaster` (animator.ts:81–142), `activeSessions`
(animator.ts:444 + the 30s cleanup at :790), the dispatchAnimate
success/error cancel-check branch duplication (animator.ts:730–781),
and the broadcaster lifetime tests in animator.test.ts.

**Concern addressed.** §3 dual paths, §6 broadcaster + activeSessions,
§5 fanout (the attached path's emission sites collapse).

**Effort.** Medium. Anchor: removes ~600 production LOC (broadcaster
~60 LOC, activeSessions + cleanup ~10 LOC, dispatchAnimate's in-process
body ~120 LOC, attached-only emission gates ~30 LOC, plus the
duplicated cancelled-result construction ~80 LOC, plus knock-on
cleanups in `animator.ts`'s `animate()` and `summon()` plumbing) and
comparable test churn (the 4 cases under `describe('subscribeToSession()',
...)` in animator.test.ts:701 plus the broadcaster-related cases in
oculus-routes.test.ts:465–567 must move or retire). Net: 4–5 production
files touched.

**Confidence.** Medium. The retirement is sound only if the SSE
running-stream consumer story has been resolved. The doc/code
discrepancy above suggests the broadcaster is not in fact serving
production traffic, but a planner taking this on must verify
empirically before deleting code.

**Impact.** High. This is the single largest cognitive load in the
package — three concerns collapse together, and the package goes from
"two ways to dispatch" to "one way to dispatch" with a single
authoritative session-record path.

**Preserves.** The test-only attached path's *coverage* (every test
currently driven through `animate()` in-process must migrate to the
detached harness, not lose coverage); whatever real consumer the SSE
running-stream serves once a replacement is chosen (the SSE route
itself can keep its surface even if the broadcaster source changes);
the `commission.session.ended` parent-chain resolution (lifecycle
emission already works on the detached path).

### C. Centralize lifecycle event emission via SessionDoc CDC

**Change.** Replace the 13-call-site emission fanout (concern 5) with a
single CDC observer on the `animator/sessions` book that fires
`session.started` on the canonical pending → running transition,
`session.ended` on any non-cancelled→terminal or running→cancelled
transition (with the existing `commission.session.ended` co-emit logic
preserved), and `anima.manifested` / `anima.session.ended` co-emits
when `metadata.role` is set. The `session.record-failed` event stays
at its current call sites (CDC cannot observe a write that didn't
happen) — but those collapse from six sites to three by routing through
the writeback reducer from candidate A. Retire `setEmitter` /
`setBackoffMachine` hook plumbing once the CDC observer subsumes the
DLQ-drain entry point.

**Concern addressed.** §5 emission fanout, with downstream relief on
§7 (the startup hook registrations go away).

**Effort.** Medium. Anchor: ~250 LOC of new CDC observer + tests,
removes ~150 LOC of fanout boilerplate across 4 files
(`animator.ts`, `session-record-handler.ts`, `startup.ts`,
`tools/session-running.ts`).

**Confidence.** Medium. Depends on Stacks CDC surfacing
*previous-status* on the change record (the observer must distinguish
"first running write" from "subsequent running update" and "non-
terminal → terminal" from "terminal → terminal duplicate"). If
previous-status is not surfaced today, candidate C either grows to
include a stacks-side change or is deferred until that change lands.

**Impact.** Medium. The fanout boilerplate is a maintenance tax (every
new write site has to remember to emit; every emission failure mode
needs identical try/catch); centralizing it eliminates a class of
"forgot to emit" bug that has historically required test-driven
discovery. But the call-site count is bounded; the win is structural,
not a large LOC delete.

**Preserves.** The six event names and their semantics
(`session.started`, `session.ended`, `session.record-failed`,
`commission.session.ended`, `anima.manifested`,
`anima.session.ended`); the three-value `phase` discriminator on
`session.record-failed` (`'insert' | 'write-record' | 'update-row'`);
the `commission.session.ended` parent-chain resolution
(`session-emission.ts:146–170`) — the CDC observer must call the same
`deriveCommissionIdForSession` helper; the `anima.*` co-emission
gating on `metadata.role`; the soft-dependency contract (no events
fire when clockworks is not installed).

**Why not a fourth or fifth candidate.** Two further candidates were
considered and dropped from the ranked list. *Rate-limit extraction
into its own package* would move ~452 LOC into a sibling but the
rate-limit machine is not itself a cost-density driver — it is dense
but well-isolated, and extraction would create a new cross-package
seam without simplifying the animator's other concerns. *Broadcaster
simplification* is fully subsumed by candidate B (the broadcaster
either disappears with the attached path, or stays as-is until the
attached path retires; there is no useful middle).

### Composite ranking summary

| # | Candidate | Effort | Confidence | Impact |
|---|-----------|--------|------------|--------|
| A | SessionDoc writeback reducer | small | high | medium |
| B | Eliminate in-process attached path | medium | medium | high |
| C | Centralize emission via CDC | medium | medium | medium |

A is ranked first because it is the highest-confidence + smallest-
effort candidate; it lays groundwork (the explicit transition tagging)
that both B and C can build on. B is ranked second despite its larger
impact because its confidence is gated on resolving the SSE
broadcaster consumer story. C is ranked third because its confidence
depends on a Stacks-side change that may or may not be in scope. A
planner with a different constraint profile (e.g. "willing to invest
in a stacks change to delete the most code") could re-rank B above A
or C above A.

## What NOT to refactor

Aggregated load-bearing constraints from the inventory tags above —
this is the digest a planner can scan before lifting any candidate
into a refactor brief.

- **Rate-limit back-off rules.** The seven invariants (D7 — non-rate-
  limit-terminal reset gate; D8 — coalesce-vs-increment; D10 — fail-
  loud config validation; D11 — verbatim getStatus; D12 — top-of-
  animate synthesized rejection; D22 — eager boot reconciliation; D24
  — first-dispatch-flips-state) are load-bearing. Any candidate that
  touches `rate-limit-backoff.ts` must preserve them.
- **Terminal-state immutability.** A non-running write to a terminal
  session must be rejected; a duplicate terminal report must drop
  silently and still write the transcript. Codified in
  `tools/session-lifecycle.test.ts:900` (`describe('Terminal-state
  immutability', ...)`).
- **Guild-wall-clock `lastActivityAt`.** The guild writes its own time
  for `lastActivityAt`, never a host-supplied timestamp. The reconciler
  depends on this for the staleness calculation.
- **DLQ-drain-before-orphan-recovery ordering.** A DLQ'd terminal
  result must be applied before the orphan reconciler scans the
  sessions book, otherwise stale-but-real terminals get marked failed.
  Codified at `tools/session-lifecycle.test.ts:624` (`describe('DLQ-
  before-reconciler ordering', ...)`).
- **Eager-backoff-read-before-first-dispatch ordering.** `start()` must
  await `backoff.read()` (and `reconcileOnBoot()`) before the first
  `animate()` call so the synchronous `peek()` reflects persisted
  state. Codified at `animator.test.ts:1582` (`describe('animate()
  eager boot reconciliation (D22)', ...)`).
- **Externally-cancelled guard.** `dispatchAnimate`'s success and
  error branches both re-read the SessionDoc and skip the terminal
  overwrite if the doc is already `'cancelled'`. Codified at
  `animator.test.ts:1221` and `:1267`.
- **Six lifecycle event names + payload shapes.**
  `session.started` / `session.ended` / `session.record-failed`
  (with phase tag) / `commission.session.ended` (with the parent-
  chain-resolved `commissionId`) / `anima.manifested` /
  `anima.session.ended`. Catalog-fixed; downstream consumers
  (clockworks standing orders, the laboratory) branch on names.
- **Soft-dependency contract.** Clockworks is in `recommends`, not
  `requires`; emission helpers must silently no-op when clockworks
  is absent. Codified at
  `session-emission.integration.test.ts:488` (`describe('soft-
  dependency contract — Clockworks not installed', ...)`).
- **Static UI assets.** `src/static/` is not a refactor target; it is
  decoupled from the dispatch / recording / back-off machinery, and
  whatever cost-density problem the audit identifies does not live
  there.
- **Public API surface in `types.ts`.** `AnimatorApi`,
  `AnimatorSessionProvider`, `SessionDoc`, `SessionResult` — all are
  consumed cross-package by spider, parlour, astrolabe, copilot,
  oculus, the CLI tools, and claude-code. Field-level changes
  cascade. Renames are out of scope; additive changes need a
  cross-package audit.
