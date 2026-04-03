# The Rigging System

The rigging system is the guild's execution pipeline — the apparatus that convert a ready writ into completed work. When the Clerk signals that an obligation is ready, the rigging system takes over: assembling the rig, running its engines, and reporting back when the work is done.

The rigging system is not a single apparatus. It is four apparatus working in concert, each owning a distinct concern, plus two foundational apparatus (Summoner and Clerk) that it depends on.

---

## Apparatus

### Spider

The Spider is the spine of the rigging system. It owns the rig's structural lifecycle from spawn to completion — and nothing else. The Spider does not know how to resolve capabilities, run engines, or manage AI sessions; it delegates all of those to other apparatus. What it does:

- Spawn a rig when the Clerk signals a writ is ready
- Traverse all active rigs, identifying engines whose upstream is complete
- Request capability chains from the Fabricator and graft them onto the rig
- Dispatch ready engines to the Executor
- Strike completed rigs and signal the Clerk

The Spider runs continuously — not bound to any single rig or commission.

### Fabricator

The Fabricator is the guild's capability catalog — the authoritative collection of engine design specifications. Every installed kit contributes its engine designs to the Fabricator at startup. When an engine in a rig declares a need it cannot yet satisfy, the Spider queries the Fabricator:

```
fabricator.resolve(need, installedKits) → EngineChain
```

The Fabricator returns the chain of engine designs that satisfies the need; the Spider grafts that chain onto the rig. The Fabricator does not touch the rig — it is a pure query service.

The Fabricator is also consulted directly by planning animas (Sages) when decomposing a commission: before planning work, a Sage can introspect what the guild is actually capable of building.

### Executor

The Executor runs engine instances. It is the substrate abstraction layer — the Spider calls `executor.run(engine, inputs)` for any ready engine, without knowing or caring whether the engine runs locally, in a Docker container, on a remote VM, or otherwise.

The Executor handles two engine kinds:

- **Clockwork engines** — deterministic, no AI. The Executor runs the engine code directly against its configured substrate.
- **Quick engines** — AI-backed. The Executor calls the Manifester to compose the anima's session context, then the Summoner to launch and manage the AI session. The yields are the session's output.

From the Spider's perspective, both kinds look identical: givens in, yields out.

### Manifester *(dependency)*

The Manifester is a foundational apparatus, not rig-specific, but the Executor depends on it for quick engine execution. Given an anima identity and writ context, the Manifester assembles the complete session context: curriculum, temperament, charter, tool instructions. It is a deterministic composition step — no AI involved. The Executor calls the Manifester before calling the Summoner.

### Summoner *(dependency)*

The Summoner is a foundational apparatus used by more than the rigging system — the Clockworks Summon Relay also calls it directly for standing-order-triggered dispatches. Within the rigging system, the Executor calls the Summoner to launch AI sessions for quick engines. The Summoner manages the session lifecycle and records results in the Daybook.

### Clerk *(dependency)*

The Clerk owns the obligation layer. It signals the Spider when a writ is ready for a rig, and receives completion signals when a rig is struck. The rigging system reports back to the Clerk but does not manage writs itself.

---

## Execution Flow

| # | Step | Apparatus |
|---|------|-----------|
| 1 | Writ becomes ready; spawn initial rig | **Spider** *(triggered by Clerk)* |
| 2 | Engine declares a need; scan installed kits; determine satisfying engine chain | **Fabricator** |
| 3 | Graft resolved engine chain onto rig structure | **Spider** *(using Fabricator output)* |
| 4 | Traverse active rigs; identify engines whose upstream is complete | **Spider** |
| 5 | Execute ready engine — clockwork or quick, any substrate | **Executor** *(routes to substrate or Manifester → Summoner)* |
| 6 | Record engine yields; propagate completion state to downstream engines | **Executor** *(yields)* → **Spider** *(state propagation)* |
| 7 | Detect rig fully complete; signal Clerk; strike rig | **Spider** → **Clerk** |

Steps 2–3 repeat as needed throughout a rig's life — engines declare needs at runtime, and the rig grows as it runs. Steps 4–6 also repeat in a continuous traversal loop. Steps 1 and 7 are the lifecycle bookends.

---

## Design Rationale

### Why Fabricator is separate from Spider

The natural first instinct is to put capability resolution inside the Spider — it's the Spider that needs the answer, after all. The Fabricator earns its independence from two directions:

1. **The Sage case.** Planning animas need to know what the guild can build before they decompose a commission into writs. If capability resolution is internal to the Spider, the Sage has no clean way to query it. A standalone Fabricator is a shared service both the Spider and the Sage can call.

2. **Separation of concerns.** The Spider's job is motion — advancing what's already planned. Capability reasoning ("what engines can satisfy this need, given the installed kits?") is a different cognitive mode. Keeping them separate keeps both apparatus well-scoped and independently testable.

### Why Executor handles both engine kinds

From the Spider's perspective, clockwork and quick engines are the same shape: givens in, yields out. Unifying execution in the Executor means the Spider has one dispatch call for any engine type, and the distinction between "run some code" and "run an AI session" lives entirely within the Executor. The substrate-switching logic (local vs Docker vs remote VM) and the AI session management logic are both Executor concerns — neither bleeds into the Spider.

### Why Summoner is not rig-specific

The Summoner manages agentic AI sessions wherever they're needed — not just in rigs. The Clockworks Summon Relay dispatches animas in response to standing orders without going through the rigging system at all. Making the Summoner a foundational apparatus (not a Spider dependency) reflects this: the Executor uses the Summoner, but the Summoner doesn't know it's inside a rig.

### Clerk / Spider boundary

The Clerk and the Spider are in contact at two points — writ-ready signals in, completion signals out — but own entirely different domains:

- The **Clerk** tracks obligations: what has been commissioned, what is owed, what state each writ is in.
- The **Spider** tracks execution: what rigs are active, what engines are running, what has been completed.

Writs can exist without rigs (awaiting planning or dependencies). Rigs always trace back to a writ. The boundary keeps the obligation record clean from execution machinery.

---

## Dependencies

```
             Clerk
               │ (writ:ready / rig:complete)
               ▼
            Spider ──────────────── Fabricator
               │
               ▼
            Executor
           /        \
    (clockwork)   (quick)
        │              │
    substrate      Manifester
   (local/          │
  docker/vm)      Summoner
                    │
                  Stacks (Daybook)
```

The Spider is the only rigging apparatus that touches the Clerk. The Executor is the only rigging apparatus that touches the Summoner. The Fabricator is a stateless query service with no downstream dependencies of its own — it reads from the kit registry provided by installed plugins at startup.
