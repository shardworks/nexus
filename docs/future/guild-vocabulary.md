# Guild Vocabulary (Staging)

This document is a transitional staging ground for guild vocabulary that has shipped but has not yet graduated into `docs/guild-metaphor.md`. Entries here describe the guild in its own conceptual register; once a term has settled and its neighbors are in place, it is promoted into the canonical metaphor document and removed from this file.

Tone, register, and pluralization policy for this document follow `docs/guild-metaphor.md` — the guild is described as a *guild*, and English plurals are used throughout.

## Infrastructure

### The Lattice

The guild's notification substrate — the apparatus that records and routes the news worth telling the patron.

When something in the guild passes a threshold worth announcing — a commission stalls, a queue drains, a balance runs low — an observer emits a pulse to the Lattice. The Lattice durably records the pulse and then fans it out to every configured delivery surface: a channel into the patron's messaging room, a line in a CLI inbox, or whatever surfaces the guild has installed. The record is the obligation; delivery is best-effort. Once a pulse is inscribed, it cannot be rewritten — a correction is simply another pulse.

The Lattice does not decide *when* something is worth telling — that judgment lives with the observer that emits. Nor does it decide what a notification *looks like* on any given surface — that belongs to the channel. The Lattice arbitrates the middle: it keeps the record and moves the word along.

See `docs/architecture/apparatus/lattice.md`.

#### Pulse

A single notification event — one immutable record on the Lattice, marking one thing worth telling. A pulse names its trigger (what happened), its source (who emitted it), and the subject it concerns. Pulses accumulate in the Lattice's book as the guild's chronological record of things announced, distinct from the Daybook's broader chronicle of everything the guild did.

### The Reckoner

A narrow observer that watches the guild's work and announces when things go wrong or go quiet.

The Reckoner reads the Clerk's books and listens for three specific conditions: a commission that stalls (stuck), a commission that fails, and the moment the guild's work queue drains entirely. When any of these conditions is met, the Reckoner emits a pulse to the Lattice. It does not judge how the news should be delivered; that is the Lattice's work. It does not modify writs, does not reach into rig internals, and does not participate in dispatch — it only observes and announces.

The Reckoner is the first observer to sit atop the Lattice substrate. Others are anticipated — balance alerts, anima completion, vision-keepers — each with its own narrow remit, each speaking through the same substrate.

See `docs/architecture/apparatus/reckoner.md`.

### The Ratchet

The guild's decision-tracking authority — the apparatus that keeps the record of the guild's reasoning.

Where the Clerk's books track what the guild *owes*, the Ratchet's books track what the guild *thinks*. The Ratchet manages clicks: atomic, immutable decision-nodes organized in a tree. Each click captures one question or inquiry; when resolved, it records the conclusion. Open sub-questions become child clicks rather than prose inside a parent, so the tree itself expresses the decomposition of the reasoning. A click's goal is live-editable while the inquiry is still open, and seals the moment the click reaches a terminal state — preserving the audit guarantee without the friction of an immutable goal from the first keystroke.

The Ratchet and the Clerk are peers, not rivals. Obligations belong to the Clerk; inquiries belong to the Ratchet. A click's conclusion may imply work, which becomes a commission on the Clerk's side, linked back to the originating click so the reasoning that produced the obligation is not lost.

See `docs/architecture/apparatus/ratchet.md`.

## Aliases

Vocabulary that has been renamed in the active codebase is recorded here as a historical bridge — for readers encountering the old term in archived prose, retired commissions, or commit history, and for writers who need to be sure they are using the current vocabulary. Entries here are *documentation only*: there is no runtime alias mechanism that translates between old and new terms. Stored writs, animator session metadata, or other persisted records that still carry the old vocabulary are not migrated by these entries — that is a separate concern.

### `piece` (execution layer) → `step` (2026-04-25)

The execution-layer atom — the unit of work that Spider's `implement-loop` engine picks up sequentially under a mandate, and that the `step-session` engine runs as an Animator session — was previously called `piece`. The writ type, the Spider engine (`step-session`, formerly `piece-session`), the Clerk tool (`step-add`, formerly `piece-add`), the Animator session metadata field (`stepId`), the engine epilogue constant (`STEP_EXECUTION_EPILOGUE`), the console-warn prefix (`[step-session]`), and the grafted engine-instance id prefix (`step-…`) all moved together. The `implement-loop` engine itself kept its name — it describes the loop coordinator, not the unit it loops over.

The rename freed the term `piece` for forthcoming use as the recursive internal-organization layer of the patron-facing planning ladder (`product → feature → piece (recursive) → mandate`). Two distinct concepts cannot share the name in the writ-type registry, in tool surfaces, or in animator prompts; the execution-layer concept vacated the name first so the planning-layer `piece` writ-type can be introduced cleanly by a separate, future commission.

If you encounter `piece` in older prose, in retired commission specs, in commit messages, or in writs persisted before the rename: it almost certainly refers to the execution-layer atom now called `step`. New writing — whether code, comments, prompts, or prose — uses `step` for the execution-layer concept and reserves `piece` for the planning-layer concept the ladder design will introduce.
