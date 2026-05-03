# Shrinking tests, file by file

A guide to reducing **test LOC** without reducing **test count** or
**coverage**. Companion to `trimming-tests.md` (which removes redundant
tests). This guide refactors the tests that are staying.

## Why shrink

The framework currently carries **~84,000 lines of test code**. Implementation
sessions spend a meaningful share of their token budget reading and writing
those tests — that cost is roughly proportional to test-corpus bytes, not
test count. Trimming redundant tests caps out around 0.2% LOC reduction
under conservative cuts because the redundancy signal is mostly tabular
parameter sweeps that we keep anyway.

Refactoring the tests that *stay* is where the real LOC lives. The goal of
this work is **fewer bytes, same tests, same coverage** — an order-of-magnitude
larger lever than deletion.

## What we're trying to achieve

For each test file, ask: *what is the densest expression of these tests
that preserves their behavior and coverage?* Then make the file look like
that.

Some general guidance:

- **Boilerplate concentrates.** Per-test fixture re-setup, hand-built
  state literals, repeated import blocks, decorative comment dividers —
  these are usually the biggest LOC sinks and the easiest wins.
- **Tabular tests want to be tables.** When N `it` blocks have the same
  shape with different inputs, a loop over a case array is shorter and
  reads better.
- **Helpers earn their keep.** Factories that produce the package's
  domain objects with override-friendly shapes pay back across many tests.
- **Don't break behavior.** Every test that was there before should still
  be there after. Every assertion should still pin the same contract. If
  a refactor changes what's tested, it's not a shrink — it's a behavior
  change. Spot-check.
- **Use judgment.** Some tests are already lean. Some files mix patterns
  that don't refactor cleanly. Don't force a transformation that fights
  the grain of the file.

Future agents have latitude to discover and apply patterns the runbook
hasn't named. The goal isn't to follow a recipe — it's to make the file
smaller while keeping the suite intact.

## Verification gate

After each refactor, the tests must:

1. **Pass.** `pnpm test` (per-package) and `pnpm test:coverage`.
2. **Cover the same lines.** Per-package coverage `before → after` should
   be within ±0.5% on lines/branches/functions.
3. **Have ≥ the same test count.** `pnpm test` reports test count; do not
   collapse two tests into one without keeping count unchanged or higher.

This is the safety net. If coverage drops or test count drops, undo
something — you removed behavior, not just bytes.

The aggregate floor (`THRESHOLDS` in `scripts/coverage-report.ts`): 67%
lines / 80% branches / 53% functions. Same gate as the trimming workflow —
if a shrink drops aggregate below floor, undo.

## The workflow

Pick a file, refactor, verify, commit. Repeat.

1. **Pick a file.** Use the per-package status table below. Within a
   package, pick the largest test file first — that's where the most
   boilerplate concentrates.
2. **Read the file.** Note current LOC and test count.
3. **Refactor.** Aim for structural changes, not deletions. If you find a
   genuinely redundant test along the way, flag it for the trimming
   workflow rather than deleting it as part of the shrink.
4. **Verify.** Run `pnpm test:coverage` for the package. Confirm tests
   pass, count is ≥ before, and coverage is within drift.
5. **Commit.** Per file or per logical pass:

   ```
   shrink <file>: <one-line summary> — N LOC → M LOC

   - Same N tests, same coverage.
   - Per-package: <pkg> X.X% → Y.Y% lines (within drift).
   ```

6. **Update the status table** in this doc with what changed.

## Package checklist

Ordered by **test LOC descending** — largest packages first, since absolute
LOC yield is the primary driver. Pick the top `pending` row when starting
a session.

Status values: `pending`, `in-progress`, `done`, `skipped`.

LOC counts from `find packages/<pkg> -name '*.test.*' | xargs wc -l` on
2026-05-03; refresh as packages are processed.

| # | Package | Status | Test lines | Date | Notes |
|--:|---|---|---|---|---|
|  1 | `plugins/spider` | in-progress | 15,196 | 2026-05-03 | 6 of 20 files shrunk: `static/spider-ui.test.ts` 2,101→1,001 (-52%); `spider-blocking.test.ts` 1,908→1,429 (-25%); `spider-core.test.ts` 1,756→1,341 (-24%); `spider-template-config.test.ts` 1,546→1,102 (-29%); `spider-cancellation.test.ts` 1,514→1,267 (-16%); `spider-when-graft.test.ts` 1,451→1,129 (-22%). Combined: -3,007 LOC. 14 files left. |
|  2 | `plugins/clerk` | pending | 9,343 | — | 8 files; large monolith `clerk.test.ts` (311 tests). |
|  3 | `plugins/clockworks` | pending | 7,945 | — | 14 files, more spread out. Less per-file fixture concentration. |
|  4 | `plugins/astrolabe` | pending | 6,614 | — | 10 files. |
|  5 | `plugins/animator` | pending | 6,273 | — | 10 files. |
|  6 | `plugins/reckoner` | pending | 4,822 | — | 7 files. Tightly written (X017 probe: 52% redundancy, lowest of monoliths) — may already be lean. |
|  7 | `framework/cli` | pending | 3,838 | — | 10 small command-test files. |
|  8 | `plugins/ratchet` | pending | 3,584 | — | 4 files. Newer code; may already be cleaner. |
|  9 | `plugins/claude-code` | pending | 3,457 | — | 6 files. |
| 10 | `plugins/sentinel` | pending | 2,877 | — | 6 files. |
| 11 | `plugins/cartograph` | pending | 2,450 | — | 3 files. |
| 12 | `plugins/tools` | pending | 2,371 | — | 5 files. |
| 13 | `plugins/oculus` | pending | 2,238 | — | 3 files. |
| 14 | `plugins/loom` | pending | 1,919 | — | 1 monolith file. |
| 15 | `framework/arbor` | pending | 1,833 | — | 2 files. |
| 16 | `plugins/parlour` | pending | 1,733 | — | 2 files. |
| 17 | `plugins/codexes` | pending | 1,387 | — | 2 files. |
| 18 | `plugins/lattice` | pending | 1,066 | — | 2 files. |
| 19 | `plugins/copilot` | pending | 819 | — | Already trimmed under X017 (-78 LOC); shrink can layer on top. |
| 20 | `plugins/clockworks-stacks-signals` | pending | 567 | — | |
| 21 | `plugins/lattice-discord` | pending | 394 | — | Already trimmed under X017 (-19 LOC). |
| 22 | `plugins/fabricator` | pending | 387 | — | Already trimmed under X017 (-12 LOC). |
| 23 | `framework/core` | pending | 275 | — | Already trimmed under X017 (-36 LOC). Small surface; low yield. |
| 24 | `plugins/stacks` | skipped | 13 | — | 13-line delegation file; nothing to shrink. |

## Related

- [`trimming-tests.md`](trimming-tests.md) — the companion runbook for
  removing redundant tests.
