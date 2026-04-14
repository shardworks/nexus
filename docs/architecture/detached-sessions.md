# Detached Sessions

Detached sessions decouple anima sessions from the guild process so a session's lifetime is not bound to the guild's lifetime. This enables the guild to be restarted for upgrades, configuration changes, or recovery without interrupting in-flight sessions.

## Goals

- **Guild restart is routine.** Restarting the guild must not interrupt running sessions, lose transcript data, or cause any session to enter an unrecoverable state.
- **Full capability across restarts.** A session's tools remain callable before, during, and after a guild restart. No degraded mode.
- **Observable, reconcilable state.** At any moment, the guild can answer "what is the true current state of session X?" without requiring the component that spawned the session to be running.
- **Extensible host model.** The protocol must accommodate future session hosts that run in containers, remote machines, or other process environments without protocol changes.

## Non-Goals

- Cross-machine session migration. A session lives on one host for its entire lifetime.
- Surviving host-machine reboots. If the machine dies, the session dies.
- Concurrent writers to the same session record. Exactly one component writes a session's state at a time.

## Terminology

- **Guild** — the long-lived process that owns the authoritative data store, exposes tool APIs, and hosts patron-facing interfaces. May be restarted at any time.
- **Session Host** — a process that runs for the lifetime of one session. Owns the anima process, hosts the tool proxy for that session, and reports session lifecycle to the guild.
- **Anima Process** — the interactive AI process (child of the session host) that consumes tools and produces transcript output.
- **Session** — a single end-to-end run of an anima process, from launch to terminal state.
- **Session Record** — the authoritative state of a session, stored in the guild's data store. Has a well-defined lifecycle state machine.

## Process Topology

```
┌─────────────────────────────────────────────────────┐
│ GUILD                            (restartable)      │
│                                                     │
│ • Authoritative data store                          │
│ • Tool HTTP API (tool calls from session hosts)     │
│ • Lifecycle API (session state transitions)         │
│ • Reconciler (periodic + startup)                   │
└───────────────┬─────────────────────────────────────┘
                ▲
                │  HTTP (tool calls + lifecycle reports)
                │
┌───────────────┴─────────────────────────────────────┐
│ SESSION HOST                 (one per session)      │
│                                                     │
│ • Tool proxy (anima-facing)                         │
│ • Lifecycle reporter                                │
│ • Transcript writer (durable, real-time)            │
│ • Supervises the anima process                      │
└───────────────┬─────────────────────────────────────┘
                │ supervises
                ▼
┌─────────────────────────────────────────────────────┐
│ ANIMA PROCESS                (one per session)      │
│ • Configured to reach tools via the Session Host    │
└─────────────────────────────────────────────────────┘
```

**Lifetimes and restart impact:**

| Process | Started by | Lifetime | Guild restart impact |
|---|---|---|---|
| Guild | Operator | Hours–days | N/A |
| Session Host | Guild | One session | None — unaffected by guild restart |
| Anima Process | Session Host | One session | None — unaffected by guild restart |

The session host is the critical mediator: it absorbs guild unavailability on behalf of the anima process, and it is the only component that can observe the anima process exiting.

## Session Lifecycle State Machine

Every session has a well-defined state. There are five states, three of which are terminal.

```
           ┌──────────┐
           │ pending  │  host is starting; not yet ready to serve tools
           └────┬─────┘
                │  host has spawned the anima process and is ready
                ▼
           ┌──────────┐
           │ running  │  anima process is alive
           └────┬─────┘
                │
      ┌─────────┼─────────┬──────────────┐
      ▼         ▼         ▼              ▼
┌──────────┐┌────────┐┌──────────┐  ┌──────────┐
│completed ││ failed ││cancelled │  │(reconciled
└──────────┘└────────┘└──────────┘   failure)
    (terminal states)               └──────────┘
```

### State definitions

| State | Meaning | Who writes it |
|---|---|---|
| `pending` | Session host has been asked to start this session but has not yet confirmed readiness. | Guild (at launch time) |
| `running` | Session host is alive, the anima process is alive, and the tool proxy is accepting calls. | Session host |
| `completed` | The anima process exited successfully (exit code 0). | Session host |
| `failed` | The anima process exited unsuccessfully, or the session host encountered a fatal error, or the reconciler determined the session is no longer alive. | Session host or reconciler |
| `cancelled` | The session was explicitly cancelled by the guild before reaching a natural terminal state. | Guild (cancel path) or session host (if it observes the cancel signal before exit) |

### Transition rules

1. **Only one writer at a time, and writers are assigned by state.** A session in `pending` is only written by the guild. A session in `running` is only written by the session host or the reconciler. Terminal states are never written again.

2. **No skipping `pending`.** The guild must record `pending` *before* the session host is spawned. This is the authorization anchor: the tool API consults the session record to decide whether a given session host is allowed to make tool calls, and that record must exist when the first tool call arrives.

3. **`pending` → `running` is host-initiated.** The session host transitions the record to `running` as its first action after it is ready to serve tool calls. This transition carries the information the guild needs to reason about session health (see "Reconciliation").

4. **Reconciler may transition `pending` or `running` directly to `failed`.** If the reconciler determines the session host is dead, it writes `failed` with an error describing the reconciliation outcome.

5. **Terminal states are final.** Once written, a terminal state cannot be changed by any writer.

## Contracts

### Guild → Session Host (launch)

The guild delivers session configuration to the host at spawn time. The configuration includes:

- **Session identity** — a unique identifier assigned by the guild.
- **Guild endpoint** — how the host reaches the guild's HTTP APIs (tool calls, lifecycle reports).
- **Anima configuration** — everything the host needs to launch the anima process (command, arguments, environment, working directory, initial prompt, system prompt).
- **Tool manifest** — the set of tools this session is authorized to call, with metadata sufficient to advertise them to the anima process.
- **Session metadata** — arbitrary key/value pairs to be attached to the session record.

The delivery mechanism is not specified, but must:
- Be secure against observation by unrelated processes on the same host.
- Fit within the capacity constraints of the host platform (e.g., avoid command-line arg length limits).
- Be delivered in one atomic unit, not piecemeal.

### Session Host → Guild (lifecycle reports)

The session host reports two lifecycle transitions via the guild's HTTP API:

**Ready report.** Sent when the host has spawned the anima process and is ready to serve tool calls. Transitions the session record from `pending` to `running`. Must carry:

- The session identifier.
- A cancellation handle the guild can use to later terminate the session host (see "Cancellation"). On a local-process host this is a process group identifier; on a container host it is a container identifier. The guild treats this as an opaque token passed back to the host's platform.
- Any session metadata the host resolved during startup.

The ready report also implicitly refreshes `last_activity_at` (see "Reconciliation").

**Heartbeat.** Sent periodically while the session is in `pending` or `running`. Carries only the session identifier. Refreshes `last_activity_at`. See "Reconciliation" for semantics.

**Terminal report.** Sent when the anima process has exited or the host has encountered a fatal error. Transitions the session record from `running` to `completed`, `failed`, or `cancelled`. Must carry:

- The session identifier.
- The terminal state.
- The anima process's exit code, signal (if any), and any error string.
- Cost and token usage, if available.
- The session's final output, if available.
- A reference to the full transcript (or the transcript itself, if the durable store requires it).

### Session Host → Guild (tool calls)

All tool calls from the anima process flow through the session host, which forwards them to the guild's Tool HTTP API. The forwarding layer must:

- **Authenticate** the call as belonging to this session (session identifier in request headers).
- **Retry on guild unavailability** with bounded exponential backoff. The guild *will* be unavailable during restarts, and the anima process must see this as latency, not failure, whenever possible.
- **Surface a clear error** to the anima process if the retry budget is exhausted. A hung tool call is worse than a failed one.

Tool call retry is distinct from lifecycle report retry (see below) because the anima process is a synchronous caller waiting on the result.

### Lifecycle report delivery guarantees

Lifecycle reports must be **at-least-once delivered**. If the guild is unavailable when a report is ready to be sent:

1. The host retries with bounded exponential backoff.
2. If the retry budget is exhausted, the host writes the report to a durable dead-letter store local to the host machine.
3. On guild startup (and periodically thereafter), the guild drains the dead-letter store and processes each entry as if it had arrived via HTTP.

Duplicate delivery must be tolerated: the terminal-state guarantee (no rewrites) makes duplicates idempotent.

### Transcript availability

The transcript of a running session must be **readable in real time by other guild-local consumers** — the dashboard, other agents, quality-evaluation tooling — without routing through the session host.

This implies:

- The session host writes transcript updates to a **shared durable store** on the host machine, with write visibility to concurrent readers. The store must support concurrent reads while writes are in progress.
- The update cadence must make "real time" meaningful: at minimum, on every meaningful unit of anima output (per-message or per-content-block, not per-session).
- Readers discover the store through a guild-level contract (a known location, a known schema), not through the session host.

The transcript is the only element of session state that is written outside the HTTP lifecycle report channel. This is intentional: it is high-frequency, append-mostly, and must remain available when the guild is down.

## Reconciliation

Because the session host is detached, the guild cannot directly observe it exiting. The liveness model is **heartbeat-based**: the session host periodically asserts "I am alive," the guild records when it last heard, and a reconciler transitions silent sessions to `failed`.

### Heartbeats

While a session is in `pending` or `running`, the session host sends an **explicit heartbeat** to the guild on a fixed interval (on the order of 30–60 seconds). The heartbeat is a small HTTP call that updates the session record's `last_activity_at` timestamp.

- Heartbeats are **at-least-once delivered** with bounded retry. If the guild is unavailable, the host keeps trying; if the retry budget is exhausted, the heartbeat is dropped (not DLQ'd — a stale heartbeat has no value on replay).
- Heartbeats are **independent of tool calls**. Tool-call authorization is a pure read and does not mutate `last_activity_at`. Sessions that are tool-heavy and sessions that are thinking get the same liveness treatment.
- The timestamp on the heartbeat is the **guild's wall-clock time at the moment of receipt**, not a host-supplied timestamp. This avoids clock-skew problems between host and guild.
- Ready reports and terminal reports implicitly refresh `last_activity_at` too; a host that just reported its state does not need a separate heartbeat in the same instant.

### Guild self-heartbeat

The guild cannot penalize a session for silence during a window when the guild itself was not listening. To give the reconciler an honest view of host liveness, the guild maintains its own heartbeat: a `guild_alive_at` timestamp in its data store, updated on a timer (same cadence as session heartbeats, or faster).

When the guild starts up, it reads the previous `guild_alive_at` from the data store. The gap between that timestamp and `now` is the **downtime window** — the duration for which the guild was not receiving any heartbeats. This window is added as a credit to every non-terminal session's silence budget during the next reconciliation pass.

If `guild_alive_at` is missing (fresh install), the downtime window is treated as zero.

### The reconciler

The reconciler scans session records in non-terminal states (`pending` and `running`) and applies a single rule:

> **If `now − last_activity_at − downtime_credit > staleness_threshold`, transition the session to `failed`.**

Where:
- `now` is the current guild wall-clock time.
- `last_activity_at` is the most recent heartbeat, ready report, or terminal report for that session.
- `downtime_credit` is the guild's most-recent detected downtime window, applied to sessions that existed before the downtime.
- `staleness_threshold` is a fixed value comfortably larger than the heartbeat interval (e.g. 3–5 × heartbeat interval), chosen to tolerate one or two missed heartbeats without declaring the session dead.

The reconciler runs:

1. **At guild startup**, after computing the downtime window. Resolves any sessions that went silent during the outage.
2. **Periodically during guild uptime**, at a cadence comparable to the heartbeat interval. Catches sessions that went silent while the guild was up.

A session marked `failed` by the reconciler carries an error describing the reconciliation outcome (for example, "No heartbeat received for 240s — session host presumed dead").

### What reconciliation does *not* do

- **It does not probe the host's platform directly.** There is no PID check, container runtime query, or network ping. The host's silence is the only signal. This is deliberate: it makes the protocol uniform across local-process hosts, container hosts, and any future host type. A host that cannot heartbeat for 3× the interval is, from the guild's perspective, indistinguishable from a dead host — and that equivalence is the whole point.
- **It does not check the anima process directly.** The session host is the supervisor; if the host is heartbeating, the anima process is its problem.
- **It does not recover the session.** Reconciliation is a terminal-state transition; it does not attempt to restart anything.
- **It does not replace lifecycle reports.** A session host that exits cleanly reports its own terminal state. Reconciliation handles the case where the host cannot report at all.

## Cancellation

Cancellation is requested by the guild and must reliably terminate the anima process.

### Cancellation protocol

1. The guild marks the session's cancellation intent (in memory or persistently — an implementation choice) and uses the **cancellation handle** (carried in the session record from the ready report) to terminate the session host via its platform's native mechanism.
2. The session host, on receipt of the signal, propagates termination to the anima process and reports the terminal state as `cancelled`.
3. If the session host has already died when cancellation is requested, the reconciler catches it on its next scan; the session is marked `failed` rather than `cancelled`, which accurately reflects what happened.

### Cancellation handles across host types

The cancellation handle is an opaque token from the guild's perspective, meaningful only to the host's platform:

- **Local-process host:** the handle is the session host's **process group identifier**. The guild terminates via a signal to the process group (not the process), which guarantees that both the session host *and* the anima process receive the signal even if the host's signal handling is broken. Signalling only the host leaves the anima process orphaned if the host's handler fails to propagate.
- **Container host:** the handle is a container identifier. The guild terminates via the container runtime's stop/kill API.
- **Remote host:** the handle is whatever the remote platform exposes — a job ID, a session token, a URL.

The ready report is where this handle enters the session record. The cancellation path is the only consumer.

## Authorization

The guild's tool HTTP API must distinguish tool calls originating from one session from those originating from another, and authorize each call against that session's tool manifest.

### Authorization anchor

The session record is the authorization anchor. When the guild receives a tool call carrying a session identifier, it looks up the session record, reads the tool manifest, and authorizes (or rejects) the call against that manifest.

**Corollary: the session record must exist before the first tool call arrives.** This is why `pending` exists and why it is written by the guild synchronously before the session host is spawned.

### Tool manifest

The tool manifest is carried both in the session record (as the authoritative authorization set) and in the configuration delivered to the session host (so it can advertise tools to the anima process). These two must be **generated from the same source** at launch time — the guild computes the manifest once and uses it in both places.

The manifest must include the infrastructure tools the session host needs to report its own lifecycle. These are added by the guild, not by the caller who initiated the session.

## Failure Modes

The spec must handle each of these cleanly.

| Failure | Protocol response |
|---|---|
| Guild restarts during session | Session host continues; tool calls retry with backoff; lifecycle reports DLQ'd if not deliverable; heartbeats are dropped during the outage; on startup the guild computes downtime credit from `guild_alive_at` so sessions are not unfairly reconciled; guild drains DLQ. |
| Session host crashes before ready report | Session record stays in `pending`; heartbeats stop; reconciler transitions to `failed` once staleness threshold elapses. |
| Session host crashes after ready report, before anima exit | Session record is in `running`; heartbeats stop; reconciler transitions to `failed` once staleness threshold elapses. |
| Anima process crashes; session host intact | Session host observes exit, sends terminal report (possibly `failed` depending on exit code). |
| Session host cannot deliver terminal report | Host writes to DLQ; guild drains on next startup. |
| Session host cannot start (bad config, missing dependency) | Host exits non-zero without ever heartbeating; reconciler catches the silent `pending` record once the staleness threshold elapses. |
| Cancellation requested while session host is dead | Reconciler catches on next scan; record transitions to `failed`. Cancel request is a no-op. |
| Two tool calls arrive with the same session ID from different hosts | Not possible under the protocol: one session ID is owned by one host for the session's lifetime. |
| Duplicate lifecycle report delivery | Terminal states are immutable, so duplicates are idempotent. Ready reports are idempotent against `running` (re-writing the same state is a no-op). |

## Extension: Container-Hosted Sessions

The protocol is designed to accommodate session hosts that run in containers:

- The session host remains a distinct process; it simply runs inside a container.
- The guild-to-host launch interface uses a container runtime instead of a local process spawn.
- Tool call and lifecycle report HTTP traffic flows over the container network to the guild.
- Transcript writes use a durable store visible to the guild — either a mounted volume, a network-attached store, or a host-side proxy.
- Reconciliation is unchanged: a container-hosted session host heartbeats over the same HTTP interface as a local host. If the container dies, heartbeats stop, and the reconciler transitions the session to `failed` on the same rule used for local hosts.
- Cancellation uses the container runtime's termination API (e.g., `docker kill`) with the container identifier carried in the ready report, instead of a process group signal.

The heartbeat-based liveness model is deliberately platform-agnostic: a silent host is a dead host, regardless of whether it was a Unix process or a container. No protocol element changes across host types except the cancellation mechanism.
