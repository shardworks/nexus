# Claude-Code Complexity Audit

## TL;DR

`@shardworks/claude-code-apparatus` reads expensively because three forces compound in one small package: a `runBabysitter` orchestrator that fuses around ten responsibilities under a single try/catch/finally; an MCP/SSE proxy server hand-rolled around four interleaved sub-machines; and a layer of tombstoned commentary preserving the history of features the package learned the hard way to keep narrow. The downstream load-bearing invariants — most consequentially the rate-limit detector's deliberate one-branch shape, the negative-pgid cancellation contract, and the `pending`-then-spawn authorization anchor — are encoded as much in retired-branch comments and spec citations as in code, so any refactor must carry that history forward. **The corroborating cost-density signal ($0.019/LOC against $0.005–0.006/LOC floors) is from an n=2 sample and is treated as a hint, not as an order**: every ranking and confidence label below is grounded in structural reasoning, with cost-density cited as a corroborator only.

| Candidate | Effort | Confidence |
| --- | --- | --- |
| A — Extract a babysitter-runtime toolkit | small | high |
| B — Decompose `runBabysitter`, folding in source-mode detection deduplication | medium | high |
| C — Extract the MCP/SSE proxy as its own module with a stable public contract | large | medium |

## Methodology and caveat

This audit is structural. The corroborating cost signal — `@shardworks/claude-code-apparatus` sits in the guild's per-LOC reading-cost top tier at approximately $0.019/LOC against package floors near $0.005/LOC — comes from an n=2 sample (claude-code paired with `animator` at ~$0.018/LOC; cheap-package floors observed on `ratchet` and `clockworks`). **Two data points have not earned the right to be the primary ranking axis.** They are a hint, not an order. Every hotspot ranking and every candidate confidence label below is grounded in structural reasoning — branch density, coupled type relationships, scattered control flow across error paths, signal/process edge cases, doc-vs-code drift — with the cost-density signal cited as corroboration only where the structural evidence already points the same way.

"Intent-focused" framing means: candidates name what to change and why it would help reading and reasoning; they do not prescribe function bodies, type definitions, refactored signatures, or other artifacts a downstream planner is supposed to produce. A planner reading this report should be able to pick a candidate and draft a refactor brief without re-reading the package end-to-end.

Citations are by symbol name plus an approximate line range (e.g. `runBabysitter` at lines ~738–977). Exact line numbers go stale on any commit and are deliberately omitted.

## Structural inventory

The package is three source files (`index.ts`, `detached.ts`, `babysitter.ts`) totalling ~1,800 source LOC against ~3,360 test LOC across five test files — a test:source ratio of approximately 1.9×. The package's external coupling is unusually low for its surface area: `claude-code` reports 14 outbound import edges (9 source, 5 test) and zero inbound edges in the cross-package coupling snapshot, meaning it is a leaf consumer that nobody imports back. The expense is internal density, not fan-out.

The concerns the package handles, file by file:

### `index.ts` (~305 LOC)

- **Provider plugin shell** — `createClaudeCodeProvider` at lines ~159–172 wires the apparatus in via the standard `Plugin` shape. Cheap, single-purpose.
- **`cancel()` provider method** — `provider.cancel` at lines ~117–139 dispatches on `cancelMetadata.kind`, sends `SIGTERM` to the process group via `process.kill(-pgid, 'SIGTERM')`, swallows `ESRCH`, rethrows `EPERM`, logs unknown kinds. Compact but signal-edge-careful.
- **`launch()` provider method** — `provider.launch` at lines ~141–147 is a one-line delegate to `launchDetached`.
- **Rate-limit detector** — `detectRateLimitFromNdjson` plus `RATE_LIMIT_ERROR_TEXT_PATTERN` at lines ~30–81. One active branch (top-level `error` field regex match) with two retired branches preserved as commentary.
- **NDJSON stream parsing** — `parseStreamJsonMessage` at lines ~206–277 walks `assistant`/`user`/`result` message types, accumulates transcript and metrics, runs the rate-limit detector first-wins on every message.
- **NDJSON buffer splitting** — `processNdjsonBuffer` at lines ~285–304 is a simple newline-splitter.
- **Final assistant text extraction** — `extractFinalAssistantText` at lines ~93–110 walks the transcript backwards.
- **`StreamJsonResult` type** — at lines ~177–196 carries exit/signal/cost/usage/transcript/`terminationTag` through the babysitter to the guild.

### `detached.ts` (~477 LOC)

- **Tool manifest computation** — `computeToolManifest` at lines ~58–70 filters by `callableBy: 'anima'` and appends three infrastructure tool names. Drives both the babysitter config and the SessionDoc's `authorizedTools`.
- **Tool serialization** — `serializeTool`/`serializeTools` at lines ~81–103 converts Zod params to JSON Schema via `z.toJSONSchema` and unwraps the outer `type`/`$schema` so the babysitter can re-wrap.
- **Path/config resolvers** — `resolveGuildToolUrl`, `resolveDbPath`, `resolveLogDir`, `resolveBabysitterPath` at lines ~108–146. The babysitter-path resolver picks `.ts` vs `.js` by `import.meta.url` extension — the *source-mode detection*, instance #1.
- **`buildBabysitterConfig`** — at lines ~179–221. Materialises claude CLI args, writes the system prompt to a temp file, threads metadata, hands the babysitter a fully-populated config object. The `systemPromptTmpDir` is owned by the babysitter's finally block.
- **Polling helpers** — `pollForTerminalStatus` at lines ~231–255 and `pollForProcessInfo` at lines ~263–292. Same loop shape twice (deadline, sleep clamp, terminal-shortcut).
- **`launchDetached` orchestration** — at lines ~328–477. Triple-promise (`init`, `result`, `processInfo`) where `init` pre-writes the `pending` SessionDoc, then spawns the babysitter. The pre-write is the authorization anchor (must succeed before spawn). Source-mode detection appears again at lines ~390–393 — this is *source-mode detection instance #2*, this time for `execArgv` forwarding to a `.ts` child.
- **`docToProviderResult`** — at lines ~299–318 maps a SessionDoc to a `SessionProviderResult`, forwarding `terminationTag` for the Animator's back-off machine.

### `babysitter.ts` (~1,013 LOC)

- **Stdin config reader and validator** — `readConfigFromStdin` at lines ~121–156. Reads stdin to completion, parses, validates a fixed required-field list.
- **Retry/HTTP helper machinery** — `findRetryableCode`, `encodeParamsAsQuery`, `callGuildHttpApi` at lines ~80–246. Bespoke retry loop with exponential backoff, error-cause-chain walking, GET-vs-POST shaping.
- **DLQ writer** — `writeToDlq` at lines ~257–264. Single-purpose, cheap.
- **MCP/SSE proxy server** — `createProxyMcpHttpServer` at lines ~277–460. Hand-rolled `http.createServer` with two routes (`GET /sse`, `POST /message`), MCP `Server` registration of `tools/list` and `tools/call`, a promise-gate for SSE-then-POST race, an SSE keepalive timer, transport lifecycle tracking, per-call diagnostic logging, GET/POST/DELETE method routing per tool.
- **SQLite transcript writer** — `openTranscriptDb`, `initTranscriptDb`, `writeTranscript` at lines ~465–535. Dynamic-imports `better-sqlite3`, opens WAL mode, prepares one `INSERT OR REPLACE` statement on a single-row table.
- **Lifecycle reporting** — `reportRunning` at lines ~544–564, `reportResult` at lines ~631–674. HTTP-call-with-DLQ-fallback wrappers around `session-running` / `session-record`.
- **Terminal-status resolution** — `resolveTerminalStatus` at lines ~587–614. Three-priority cascade (cancel override → NDJSON termination tag → exit-code 0/non-zero) producing the payload status.
- **Stderr redirect / per-session log** — `redirectStderrToFile` at lines ~690–721. Replaces `process.stderr.write` with an fs-backed implementation; writes the startup banner; returns the owned fd for caller-managed close.
- **Main orchestrator** — `runBabysitter` at lines ~738–977. Fuses transcript-DB open, MCP proxy start, tmpdir creation, claude args assembly, claude spawn, prompt pipe, stderr forward + rolling-tail capture, running report, heartbeat scheduling, SIGTERM handler, NDJSON ingestion / accumulator wiring, exit-code wait, terminal report, top-level error fallback, and cleanup. ~240 LOC of `try / catch / finally` over ten responsibilities.
- **Script entry point** — `main` at lines ~986–1003 plus the entry-point check at lines ~1006–1013.

## Complexity hotspots

### Cross-cutting cost signals

Two phenomena cut across every concern in this package and amplify the per-LOC reading cost on each one. They are surfaced once here so the per-concern entries below can stay terse.

**Test:source ratio of approximately 1.9×.** ~3,360 test LOC against ~1,800 source LOC, with `babysitter.test.ts` alone (~1,535 LOC) larger than every source file. The ratio is structurally honest — most of the package is asynchronous I/O against a child process, an HTTP server, an SQLite handle, and the guild's HTTP API, and all of that surface needs covering — but it inflates the read cost twice: once when the reader walks the source and again when they cross-check behaviour against the tests. By contrast, ratchet's source-to-test ratio is closer to 1:1 on a comparable surface, and clockworks splits its tests across many small test files paired one-to-one with small source files.

**Tombstoned commentary tracking past production incidents.** Four distinct comment blocks in this package preserve the history of features that were tried, failed, and removed. Every reader pays the cost of these tombstones because they cannot be skimmed — each one is load-bearing for understanding why the surrounding code is written narrowly. The four tombstones live in: `detectRateLimitFromNdjson` at lines ~30–67 (two retired speculative branches); `resolveTerminalStatus` at lines ~568–585 (exit-code-based detection retired after false-positive pauses); the stderr forwarder inside `runBabysitter` at lines ~806–820 (stderr-pattern detection retired); and the SSE-race promise-gate in `createProxyMcpHttpServer` at lines ~345–353 (POST-before-GET race fix). The corroborating data point is that ratchet and clockworks carry essentially no tombstones of this character — their commentary is forward-looking, not historical.

### Hotspot 1 — `runBabysitter` orchestrator fuses ~10 responsibilities

`runBabysitter` at lines ~738–977 is the package's largest single function (~240 LOC) and the densest concentration of branching in the codebase. Its JSDoc at lines ~725–737 enumerates 8 numbered steps; the body delivers steps numbered 1, 2, 3, 4, 5, 5b (heartbeat scheduler), 5c (SIGTERM handler), 6, 7, 8, and 9 — eleven labelled steps under a JSDoc that promises eight, with the heartbeat scheduler and the SIGTERM handler tucked as sub-steps under "5". The discrepancy is itself the artifact: the comment was true once and the function has grown past it.

Reading cost compounds through:

- A single `try / catch / finally` block at lines ~756–977 wrapping the whole orchestrator. Every concern (transcript DB, MCP proxy, tmpdir, claude process, heartbeat timer, SIGTERM handler, stderr-tail buffer, NDJSON accumulator) shares one cleanup scope, so the reader has to mentally page in all of them while reasoning about any one of them.
- Three `let` variables at lines ~750–754 (`db`, `mcpHandle`, `tmpDir`, `claudeProc`) initialised to `null` and mutated through the body so the finally block can clean up on partial init. State threading across the function rather than handed in.
- The accumulator object at lines ~872–883 carries five fields (transcript, costUsd, tokenUsage, providerSessionId, terminationTag) that are mutated by `parseStreamJsonMessage` reaching into it. The mutation contract is implicit — the reader has to check `parseStreamJsonMessage` to know what `acc` is going to look like by the time `runBabysitter` reads it.
- A nested `Promise` constructor at lines ~901–908 wraps `claudeProc.on('error')` and `claudeProc.on('close')` but only one of the two paths can resolve — readers must verify the rejection path drives the outer catch.
- The top-level catch at lines ~942–964 contains its own embedded copy of the failure-reporting cascade (HTTP call → DLQ writeToDlq), partly duplicating `reportResult`.

This hotspot is corroborated by the cost signal: the file's read cost dominates the package and `runBabysitter` dominates the file.

### Hotspot 2 — MCP/SSE proxy server hand-roll

`createProxyMcpHttpServer` at lines ~277–460 (~190 LOC) hand-rolls an HTTP server around the MCP SDK's `Server` and `SSEServerTransport`. The function is one logical unit but reads as four interleaved sub-machines:

- MCP tool registration (`ListToolsRequestSchema`, `CallToolRequestSchema`) with a per-tool method lookup map and an inline call to `callGuildHttpApi`.
- An SSE transport promise-gate at lines ~348–356 — `transportReady` plus `resolveTransport`/`rejectTransport` — that solves a POST-before-GET race the comment block at lines ~345–353 documents as a load-bearing fix.
- A keepalive timer at lines ~360–394 sending SSE comment frames every 30s, with cleanup logic spread across the `res.on('close')` handler and the outer `close()`.
- A diagnostic logging layer (`sseConnectedAt`, `sseClosedAt`, `toolCallCount`) threaded across every branch, used to trace connection-drop bugs at lines ~370–420.

Two MCP transports, an HTTP routing layer, a keepalive, and a diagnostic ring buffer in one function is the cost driver. None of them are individually complex; the reading cost is in the interleaving.

### Hotspot 3 — Rate-limit NDJSON detector with retired-branch tombstones

`detectRateLimitFromNdjson` at lines ~69–81 in `index.ts` is one active branch of code (a regex match on `msg.error`) — but the surrounding doc-block at lines ~30–67 is ~38 lines of preserved history justifying the narrowness. The ratio of explanation to executable code (~1:0.2) is the cost driver, not the branching, and it is intentional: every reader needs the history to understand why the detector is one branch instead of three.

The full enumeration of retired branches is deferred to the "what NOT to refactor" section (per the design split — historic context is a correctness invariant, not a hotspot). Here it suffices to say: the tombstones cost the reader on every visit, and that cost is load-bearing — removing them would re-open the cascade history the package paid two production incidents to learn.

A separate observation in the same file: the package README at `packages/plugins/claude-code/README.md` describes a "two-branch NDJSON detector" with `subtype` and `is_error` branches active. The code is a one-branch detector, and the tombstones name `subtype` and `is_error` as the *retired* branches. The README and the code disagree about the active surface — readers cross-checking the two pay an extra hop to resolve the contradiction. This drift is a cost driver in its own right; remediation is out of scope for this audit, but the signal is captured for downstream pickup.

### Hotspot 4 — Bespoke HTTP retry helper

`callGuildHttpApi` at lines ~192–246, paired with `findRetryableCode` at lines ~92–102 and `encodeParamsAsQuery` at lines ~175–190, is a small retry loop — but it duplicates a pattern that the broader codebase has multiple copies of, and it interleaves three concerns (URL+method shaping, retry classification by error-cause-chain code, exponential backoff with deadline) in one function. The error-cause-chain walk in `findRetryableCode` is a 5-deep traversal that exists because Node's `fetch` wraps the underlying ECONN error one layer deep — a subtle reading hazard that the function caps to prevent infinite loops on circular cause chains. Cost is moderate per visit but every transcript- and lifecycle-related concern reaches into this helper.

### Hotspot 5 — Duplicated source-mode detection

The `.ts` vs `.js` extension test appears twice for two distinct purposes: `resolveBabysitterPath` at lines ~142–146 in `detached.ts` picks the babysitter script path, and the inline check at lines ~390–393 inside `launchDetached` decides whether to forward `process.execArgv` to the spawned child. Both checks key on the same predicate (the running module's URL or path ends with `.ts`) but they live in separate scopes and one mutates `nodeArgs`, the other returns a path. Reading either site requires understanding that the package supports two run modes (compiled `dist/` and source `src/` via `--experimental-transform-types`); reading the second requires recalling the first to confirm the predicates can't drift.

### Hotspot 6 — Stderr redirect interacting with rolling-tail capture

`redirectStderrToFile` at lines ~690–721 replaces `process.stderr.write` with an fs-backed implementation against an owned fd. Inside `runBabysitter`, the claude child's stderr is forwarded to that redirected stderr at lines ~816–820 *and* simultaneously appended to a rolling-tail buffer (`stderrTail`) capped at `STDERR_DIAGNOSTIC_TAIL_LIMIT` characters. The tail is then attached to the `terminationDiagnostic` payload only when the resolved status is exactly `'failed'`, gated inside `reportResult` at lines ~644–652. Three sites cooperate to deliver one passive diagnostic — the redirect (file open + write replacement), the rolling buffer (per-chunk slice), and the `'failed'`-only attachment gate — and each site has its own correctness reason that the reader must reconstruct from comments.

### Hotspot 7 — Triple-promise pattern in `launchDetached`

`launchDetached` at lines ~328–477 returns `{ chunks, result, processInfo }` where each is constructed independently but all three depend on a shared `init` IIFE at lines ~368–409 that pre-writes the `pending` SessionDoc and spawns the babysitter. `chunks` is a synchronous empty async iterable (lines ~412–420) since real-time output flows through SQLite; `result` awaits `init`, then polls the sessions book, then maps the doc to a `SessionProviderResult` (lines ~423–449); `processInfo` awaits `init`, polls for the cancel handle, falls back to the babysitter PID (lines ~453–474). The three promises share one initialisation but each carries its own try/catch, its own fallback path, its own error message format. Readers tracking the `processInfo` flow have to step through `result`'s flow first to confirm `init` is unique. The return shape is a quiet contract that the next reader has to reconstruct.

## Ranked refactor candidates

Three candidates, spanning a small / medium / large effort spread. Each is a single-proposal commission seed: the proposal, the concern it addresses, a scope-anchored effort label, and a signal-strength confidence label for per-LOC cost reduction. None prescribe an implementation shape — that decision belongs to the planner who picks one.

The effort scale is scope-anchored:

- **small** = single-file extraction. Move code, change no public contracts, no consumers update.
- **medium** = internal-API change. New cross-module surface inside the package; types or imports updated within `claude-code` only.
- **large** = cross-package contract change. New exports, new package boundaries, or signatures that other packages have to update.

The confidence scale is signal-strength:

- **high** = multiple independent structural signals point the same direction (e.g. tombstones + duplication + cost-density).
- **medium** = one strong structural signal.
- **low** = the proposal is plausible but the cost-reduction lever is uncertain — a downstream planner may reasonably decide the change does not pay back.

### Candidate A — Extract a babysitter-runtime toolkit (small, high)

**Proposal.** Move the small, single-purpose primitives currently embedded in `babysitter.ts` into a new sibling source file (call it `runtime.ts` or similar; the planner picks). The candidates for extraction are the bespoke retry/HTTP helpers (`findRetryableCode`, `encodeParamsAsQuery`, `callGuildHttpApi` at lines ~80–246), the DLQ writer (`writeToDlq` at lines ~257–264), the stdin config reader plus required-field validator (`readConfigFromStdin` at lines ~121–156), the SQLite open/init/write trio (`openTranscriptDb`, `initTranscriptDb`, `writeTranscript` at lines ~465–535), and the stderr redirect (`redirectStderrToFile` at lines ~690–721). The lifecycle reporters (`reportRunning`, `reportResult`) also have a natural home in this toolkit.

**Concern addressed.** The cross-cutting cost-signal observation (test:source ratio) and Hotspot 4 (bespoke HTTP retry helper). Today these primitives are scattered through the same file as the orchestrator and the proxy server, which means every reader of `babysitter.ts` pays the cost of their density even when their question is about lifecycle or HTTP plumbing alone. Their tests already cluster naturally — `babysitter.test.ts` contains a `findRetryableCode` describe block at lines ~1162 of the test file, a `callGuildHttpApi` describe block at lines ~168 and ~1205, a `writeToDlq` describe block at lines ~245 — so a parallel split of the test file is straightforward.

**Effort.** Small — single-file extraction with no public contract change. Public exports from `babysitter.ts` can re-export from the new module to keep the babysitter entry-point shape intact.

**Confidence.** High — three structural signals corroborate. The primitives are already mutually independent (no shared closure); the tests are already partitioned by primitive; and the package's outbound coupling is low enough (14 edges total) that a new internal module does not propagate elsewhere.

### Candidate B — Decompose `runBabysitter`, folding in source-mode detection deduplication (medium, high)

**Proposal.** Decompose `runBabysitter` at lines ~738–977 along the seams already implied by its numbered-step structure: at minimum, an init/setup phase (transcript DB, MCP proxy, tmpdir, claude args, claude spawn), a steady-state phase (running report, heartbeat scheduler, SIGTERM handler, NDJSON ingestion, exit wait), and a terminal phase (heartbeat stop, signal-handler cleanup, terminal report, top-level error fallback, finally cleanup). Each phase becomes a function with an explicit handoff shape; the orchestrator becomes a sequencer rather than a try/catch envelope around 240 LOC of mixed concerns.

Fold the source-mode detection consolidation into the same commission. The two detection sites in `detached.ts` — `resolveBabysitterPath` at lines ~142–146 and the inline `isSource` test at lines ~390–393 — should share a single source-mode predicate so the two run modes (compiled vs. transform-types source) cannot drift between them. The fold makes sense in this candidate because the orchestrator decomposition is the moment a planner is reaching across the babysitter and the launcher anyway.

**Concern addressed.** Hotspot 1 (orchestrator fusing ~10 responsibilities) directly. Hotspot 5 (duplicated source-mode detection) bundled in. The JSDoc-vs-body discrepancy at lines ~725–737 — eight documented steps against eleven labelled in the body — is a symptom that resolves naturally when the decomposition lets the function shrink to a length the comment can still describe truthfully.

**Effort.** Medium — internal-API change. The shape of the new internal handoffs is inside the package (no public-API churn), but the callers of `runBabysitter` from `main` at lines ~986–1003 stay one line, and `babysitter.test.ts` will need partial restructuring so each phase has its own describe block. The accumulator object's mutation contract with `parseStreamJsonMessage` in `index.ts` is the one cross-file edge a planner has to either preserve or restate; either is a local decision.

**Confidence.** High — multiple structural signals: the JSDoc-body drift, the named numbered steps already in the body, the partial duplication of the failure-reporting cascade in the top-level catch, and the corroborating cost-density data point. The orchestrator is the largest reading-cost line item in the package and the decomposition seams are already drawn.

### Candidate C — Extract the MCP/SSE proxy as its own module with a stable public contract (large, medium)

**Proposal.** Promote `createProxyMcpHttpServer` at lines ~277–460 (and the small surface around it — the SSE keepalive, the diagnostic counters, the transport promise-gate) to a dedicated module with a public-shaped contract: a constructor that takes the tool list, the upstream guild URL, and a session id, and returns a handle exposing `url` and `close()`. The aim is not to share the proxy across packages today; it is to give the proxy concern a home of its own so reading the babysitter does not require paging in MCP-server lifecycle, SSE race-fix logic, and per-call diagnostics.

**Concern addressed.** Hotspot 2 (MCP/SSE proxy hand-roll). The four interleaved sub-machines (MCP registration, SSE promise-gate, keepalive timer, diagnostic logging) all live in the same function today, and the diagnostics at lines ~370–420 are load-bearing for tracing the production SSE-drop history. Lifting the whole machine to its own module lets the diagnostic surface live with the SSE state without crowding the babysitter orchestrator.

**Effort.** Large — cross-package contract surface. The proxy's existing call into `callGuildHttpApi` and its dependence on `toolNameToRoute` from `@shardworks/tools-apparatus` mean the module's surface lands at the boundary between `claude-code` and `tools`. Even keeping the new module package-private, a planner has to decide whether the proxy depends on the runtime toolkit from Candidate A (which would imply Candidate A is a prerequisite), and whether the diagnostic surface stays string-format `process.stderr.write` calls or hardens into a pluggable observer.

**Confidence.** Medium — the structural signal is strong (the four sub-machines are clearly distinguishable and each has its own correctness reason) but the cost lever is uncertain. The proxy is read less often than the orchestrator; the per-LOC reading cost may be high in this slice but the slice is small in calendar time. A planner may reasonably decide this work is better paid for by Candidate B's reduction of the surrounding context cost than by extracting the proxy itself.

## What NOT to refactor

A flat list of load-bearing invariants. Each one names a behaviour that looks refactorable on a casual read but is locked in by a spec section, a tombstoned comment, or a test name. Treat this as a tripwire checklist while drafting any refactor brief.

- **Pre-write of the `pending` SessionDoc must complete before the babysitter is spawned.** This is the authorization anchor — the tool API reads the session record to authorize calls, and that record must exist before the first tool call arrives. Citation: `docs/architecture/detached-sessions.md` § Authorization → "Authorization anchor"; reinforced in `launchDetached` at lines ~366–382 of `detached.ts` (the `init` IIFE explicitly sequences `sessions.put({ status: 'pending' })` before the spawn).
- **Cancellation must signal the process group, not the babysitter PID.** `process.kill(-pgid, 'SIGTERM')` in `provider.cancel` at lines ~123–132 of `index.ts` guarantees the claude child receives the signal even if the babysitter's signal handler is broken. Signalling the babysitter alone leaves claude orphaned. Citation: `docs/architecture/detached-sessions.md` § Cancellation handles across host types → "Local-process host"; the negative-pgid form is also asserted by the `'sends SIGTERM to process group for local-pgid'` test in `cancel.test.ts`.
- **`ESRCH` must be swallowed in cancel; `EPERM` must be rethrown.** A process group already dead is the expected race; a permission error is a programmer-visible bug. The branching in `provider.cancel` at lines ~125–131 of `index.ts` is asserted by the `'swallows ESRCH errors (process group already dead)'` and `'propagates EPERM errors'` tests in `cancel.test.ts`.
- **Termination-tag accumulation is first-wins.** `parseStreamJsonMessage` in `index.ts` at lines ~225–228 only sets `acc.terminationTag` when it is undefined. The ordering preserves the source of the first observation, which the Animator's back-off machine relies on for auditability. Asserted by `'is first-wins — a later success does not clear the tag'` in `rate-limit-detection.test.ts`.
- **The rate-limit detector is intentionally one branch, not three.** `detectRateLimitFromNdjson` in `index.ts` at lines ~30–81 carries an explicit doc-block enumerating the retired branches: a `result`-text branch (matched an assistant's prose summary of a prior rate-limit and false-paused the guild); a `subtype`-only speculative branch (never observed in the wild); and an `is_error: true` plus error-text speculative branch (also never observed). Together these were a "speculative cascade" the package retired after two production incidents. Reintroducing any of them requires evidence of a live provider emission against the new shape. Reason: false positives on the rate-limit signal pause the entire animator; the cost of a missed detection is one failed session, the cost of a false detection is hours of guild downtime. Asserted by `'does NOT tag a result-text branch (retired — false-positive on assistant prose summaries)'`, `'does NOT tag a speculative subtype-only shape (retired — never observed)'`, and `'does NOT tag a speculative is_error+error-text shape (retired — never observed)'` in `rate-limit-detection.test.ts`.
- **Generic non-zero exit codes map to `'failed'`, never to `'rate-limited'`.** `resolveTerminalStatus` in `babysitter.ts` at lines ~587–614 returns `'failed'` on any non-zero exit without a structured tag. Citation: the doc-block at lines ~568–585 — "exit-code-based detection was retired because it produced false-positive pauses." Asserted by `'maps a generic non-zero exit code to failed (exit-code branch retired)'` in `rate-limit-detection.test.ts`.
- **Babysitter stdin contract: write config, end stdin, unref the process.** `launchDetached` in `detached.ts` at lines ~401–406 writes the JSON config, calls `proc.stdin!.end()`, then `proc.unref()`. The end-of-stdin is what unblocks `readConfigFromStdin` in `babysitter.ts` at lines ~121–156; the unref detaches the babysitter from the guild process so the guild can exit independently. Reason: the babysitter must survive guild restarts (Citation: `docs/architecture/detached-sessions.md` § Process Topology, "session host" lifetime row).
- **Source-mode `execArgv` forwarding to the spawned `.ts` babysitter.** `launchDetached` at lines ~390–393 of `detached.ts` forwards `process.execArgv` to the child when the babysitter path is `.ts`. Without this, node tries to load the `.ts` file as plain CommonJS and crashes with `MODULE_NOT_FOUND` before the babysitter can call `session-running`. Reason captured in the doc-block at `resolveBabysitterPath` lines ~129–141 of `detached.ts`.
- **Single-row transcript with `INSERT OR REPLACE` shape.** `initTranscriptDb` in `babysitter.ts` at lines ~494–523 prepares one statement that overwrites the prior row by primary key on every write. The shape is what makes concurrent reads in WAL mode see a coherent transcript snapshot at every meaningful boundary. Citation: `docs/architecture/detached-sessions.md` § Transcript availability ("update cadence must make 'real time' meaningful: at minimum, on every meaningful unit of anima output"); asserted by the `'writes and overwrites transcript entries'` and `'content is readable by an external process'` tests in `babysitter.test.ts`.
- **DLQ delivery is at-least-once with idempotent terminal writes.** `reportRunning` and `reportResult` in `babysitter.ts` at lines ~544–564 and ~631–674 fall through to `writeToDlq` only on retry exhaustion; the guild's DLQ drain is expected to replay these payloads on the next start, and terminal-state immutability makes the duplicates harmless. Citation: `docs/architecture/detached-sessions.md` § Lifecycle report delivery guarantees → "Duplicate delivery must be tolerated".
- **Babysitter PID equals PGID because of `detached: true`.** The cancel handle reported at lines ~822–823 of `runBabysitter` (`{ kind: 'local-pgid' as const, pgid: process.pid }`) and the fallback at lines ~471–474 of `launchDetached` both rely on the babysitter process's own PID being its process-group leader. `detached: true` on the spawn at lines ~394–399 of `detached.ts` is what makes that true (it triggers `setsid()` under the hood). Reason: documented in the README "Lifecycle" section, step 6.
- **SSE-then-POST race is closed by the transport promise-gate.** `createProxyMcpHttpServer` at lines ~348–356 of `babysitter.ts` resolves a `transportReady` promise the `POST /message` handler awaits at lines ~407–411, eliminating the race where the MCP client posts before the SSE GET handshake completes. Citation: the doc-block at lines ~345–353 of `babysitter.ts`. Asserted by `'MCP client can connect and list tools immediately after SSE connection'` in `babysitter.test.ts`.
- **Per-session log redirect prevents EPIPE on guild restart.** `redirectStderrToFile` in `babysitter.ts` at lines ~690–721 replaces `process.stderr.write` with an fs-backed implementation against an owned fd opened in append mode. Without this, an inherited stderr fd from the guild becomes invalid when the guild restarts, and the next `process.stderr.write` crashes with EPIPE. Citation: README § Session Logs ("This eliminates EPIPE crashes when the guild restarts (which would invalidate an inherited stderr fd)").
- **Stderr forwarding from claude is informational only — no detection.** The handler at lines ~816–820 of `runBabysitter` writes claude's stderr bytes to the redirected log and into a rolling tail buffer, but never pattern-matches them. Reason: stderr-pattern detection was retired alongside the speculative subtype/is_error branches because it false-paused the guild on assistant prose summaries. Citation: the comment block at lines ~806–815 of `babysitter.ts` and the `'attaches terminationDiagnostic on failed status (non-zero exit, no tag)'` test in `babysitter.test.ts` (which asserts the tail surfaces only as a passive diagnostic on `'failed'`).

## Cost-density comparator

The comparator orientation: `claude-code` at approximately $0.019/LOC against `ratchet` at approximately $0.006/LOC and `clockworks` at approximately $0.005/LOC, with `animator` as the parallel hotspot at approximately $0.018/LOC. The two cheap-package floors are useful precisely because they are *not* trivial — `ratchet` is a writ-store apparatus with a status state machine and a tree query (~818 source LOC in `ratchet.ts` alone), and `clockworks` carries a dispatcher, a scheduler, a relay registry, and a daemon (~553 source LOC in `dispatcher.ts` and more elsewhere). They are the same order of magnitude in surface size as `claude-code`, so the per-LOC gap is not explained by package smallness.

What `claude-code` carries that `ratchet` and `clockworks` do not:

- **Multiple distinct concerns co-resident in one orchestrator.** `runBabysitter` fuses transcript IO, MCP server lifecycle, child-process supervision, signal handling, lifecycle reporting, and cleanup. The closest comparator in the cheap packages is `runDispatchSweep` in `clockworks/dispatcher.ts` at lines ~74 onwards, which fuses event scanning, validator invocation, relay lookup, and dispatch-row writing — but every one of those concerns is in-process and synchronous against the data store. Nothing in `clockworks` spawns a child process.
- **Subprocess plumbing.** The claude-code package owns a `child_process.spawn` call with `detached: true`, a stdin pipe, a stdout NDJSON parser, a stderr forwarder with rolling-tail capture, and an `on('close')` exit handler — all five interleaved inside `runBabysitter`. Neither ratchet nor clockworks shell out at all in their hot paths.
- **HTTP plumbing on both sides of a boundary.** `babysitter.ts` runs an HTTP server (the MCP/SSE proxy at lines ~363–431) and an HTTP client (the bespoke `callGuildHttpApi` retry helper) in the same file. The cheap packages talk to in-process `Book` handles via `@shardworks/stacks-apparatus`; their outbound coupling counts (ratchet: 37 outbound; clockworks: 81 outbound) reflect that they coordinate with the substrate, not with foreign HTTP endpoints.
- **Signal handling.** The `SIGTERM` listener installed at lines ~852–869 of `runBabysitter` and the `process.kill(-pgid, ...)` cancel path in `provider.cancel` at lines ~123–132 of `index.ts` are POSIX-edge concerns absent from both comparators.
- **Tombstoned commentary tracking past production incidents.** Four distinct tombstones (rate-limit cascade, exit-code retirement, stderr-pattern retirement, SSE race fix). Ratchet and clockworks carry forward-looking comments — design-decision references like `Commission decisions honored: D1, D2, D8–D14, D17–D26.` at lines ~30 of `dispatcher.ts` — but no comparable history of retired branches.
- **Test:source ratio approaching 2×.** ~1.9× in claude-code; closer to 1:1 in ratchet (5 test files vs. one source file `ratchet.ts` plus a small `tools/` directory) and split into many small test/source pairs in clockworks. The gap reflects what claude-code tests *have* to test — async I/O against a child, a server, a database, and a remote HTTP API, all of which need both happy-path and failure-path coverage in mock harnesses.

In short: the cheap packages get to be cheap because they are pure-Node, in-process, and synchronous against a typed substrate. Claude-code is none of those, and the per-LOC gap is paying for that delta.

## Cross-pattern observation against the parallel animator audit

The intent of this section is observational, not assertive. A parallel audit of `@shardworks/animator-apparatus` is in flight; its findings are not yet available. Until that audit lands, the patterns called out here are claims about claude-code's own source, flagged as candidates for shared substrate-level findings if the animator audit confirms the same shapes. No claim is made about animator's complexity here.

Patterns observed in claude-code's source that are candidates for substrate-level findings:

- **Single orchestrator function with deep `try / catch / finally` fusing many concerns.** `runBabysitter` at lines ~738–977 of `babysitter.ts` is the claude-code instance. The animator's `animator.ts` at ~1,003 LOC is the natural cross-comparison target; if the animator audit also identifies a single orchestrator function fusing many responsibilities under a shared error-cleanup envelope, the pattern is a candidate for a substrate-level finding ("orchestrator hotspots") rather than a claude-code-specific one. **This is a candidate, pending animator-audit confirmation — not an assertion.**
- **Tombstoned commentary tracking past production incidents.** Claude-code carries four (rate-limit cascade, exit-code retirement, stderr-pattern retirement, SSE race fix). If the animator audit observes a comparable tombstone pattern around its rate-limit back-off machine at `rate-limit-backoff.ts` (which by file existence alone suggests a state machine with non-trivial history), the pattern is a candidate for a substrate-level finding ("tombstone density as cost driver"). **This is a candidate, pending animator-audit confirmation — not an assertion.**
- **High test:source ratio because most surface is asynchronous I/O.** Claude-code is ~1.9×. If the animator audit observes a comparable ratio against its session-emission, broadcaster, and provider-supervision surface, the pattern is a candidate for a substrate-level finding ("async-I/O surface inflates test mass"). **This is a candidate, pending animator-audit confirmation — not an assertion.**

A planner reading this audit alongside the animator audit should treat agreement on any of these patterns as a substrate-level finding to write up separately — and disagreement as evidence that the pattern is local to one package and should be addressed there alone.




