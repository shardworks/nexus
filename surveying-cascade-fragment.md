# `docs/architecture/surveying-cascade.md` — graft fragment

This fragment supplies §3.4, §3.6, and §3.7 rewrites for the
sanctum-side canonical `docs/architecture/surveying-cascade.md`. The
draft worktree this commission landed in does not carry the file (the
canonical version lives at `/workspace/nexus/docs/architecture/`), so
the rewrites are produced as a sibling artifact for the patron to graft
into the source-of-truth doc — per D14 of the cartograph
ext-slot-cleanup commission spec.

The rewrites describe the post-cleanup architecture in which the
cartograph contributes no companion books and writes per-writ stage
under `writ.ext['cartograph']` via `clerk.setWritExt`. The substrate
described by `surveying-cascade.md` is the next downstream consumer of
this slot; landing the cleanup first lets the substrate be specified
against a single writ-type-filtered CDC subscription rather than three
per-book subscriptions.

The fragments below are written in the same prose style as the
existing arch doc and assume the surrounding sections (numbering,
conventions, headings) carry over unchanged. Where a fragment cites a
neighbouring section by number, that number reflects the source-of-
truth doc's current numbering.

---

## §3.4 — Survey-writ envelope (revision)

The survey writ carries the substrate's published metadata through two
sanctioned plugin-keyed slots on the writ row, both written
exclusively through the Clerk's `setWritExt` / `setWritStatus` APIs so
sibling sub-slots are preserved under concurrent writers:

- **`writ.status['surveyor']`** — observation slot. The substrate
  stamps this slot when the survey terminates: it carries the survey
  outcome, the writ-completion observations the surveyor recorded, and
  any per-rig observation summary. Outcomes are surveyor-private; the
  consumer reads them post-hoc.
- **`writ.ext['surveyor']`** — metadata slot. Carries
  registration-time provenance the substrate needs the writ to *bear*
  rather than have *observed about it*: `rigVersion` (the rig's
  semver pin at the moment the survey was queued) and `surveyorId`
  (the substrate-instance id for traceability across multi-substrate
  deployments).

Three earlier-spec fields are dropped because they duplicate fields
the Clerk already carries:

- `targetNodeId` — replaced by `writ.parentId`. The survey writ's
  parent edge already names the writ being surveyed; a parallel
  metadata field is a coordination liability.
- `rigName` — replaced by `writ.type`. The substrate registers one
  writ type per rig, so the type *is* the rig name; carrying both
  lets them drift.
- `completedAt` — replaced by `writ.resolvedAt`. The Clerk stamps
  `resolvedAt` automatically on every terminal phase transition, and
  the surveyor's terminal transition is the only path that produces a
  completed survey.

The substrate is the only writer to either sub-slot. Other plugins
that need to read survey provenance or outcome traverse the slot
contract documented on `ClerkApi.setWritStatus` / `ClerkApi.setWritExt`
respectively.

## §3.6 — CDC subscription (revision)

The substrate maintains a single CDC subscription against the
Clerk-owned writs book and filters in the handler by writ type:

```ts
stacks.watch<WritDoc>('clerk', 'writs', (event) => {
  if (!isSurveyableType(event.entry.type)) return;
  // ...substrate handler...
}, { failOnError: false });
```

Where `isSurveyableType` returns true for `vision`, `charge`, `piece`
(every cartograph-owned writ type) plus any other rig-registered type
the substrate is configured to survey. The handler runs at Phase 2
(post-commit, after `coalesceEvents`) so the CDC stream the substrate
observes carries one event per logical change rather than one event
per intermediate write.

This replaces the three per-book subscriptions the earlier draft
specified — `book.cartograph.visions.{created,updated}`,
`book.cartograph.charges.{created,updated}`, and
`book.cartograph.pieces.{created,updated}` — none of which exist
post-cleanup because the cartograph contributes no books. The single
writs-book subscription is functionally equivalent and trivially
extensible to additional writ types as more rigs come online.

The single-event-per-apply guarantee discussed in the earlier draft
carries through unchanged: the cartograph's `createX` / `transitionX`
primitives are already transactional. `createX` opens one
`stacks.transaction(...)` that wraps the writ-row put and the
`setWritExt('cartograph')` stamp, so the substrate sees one coalesced
`create` event with the final state. `transitionX` wraps
`clerk.transition` + `setWritExt('cartograph')` and yields one
coalesced `update` event. Patron-driven flows (e.g. `vision-apply`)
that compose multiple typed-API calls under one outer
`stacks.transaction` produce one coalesced event per apply for the
same reason.

## §3.7 — Substrate-owned things (revision)

The substrate owns the following:

- The surveyor scheduler, its tick loop, and the per-rig surveyor
  registry.
- The `status['surveyor']` slot on every survey writ. Stamped on
  completion via `ClerkApi.setWritStatus(writId, 'surveyor', ...)`.
  Carries the survey outcome and per-completion observations.
- The `ext['surveyor']` slot on every survey writ. Stamped at
  registration via `ClerkApi.setWritExt(writId, 'surveyor', ...)`.
  Carries the registration-time provenance fields described in §3.4.
- The substrate-internal records book (e.g. surveyor backoff,
  per-rig health metrics) — implementation detail, not part of the
  cross-plugin contract.

`books.surveys` is dropped from this list. The earlier draft included
it as a substrate-owned book holding `SurveyDoc` rows keyed by the
survey writ id; the post-cleanup architecture has no parallel. Survey
metadata that would otherwise live on a `SurveyDoc` row lives on the
two ext/status slots instead, both of which are carried by the writ
row itself.

The earlier draft's "stamps `SurveyDoc` on completion" wording is
replaced with "stamps `status['surveyor']` on completion" — the
mechanism is `setWritStatus` rather than a companion-book put, and the
slot is the observation sub-slot keyed by the substrate's plugin id.

---

## Notes for the patron

- The fragment assumes the canonical `surveying-cascade.md` has been
  refreshed to reflect the post-cleanup cartograph; if any earlier
  paragraphs in §3.x still reference the deleted companion books they
  should be reworked with the same minimal-edit discipline used here
  ("companion doc" → "ext['cartograph'] slot" / "status['surveyor']
  slot" depending on observation-vs-metadata semantics).
- The CDC code snippet in §3.6 is illustrative; the substrate's actual
  handler will carry richer logic (rig dispatch, deduplication,
  stuck-survey reaper). The key load-bearing detail is the
  single-subscription shape — book name `'writs'`, filter on
  `event.entry.type`, Phase 2 (`failOnError: false`).
- The revisions do not depend on each other; §3.4 and §3.7 can be
  grafted independently. §3.6 should be grafted alongside §3.4
  because §3.6's "single-event-per-apply" prose references the slot
  names §3.4 introduces.
