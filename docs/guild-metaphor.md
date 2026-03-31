# The Guild Metaphor

> **Tone guidance for authors:** This document describes the guild as a *guild* — from the perspective of its members, its patron, and its traditions. Write as though explaining how a craftsman's guild operates, not how a software system is architected. Technical details (database schemas, API contracts, status enums) belong in the reference docs under `docs/reference/`. If you find yourself writing implementation specifics, you're in the wrong register.
>
> **On pluralization:** Where terms derive from Latin or other classical roots, this document uses English plurals throughout — *animas* not *animae*, *codexes* not *codices*. Accessibility over pedantry.

The guild metaphor is the organizing model for Nexus Mk 2.1. It maps the structure and operations of a craftsman's guild onto a multi-agent AI system — not as decoration, but as a conceptual framework that makes the system's architecture legible to both humans and agents.

## Core Entities

### Guild

The whole system. The guild is the top-level container for all agents, resources, and activity. There is one guild.

### Patron

The human. The patron commissions work from the guild and consumes what it delivers. The patron interacts through the guild's interfaces — CLI, status reports, delivered works — and judges those works by using them. The patron may assign codexes as targets for commissions ("build the next thing in this codex"), but does not direct how the guild organizes its labor.

### Anima

The fundamental unit of identity in the system. An anima is an ephemeral presence (akin to a spirit) animated by an AI agent. They have a persistent identity that is manifested when called upon, composed from the anima's own nature (training, temperament, etc.) and the guild's institutional records each time they are needed. The word comes from Latin, meaning "animating principle" — the thing that makes something alive rather than mechanical. Between manifestations, an anima exists in the register as identity and history; the guild maintains their continuity, not the individual.

This is the core distinction in the system: **animas are animated** (backed by AI, capable of judgment, spirited), **engines are inanimate** (no AI, purely mechanical).

#### States

Every anima exists in one of three states:

| State | Meaning |
|-------|---------|
| **Aspirant** | Being trained, not yet dispatchable. The anima exists in the register but cannot be assigned work. |
| **Active** | On the roster, available for dispatch or currently working. This is a working anima. |
| **Retired** | No longer active. The anima's record persists in the register forever, but they are no longer dispatchable. |

#### Standing vs. Commissioned

The meaningful distinction among active animas is not named vs. unnamed (all animas are named) but **standing** vs. **commissioned**:

- **Standing** — available indefinitely, called on by name. A standing anima persists on the roster across commissions. They are always there, always available.
- **Commissioned** — instantiated for a specific commission. A commissioned anima's roster membership lasts only as long as the commission it was created for. A fresh anima is created (or an existing one is commissioned) for each commission, and their tenure ends when the commission completes.

Concretely, standing and commissioned animas are the same thing: entries in the register with names, instructions, and history. The difference is tenure, not nature.

### Register

The authoritative record of every anima that has ever existed — one of the guild's core record Books. The register is the guild's institutional memory — it contains aspirants in training, active members, and retired animas. Each register entry records the anima's name, composition, and full state history. See [The Books](#the-books) for how the Register relates to the Ledger and Daybook.

### Roster

The active subset of the register. The roster is a filtered view, not a separate store — it shows all animas currently in `active` state. The roster is the system's source of truth for "who can do what right now," including each anima's role and standing/commissioned status.

## Roles

A function in the guild, filled by zero or more members. Roles define *what kind of work* a member performs and *when they are invoked*. Roles are not a fixed set — a guild defines its own roles to match how it organizes its work. New roles can emerge as the guild evolves; old ones can be retired.

A guild might have planners and builders, or architects and developers, or a single generalist role that does everything. The organizational structure is the guild's choice. The guild-starter-kit ships with a set of roles as a starting point:

| Role | Function |
|------|----------|
| **Artificer** | Executes tasks. Receives planned work and builds the thing. |
| **Sage** | Plans work. Decomposes commissions, refines vague instructions into concrete writs with acceptance criteria. |
| **Master Sage** | Senior sage. Reviews incoming commissions, determines scope, and may convene a Council of Sages for complex cases. |

These are one guild's organizational model — not requirements. Other roles (Guildmaster, Coinmaster, Oracle, Instructor, and others) are anticipated but not yet defined.

## Work

### Commission

The patron's act of requesting work. The patron commissions work; the guild determines how to fulfill it. A commission might call for something large — "build me a notification system" — or something small — "fix this bug." The guild receives the commission and decides how the labor should be organized.

A commission describes **origin** — it is the patron's request, the act that sets the guild to work. It does not imply a particular size or shape of labor. That's for the guild to determine.

### The Shape of Labor

When the guild receives a commission, it issues a **writ** — the guild's formal record of what has been asked for. A writ captures the obligation: what must be done, how it stands, and how it relates to other work. Writs persist in the guild's books regardless of how the work is ultimately carried out.

Writs are how the guild gives shape to labor at every scale. A writ might describe a broad undertaking or a narrow task. The guild chooses its own vocabulary for the kinds of writs it issues — *feature*, *task*, *step*, *bug*, or whatever fits the craft. The vocabulary is the guild's; the framework imposes no fixed hierarchy.

When a writ is concrete enough to act on, it spawns a **rig** to carry the obligation through. The writ names what is owed; the rig does the work. A writ may exist without a rig — still being weighed or planned — but every active rig traces back to a writ.

Two kinds of writs are built into the guild's operations:

- **Mandate** — the root writ created when a commission arrives. The mandate *is* the commission's obligation expressed as trackable labor. Fulfilling the mandate fulfills the commission.
- **Summon** — a bookkeeping writ the guild synthesizes when an anima is called to work outside the normal commission pipeline. Every session of work has a writ; the summon ensures this is true even for ad hoc calls.

See [Writs](architecture/writs.md) for the full technical design — lifecycle, completion rollup, prompt templates, and status transitions.

### Rig

The working structure assembled to fulfill a commission. A rig is seeded at commission time — a minimal starting point representing what must be achieved. From there the Walker builds it out: adding engines and arranging them in sequence, each depending on the work of those before it. Some engines run autonomously; others are animated by an anima. A rig is never delivered to the patron; it is the scaffolding that enables delivery. When the work is done, the obligation is fulfilled and the rig is struck.

Rigs are dynamic. Any engine whose work is not yet complete may be replaced with a chain of engines, allowing the rig to grow and adapt as the work unfolds. Engines that have completed their work are fixed — their yield is final.

### Works

The guild's output — what is delivered to the patron. Works are intentionally vague: running software, usable tools, deployed services, solved problems. The patron judges works by using them. What counts as a work is defined by what the patron can touch, run, or interact with.

Works vary in kind. Some accumulate across many commissions; some are produced once and delivered; some are the incidental yield of a single engine run. The guild's vocabulary for its works:

#### Binding *(canonical)*

A body of inscriptions that compels a system to behave. The guild's primary and most complex work product. Bindings live in codexes, accumulate across successive commissions, and govern the behavior of running systems.

| Term | Definition |
|------|------------|
| **Binding** | The complete body of inscriptions in a codex governing a system's behavior |
| **Sealed binding** | The authoritative, operative binding — what currently governs the system |
| **Draft binding** | A binding in progress — being shaped by an anima or engine, not yet authoritative |
| **Inscription** | A discrete addition to a draft binding. The anima inscribes; the draft grows |
| **Sealing** | The act of incorporating a draft binding into the sealed binding |
| **Abandoning** | Setting a draft binding aside without sealing. The work persists in the Daybook but never becomes authoritative |
| **Edition** | The sealed binding at a specific significant moment — marked, versioned, and distributed |

A commission arrives; the Walker opens a draft binding from the codex; an anima staffs the engine — inscribing changes, building up the draft. When the anima signals completion, the sealing engine incorporates the draft into the sealed binding. The codex grows. If the draft contradicts the sealed binding, the sealing engine seizes; the draft must be reconciled before sealing can proceed.

A codex may have multiple draft bindings open simultaneously. Each is independent. Each must be sealed or abandoned on its own terms.

> *A note on register:* The binding vocabulary — sealed binding, draft binding, inscription, sealing, edition — keeps the system's language consistent with the broader guild metaphor rather than replacing git terminology with more evocative equivalents. These terms are unlikely to appear in introductory presentations; a speaker would say "the AI opens a branch, does its work, and merges back" and the audience would follow without friction. What the binding vocabulary does is prevent register breaks for those who have internalized the guild metaphor. Use plain git terms (branch, commit, merge) in examples where precision matters; reserve the binding vocabulary for reference documentation and internal system language.

#### Document

A written work — analysis, research, specification, report, technical writeup. Produced by an anima in an animated engine, reviewed, and delivered. Documents have a draft and a sealed state but do not accumulate across commissions and do not live in codexes.

| Term | Definition |
|------|------------|
| **Draft document** | A document in progress — being inscribed by an anima |
| **Sealed document** | A document approved and delivered to the patron |

#### Model

A trained artifact — an ML model, a fine-tune, an embedding. Produced by a training engine run. Models have iterations during training but do not accumulate inscriptions in the binding sense — each training run produces a discrete artifact.

| Term | Definition |
|------|------------|
| **Draft model** | A model under evaluation — trained, not yet approved for use |
| **Sealed model** | A model approved and released for use |
| **Iteration** | A discrete training run producing a candidate model |

#### Yield

The incidental output of an engine run — statistics, data products, metrics, generated images, communications. Yield is produced, delivered or consumed, and done. No meaningful draft/sealed lifecycle. No accumulation. Yield is not tracked as a work product in the Ledger — it is the output of a specific engine in a specific rig, recorded in the Daybook as part of that engine's completion.

---

| Kind | Draft/sealed | Lives in codex | Accumulates | Tracked in Ledger |
|------|-------------|----------------|-------------|-------------------|
| **Binding** | Full lifecycle | ✓ | ✓ | ✓ |
| **Document** | Draft/sealed | ✗ | ✗ | ✓ |
| **Model** | Draft/sealed | ✗ | ✗ | ✓ |
| **Yield** | None | ✗ | ✗ | ✗ |

Bindings are the guild's primary work product — the most complex, the most persistent, the most consequential. Everything else is simpler.

## Codexes

The canonical record of a body of work — assigned to the guild by the patron or maintained for its own operations. The guild works *toward* a codex across successive commissions, each one inscribing more into it.

Some codexes hold works for the patron — applications, services, deployed systems. Others are purely guild infrastructure, maintained for the guild's own operations.

## Knowledge & Training

### Charter

The guild's institutional body of policy, procedure, and operational standards — the governing document all members follow. Maintained by leadership. The charter defines how the guild operates: procedures, standards, policies, and environmental facts. Every anima receives the charter when manifested for a session.

### Curriculum

A named, versioned, immutable body of training content. A curriculum defines what an anima knows and how it approaches work — skills, craft knowledge, methodology. Curricula are never edited after creation; new thinking produces a new version. The Thomson curriculum v2 is a distinct artifact from v1.

### Temperament

A named, versioned, immutable personality template. A temperament governs an anima's disposition, communication style, and character — who they are, as distinct from what they know (curriculum) or what they must do (charter). Same lifecycle as curricula: immutable per version, new thinking produces a new version.

## Infrastructure

### Apparatus

A named, persistent, deterministic system — the guild's operational fabric. Apparatus are always running: they predate any individual commission and outlast any rig. They are not personas; they hold no craft, no spirit, no judgment. Where animas are animated and engines do the work of rigs, apparatus are the guild itself in continuous operation.

The Clockworks, the Walker, and the Surveyor are the guild's core apparatus. The set is not fixed — a guild may install additional apparatus as its needs grow.

### Guildhall

The guild's institutional center — a home, not a codex. The guildhall is where the charter hangs on the wall, where the tools are stored, where the register is kept, where training content lives. Work doesn't happen here; this is where the guild's knowledge, configuration, and equipment are maintained. Always present, always accessible.

Distinct from codexes: codexes are where the guild's inscriptions accumulate. The guildhall is the building they come from — the place that tells them who they are and equips them for the job.

### Engine

A machine chartered with the guild to perform a bounded piece of work. Engines are the guild's automated capabilities — deterministic, tireless, purpose-built. An engine declares what it can do; the guild puts it to work.

Engines serve in two contexts:

**In the Clockworks** — named in standing orders and set in motion when events fire. This is how the guild acts on itself: something happens, an engine responds. The summon-engine is the built-in clockwork engine that handles anima session dispatch — when a standing order calls for an anima, it is the summon-engine that resolves the role, binds a writ, and launches the session.

**In a rig** — the unit of work in the execution graph, mounted by the Walker. Two kinds:
- **Autonomous** — deterministic, requiring no creative judgment. The press that stamps, the bellows that blow, the mill that grinds. Runs on the yield of upstream work; produces its own yield when done.
- **Animated** — requires an anima. The engine defines the work and holds the anima's context; the anima brings the judgment the work requires. When the anima seals their work, the engine's yield is complete.

The distinction between anima and engine holds even for animated engines: the anima is the intelligence; the engine is the work context. A craftsman at a machine — the craftsman brings the skill; the machine defines the task.

Kits contribute engine designs; the Walker mounts them as the rig demands. The same design may run in many rigs at once, each working independently.

An engine in a rig moves through three states: *idle* (upstream work not yet complete), *working* (running, yield not yet ready), and *complete* (yield ready, downstream work may proceed). Completed engines are fixed — their yield is final.

Not everything mechanical is an engine. Libraries, ledger-keepers, and other working parts of the guild's infrastructure are just the building — they don't participate in the coordinated work of rigs or the Clockworks. The engine concept is reserved for machines chartered with the guild and put to work through its clockworks or rigs.

### Kit

A bundle of engine designs and anima tools contributed to extend what the guild can build. A kit declares what needs it can meet, what prior work it requires, and what chain of engines it will assemble to meet those needs. The Walker draws from installed kits when extending a rig — a guild's installed kits determine what work it can take on.

Kits are the guild's extension points. A guild without kits can accept commissions but cannot fulfill them. Each installed kit extends the range of work the Walker can set in motion.

### Clockworks

The guild's nervous system — an event-driven layer that connects things that happen to things that should respond. The Clockworks keeps its own records of what it has seen and how it responded — these are its own working memory, not part of the guild's Books. The Clockworks processes events according to the guild's standing orders, turning the guild from a tool the patron operates into a system that operates itself.

### Standing Order

A registered response to an event, defined in `guild.json`. A standing order says: *whenever this event is signaled, do this*. All standing orders invoke clockwork engines via the `run` verb. The `summon` verb is syntactic sugar — it invokes the **summon-engine**, which manifests an anima in the named role and delivers the event as their context. Standing orders may carry additional params (like `maxSessions` for the circuit breaker) that configure the engine's behavior. Standing orders are guild policy — they live in configuration, not in engine code.

### Surveyor

The apparatus that maintains the guild's knowledge of its codexes. When a codex is registered, the Surveyor inspects it — determining what kinds of work are applicable and how each is fulfilled for that specific codex. When a codex changes, the Surveyor updates its records. The guild's ability to seed rigs from commission text depends on the Surveyor's knowledge: without a current survey, the guild cannot reliably turn a patron's words into a working rig.

The Surveyor's records live in the guildhall, not in the codexes themselves — a survey is the guild's understanding of a codex, not part of the codex's own inscriptions.

### Walker

The apparatus that keeps all active rigs in motion. The Walker moves continuously through every active rig — not bound to any single commission, predating and outlasting them all. When an engine is ready to run, the Walker sets it in motion: starting an autonomous engine or summoning an anima for an animated one. When an engine declares a need the rig cannot yet satisfy, the Walker extends the rig — drawing on installed kits to add the engines needed to meet it.

The rig grows as it runs. The Walker is why.

### Tool

A tool an anima actively wields during work. Tools are the guild's toolkit — instruments that animas use to interact with guild systems, query information, record notes, and perform operations. Each tool ships with instructions that are delivered to the anima when manifested for a session, so the anima knows how to use its tools.

Distinct from engines: tools are instruments the anima wields during work; an engine is the work context the anima staffs — or that runs without one. An anima uses a tool to act; an anima staffs an engine to fulfill a commission.

### Relic

An artifact the guild depends on but does not maintain or fully understand. Load-bearing and sacred, not deprecated — a relic is respected for what it carries. Relics are a natural lifecycle stage for tools built fast during periods of rapid growth.

## The Books

The guild keeps its **Books** in the guildhall — the operational records that accumulate as the guild works. The Books record what the guild *has done*; the guildhall's configuration defines what the guild *is*.

### Register

The membership roll. Who exists and what they're made of. The Register records every anima — their name, their composition, their role assignments. It is the guild's institutional memory of its people. Updated when members join or retire; consulted whenever an anima is called to work.

### Ledger

The book of work. What has been commissioned and how labor is organized. The Ledger records commissions, assignments, and writs — the guild's tracked work items. It is the guild's transaction record: what was asked for, who is doing it, and how far along it has come.

### Daybook

The chronicle. What happened, when, and what it cost. The Daybook records sessions and the audit trail — the raw chronological account of guild activity. Nothing reads the Daybook to decide what to do next; it exists so the guild can look back and understand what occurred.

The name comes from bookkeeping: a daybook is the chronological journal of transactions before they are posted to the ledger. The Daybook is the raw record of activity; the Ledger is the structured record of work.

### What the Books are not

The Clockworks keeps its own working memory — what it has seen, what it did in response — but this is the apparatus's internal state, not a book the guild consults. The guild's configuration (roles, standing orders, equipment, codexes) lives in the guildhall, not in the Books.
