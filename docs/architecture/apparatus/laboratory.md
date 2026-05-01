# The Laboratory — API Contract

Status: **Draft — MVP**

Package: `@shardworks/laboratory-apparatus` · Plugin id: `laboratory`

> **⚠️ MVP scope.** First implementation ships one writ type (`trial`),
> one canonical rig template (`post-and-collect-default`), the
> fixture/scenario/probe/archive engine set (subprocess shell-out for
> guild & codex bootstrap), three standard probes, three retrieval
> tools, and the on-demand extract pipeline. The higher-level
> `experiment` writ type that groups multiple trials is parked for v2;
> custom rig templates are extensible via plugin contribution but no
> alternate template ships in v1. Probes bundle in this package for
> MVP with per-probe directories so a future per-plugin lift is
> mechanical.

The canonical specification lives at `packages/laboratory/README.md`.
This document focuses on the apparatus's place in the guild
architecture and its kit-vocabulary contract; consult the README for
exhaustive book schemas, the archive design, and probe/extract
contracts.

---

## Purpose

The Laboratory turns trial-shaped experiments — running a guild
configuration under controlled conditions and capturing what
happened — into typed, reproducible apparatus output. It exists for
two audiences:

- **Nexus dev.** Cost/quality tuning, prompt evaluation, plugin
  variant comparison. Replaces a previous standalone-bash spec
  (archived at `nexus-mk2/docs/archive/deprecated-docs/experimental-
  infrastructure-setup-and-artifacts.md`).
- **End users.** Evaluate prompts, plugins, and config variants by
  authoring trial manifests against a stable apparatus surface.

The Laboratory does **not** decide what an experiment means, judge a
trial's outcome, or analyze captured data. It bootstraps disposable
fixtures, runs the workload, captures data, archives an index, and
provides retrieval tooling. Analysis is a downstream activity that
reads the apparatus's books or extracted directories.

---

## Dependencies

```
requires:    ['stacks', 'clerk', 'spider', 'fabricator']
recommends:  ['codexes', 'animator']
```

- **Stacks** — the persistence substrate for the three laboratory
  books (`lab-trial-archives`, `lab-trial-stacks-dumps`,
  `lab-trial-codex-commits`).
- **Clerk** — `trial` writ-type registration; the manifest CLI uses
  Clerk to post the writ + stamp `ext.laboratory.config`.
- **Spider** — the rig-template execution engine. The Laboratory's
  `post-and-collect-default` template enumerates five phase
  orchestrators that Spider crawls.
- **Fabricator** — engine design registration. `lab-trial-extract`
  resolves probe engines via `FabricatorApi.getEngineDesign` and
  dispatches by structural type-guard (no separate probe registry).
- **Codexes** — the lab-host's Scriptorium is required at engine-
  execution time for `lab.codex-setup` / `lab.codex-teardown`.
  `recommends` so a guild can start the Laboratory without Codexes
  installed; trials that touch the codex fixture surface fail when
  the engine runs.
- **Animator** — same recommends rationale: trials whose scenario
  produces sessions need Animator running in the test guild, but the
  Laboratory itself runs no sessions in the lab-host.

---

## Kit Interface

The Laboratory contributes no new kit-vocabulary type. Plugins that
want to author custom probes or alternate scenarios contribute
through existing seams:

- `engines` (Fabricator) — for new probe engines that satisfy the
  `ProbeEngineDesign` structural shape (`EngineDesign` plus an
  `extract(args) → { files }` method).
- `books` (Stacks) — for plugins that own a probe-specific book.
- `rigTemplates` / `rigTemplateMappings` (Spider) — for alternate
  trial flows beyond `post-and-collect-default`.

A future kit type (`probes`) might explicitly declare extraction
handlers, but for MVP the structural-subtype approach (probe engines
have an `extract()` method; the trial-extract tool dispatches via
type guard) avoids a parallel registry.

---

## Support Kit

```typescript
supportKit: {
  engines: {
    // Phase orchestrators (template backbone)
    'lab.setup-phase': ...,
    'lab.scenario-phase': ...,
    'lab.probes-phase': ...,
    'lab.archive-phase': ...,
    'lab.teardown-phase': ...,

    // Fixture engines
    'lab.codex-setup': ..., 'lab.codex-teardown': ...,
    'lab.guild-setup': ..., 'lab.guild-teardown': ...,

    // Scenario engines
    'lab.commission-post-xguild': ...,
    'lab.wait-for-writ-terminal-xguild': ...,

    // Probes
    'lab.probe-stacks-dump': ...,
    'lab.probe-git-range': ...,
    'lab.probe-trial-context': ...,

    // Archive
    'lab.archive': ...,
  },
  rigTemplates: {
    'post-and-collect-default': ...,  // five-phase backbone
  },
  rigTemplateMappings: { trial: 'post-and-collect-default' },
  tools: [
    labTrialPost,         // nsg lab trial-post <manifest>
    labTrialShow,         // nsg lab trial-show <trialId>
    labTrialExtract,      // nsg lab trial-extract <trialId> --to <path>
    labTrialExportBook,   // nsg lab trial-export-book <trialId> --book <name>
  ],
  books: {
    'lab-trial-archives':       { indexes: ['trialId', 'archivedAt'] },
    'lab-trial-stacks-dumps':   { indexes: ['trialId', 'sourceBook', ['trialId', 'sourceBook']] },
    'lab-trial-codex-commits':  { indexes: ['trialId', ['trialId', 'sequence']] },
  },
}
```

---

## Architecture

The Laboratory is a stack of three layers, all sitting between the
patron-side manifest (sanctum YAML) and the captured trial data
(lab-host books):

### 1. Authoring — `LaboratoryTrialConfig`

A trial is a single execution unit posted as a `trial` writ. Its
`ext.laboratory.config` declares fixtures (DAG), scenario, probes,
and archive — verbatim mirror of the YAML manifest the patron
authors. The `lab-trial-post` tool validates the manifest, posts the
writ, stamps the config, and (unless `--draft`) transitions
`new → open` so the rig fires.

### Test-guild bootstrap

Trials are reproducibility artifacts: the manifest is archived and
must re-resolve to the same artifacts months later. The Laboratory
enforces this in two ways:

**Stable plugin pins.** The manifest CLI rejects unstable pin forms
at load time — `file:`/`link:`/`workspace:`/version ranges/dist-tags
all fail with specific reasons. Whitelist: exact semver,
`git+<url>#<sha>` (any scheme including `git+file://`), GitHub
shorthand `foo/bar#<sha>`, registry tarball URLs.

**Version-true bootstrap.** `lab.guild-setup` runs:

```sh
npx -p @shardworks/nexus@<frameworkVersion> nsg init <testGuild>
```

— the trial-pinned framework's `init` against the trial-pinned
`VERSION` constant. After this, the test guild has the framework in
its own `node_modules`; the binstub at `<testGuild>/node_modules/.bin/nsg`
is the version-true CLI, used for every subsequent shellout (plugin
install, codex add, commission-post, writ-show). The lab-host needs
only Node + npx — no global `nsg`, no lab-host-side framework
install, no version coordination between lab-host and test guild.

`frameworkVersion` resolution: manifest field if set, otherwise
fall back to the lab-host's installed `@shardworks/nexus-core`
VERSION. Refuses to fall back to `'0.0.0'` (dev source) — manifest
authors must pin explicitly when running on a dev lab-host. The
resolved value is written back into the trial writ's
`ext.laboratory.config` before publish so the archive snapshot
captures the actual pin used.

### 2. Execution — five-phase rig template

`post-and-collect-default` is the canonical template. Its engine
list is five phase orchestrators in sequence:

```
setup-phase → scenario-phase → probes-phase → archive-phase → teardown-phase
```

Each phase orchestrator reads `writ.ext.laboratory.config`, computes
its phase's graft, and returns immediately. The grafted engines do
the real work; phase orchestrators are organizational. The split
into five named phases gives per-phase failure visibility (oculus
shows `lab.probes-phase failed`, not "the orchestrator failed
somewhere") and an extension point: a custom rig template can slot a
`lab.warmup-phase` between any two without forking a god orchestrator.

`graftTail` is set only on `lab.teardown-phase`. Intermediate phases
let the next phase fire immediately when the prior orchestrator
returns; real work-engines wait on explicit upstream refs.

### 3. Capture — DB-authoritative archive

The archive subsystem is **DB-authoritative with on-demand
filesystem materialization.** Captured data lives in the lab guild's
stacks DB; the filesystem story is provided by the `lab-trial-extract`
tool that reads from books on demand.

Three books participate:

- **`lab-trial-archives`** — owned by `lab.archive`. One row per
  trial: `{ id, trialId (FK → clerk/writs.id), archivedAt,
  probes: [{ id, engineId, summary }] }`. Archive engine has no
  schema opinions about probe data.
- **`lab-trial-stacks-dumps`** — owned by `lab.probe-stacks-dump`.
  One row per source-row across every book in the test guild.
  Generic JSON-bodied; querying via SQLite JSON1 expressions.
- **`lab-trial-codex-commits`** — owned by `lab.probe-git-range`.
  One row per captured commit, body is the patch text. Big-diff
  tripwire: any single diff over 10MB fails the probe.

Atomicity is **per-engine, not per-trial.** The rig grafts probes
ahead of archive as separate engines; each probe writes its bulk
data atomically inside its own SQLite transaction; archive writes
its index row atomically once. Trials whose rigs fail before
reaching archive have no `lab-trial-archives` row; orphan probe
rows are tolerated and filtered out by analytical queries (every
join starts from `lab-trial-archives`). Cleanup of orphan probe
rows is future polish.

The teardown engines (`lab.guild-teardown`, `lab.codex-teardown`)
refuse to run unless a `lab-trial-archives` row exists for the
trial — implemented in `archive/presence.ts`. The check is rooted
in persistent state, not the in-flight upstream chain, so any rig-
assembly mistake that routes teardowns around the archive engine
is caught at runtime.

---

## Probe extraction-dispatch

Probes are engine designs with an extra `extract()` method:

```typescript
interface ProbeEngineDesign extends EngineDesign {
  run(givens, context): Promise<EngineRunResult>;
  extract(args: {
    trialId: string;
    targetDir: string;
  }): Promise<{ files: Array<{ path: string; bytes: number }> }>;
}

function isProbeEngineDesign(d: EngineDesign): d is ProbeEngineDesign {
  return typeof d.extract === 'function';
}
```

The `lab-trial-extract` tool walks the archive row's `probes[]` and:

1. Looks up each probe by `engineId` via `FabricatorApi.getEngineDesign`.
2. Confirms the design satisfies `isProbeEngineDesign` (type guard).
3. Invokes `extract({ trialId, targetDir })` to materialize the
   probe's captured data.

No separate probe registry. The Fabricator already catalogues every
engine; the type guard is the seam. Engines without `extract()` are
silently reported as `skippedProbes` (defensive — a non-probe engine
should never appear in an archive row's probe list, but the tool
handles it cleanly).

The extract tool also writes two top-level files generated from
archive metadata: `manifest.yaml` (the trial writ's
`ext.laboratory.config` verbatim) and `README.md` (archive metadata
+ probe summaries). It refuses to overwrite a non-empty target
directory unless `--force` is supplied.

---

## CLI surface

With four `lab-` tools registered, the framework's auto-grouping
(see `instrumentarium.md`) activates and surfaces them under `nsg lab`:

- `nsg lab trial-post <manifest>` — post a trial writ from a YAML
  manifest. Validates schema, fixture DAG, and probe id uniqueness.
- `nsg lab trial-show <trialId>` — print the archive row + probe
  summaries from `lab-trial-archives`.
- `nsg lab trial-extract <trialId> --to <path> [--force]` —
  materialize all captured data to a directory.
- `nsg lab trial-export-book <trialId> --book <name> [--format jsonl|json]`
  — stream one source book for analysis pipelines.

For programmatic analysis without going through extract, scripts can
attach the lab guild's stacks DB directly (DuckDB reads SQLite
natively) and query `lab-trial-stacks-dumps` /
`lab-trial-codex-commits` with JSON1 expressions.

---

## Configuration

```typescript
interface LaboratoryConfig {
  reserved?: never;  // No fields read in v1.
}

declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    laboratory?: LaboratoryConfig;
  }
}
```

Trial-specific configuration lives on individual writs at
`ext.laboratory.config`, not in `guild.json`. The `laboratory` block
is reserved for future global lab settings (default codex org,
extract-output base path, etc.).

---

## Future

- **`experiment` writ type.** Groups multiple trials under a parent;
  enables comparative analysis across variants. Trial state machine
  was authored mandate-shaped from day one to support nesting under
  an experiment parent without a config-level migration.
- **Per-plugin probe lifts.** Built-in probes already organize per-
  directory under `src/probes/<name>/`. When a third-party probe
  forces the issue (or a built-in probe grows enough to warrant a
  separate package), the lift is a mechanical move — no
  architectural surgery.
- **Failed-trial orphan cleanup.** Setup engines may grab a release-
  on-rig-terminal handle so codex/guild fixtures clean up even when
  the rig fails before reaching archive. (Currently failed rigs
  leave orphan codexes in the lab-host's Scriptorium and orphan
  guild dirs on disk.)
- **Daemon ↔ CLI Scriptorium state coordination.** `nsg codex remove`
  from the CLI runs in a separate process and updates `guild.json`,
  but the running daemon's in-memory Scriptorium state isn't
  notified; the daemon's next `guild.json` write reverts orphan
  removals. Cosmetic for now (orphans don't run code) but means
  CLI-side cleanup needs a daemon restart to stick.

---

## Implementation Notes

- The probe `extract()` handler reads back from the per-probe book
  in the lab-host's Stacks (via `guild().apparatus<StacksApi>`).
  This is the same API surface the `run()` method writes through —
  symmetric, no extra abstractions.
- `lab.probe-stacks-dump` opens the test guild's `nexus.db` directly
  via `better-sqlite3` (already a transitive dep through Stacks)
  rather than shelling out to `nsg writ-list` etc. The probe runs
  in the lab-host process; the test guild's DB is read-only-attached
  for the duration of the probe.
- `lab.probe-git-range` walks `git rev-list --reverse base..head`
  in the codex bare repo. The bare's `main` ref is updated as the
  test guild seals — re-reading `main` at probe time gives the
  current head SHA without requiring the test guild to publish it.
- The codified pipeline smoke test
  (`packages/laboratory/src/integration.test.ts`) exercises probe →
  archive → teardown gating → extract end-to-end without spinning
  up the full Spider stack and without subprocess shell-out.
  Subprocess fixture engines (codex-setup, guild-setup,
  commission-post-xguild) and probe engines that need a real test
  guild on disk (probe-stacks-dump, probe-git-range) are exercised
  by live verifies and ported real-world trials.
