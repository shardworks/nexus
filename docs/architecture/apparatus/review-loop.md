# The Review Loop — Design Spec

Status: **Design** (not yet implemented)

> **Not a traditional apparatus.** The review loop does not have a `start()`/`stop()` lifecycle or a persistent runtime API. It is a composition pattern — a pair of engine designs and a rig structure — within the rigging system. This document specifies the design as implemented in the Spider.

---

## Purpose

The review loop moves quality assurance inside the rig. Instead of dispatching a commission once and surfacing the result to the patron regardless of quality, the rig runs an implementation pass, evaluates the result against concrete criteria, and — if the criteria are not met — runs a revision pass. The patron receives work only after it has cleared at least one automated review gate, or after the loop has exhausted its retry budget.

This is not a general-purpose test harness. The review loop does one thing: catch the most common and cheapest-to-detect failure modes before they become patron problems.

**What the review loop is not:**
- A replacement for spec quality. A bad spec produces bad work; the review loop helps only when the anima had the information to succeed but failed in execution.
- A Clockworks-dependent system. The loop runs entirely within the rigging pipeline using existing apparatus.
- A complete quality gate. The MVP catches mechanical failures; richer review criteria are future scope.

---

## Empirical Motivation

Commission log X013 (`experiments/data/commission-log.yaml`) through 2026-04-02 shows the following outcome distribution across patron-tracked commissions with known outcomes:

| Outcome | Count | Notes |
|---------|-------|-------|
| success | 7 | Includes 1 with revision_required=true (partial attribution issue) |
| partial | 2 | Required follow-up commissions |
| abandoned | 3 | Two were test/infra noise; one was execution_error |
| cancelled | 1 | Process failure, not work failure |

Of the real work failures, the two most common causes were:
1. **Uncommitted changes** — anima produced correct work but did not commit before session end. Mechanically detectable.
2. **Partial execution** — anima completed some of the spec but missed a subsystem (e.g. missed a test file, broke a build). Partially detectable via build/test runs.

Both are catchable with cheap, mechanical review criteria. Neither requires an LLM judge. This is the MVP's target.

---

## Design Decision: Where Does the Loop Live?

Three candidate locations were considered:

### Option B: Review engine in every rig (full design)

The Spider seeds every rig with an `implement → review → [revise → review]*N` chain by default. The review engine is a clockwork engine; the revise engine is a quick engine. Both are standard engine designs contributed by a kit.

**Pros:** Architecturally clean. Composes naturally with Spider's traversal. Reusable engine designs. Composes naturally with the Spider — the rig handles iteration natively.

**Cons:** Requires the Spider. Not implementable until the rigging system exists.

### Option C: Rig pattern via origination engine

The origination engine seeds rigs with review chains by default. Superficially similar to Option B, but the decision of whether to include a review loop is made at origination time, not by a default rig structure.

**Pros:** Gives origination agency over review strategy (some work may not need review; some may need richer review).

**Cons:** Complicates origination. Review is almost always appropriate; making it opt-in inverts the sensible default.

### Decision

**Option B (review engines in the rig) is the chosen design.**

The Spider seeds every rig with an `implement → review → revise → seal` chain. The review engine is a clockwork engine that runs mechanical checks and a reviewer session; the revise engine is a quick engine. Both are standard engine designs contributed by the Spider's support kit. The rig pattern (Option C) governs per-commission review configuration as a future enhancement.

---

## Review Engines in the Rig

### Engine Designs

#### `review` engine (clockwork)

**Design:**
```typescript
{
  id: 'review',
  kind: 'clockwork',
  inputs: ['writId', 'worktreePath', 'attempt'],
  outputs: ['reviewResult'],
  config: {
    checks: ['uncommitted_changes', 'build', 'test'],
    buildCommand: string | undefined,
    testCommand: string | undefined,
  }
}
```

The review engine runs the same three checks as the MVP. It writes a `ReviewResult` to its yield. It does not branch — it always completes, passing the result downstream.

The downstream engine (either a `seal` engine or a `revise` engine) reads `reviewResult.passed` to decide what to do. The Spider sees a completed engine regardless of outcome; the branching logic lives in the rig structure (see Rig Pattern below).

#### `revise` engine (quick)

**Design:**
```typescript
{
  id: 'revise',
  kind: 'quick',
  inputs: ['writId', 'worktreePath', 'reviewResult', 'attempt'],
  outputs: ['sessionResult'],
  role: 'artificer',
}
```

The revise engine assembles the revision prompt (same template as MVP) and launches an anima session. The session runs in the existing worktree — it does not open a new draft.

### Rig Pattern

The default rig for a commission with review enabled:

```
                ┌──────────────┐
                │  implement   │  (quick engine: artificer)
                │    engine    │
                └──────┬───────┘
                       │ yield: sessionResult
                       ▼
                ┌──────────────┐
                │    review    │  (clockwork engine)
                │   engine 1  │
                └──────┬───────┘
                       │ yield: reviewResult
          ┌────────────┴────────────┐
          │ passed                  │ failed (attempt < maxRetries)
          ▼                         ▼
   ┌─────────────┐         ┌──────────────────┐
   │    seal     │         │     revise       │  (quick engine: artificer)
   │   engine    │         │     engine 1     │
   └─────────────┘         └────────┬─────────┘
                                    │ yield: sessionResult
                                    ▼
                           ┌──────────────────┐
                           │     review       │  (clockwork engine)
                           │    engine 2      │
                           └────────┬─────────┘
                                    │ yield: reviewResult
                       ┌────────────┴────────────┐
                       │ passed                  │ failed
                       ▼                         ▼
                ┌─────────────┐         ┌──────────────────┐
                │    seal     │         │    escalate      │  (clockwork engine)
                │   engine    │         │    engine        │
                └─────────────┘         └──────────────────┘
```

The Spider traverses this graph naturally. Each engine completes and propagates its yield; downstream engines activate when their upstream is complete. The conditional branching (pass → seal, fail → revise) is expressed in the rig structure, not in Spider logic — the Spider just runs whatever is ready.

**Seeding the rig:** The origination engine produces this graph when it seeds the rig. For `maxRetries=2`, the origination engine seeds a fixed graph (not dynamically extended). If the guild wants `maxRetries=0` (no review loop), origination seeds the simple `implement → seal` graph.

**Dynamic extension (future):** A more sophisticated design would have the review engine declare a `need: 'revision'` when it fails, and the Fabricator would resolve and graft the next revise+review pair. This avoids pre-seeding the full graph and enables arbitrary retry depths. This is Future scope — the fixed graph is sufficient for MVP and avoids Spider complexity in the initial rigging implementation.

### Spider Integration

The Spider needs no changes to support the review loop. It already:
- Traverses all engines whose upstream is complete
- Routes ready engines to the Executor
- Handles both clockwork and quick engine kinds

The review loop is just a graph shape that Spider happens to traverse. The `escalate` clockwork engine signals the Clerk with a `failed` transition; the `seal` clockwork engine signals completion. The Spider itself is agnostic.

---

## Review Criteria Reference

### MVP Criteria (Mechanical)

| Check | Description | Detection Method | Cost |
|-------|-------------|-----------------|------|
| `uncommitted_changes` | All work is committed | `git status --porcelain` | < 100ms |
| `build` | Build command exits cleanly | Run configured build command | Varies |
| `test` | Test suite passes | Run configured test command | Varies |

The `uncommitted_changes` check is always enabled. Build and test checks are opt-in via guild configuration.

### Future Criteria (Judgment-Required)

These are not in scope for MVP but are the natural next layer:

| Check | Description | Detection Method | Cost |
|-------|-------------|-----------------|------|
| `spec_coverage` | Diff addresses spec requirements | LLM-as-judge pass on (spec, diff) | Medium |
| `no_regressions` | No tests were deleted or disabled | Diff analysis | Low |
| `type_check` | TypeScript compilation passes | `tsc --noEmit` | Varies |
| `lint` | Linter passes | Run configured lint command | Varies |

The LLM-as-judge `spec_coverage` check is the most valuable future criterion — it catches the "anima only addressed part of the spec" failure mode that mechanical checks miss. It requires a separate quick engine with access to the writ body and the diff, and a structured prompt asking whether the diff achieves the spec's stated goals.

---

## Artifact Schema

Every review pass writes an artifact. Artifacts live in the commission data directory alongside the existing artifacts written by the Laboratory.

### Location

```
experiments/data/commissions/<writ-id>/
  commission.md          (existing — writ body)
  review.md              (existing template — patron review slot)
  review-loop/
    attempt-1/
      review.md          (ReviewResult as structured markdown)
      git-status.txt     (git status output)
      git-diff.txt       (git diff HEAD output)
    attempt-2/
      review.md
      git-status.txt
      git-diff.txt
    escalation.md        (if loop exhausted; patron-facing summary)
```

The review engine writes these artifacts via the Stacks or directly to the commission data directory.

### `review.md` Schema

```markdown
# Review — Attempt {N}

**Writ:** {writId}
**Timestamp:** {ISO 8601}
**Result:** PASSED | FAILED

## Checks

| Check | Result | Duration |
|-------|--------|----------|
| uncommitted_changes | ✓ PASS / ✗ FAIL | {ms}ms |
| build | ✓ PASS / ✗ FAIL | {ms}ms |
| test | ✓ PASS / ✗ FAIL | {ms}ms |

## Failures

{for each failure}
### {check}
{message}

```
{detail}
```
{end for}
```

### `escalation.md` Schema

```markdown
# Review Loop Escalated

**Writ:** {writId}
**Title:** {writ.title}
**Attempts:** {N}
**Timestamp:** {ISO 8601}

The review loop exhausted its retry budget ({maxRetries} retries) without
achieving a passing review. The draft has been abandoned.

## Summary of Failures

{for each attempt}
### Attempt {N}
{list of failed checks with messages}
{end for}

## Recommended Actions

- Inspect the worktree state preserved in the draft artifacts
- Review the git-diff.txt files in each attempt directory
- Revise the spec to address the observed failure mode before re-dispatching
```

---

## Configuration

Review configuration lives in `guild.json`:

```json
{
  "review": {
    "enabled": true,
    "maxRetries": 2,
    "buildCommand": "pnpm build",
    "testCommand": "pnpm test"
  }
}
```

All fields are optional. `enabled` defaults to `false` (opt-in). The intent is to make it default-on once the loop has been validated in practice. This configuration is consumed by the origination engine to decide whether to seed the review graph and what configuration to pass to the review engine.

---

## Observability

The review loop is itself experiment data. Every iteration produces artifacts that the Laboratory can capture and analyze:

1. **Review artifacts** (`review-loop/attempt-N/`) — structured pass/fail evidence for each check. Enables quantitative analysis: which checks catch what failure modes? How often does the second attempt pass where the first failed?

2. **Session records** — revision sessions are recorded in the Animator's `sessions` book with `metadata.trigger: 'review-revision'` and `metadata.attempt: N`. Enables cost accounting: how much does the review loop add per commission?

3. **Writ resolution field** — when the loop escalates, the writ resolution includes the retry count. The commission log's `failure_mode` can be set to `review_exhausted` to distinguish review-loop failures from first-try failures.

4. **Commission log** — the `revision_required` field will more accurately reflect anima-driven revisions vs. patron-driven revisions once the review loop is active. The distinction becomes: `revision_required: true, revision_source: patron | review_loop`.

---

## Open Questions

These questions could not be resolved without patron input or empirical data from MVP deployment. Flag for patron review before implementation.

**Q1: Default-on or opt-in?**

The spec recommends opt-in for MVP (`enabled: false` default) to avoid surprises during initial deployment. However, opting-in per guild means the review loop doesn't run in experiments where it would produce the most useful data. Consider making it default-on from the start, with `enabled: false` as the escape hatch for commissions where review is inappropriate (e.g. spec-writing commissions like this one, where there's no build/test to run).

**Q2: Should revision sessions open new drafts or continue in the existing worktree?**

The current design continues in the existing worktree. This means revision builds on what the first attempt produced — which is usually correct (fix what's broken, don't start over). But it also means the revision session can see a messy worktree with uncommitted changes from the first attempt. Does the first attempt's work contaminate the revision? Or is seeing it in context (via `git diff`) actually helpful? No empirical evidence yet.

**Q3: What is the revision session's role?**

Should the revising anima be the same role as the implementing anima (e.g. `artificer`)? Or should the review loop summon a different role with explicit "you are reviewing and fixing prior work" instructions? The current spec defaults to the same role with a modified prompt. A distinct `revisor` role with specialized temperament could perform better. Needs a/b testing once the loop is running.

**Q4: Should the review pass happen before sealing, or is it implicitly "before sealing"?**

The current design places the review pass between the implementation session and the seal step. This means the draft is open during review. If the review pass runs the test suite, the test suite runs inside the worktree before sealing — which is correct. But it also means the worktree is mutable during review (in theory another process could write to it). Is this a problem in practice? Probably not for single-dispatch guilds, but worth noting.

**Q5: LLM-as-judge: when and how?**

The spec defers LLM-as-judge review to future scope, but it's the most valuable future criterion. Key unresolved questions: which model? What's the prompt structure? What's the acceptance threshold (0-10 score? binary pass/fail from the judge)? Who pays for the judge session — is it accounted separately from the commission cost? These need design work before the feature is useful.

**Q6: Should the review loop apply to spec-writing commissions?**

This commission is itself a spec-writing commission. There's no build command to run, no test suite to pass. The only mechanical check that applies is `uncommitted_changes`. Is that sufficient to warrant running the loop? Or should spec-writing commissions (like this one, with no target codex build) opt out of the loop by default? Consider: a charge type hint (`spec` vs. `implementation`) could guide the origination engine to include or exclude the review loop in the initial rig.

---

## Future Evolution

### Phase 2 (Spider-level engine designs)
- `review` clockwork engine contributed by a kit
- `revise` quick engine contributed by the same kit
- Origination engine seeds review graph by default
- Review configuration passed per-rig, not just per-guild

### Phase 3 (Richer review criteria)
- LLM-as-judge `spec_coverage` check
- `type_check` and `lint` checks
- Per-commission review configuration (charge type → review strategy)
- Distinct `revisor` role with specialized temperament

### Phase 4 (Dynamic extension)
- Review engine declares `need: 'revision'` on failure
- Fabricator resolves revision chain dynamically
- Arbitrary retry depth (or patron-configured per-commission)
- Review loop data feeds Surveyor codex profiles (this codex has a 60% first-try rate → seed richer review graph by default)

