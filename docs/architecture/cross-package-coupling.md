# Cross-package coupling snapshot

> **Generated snapshot — do not hand-edit.** This file is produced by
> `pnpm coupling-audit` from `scripts/cross-package-coupling.ts` and is
> regenerated rather than maintained. It is not an architecture spec.

## Methodology

- **Snapshot date (UTC):** 2026-04-25T18:47:36.895Z
- **Git SHA:** `caf9ecc76b3c2b18916b26d7498547896cfb1305` **(working tree dirty — regenerate from a clean SHA before committing)**
- **Files scanned:** 333 `.ts` files (229 source, 104 test)
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
| animator | 44 | 77 | 121 | 21 | 34 | 23 | 43 |
| astrolabe | 0 | 65 | 65 | 0 | 36 | 0 | 29 |
| claude-code | 0 | 16 | 16 | 0 | 11 | 0 | 5 |
| clerk | 77 | 46 | 123 | 28 | 35 | 49 | 11 |
| clockworks | 6 | 82 | 88 | 4 | 21 | 2 | 61 |
| codexes | 2 | 22 | 24 | 2 | 20 | 0 | 2 |
| copilot | 0 | 8 | 8 | 0 | 4 | 0 | 4 |
| fabricator | 50 | 3 | 53 | 23 | 1 | 27 | 2 |
| lattice | 12 | 21 | 33 | 3 | 9 | 9 | 12 |
| lattice-discord | 1 | 4 | 5 | 0 | 3 | 1 | 1 |
| loom | 9 | 6 | 15 | 6 | 4 | 3 | 2 |
| nexus | 0 | 34 | 34 | 0 | 28 | 0 | 6 |
| nexus-arbor | 2 | 5 | 7 | 2 | 3 | 0 | 2 |
| nexus-core | 282 | 0 | 282 | 153 | 0 | 129 | 0 |
| oculus | 0 | 13 | 13 | 0 | 5 | 0 | 8 |
| parlour | 0 | 22 | 22 | 0 | 14 | 0 | 8 |
| ratchet | 0 | 37 | 37 | 0 | 32 | 0 | 5 |
| reckoner | 0 | 47 | 47 | 0 | 7 | 0 | 40 |
| spider | 3 | 255 | 258 | 2 | 118 | 1 | 137 |
| stacks | 185 | 2 | 187 | 52 | 2 | 133 | 0 |
| tools | 102 | 10 | 112 | 93 | 2 | 9 | 8 |

## Top 10 inbound

Packages most frequently imported _from_ — the universal-substrate signal.

| rank | plugin id | inbound edges |
| ---: | --- | ---: |
| 1 | nexus-core | 282 |
| 2 | stacks | 185 |
| 3 | tools | 102 |
| 4 | clerk | 77 |
| 5 | fabricator | 50 |
| 6 | animator | 44 |
| 7 | lattice | 12 |
| 8 | loom | 9 |
| 9 | clockworks | 6 |
| 10 | spider | 3 |

## Top 10 outbound

Packages that import _from_ the most other packages — the tangled-client signal.

| rank | plugin id | outbound edges |
| ---: | --- | ---: |
| 1 | spider | 255 |
| 2 | clockworks | 82 |
| 3 | animator | 77 |
| 4 | astrolabe | 65 |
| 5 | reckoner | 47 |
| 6 | clerk | 46 |
| 7 | ratchet | 37 |
| 8 | nexus | 34 |
| 9 | codexes | 22 |
| 10 | parlour | 22 |

## Top 10 pairs

Heaviest directed package pairs A → B, ranked by import-line count.

| rank | from | to | import lines |
| ---: | --- | --- | ---: |
| 1 | spider | nexus-core | 71 |
| 2 | spider | stacks | 61 |
| 3 | spider | fabricator | 39 |
| 4 | spider | clerk | 38 |
| 5 | clockworks | nexus-core | 32 |
| 6 | clockworks | stacks | 32 |
| 7 | animator | stacks | 30 |
| 8 | animator | nexus-core | 28 |
| 9 | spider | animator | 26 |
| 10 | clerk | nexus-core | 22 |
