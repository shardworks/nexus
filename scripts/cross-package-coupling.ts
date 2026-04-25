#!/usr/bin/env node
/**
 * cross-package-coupling.ts — Generate the cross-package import-coupling
 * snapshot at docs/architecture/cross-package-coupling.md.
 *
 * Single-purpose audit script. No CLI flags, no third-party dependencies, no
 * side effects beyond writing the canonical output path. Run via:
 *
 *   pnpm coupling-audit
 *
 * Methodology, counting rules, and decision rationale: see the spec captured
 * in docs/architecture/cross-package-coupling.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Repo root resolution ───────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ── Workspace discovery ────────────────────────────────────────────────────

/**
 * A discovered workspace package.
 */
export interface DiscoveredPackage {
  /** Absolute path to the package directory. */
  dir: string;
  /** Package directory path relative to the repo root. */
  relDir: string;
  /** npm name as declared in package.json (e.g. `@shardworks/spider-apparatus`). */
  npmName: string;
  /** Display label (e.g. `spider`). See {@link toPluginId}. */
  pluginId: string;
}

/**
 * Read pnpm-workspace.yaml with a small inline line-based reader.
 *
 * The shape is fixed at two glob lines today (`packages/framework/*` and
 * `packages/plugins/*`) and a `packages:` header — anything more elaborate
 * indicates a structural change and should fail loudly via the assertions in
 * this function.
 */
export function readWorkspaceGlobs(workspaceYamlPath: string): string[] {
  const text = fs.readFileSync(workspaceYamlPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, ''); // strip comments
    if (/^\s*$/.test(line)) continue;
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (match) {
        globs.push(match[1]);
        continue;
      }
      // Non-list line under packages: treat as end-of-section.
      if (/^\S/.test(line)) {
        inPackages = false;
      }
    }
  }
  if (globs.length === 0) {
    throw new Error(`No workspace globs found in ${workspaceYamlPath}`);
  }
  return globs;
}

/**
 * Expand a workspace glob like `packages/framework/*` to the list of matching
 * directories that contain a package.json file.
 *
 * Only the simple "single trailing `*`" shape is supported — that is what the
 * workspace uses today.
 */
export function expandGlob(repoRoot: string, glob: string): string[] {
  if (!glob.endsWith('/*')) {
    throw new Error(`Unsupported workspace glob shape: ${glob}`);
  }
  const parentRel = glob.slice(0, -2);
  const parentAbs = path.resolve(repoRoot, parentRel);
  if (!fs.existsSync(parentAbs)) return [];
  const entries = fs.readdirSync(parentAbs, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(parentAbs, entry.name);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      dirs.push(dir);
    }
  }
  dirs.sort();
  return dirs;
}

/**
 * Apply the plugin-id derivation rule:
 *   1. Strip the `@shardworks/` scope.
 *   2. Retain other scopes as a prefix (`@acme/foo` → `acme/foo`).
 *   3. Strip a trailing `-(plugin|apparatus|kit)` suffix.
 */
export function toPluginId(npmName: string): string {
  let id = npmName;
  if (id.startsWith('@shardworks/')) {
    id = id.slice('@shardworks/'.length);
  } else if (id.startsWith('@')) {
    // Strip the leading `@` but keep the scope-as-prefix shape.
    id = id.slice(1);
  }
  id = id.replace(/-(plugin|apparatus|kit)$/, '');
  return id;
}

/**
 * Discover every workspace package declared in pnpm-workspace.yaml.
 */
export function discoverPackages(repoRoot: string): DiscoveredPackage[] {
  const workspaceYaml = path.join(repoRoot, 'pnpm-workspace.yaml');
  const globs = readWorkspaceGlobs(workspaceYaml);
  const dirs: string[] = [];
  for (const glob of globs) {
    for (const dir of expandGlob(repoRoot, glob)) {
      dirs.push(dir);
    }
  }
  const packages: DiscoveredPackage[] = [];
  for (const dir of dirs) {
    const pkgJsonPath = path.join(dir, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
    if (typeof pkgJson.name !== 'string' || pkgJson.name.length === 0) {
      throw new Error(`Missing or invalid "name" in ${pkgJsonPath}`);
    }
    packages.push({
      dir,
      relDir: path.relative(repoRoot, dir),
      npmName: pkgJson.name,
      pluginId: toPluginId(pkgJson.name),
    });
  }
  packages.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  return packages;
}

// ── Import parser ──────────────────────────────────────────────────────────

/**
 * Matches the `from '@shardworks/<spec>'` token used by both `import ... from`
 * and `export ... from` clauses. Single-line; the workspace has no imports
 * that split the `from` token from its specifier across lines.
 */
const FROM_PATTERN = /\bfrom\s+['"](@shardworks\/[^'"\n]+)['"]/g;

/**
 * Matches dynamic `import('@shardworks/<spec>')` calls (typically inside an
 * `await import(...)` expression).
 */
const DYNAMIC_PATTERN = /\bimport\s*\(\s*['"](@shardworks\/[^'"\n]+)['"]/g;

/**
 * One parsed import edge: the file contributes one edge per matched line. The
 * target is the @shardworks/* npm name (with subpath collapsed to the parent
 * package — see {@link collapseToParent}).
 */
export interface ParsedEdge {
  /** 1-indexed line number where the edge was matched. */
  line: number;
  /** The full matched specifier, e.g. `@shardworks/stacks-apparatus`. */
  rawSpec: string;
  /** The collapsed parent npm name, e.g. `@shardworks/stacks-apparatus`. */
  target: string;
}

/**
 * Collapse a possibly-subpath @shardworks/* specifier down to its parent npm
 * name. `@shardworks/stacks-apparatus/testing` becomes
 * `@shardworks/stacks-apparatus`.
 */
export function collapseToParent(spec: string): string {
  if (!spec.startsWith('@shardworks/')) return spec;
  const rest = spec.slice('@shardworks/'.length);
  const slash = rest.indexOf('/');
  return slash === -1
    ? `@shardworks/${rest}`
    : `@shardworks/${rest.slice(0, slash)}`;
}

/**
 * Parse a TypeScript source string and yield one {@link ParsedEdge} per line
 * that mentions an `@shardworks/*` import. The same line can contribute more
 * than one edge if it contains multiple matches (rare but legal).
 *
 * The parser is deliberately syntactic, not semantic — the limitations
 * documented in the methodology header (false positives inside string
 * literals or block comments) are accepted in exchange for zero third-party
 * dependencies.
 */
export function parseImports(source: string): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of [FROM_PATTERN, DYNAMIC_PATTERN]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const rawSpec = match[1];
        edges.push({
          line: i + 1,
          rawSpec,
          target: collapseToParent(rawSpec),
        });
      }
    }
  }
  return edges;
}

// ── Source-file walking ────────────────────────────────────────────────────

/**
 * Recursively yield every `*.ts` file under `dir`. Hidden directories,
 * `node_modules`, and `dist` directories are skipped — they cannot contain
 * fresh source for the audit. Symlinks are not followed.
 */
export function* walkTsFiles(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.name.startsWith('.')) continue;
      yield* walkTsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Filename convention used to classify a file as a test. Repo convention
 * matches both `*.test.ts` and `*.integration.test.ts`.
 */
const TEST_FILENAME_RE = /\.test\.ts$/;

/**
 * One file scanned by the audit, paired with the @shardworks/* edges it
 * carries.
 */
export interface ScannedFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the repo root. */
  relPath: string;
  /** The owning package's npm name. */
  ownerNpmName: string;
  /** True if the filename matches {@link TEST_FILENAME_RE}. */
  isTest: boolean;
  /** All @shardworks/* edges parsed from this file (one per import line). */
  edges: ParsedEdge[];
}

/**
 * Scan every `.ts` file under each package's directory, parse its imports,
 * and return the flat list of {@link ScannedFile}s. Throws if a file cannot
 * be read or if it carries an `@shardworks/*` import that does not resolve
 * to any discovered package.
 */
export function scanWorkspace(
  repoRoot: string,
  packages: DiscoveredPackage[],
): ScannedFile[] {
  const known = new Set(packages.map((p) => p.npmName));
  const files: ScannedFile[] = [];
  for (const pkg of packages) {
    for (const file of walkTsFiles(pkg.dir)) {
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch (err) {
        const rel = path.relative(repoRoot, file);
        throw new Error(`Failed to read ${rel}: ${(err as Error).message}`);
      }
      const edges = parseImports(source);
      for (const edge of edges) {
        if (!known.has(edge.target)) {
          const rel = path.relative(repoRoot, file);
          throw new Error(
            `Unknown @shardworks/* target "${edge.target}" referenced in ${rel}:${edge.line}`,
          );
        }
      }
      files.push({
        path: file,
        relPath: path.relative(repoRoot, file),
        ownerNpmName: pkg.npmName,
        isTest: TEST_FILENAME_RE.test(path.basename(file)),
        edges,
      });
    }
  }
  return files;
}

// ── Aggregation ────────────────────────────────────────────────────────────

/**
 * Per-package totals broken out into source/test buckets. Plugin-id keyed.
 */
export interface PackageSummary {
  pluginId: string;
  npmName: string;
  inboundSrc: number;
  inboundTest: number;
  outboundSrc: number;
  outboundTest: number;
}

/**
 * One ranked entry in the inbound or outbound top-N tables.
 */
export interface RankingEntry {
  pluginId: string;
  count: number;
}

/**
 * One ranked entry in the A→B pair-weight top-N table.
 */
export interface PairEntry {
  fromPluginId: string;
  toPluginId: string;
  count: number;
}

/**
 * The complete set of report sections.
 */
export interface Aggregations {
  /** Per-package summary, sorted alphabetically by plugin id. */
  perPackage: PackageSummary[];
  /** Top-10 inbound by combined edge count. */
  topInbound: RankingEntry[];
  /** Top-10 outbound by combined edge count. */
  topOutbound: RankingEntry[];
  /** Top-10 A→B pairs by import-line count. */
  topPairs: PairEntry[];
  /** Total .ts files scanned. */
  totalFiles: number;
  /** Total source (non-test) .ts files scanned. */
  sourceFiles: number;
  /** Total test .ts files scanned. */
  testFiles: number;
}

/**
 * Compute the four report aggregations from the scanned-file list.
 */
export function aggregate(
  packages: DiscoveredPackage[],
  files: ScannedFile[],
): Aggregations {
  const npmToPluginId = new Map(packages.map((p) => [p.npmName, p.pluginId]));

  const init = (): PackageSummary => ({
    pluginId: '',
    npmName: '',
    inboundSrc: 0,
    inboundTest: 0,
    outboundSrc: 0,
    outboundTest: 0,
  });
  const perPackageMap = new Map<string, PackageSummary>();
  for (const pkg of packages) {
    const sum = init();
    sum.pluginId = pkg.pluginId;
    sum.npmName = pkg.npmName;
    perPackageMap.set(pkg.npmName, sum);
  }

  const pairCounts = new Map<string, number>(); // key: `${from}|${to}`

  let totalFiles = 0;
  let sourceFiles = 0;
  let testFiles = 0;

  for (const file of files) {
    totalFiles += 1;
    if (file.isTest) testFiles += 1;
    else sourceFiles += 1;

    const owner = perPackageMap.get(file.ownerNpmName);
    if (!owner) {
      throw new Error(
        `Internal error: file ${file.relPath} has unknown owner ${file.ownerNpmName}`,
      );
    }

    for (const edge of file.edges) {
      // Self-imports are not cross-package edges; skip.
      if (edge.target === file.ownerNpmName) continue;

      const target = perPackageMap.get(edge.target);
      if (!target) {
        // Should already have been caught by scanWorkspace, but defensively
        // throw here too rather than producing silently wrong totals.
        throw new Error(
          `Unknown @shardworks/* target "${edge.target}" in ${file.relPath}:${edge.line}`,
        );
      }

      if (file.isTest) {
        owner.outboundTest += 1;
        target.inboundTest += 1;
      } else {
        owner.outboundSrc += 1;
        target.inboundSrc += 1;
      }

      const fromId = owner.pluginId;
      const toId = target.pluginId;
      const key = `${fromId}|${toId}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }

  const perPackage = [...perPackageMap.values()].sort((a, b) =>
    a.pluginId.localeCompare(b.pluginId),
  );

  const inboundTotal = (s: PackageSummary): number => s.inboundSrc + s.inboundTest;
  const outboundTotal = (s: PackageSummary): number => s.outboundSrc + s.outboundTest;

  const topInbound = perPackage
    .filter((s) => inboundTotal(s) > 0)
    .map((s) => ({ pluginId: s.pluginId, count: inboundTotal(s) }))
    .sort((a, b) => b.count - a.count || a.pluginId.localeCompare(b.pluginId))
    .slice(0, 10);

  const topOutbound = perPackage
    .filter((s) => outboundTotal(s) > 0)
    .map((s) => ({ pluginId: s.pluginId, count: outboundTotal(s) }))
    .sort((a, b) => b.count - a.count || a.pluginId.localeCompare(b.pluginId))
    .slice(0, 10);

  const topPairs: PairEntry[] = [...pairCounts.entries()]
    .map(([key, count]) => {
      const [fromPluginId, toPluginId] = key.split('|');
      return { fromPluginId, toPluginId, count };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.fromPluginId.localeCompare(b.fromPluginId) ||
        a.toPluginId.localeCompare(b.toPluginId),
    )
    .slice(0, 10);

  // npmToPluginId is currently unused once aggregation finishes; reference it
  // here so future readers can see it in the closure without a "no-unused"
  // surprise after edits.
  void npmToPluginId;

  return {
    perPackage,
    topInbound,
    topOutbound,
    topPairs,
    totalFiles,
    sourceFiles,
    testFiles,
  };
}

// ── Git provenance ─────────────────────────────────────────────────────────

/**
 * The current git HEAD SHA and a flag indicating whether the working tree
 * carries uncommitted changes. The dirty flag is included in the snapshot
 * header as a fail-loud signal that the audit was taken against an
 * uncommitted tree.
 */
export interface GitProvenance {
  sha: string;
  dirty: boolean;
}

/**
 * Read the current git HEAD SHA and dirty status using `git` in the given
 * repo root. Throws if `git` is not available or fails.
 */
export function readGitProvenance(repoRoot: string): GitProvenance {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { sha, dirty: status.trim().length > 0 };
}

// ── Markdown rendering ─────────────────────────────────────────────────────

/**
 * The literal command users run to regenerate the snapshot. Documented in the
 * methodology header so the doc survives changes to the underlying node flags.
 */
const REGENERATION_COMMAND = 'pnpm coupling-audit';

/**
 * Render the report as markdown. The output is deterministic for a given
 * (packages, files, provenance) tuple aside from the snapshot date.
 */
export function renderMarkdown(
  agg: Aggregations,
  provenance: GitProvenance,
  snapshotDateIso: string,
): string {
  const lines: string[] = [];

  lines.push('# Cross-package coupling snapshot');
  lines.push('');
  lines.push(
    '> **Generated snapshot — do not hand-edit.** This file is produced by',
    `> \`${REGENERATION_COMMAND}\` from \`scripts/cross-package-coupling.ts\` and is`,
    '> regenerated rather than maintained. It is not an architecture spec.',
  );
  lines.push('');

  lines.push('## Methodology');
  lines.push('');
  lines.push(`- **Snapshot date (UTC):** ${snapshotDateIso}`);
  lines.push(
    `- **Git SHA:** \`${provenance.sha}\`${provenance.dirty ? ' **(working tree dirty — regenerate from a clean SHA before committing)**' : ''}`,
  );
  lines.push(
    `- **Files scanned:** ${agg.totalFiles} \`.ts\` files (${agg.sourceFiles} source, ${agg.testFiles} test)`,
  );
  lines.push(`- **Regeneration command:** \`${REGENERATION_COMMAND}\``);
  lines.push('');
  lines.push('### Counting rules');
  lines.push('');
  lines.push(
    '- One edge per import line. The unit is the line carrying the',
    '  `from \'@shardworks/...\'` clause (or, for dynamic imports, the line',
    '  carrying `import(\'@shardworks/...\')`).',
    '- `import type` statements are counted indistinguishably from value',
    '  imports — same orientation cost.',
    '- `export ... from \'@shardworks/...\'` re-exports are counted as edges.',
    '- Dynamic `await import(\'@shardworks/...\')` calls are counted as edges.',
    '- Subpath imports (e.g. `@shardworks/stacks-apparatus/testing`) are',
    '  collapsed to the parent package — the boundary is the package, not',
    '  the subpath.',
    '- Self-imports (a package importing its own npm name) are excluded.',
    '- A file is classified as a **test** when its filename matches',
    '  `\\.test\\.ts$`; everything else is **source**.',
    '- Only `*.ts` source files under the workspace globs in',
    '  `pnpm-workspace.yaml` are scanned. Markdown, JSON, and YAML files are',
    '  not — README example imports are noise.',
    '- Plugin ids in this report are derived from each npm package name by',
    '  stripping the `@shardworks/` scope and any trailing',
    '  `-(plugin|apparatus|kit)` suffix. See',
    '  `docs/architecture/index.md#plugin-ids`.',
  );
  lines.push('');

  lines.push('## Per-package summary');
  lines.push('');
  lines.push(
    '| plugin id | inbound | outbound | total | src in | src out | test in | test out |',
  );
  lines.push(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const s of agg.perPackage) {
    const inb = s.inboundSrc + s.inboundTest;
    const out = s.outboundSrc + s.outboundTest;
    const total = inb + out;
    lines.push(
      `| ${s.pluginId} | ${inb} | ${out} | ${total} | ${s.inboundSrc} | ${s.outboundSrc} | ${s.inboundTest} | ${s.outboundTest} |`,
    );
  }
  lines.push('');

  lines.push('## Top 10 inbound');
  lines.push('');
  lines.push(
    'Packages most frequently imported _from_ — the universal-substrate signal.',
  );
  lines.push('');
  lines.push('| rank | plugin id | inbound edges |');
  lines.push('| ---: | --- | ---: |');
  agg.topInbound.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.pluginId} | ${r.count} |`);
  });
  lines.push('');

  lines.push('## Top 10 outbound');
  lines.push('');
  lines.push(
    'Packages that import _from_ the most other packages — the tangled-client signal.',
  );
  lines.push('');
  lines.push('| rank | plugin id | outbound edges |');
  lines.push('| ---: | --- | ---: |');
  agg.topOutbound.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.pluginId} | ${r.count} |`);
  });
  lines.push('');

  lines.push('## Top 10 pairs');
  lines.push('');
  lines.push(
    'Heaviest directed package pairs A → B, ranked by import-line count.',
  );
  lines.push('');
  lines.push('| rank | from | to | import lines |');
  lines.push('| ---: | --- | --- | ---: |');
  agg.topPairs.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | ${p.fromPluginId} | ${p.toPluginId} | ${p.count} |`,
    );
  });
  lines.push('');

  return lines.join('\n');
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

/**
 * Output path for the canonical snapshot. Not configurable by design — D17
 * forbids CLI flags.
 */
const OUTPUT_REL_PATH = 'docs/architecture/cross-package-coupling.md';

/**
 * Top-level entry point. Discovers packages, scans the workspace, aggregates,
 * renders markdown, and writes the snapshot to its canonical path.
 */
export function main(): void {
  const packages = discoverPackages(REPO_ROOT);
  const files = scanWorkspace(REPO_ROOT, packages);
  const agg = aggregate(packages, files);
  const provenance = readGitProvenance(REPO_ROOT);
  const snapshotDateIso = new Date().toISOString();
  const markdown = renderMarkdown(agg, provenance, snapshotDateIso);

  const outPath = path.join(REPO_ROOT, OUTPUT_REL_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);

  process.stdout.write(
    `Wrote ${OUTPUT_REL_PATH} — ${agg.totalFiles} files scanned (${agg.sourceFiles} source, ${agg.testFiles} test); SHA ${provenance.sha}${provenance.dirty ? ' (DIRTY)' : ''}\n`,
  );
}

const isDirectInvocation = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectInvocation) {
  main();
}
