# Cross-package coupling snapshot

> **Generated snapshot — do not hand-edit.** This file is produced by
> `pnpm coupling-audit` from `scripts/cross-package-coupling.ts` and is
> regenerated rather than maintained. It is not an architecture spec.

## Methodology

- **Snapshot date (UTC):** 2026-04-25T13:43:24.983Z
- **Git SHA:** `d6f68e7e001f1b1a6ac06049eeca0b4e6a852389`
- **Files scanned:** 331 `.ts` files (228 source, 103 test)
- **Regeneration command:** `pnpm coupling-audit`

### Counting rules

- One edge per import line. The unit is the line carrying the
  `from '@shardworks/...'` clause (or, for dynamic imports, the line
  carrying `import('@shardworks/...')`).
- `import type` statements are counted indistinguishably from value
  imports — same orientation cost.
- `export ... from '@shardworks/...'` re-exports are counted as edges.
- Dynamic `await import('@shardworks/...')` calls are counted as edges.
- Subpath imports (e.g. `@shardworks/stacks-apparatus/testing`) are
  collapsed to the parent package — the boundary is the package, not
  the subpath.
- Self-imports (a package importing its own npm name) are excluded.
- A file is classified as a **test** when its filename matches
  `\.test\.ts$`; everything else is **source**.
- Only `*.ts` source files under the workspace globs in
  `pnpm-workspace.yaml` are scanned. Markdown, JSON, and YAML files are
  not — README example imports are noise.
- Plugin ids in this report are derived from each npm package name by
  stripping the `@shardworks/` scope and any trailing
  `-(plugin|apparatus|kit)` suffix. See
  `docs/architecture/index.md#plugin-ids`.

## Per-package summary

| plugin id | inbound | outbound | total | src in | src out | test in | test out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| animator | 43 | 77 | 120 | 20 | 34 | 23 | 43 |
| astrolabe | 0 | 63 | 63 | 0 | 34 | 0 | 29 |
| claude-code | 0 | 14 | 14 | 0 | 9 | 0 | 5 |
| clerk | 80 | 46 | 126 | 28 | 35 | 52 | 11 |
| clockworks | 5 | 81 | 86 | 3 | 20 | 2 | 61 |
| clockworks-retry | 6 | 23 | 29 | 0 | 6 | 6 | 17 |
| codexes | 2 | 22 | 24 | 2 | 20 | 0 | 2 |
| copilot | 0 | 8 | 8 | 0 | 4 | 0 | 4 |
| fabricator | 52 | 3 | 55 | 23 | 1 | 29 | 2 |
| lattice | 12 | 21 | 33 | 3 | 9 | 9 | 12 |
| lattice-discord | 1 | 4 | 5 | 0 | 3 | 1 | 1 |
| loom | 9 | 6 | 15 | 6 | 4 | 3 | 2 |
| nexus | 0 | 31 | 31 | 0 | 26 | 0 | 5 |
| nexus-arbor | 2 | 5 | 7 | 2 | 3 | 0 | 2 |
| nexus-core | 280 | 0 | 280 | 150 | 0 | 130 | 0 |
| oculus | 0 | 13 | 13 | 0 | 5 | 0 | 8 |
| parlour | 0 | 22 | 22 | 0 | 14 | 0 | 8 |
| ratchet | 0 | 37 | 37 | 0 | 32 | 0 | 5 |
| reckoner | 0 | 53 | 53 | 0 | 7 | 0 | 46 |
| spider | 6 | 247 | 253 | 4 | 114 | 2 | 133 |
| stacks | 190 | 2 | 192 | 52 | 2 | 138 | 0 |
| tools | 100 | 10 | 110 | 91 | 2 | 9 | 8 |

## Top 10 inbound

Packages most frequently imported _from_ — the universal-substrate signal.

| rank | plugin id | inbound edges |
| ---: | --- | ---: |
| 1 | nexus-core | 280 |
| 2 | stacks | 190 |
| 3 | tools | 100 |
| 4 | clerk | 80 |
| 5 | fabricator | 52 |
| 6 | animator | 43 |
| 7 | lattice | 12 |
| 8 | loom | 9 |
| 9 | clockworks-retry | 6 |
| 10 | spider | 6 |

## Top 10 outbound

Packages that import _from_ the most other packages — the tangled-client signal.

| rank | plugin id | outbound edges |
| ---: | --- | ---: |
| 1 | spider | 247 |
| 2 | clockworks | 81 |
| 3 | animator | 77 |
| 4 | astrolabe | 63 |
| 5 | reckoner | 53 |
| 6 | clerk | 46 |
| 7 | ratchet | 37 |
| 8 | nexus | 31 |
| 9 | clockworks-retry | 23 |
| 10 | codexes | 22 |

## Top 10 pairs

Heaviest directed package pairs A → B, ranked by import-line count.

| rank | from | to | import lines |
| ---: | --- | --- | ---: |
| 1 | spider | nexus-core | 68 |
| 2 | spider | stacks | 59 |
| 3 | spider | fabricator | 39 |
| 4 | spider | clerk | 36 |
| 5 | clockworks | stacks | 32 |
| 6 | clockworks | nexus-core | 31 |
| 7 | animator | stacks | 30 |
| 8 | animator | nexus-core | 28 |
| 9 | spider | animator | 26 |
| 10 | clerk | nexus-core | 22 |
