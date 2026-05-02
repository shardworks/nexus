# Trimming tests, package by package

A guide to identifying and removing redundant tests in the framework
monorepo, using per-test coverage attribution as the primary signal.

## Why trim

The framework currently carries **~80,000 lines of test code against ~50,000
lines of production source** — a 1.6:1 test-to-source ratio. Many of those
tests were written by autonomous agents and are heavily parameterized: the
same code path exercised with different inputs, asserting different output
values. Coverage-wise, they are equivalent; behaviorally, they are
parameter sweeps.

The goal of this trim is to reduce test maintenance burden and cycle time
without losing meaningful coverage. The aggregate threshold gate (see
`scripts/coverage-report.ts`, floors `67/80/53` for line/branch/function
coverage) prevents accidental over-trimming — any commit that drops
aggregate coverage below floor fails CI and the spider review loop.

## How the analyzer works

`scripts/test-uniqueness.ts` attributes coverage to individual tests by:

1. **Discovering tests** in the package — running each test file once with
   `node:test`'s programmatic `run()` API to enumerate every leaf test by
   `(file, suite path, test name)`.
2. **Per-test coverage**: spawning one node process per test with
   `--test-name-pattern=<exact match>` and `--experimental-test-coverage`,
   capturing the per-test lcov.
3. **Building a coverage matrix**: each test → a set of `<file>:<line>`
   tokens for source lines it caused to execute (DA records with hit > 0).
4. **Greedy reduction**: iteratively identify tests whose lines are all
   covered by *other* still-active tests; mark deletable; repeat until
   no zero-unique tests remain.
5. **Equivalence-class classification**: hash each test's line-set
   signature; group tests by signature. Within the redundant set,
   distinguish equivalence-class redundancy (≥1 group member is
   required — the choice of which to keep is arbitrary on coverage
   grounds) from strict subsumption (unique signature, lines covered
   only by the *union* of other tests). Surface them in separate report
   sections so the user knows whether to compare assertion strength
   (equivalence) or just check for unique contracts (subsumption).

### Note on the lcov import baseline

When you run a single test in isolation with `--experimental-test-coverage`,
the lcov shows **roughly half the lines of any imported source file as
hit=1**, even before the test body runs. Those are *real* hits — top-level
imports, top-level constants, function declarations, and the module's
initialization code all execute when the module is loaded. The other half
(function bodies for un-called functions) correctly show hit=0.

This is sometimes mistaken for "line coverage is bogus" — it's not. The
import-time baseline is shared across every test in the same file, so it
cancels out of per-test *uniqueness* (which is what redundancy detection
cares about). What distinguishes one test from another is the lines inside
the function bodies that test specifically exercised.

### Caveat: line vs branch granularity

Line coverage is the same signal as the aggregate threshold gate (`pnpm
coverage`'s `THRESHOLDS.lines`), so any test the analyzer flags as
redundant (whether equivalence-class or subsumed) is by definition safe
to delete from the *line-coverage* gate's perspective. However:

- The aggregate gate also checks **branch coverage** (80% floor).
- Two tests covering the same line but taking different branches at
  that line will both appear redundant under line-attribution but are
  *not* behaviorally equivalent.
- In practice, over-trimming via this analyzer will show up as a
  branch-coverage drop in `pnpm coverage` — the gate catches it.

If you want a finer signal, the analyzer was previously written against
FNDA (functions called) + BRDA (branches taken) tokens — the variant
lives in git history. Lines were chosen for the current implementation
because they're the standard signal, easy to inspect ("this test covers
these line ranges in foo.ts"), and aligned with the primary gate metric.

### What "redundant" means here

A test is **redundant** if every source line it caused to execute is
also covered by some other test in the package (either by a single
test, or by the union). Deleting a redundant test does not lose line
coverage.

The analyzer further classifies redundancy:

- **Coverage-equivalent**: the test shares a line-set signature with at
  least one other test. The greedy reducer arbitrarily keeps one and
  flags the rest; on coverage grounds, *any one* member of the group is
  sufficient. Pick on assertion strength.
- **Coverage-subsumed**: the test has a unique line-set signature, but
  its lines are covered by the union of required tests. There is no
  swap candidate; either it asserts a unique contract (keep) or it does
  not (cut).

**Redundancy means we _can_ delete the test without losing coverage.
It does NOT mean we _should_.** Two tests that exercise the same lines
with different inputs are line-coverage-equivalent but assert different
behavior — the redundant one might be the only test verifying that input
X produces output Y. Spot-check before deleting (the report includes a
peek at each test's first assertion).

## The workflow

Pick a package, run the analyzer, review, delete, verify. Repeat.

### 1. Run the analyzer

```sh
pnpm test:uniqueness <pkg>
```

`<pkg>` accepts shortforms: `spider`, `plugins/spider`, `framework/cli`.

Options:
- `--workers N` — parallel test workers (default 4, max 8).
- `--filter <regex>` — analyze only tests whose `<file> :: <path>` matches.
- `--no-cache` — ignore mtime cache, force fresh runs.
- `--json-only` / `--md-only` — skip one of the output formats.

Output:
- `coverage/uniqueness/<pkg>.md` — human-readable report.
- `coverage/uniqueness/<pkg>.json` — full matrix for tooling.
- `<pkg>/coverage/per-test/` — cached per-test lcov files (mtime-keyed).

The first run on a package is roughly 2× the package's normal `pnpm test`
duration (one process per test). Subsequent runs are near-instant if no
test files changed.

### 2. Read the report

The report has five sections:

- **Coverage-equivalent groups** — sets of tests with **identical line
  coverage**. The greedy reducer arbitrarily picks one as "required" and
  the rest as "redundant" within each group, but the choice is arbitrary
  on coverage grounds. Compare assertion peeks and pick the strongest.
  *Do not assume the reducer's pick is the right keep.*
- **Coverage-subsumed tests** — redundant tests with a unique line-set
  signature (no equivalent peer). Their lines are covered by the *union*
  of required tests, but not by any single one. Sorted by total covered
  lines descending. The asymmetry is genuine; cutting them is the
  obvious move modulo a behavior-pinning spot-check.
- **Low-uniqueness required tests** — survived reduction but contribute ≤5
  unique lines. Candidates if you want to push further at the cost of
  small coverage drops.
- **High-leverage required tests** — top 10 by unique lines. The
  load-bearing tests for this package; never delete.
- **Per-file rollup** — files sorted by redundant-test count. Use this to
  prioritize which monolith to dig into first.

The split between equivalence groups and subsumption is the key framing
fix. Older versions of this report listed everything as "pure-redundant,"
which implied a false hierarchy ("the reducer says X is redundant, so
delete X") inside equivalence classes where the choice was arbitrary.
Today the report tells you *which kind* of redundancy each test
exhibits, so you can compare assertion strength on equivalence groups
and rubber-stamp deletions on subsumed tests (after the spot-check).

### 3. Spot-check candidates

**For each coverage-equivalent group**, compare the assertion peeks of
all members. Pick the strongest assertion to keep; the others are
deletable. Heuristics for "strongest":

- Asserts more properties (status code AND body, vs status code only).
- Pins a contract no other group member pins (e.g., one of three
  same-coverage tests is the only one verifying `outcome.ok === true`).
- Asserts deeper structure (deepEqual on a complex value vs `assert.ok`).

If after comparing peeks all members pin distinct contracts (e.g.,
three success-path tests where one verifies the URL, one verifies the
body, one verifies the result), keep them all — coverage equivalence
does not imply behavioral equivalence.

**Beware the transitive-coverage trap.** When the strongest member of an
equivalence class pins a contract that is *transitively* covered by
tests in another file (typically a helper's own test suite), the
strongest-keep heuristic can mislead. Example: an integration test that
exercises a helper end-to-end has stronger assertions than a sibling
test that doesn't go through the helper, but if the helper has its own
exhaustive unit tests, the integration test's added strength is itself
redundant — and either consolidation (keep the integration test, or
keep the simpler sibling and rely on the helper's unit tests) is
defensible. Surface the call explicitly when you see this pattern; the
analyzer can't tell which other-file tests transitively cover the
extra assertion. Lean toward keeping the simpler test only when the
helper's coverage is itself robust (≥1 representative + edge cases for
each branch the integration test exercises).

**For each coverage-subsumed test**, look at the assertion peek and ask:

- Is this asserting a **distinct behavior** (different input → different
  output) that no required test verifies? Keep it.
- Is this the **only test** for an edge case (empty string, malformed
  input, error path)? Keep it — coverage subsumption often misses
  edge-case value.
- Otherwise it's a candidate for deletion.

### 4. Delete

Open the test file, find the redundant test, delete the `it(...)` /
`test(...)` block. If a `describe` becomes empty, delete the describe too.
Don't auto-clean — surgery on test files should be deliberate.

If the redundant tests cluster into whole describe blocks, consider
deleting the describe wholesale. Check whether any test in the describe
appears in the *required* list before deleting.

### 5. Verify

```sh
# Per-package: tests still pass, per-package coverage unchanged-ish
cd packages/<pkg> && pnpm test:coverage

# Monorepo: aggregate coverage still above floor
cd <repo-root> && pnpm coverage
```

The aggregate `pnpm coverage` is the gate. If it exits 0, the trim was
within the floor — commit. If it exits non-zero, you over-trimmed —
restore some tests and try again.

### 6. Re-analyze

```sh
pnpm test:uniqueness <pkg>
```

Cached results are reused for tests in unchanged files; only the touched
file's tests re-run. Confirm the redundant total shrank (equivalence
groups dissolved or subsumed list reduced) and the high-leverage list
stayed intact.

### 7. Commit

Per package, with a descriptive message:

```
trim <pkg>: delete N redundant tests

- N pure-redundant tests removed from <files>
- Aggregate coverage: 67.96% → 67.92% (within floor)
- Per-package: <pkg> 78.5% → 78.3%
- Coverage-equivalent parameter sweeps consolidated; behavior preserved.
```

Update the **status table** at the bottom of this doc with what changed.

## Caveats and known limits

- **Coverage ≠ behavior.** Branch-coverage equivalence does not imply
  semantic equivalence. The peek and your judgment are the safety net.
- **Function coverage is coarse.** A test that calls function `foo` with
  any input "covers" `foo`. If `foo` is purely linear, no other tests
  calling `foo` will appear unique relative to that one. Consider whether
  multiple inputs are still worth keeping for assertion value even if not
  for coverage value.
- **The greedy reducer is not optimal.** It finds *a* valid reduction, not
  the maximum one — different orderings produce different sized redundant
  sets. Good enough for the trim; if you want tighter, run multiple times
  with `--filter` scopes and compare.
- **Tests with regex-meta or space-collision names are skipped.** node:test's
  `--test-name-pattern` matches against `<suite> <test>` joined by single
  space. If two tests in a file share that joined string (e.g.,
  describe `'foo bar'` test `'baz'` collides with describe `'foo'` test
  `'bar baz'`), both are skipped to avoid mis-attribution. The script
  surfaces this with a warning.
- **Slow tests still cost.** First-run wall-time is roughly `2× pnpm test`
  per package (one process per test, fanned out across workers). Use
  `--filter` if you want to scope down. Subsequent runs use the cache.

## Package checklist

Unified checklist of all framework packages, ordered by test-line count
(smallest first). The order is the recommended trim sequence: validate
the workflow on small packages before tackling monoliths. Pick the
first `pending` row when starting a trim session.

When a package is processed:
- Set Status to `trimmed` (or `skipped` with a reason).
- Update Test lines to `before → after`.
- Fill in Date.
- Add a one-line note. Full data lives in the X017 artifact at
  `/workspace/nexus-mk2/experiments/X017-test-redundancy/artifacts/<YYYY-MM-DD>-<pkg-flat>.yaml`.

Status values: `pending`, `trimmed`, `skipped`.

Test-line counts are from `find packages/<pkg>/src -name '*.test.ts' |
xargs wc -l` on 2026-05-02; refresh as packages are processed.

| # | Package | Status | Test lines | Date | Notes |
|--:|---|---|---|---|---|
|  1 | `plugins/stacks` | skipped | 13 | 2026-05-02 | Test surface is a 13-line delegation to a shared cross-backend conformance suite; trimming would alter contract, not redundancy. |
|  2 | `framework/core` | trimmed | 311 → 275 | 2026-05-02 | Cut 6 of 29 flagged candidates (21%). |
|  3 | `plugins/fabricator` | trimmed | 399 → 387 | 2026-05-02 | Cut 1 of 13 flagged candidates (7.7%); kit+apparatus integration test was belt-and-suspenders. |
|  4 | `plugins/lattice-discord` | trimmed | 413 → 394 | 2026-05-02 | Cut 1 of 8 flagged candidates (12.5%); 5xx test was a strictly-weaker parameter sweep of the kept 4xx test on the same `!response.ok` branch. |
|  5 | `plugins/clockworks-stacks-signals` | skipped | 567 | 2026-05-02 | 12 of 13 flagged (92.3%) but the only deletable candidate (patch() update test, strict subset of put-over-existing) was load-bearing for the aggregate function-coverage floor — cutting it drops 53.08% → 52.99% (5 transitive Stacks patch-chain functions). New X017 finding: line-redundant ≠ function-redundant. |
|  6 | `plugins/copilot` | trimmed | 897 → 819 | 2026-05-02 | Cut 5 of 27 flagged candidates (18.5%); 4× strict-subset on same code path (providerSessionId-last, apiEndpoint-only-vs-URL+auth, start-with-config-name-only, 4-round accumulator), 1× parameter-sweep duplicate (custom-env-var missing-token). |
|  7 | `plugins/lattice` | pending | 1,066 | — | |
|  8 | `plugins/codexes` | pending | 1,387 | — | |
|  9 | `plugins/parlour` | pending | 1,733 | — | |
| 10 | `framework/arbor` | pending | 1,833 | — | Probed: 80% pure-redundant under DA-based analysis. Small monolith, two files. |
| 11 | `plugins/loom` | pending | 1,919 | — | |
| 12 | `plugins/ratchet` | pending | 2,069 | — | |
| 13 | `plugins/oculus` | pending | 2,238 | — | |
| 14 | `plugins/tools` | pending | 2,371 | — | |
| 15 | `plugins/cartograph` | pending | 2,450 | — | |
| 16 | `plugins/sentinel` | pending | 2,877 | — | |
| 17 | `plugins/claude-code` | pending | 3,457 | — | |
| 18 | `framework/cli` | pending | 3,838 | — | |
| 19 | `plugins/reckoner` | pending | 4,822 | — | |
| 20 | `plugins/astrolabe` | pending | 5,749 | — | |
| 21 | `plugins/animator` | pending | 6,273 | — | |
| 22 | `plugins/clerk` | pending | 7,148 | — | Top-3 by volume. |
| 23 | `plugins/clockworks` | pending | 7,945 | — | Top-3 by volume. |
| 24 | `plugins/spider` | pending | 18,714 | — | **Headline target.** Largest test volume + lowest coverage-to-volume ratio (70.7% line / 18.7k test lines) = largest expected win. |

For the bigger packages, expect first-pass redundancy in the **30–60%**
range based on early probes (`framework/core` 74%, `framework/arbor`
80%). Note: the framework/core post-review *deletion* rate was 21%, far
below the 74% pure-redundant flag rate — the analyzer flags parameter
sweeps that humans value. See X017 spec H2 and the framework/core
artifact for the calibration story.

## Related

- [`scripts/test-uniqueness.ts`](../../scripts/test-uniqueness.ts) — the analyzer source.
- [`scripts/coverage-report.ts`](../../scripts/coverage-report.ts) — the aggregator + threshold gate.
- `pnpm coverage` — full pipeline (test + aggregate + threshold check).
- The aggregate floor (`THRESHOLDS` in `coverage-report.ts`): 67% lines /
  80% branches / 53% functions.
