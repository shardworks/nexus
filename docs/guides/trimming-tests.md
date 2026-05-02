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
3. **Building a coverage matrix**: each test → a set of "coverage units"
   it exercised. Units are functions called (FNDA records) and branches
   taken (BRDA records).
4. **Greedy reduction**: iteratively identify tests whose units are all
   covered by *other* still-active tests; mark deletable; repeat until
   no zero-unique tests remain.

### Why not line coverage?

Line coverage (`DA:` records) **cannot** be used for per-test attribution
in node:test's lcov output. V8 instrumentation marks every reachable line
in a loaded module as `hit=1` regardless of whether a given test actually
exercised it — so any test that imports a module appears to "cover" every
reachable line of it. Function coverage (FNDA hit count) and branch
coverage (BRDA hit count) correctly reflect actual execution, so the
analyzer uses those.

This is mirrored in the report's terminology: "coverage units" (functions
+ branches), not "lines." The per-package and aggregate line-coverage
numbers from `pnpm coverage` are still meaningful at the *whole-suite*
level — they only break down at the *per-test* level.

### What "redundant" means here

A test is **pure-redundant** if every function it called and every branch
it took is also called/taken by some other test in the package. Deleting
a pure-redundant test does not lose coverage at the function or branch
level.

**Pure redundancy means we _can_ delete the test without losing coverage.
It does NOT mean we _should_.** Two tests that exercise the same branches
with different inputs are coverage-equivalent but assert different
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

The report has four lists:

- **Pure-redundant tests** — sorted by total covered units descending. The
  ones with the highest count are the safest to delete (most overlap with
  the rest of the suite).
- **Low-uniqueness required tests** — survived reduction but contribute ≤5
  unique units. Candidates if you want to push further at the cost of
  small coverage drops.
- **High-leverage required tests** — top 10 by unique units. The
  load-bearing tests for this package; never delete.
- **Per-file rollup** — files sorted by redundant-test count. Use this to
  prioritize which monolith to dig into first.

### 3. Spot-check candidates

For each pure-redundant test you're considering deleting, look at the
**assertion peek** in the report — the first `assert.*` call extracted
from the test body. Ask:

- Is this asserting a **distinct behavior** (different input → different
  output) that no required test verifies? Keep it.
- Is this asserting **the same thing** as another test (e.g., both
  `assert.equal(foo('x'), 'X')` and `assert.equal(foo('y'), 'Y')` exercising
  identical branches)? It might be a parameter sweep — consider whether
  the table-driven coverage is worth keeping or whether one representative
  is enough.
- Is this the **only test** for an edge case (empty string, malformed input,
  error path)? Keep it — coverage equivalence often misses edge-case value.

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
file's tests re-run. Confirm the redundant list shrank and the high-leverage
list stayed intact.

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

## Per-package trim status

Update this table when you trim a package. Keep entries terse — full data
is in the JSON dump at the time of commit.

| Package | Status | Tests before → after | Coverage before → after | Date | Notes |
|---|---|---|---|---|---|
| _none yet_ | | | | | |

## Suggested order of attack

Roughly smallest to largest, validating the workflow on small packages
before tackling monoliths:

1. **`framework/core`** (39 tests, 311 test lines) — proof of workflow.
2. **`framework/arbor`** (113 tests, 1,833 test lines) — small monolith.
3. **`plugins/stacks`** (99 tests, 13 test lines visible — most is the
   conformance suite) — high coverage already, low priority.
4. Mid-size plugins: `tools`, `codexes`, `copilot`, `lattice`, `lattice-discord`,
   `fabricator`, `loom`.
5. Larger plugins: `oculus`, `parlour`, `cartograph`, `claude-code`,
   `sentinel`, `astrolabe`, `clockworks`, `reckoner`.
6. Top three by test volume: `clerk` (7,148 lines), `clockworks` again if
   needed, **`spider`** (18,714 lines, the headline target).

For the bigger packages, expect first-pass redundancy in the **30–60%**
range based on the early `framework/core` (74%) and `framework/arbor`
(52%) results. Spider in particular has the highest test volume in the
monorepo and the lowest coverage-to-volume ratio (70.7% line coverage
from 18.7k test lines), making it the largest expected win.

## Related

- [`scripts/test-uniqueness.ts`](../../scripts/test-uniqueness.ts) — the analyzer source.
- [`scripts/coverage-report.ts`](../../scripts/coverage-report.ts) — the aggregator + threshold gate.
- `pnpm coverage` — full pipeline (test + aggregate + threshold check).
- The aggregate floor (`THRESHOLDS` in `coverage-report.ts`): 67% lines /
  80% branches / 53% functions.
