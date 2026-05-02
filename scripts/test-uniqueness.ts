#!/usr/bin/env node
/**
 * test-uniqueness.ts — Per-test coverage uniqueness analyzer.
 *
 * For a given package, attribute V8 line coverage to individual tests by
 * spawning one node process per test (filtered with --test-name-pattern),
 * then identify "redundant" tests — those whose covered lines are entirely
 * covered by other tests. Such tests can be deleted without losing line
 * coverage.
 *
 * The report lists candidates; human review is essential. Coverage
 * uniqueness identifies tests we *can* delete without losing line coverage,
 * NOT tests we *should* delete (a redundant test may assert different
 * behavior on the same lines as another).
 *
 * Usage:
 *   pnpm test:uniqueness <pkg> [options]
 *
 *   <pkg>           e.g. 'plugins/spider' or 'spider' (we resolve)
 *
 * Options:
 *   --workers N     Parallel workers (default 4, max 8)
 *   --filter REGEX  Only analyze tests whose full path matches this regex
 *   --no-cache      Ignore mtime cache, force fresh per-test runs
 *   --json-only     Skip markdown output
 *   --md-only       Skip JSON output
 *
 * Output:
 *   coverage/uniqueness/<pkg>.md     — human report (commit-friendly)
 *   coverage/uniqueness/<pkg>.json   — full matrix (gitignored, regenerable)
 *   <pkg-dir>/coverage/per-test/     — cached per-test lcov files
 *
 * Methodology, interpretation rules, and the trim workflow:
 *   docs/guides/trimming-tests.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { run } from 'node:test';
import { cpus } from 'node:os';

// ── Repo root resolution ───────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ── CLI parsing ────────────────────────────────────────────────────────────

interface Options {
  workers: number;
  filter: RegExp | null;
  noCache: boolean;
  jsonOnly: boolean;
  mdOnly: boolean;
}

function parseArgs(): { pkg: string; opts: Options } {
  const args = process.argv.slice(2);
  let pkg = '';
  const opts: Options = {
    workers: 4,
    filter: null,
    noCache: false,
    jsonOnly: false,
    mdOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workers') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 8) {
        die(`--workers must be 1..8, got ${args[i]}`);
      }
      opts.workers = n;
    } else if (a === '--filter') {
      try {
        opts.filter = new RegExp(args[++i]);
      } catch (e) {
        die(`--filter is not a valid regex: ${(e as Error).message}`);
      }
    } else if (a === '--no-cache') {
      opts.noCache = true;
    } else if (a === '--json-only') {
      opts.jsonOnly = true;
    } else if (a === '--md-only') {
      opts.mdOnly = true;
    } else if (a.startsWith('--')) {
      die(`unknown flag: ${a}`);
    } else if (!pkg) {
      pkg = a;
    } else {
      die(`unexpected positional arg: ${a}`);
    }
  }

  if (!pkg) die('usage: pnpm test:uniqueness <pkg> [options]');
  return { pkg, opts };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// ── Package resolution ─────────────────────────────────────────────────────

interface ResolvedPackage {
  /** Canonical name like 'plugins/spider' */
  name: string;
  /** Absolute path to package directory */
  dir: string;
  /** Glob(s) for test discovery, copied from package.json's `test` script */
  testGlobs: string[];
}

function resolvePackage(input: string): ResolvedPackage {
  // Accept 'spider', 'plugins/spider', 'packages/plugins/spider', or absolute.
  const candidates = [
    input,
    `plugins/${input}`,
    `framework/${input}`,
  ];
  for (const c of candidates) {
    const dir = path.isAbsolute(c) ? c : path.join(REPO_ROOT, 'packages', c);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const name = path.relative(path.join(REPO_ROOT, 'packages'), dir);
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const testScript = json.scripts?.test ?? '';
      // Extract single-quoted glob patterns from the test script: 'src/**/*.test.ts'
      const globs = [...testScript.matchAll(/'([^']+)'/g)]
        .map((m) => m[1])
        .filter((g) => g.includes('test'));
      if (globs.length === 0) {
        die(`could not find test globs in ${name}'s test script: ${testScript}`);
      }
      return { name, dir, testGlobs: globs };
    }
  }
  die(`could not resolve package: ${input}`);
}

// ── Test discovery ─────────────────────────────────────────────────────────

interface TestRecord {
  /** Path to test file relative to the package dir, e.g. 'src/foo.test.ts' */
  file: string;
  /** Suite (describe) chain leading to the test, in order */
  suitePath: string[];
  /** Test name (the `it`/`test` title) */
  name: string;
  /** Canonical full path used for display + caching */
  fullPath: string;
}

/**
 * Use node:test's programmatic API to enumerate tests in the package without
 * coverage instrumentation. The `run({ files })` stream emits 'test:pass' /
 * 'test:fail' events for each leaf test with full nesting info.
 */
async function discoverTests(pkg: ResolvedPackage): Promise<TestRecord[]> {
  // Resolve glob patterns to actual file paths
  const testFiles = await resolveGlobs(pkg.dir, pkg.testGlobs);
  if (testFiles.length === 0) {
    die(`no test files found under ${pkg.dir} matching ${pkg.testGlobs.join(', ')}`);
  }
  console.log(`Discovering tests in ${testFiles.length} files...`);

  const records: TestRecord[] = [];
  // Use the programmatic runner with a custom event handler. We don't actually
  // care about pass/fail at this stage — only the test paths and that they exist.
  const stream = run({
    files: testFiles,
    concurrency: false, // sequential for stable enumeration
    timeout: 5 * 60_000,
  });

  // Stack tracks describe nesting. node:test emits test:start / test:pass /
  // test:fail with `nesting` (depth) and `name`. We rebuild the suite path
  // by tracking describe boundaries.
  const stack: string[] = [];
  const seen = new Set<string>();

  for await (const ev of stream) {
    if (ev.type === 'test:start') {
      const e = ev.data as { name: string; nesting: number };
      // Trim stack to current nesting depth, then push
      stack.length = e.nesting;
      stack[e.nesting] = e.name;
    } else if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const e = ev.data as {
        name: string;
        nesting: number;
        file?: string;
        details?: { type?: string };
        skip?: boolean;
        todo?: boolean;
      };
      if (e.skip || e.todo) continue;
      // Suites (describe blocks) also emit test:pass when their children all pass.
      // Distinguish leaf tests: details.type === 'suite' marks a suite.
      if (e.details?.type === 'suite') continue;

      const suitePath = stack.slice(0, e.nesting);
      const file = e.file
        ? path.relative(pkg.dir, e.file)
        : '<unknown>';
      const fullPath = `${file} :: ${suitePath.concat(e.name).join(' > ')}`;
      // Dedup (paranoid — same test shouldn't appear twice in one run)
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      records.push({ file, suitePath, name: e.name, fullPath });
    }
  }

  return records;
}

/**
 * Tiny synchronous glob resolver — handles `src/**\/*.test.ts` and similar.
 * We don't need full glob power; just `**` (any directory depth), `*` (any
 * file name segment), and literal path components.
 */
async function resolveGlobs(baseDir: string, globs: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const glob of globs) {
    walk(baseDir, '', glob, out);
  }
  return [...out].sort();
}

function walk(baseDir: string, relPath: string, glob: string, out: Set<string>): void {
  // Convert glob to regex anchored to start-of-relPath
  const regex = globToRegex(glob);
  const fullDir = path.join(baseDir, relPath);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return;
  for (const entry of fs.readdirSync(fullDir)) {
    const childRel = path.join(relPath, entry);
    const childAbs = path.join(fullDir, entry);
    const stat = fs.statSync(childAbs);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      walk(baseDir, childRel, glob, out);
    } else if (regex.test(childRel)) {
      out.add(childAbs);
    }
  }
}

function globToRegex(glob: string): RegExp {
  // Transform glob to regex with proper '**' semantics:
  //   '**/'  → '(?:[^/]+/)*'  — zero or more path segments
  //   '/**'  → '(?:/.*)?'     — optional trailing path
  //   '*'    → '[^/]*'        — single segment, no slashes
  let re = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '(?:/.*)?';
      i += 3;
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i++;
    } else if ('.+?^${}()|[]\\'.includes(glob[i])) {
      re += '\\' + glob[i];
      i++;
    } else {
      re += glob[i];
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

// ── Per-test coverage ──────────────────────────────────────────────────────

interface TestCoverage {
  test: TestRecord;
  /**
   * Set of "<file>:<line>" tokens for source lines this test caused to
   * execute (DA records with hit > 0). Kept under the generic name
   * `coverageUnits` so the matrix code stays signal-agnostic if we ever
   * switch to BRDA (branches) or FNDA (functions) tokens.
   */
  coverageUnits: Set<string>;
  passed: boolean;
  durationMs: number;
  /** True if loaded from mtime-valid cache rather than freshly run */
  fromCache: boolean;
}

interface CacheManifest {
  /** test fullPath → { mtime, hash, lcovFile } */
  entries: Record<string, { mtime: number; lcovFile: string }>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternFor(t: TestRecord): string {
  // node:test's --test-name-pattern matches against the FULL test path with
  // describe titles and the test name joined by a SINGLE SPACE.
  // Verified empirically: ' > ', '/', '>', and other separators do not match.
  // Collision risk: a describe-title with embedded spaces can produce the
  // same joined string as a different describe/test split — we detect this
  // up-front (see findCollisions) and skip colliding tests rather than
  // mis-attribute coverage.
  return '^' + t.suitePath.concat(t.name).map(escapeRegex).join(' ') + '$';
}

/**
 * Detect tests whose --test-name-pattern would not uniquely identify them
 * within their file (the joined string collides with another test's). When
 * matched against an ambiguous pattern, the runner runs ALL colliding tests,
 * which would inflate coverage attribution. Better to surface and skip.
 */
function findCollisions(tests: TestRecord[]): Map<string, TestRecord[]> {
  const byKey = new Map<string, TestRecord[]>();
  for (const t of tests) {
    const key = `${t.file}\0${t.suitePath.concat(t.name).join(' ')}`;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push(t);
  }
  const collisions = new Map<string, TestRecord[]>();
  for (const [key, arr] of byKey) {
    if (arr.length > 1) collisions.set(key, arr);
  }
  return collisions;
}

function testHash(t: TestRecord): string {
  return crypto
    .createHash('sha256')
    .update(t.file + '\0' + t.suitePath.join('\0') + '\0' + t.name)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Common --experimental-test-coverage flag set, applied identically for
 * baseline and per-test runs so subtraction is meaningful.
 */
function coverageFlagsForFile(testFile: string): string[] {
  return [
    '--disable-warning=ExperimentalWarning',
    '--experimental-transform-types',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.ts',
    '--test-coverage-exclude=**/*.test.ts',
    '--test-coverage-exclude=**/*.test.js',
    '--test-coverage-exclude=**/*.d.ts',
    '--test-coverage-exclude=**/test-helpers.ts',
    '--test-coverage-exclude=**/*-test-fixture.ts',
    '--test-coverage-exclude=**/conformance/**',
  ];
}

async function runOneTest(
  t: TestRecord,
  pkg: ResolvedPackage,
  cacheDir: string,
  manifest: CacheManifest,
  noCache: boolean,
): Promise<TestCoverage> {
  const start = Date.now();
  const hash = testHash(t);
  const lcovPath = path.join(cacheDir, `${hash}.lcov`);
  const fileMtime = fs.statSync(path.join(pkg.dir, t.file)).mtimeMs;

  // Cache lookup — entry mtime matches and lcov file exists → reuse.
  if (!noCache && manifest.entries[t.fullPath]) {
    const cached = manifest.entries[t.fullPath];
    if (cached.mtime === fileMtime && fs.existsSync(lcovPath)) {
      return {
        test: t,
        coverageUnits: parseLcovHits(fs.readFileSync(lcovPath, 'utf8')),
        passed: true,
        durationMs: 0,
        fromCache: true,
      };
    }
  }

  const args = [
    ...coverageFlagsForFile(t.file),
    `--test-name-pattern=${patternFor(t)}`,
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=spec',
    '--test-reporter-destination=/dev/null',
    '--test',
    path.join(pkg.dir, t.file),
  ];

  fs.mkdirSync(path.dirname(lcovPath), { recursive: true });
  try { fs.unlinkSync(lcovPath); } catch { /* not present */ }

  const result = await execNode(args, pkg.dir);
  const durationMs = Date.now() - start;

  if (!fs.existsSync(lcovPath) || fs.statSync(lcovPath).size === 0) {
    console.error(
      `  ⚠ no coverage captured for ${t.fullPath} (exit ${result.code}); pattern=${patternFor(t)}`,
    );
    return {
      test: t,
      coverageUnits: new Set(),
      passed: result.code === 0,
      durationMs,
      fromCache: false,
    };
  }

  const coverageUnits = parseLcovHits(fs.readFileSync(lcovPath, 'utf8'));
  manifest.entries[t.fullPath] = { mtime: fileMtime, lcovFile: `${hash}.lcov` };

  return {
    test: t,
    coverageUnits,
    passed: result.code === 0,
    durationMs,
    fromCache: false,
  };
}

function execNode(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * Parse an lcov text blob into a Set of "<file>:<line>" tokens for lines
 * the test actually caused to execute (DA records with hit > 0).
 *
 * Note on the no-match-baseline puzzle: when the runner is invoked with a
 * pattern that matches no tests, you'll see roughly half the lines of any
 * imported source file as hit=1 in the lcov. Those are *real* hits — they
 * come from top-level statements (imports, function declarations, top-level
 * constants) that execute when the module is loaded. The other half (function
 * bodies for un-called functions) correctly show hit=0. So DA records are
 * accurate per-test attribution; the import-time baseline is a true cost of
 * per-file granularity, not a bug. Pure-redundant tests within the same file
 * naturally share that baseline, but the *unique* contribution of each test
 * (uniqueness in the redundancy matrix) is dominated by branches actually
 * taken inside function bodies, so the analysis still produces good signal.
 *
 * Branch coverage (BRDA) and function coverage (FNDA) are also accurate and
 * available — see git history for the FNDA+BRDA variant. Lines are used here
 * because they're the same signal as the aggregate threshold gate, and they
 * map directly to source ranges humans can inspect when reviewing candidates.
 */
function parseLcovHits(text: string): Set<string> {
  const out = new Set<string>();
  let curFile: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      curFile = line.slice(3).trim();
    } else if (!curFile) {
      continue;
    } else if (line.startsWith('DA:')) {
      // DA:lineNumber,hitCount
      const [num, hit] = line.slice(3).split(',');
      if (Number(hit) > 0) out.add(`${curFile}:${num}`);
    } else if (line === 'end_of_record') {
      curFile = null;
    }
  }
  return out;
}

// ── Worker pool ────────────────────────────────────────────────────────────

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  let nextLog = 0;
  const total = items.length;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const { item, index } = queue.shift()!;
        await worker(item, index);
        const done = total - queue.length;
        if (done >= nextLog) {
          process.stderr.write(`  ${done}/${total}\r`);
          nextLog = done + Math.max(1, Math.floor(total / 20));
        }
      }
    }),
  );
  process.stderr.write(`\n`);
}

// ── Reduction ──────────────────────────────────────────────────────────────

interface Reduction {
  redundant: TestCoverage[];
  required: TestCoverage[];
  /** uniqueCount per test in the FINAL reduced set (post-reduction snapshot) */
  finalUniqueCount: Map<TestCoverage, number>;
  /** uniqueCount per test BEFORE any reduction (input snapshot) */
  initialUniqueCount: Map<TestCoverage, number>;
}

/**
 * Greedy reduction: iteratively identify a test whose covered lines are all
 * also covered by other still-active tests (zero-unique), remove it, repeat.
 * Sound (preserves all line coverage) but not optimal — different removal
 * orders yield different redundant-set sizes. We pick the highest-coverage
 * candidate first as a heuristic for "safest to drop" (its lines have the
 * most external coverage).
 */
function greedyReduce(coverages: TestCoverage[]): Reduction {
  // line → Set<TestCoverage> covering it
  const lineCoverers = new Map<string, Set<TestCoverage>>();
  for (const c of coverages) {
    for (const l of c.coverageUnits) {
      let s = lineCoverers.get(l);
      if (!s) { s = new Set(); lineCoverers.set(l, s); }
      s.add(c);
    }
  }

  function uniqueCount(c: TestCoverage): number {
    let n = 0;
    for (const l of c.coverageUnits) {
      if (lineCoverers.get(l)!.size === 1) n++;
    }
    return n;
  }

  // Initial snapshot (before any removal)
  const initialUniqueCount = new Map<TestCoverage, number>();
  for (const c of coverages) initialUniqueCount.set(c, uniqueCount(c));

  const active = new Set(coverages);
  const redundant: TestCoverage[] = [];

  while (true) {
    // Find all zero-unique candidates
    const candidates: TestCoverage[] = [];
    for (const c of active) {
      if (uniqueCount(c) === 0) candidates.push(c);
    }
    if (candidates.length === 0) break;

    // Heuristic: drop the one with the most coverage first (most overlap).
    candidates.sort((a, b) => b.coverageUnits.size - a.coverageUnits.size);
    const drop = candidates[0];
    redundant.push(drop);
    active.delete(drop);
    for (const l of drop.coverageUnits) lineCoverers.get(l)!.delete(drop);
  }

  const required = [...active];
  const finalUniqueCount = new Map<TestCoverage, number>();
  for (const c of required) finalUniqueCount.set(c, uniqueCount(c));

  return { redundant, required, finalUniqueCount, initialUniqueCount };
}

// ── Reporting ──────────────────────────────────────────────────────────────

function readTestAssertionPeek(pkg: ResolvedPackage, t: TestRecord): string {
  // Open the test file, locate the test() / it() call by name, and grab the
  // first assert.* line within it. Best-effort; failure returns ''.
  try {
    const src = fs.readFileSync(path.join(pkg.dir, t.file), 'utf8');
    const lines = src.split('\n');
    const escName = escapeRegex(t.name);
    // Match `it('name'`, `test('name'`, or it("name") etc.
    const start = lines.findIndex((line) =>
      new RegExp(`(?:\\b(?:it|test)\\s*\\(\\s*['"\`])${escName}(?:['"\`])`).test(line),
    );
    if (start < 0) return '';
    // Search up to ~80 lines after for the first assert call.
    for (let i = start; i < Math.min(start + 80, lines.length); i++) {
      const m = /\bassert(?:\.\w+)?\s*\([^)]*\)/.exec(lines[i]);
      if (m) return m[0].length > 100 ? m[0].slice(0, 100) + '…' : m[0];
    }
    return '';
  } catch {
    return '';
  }
}

interface Report {
  pkg: string;
  totals: {
    tests: number;
    redundant: number;
    required: number;
    coverageUnits: number;
    redundantCoverageUnits: number;
  };
  redundantList: Array<{
    fullPath: string;
    file: string;
    coverageUnits: number;
    peek: string;
  }>;
  lowUniquenessList: Array<{
    fullPath: string;
    file: string;
    uniqueUnits: number;
    coverageUnits: number;
    peek: string;
  }>;
  highLeverageList: Array<{
    fullPath: string;
    file: string;
    uniqueUnits: number;
    coverageUnits: number;
  }>;
  perFileStats: Array<{
    file: string;
    tests: number;
    redundantTests: number;
    totalCoverageUnits: number;
  }>;
}

function buildReport(
  pkg: ResolvedPackage,
  coverages: TestCoverage[],
  reduction: Reduction,
): Report {
  const allUnits = new Set<string>();
  for (const c of coverages) for (const u of c.coverageUnits) allUnits.add(u);
  const redundantUnits = new Set<string>();
  for (const c of reduction.redundant) for (const u of c.coverageUnits) redundantUnits.add(u);

  // Sort redundant by coverage size desc — biggest wins first
  const redundantSorted = [...reduction.redundant]
    .sort((a, b) => b.coverageUnits.size - a.coverageUnits.size);

  // Low-uniqueness: among required, sort by initial unique count asc (those
  // that survived but only barely — small unique contribution → next-tier
  // trim candidates if we want to push further).
  const lowUniqueness = [...reduction.required]
    .map((c) => ({ c, u: reduction.finalUniqueCount.get(c) ?? 0 }))
    .filter((x) => x.u <= 5)
    .sort((a, b) => a.u - b.u)
    .slice(0, 30);

  // High-leverage: top 10 by final unique count
  const highLeverage = [...reduction.required]
    .map((c) => ({ c, u: reduction.finalUniqueCount.get(c) ?? 0 }))
    .sort((a, b) => b.u - a.u)
    .slice(0, 10);

  // Per-file stats
  const perFileMap = new Map<string, { tests: number; redundantTests: number; coverageUnits: Set<string> }>();
  for (const c of coverages) {
    let s = perFileMap.get(c.test.file);
    if (!s) { s = { tests: 0, redundantTests: 0, coverageUnits: new Set() }; perFileMap.set(c.test.file, s); }
    s.tests++;
    for (const l of c.coverageUnits) s.coverageUnits.add(l);
  }
  for (const c of reduction.redundant) {
    perFileMap.get(c.test.file)!.redundantTests++;
  }
  const perFileStats = [...perFileMap.entries()]
    .map(([file, s]) => ({
      file,
      tests: s.tests,
      redundantTests: s.redundantTests,
      totalCoverageUnits: s.coverageUnits.size,
    }))
    .sort((a, b) => b.redundantTests - a.redundantTests || b.tests - a.tests);

  return {
    pkg: pkg.name,
    totals: {
      tests: coverages.length,
      redundant: reduction.redundant.length,
      required: reduction.required.length,
      coverageUnits: allUnits.size,
      redundantCoverageUnits: redundantUnits.size,
    },
    redundantList: redundantSorted.map((c) => ({
      fullPath: c.test.fullPath,
      file: c.test.file,
      coverageUnits: c.coverageUnits.size,
      peek: readTestAssertionPeek(pkg, c.test),
    })),
    lowUniquenessList: lowUniqueness.map(({ c, u }) => ({
      fullPath: c.test.fullPath,
      file: c.test.file,
      uniqueUnits: u,
      coverageUnits: c.coverageUnits.size,
      peek: readTestAssertionPeek(pkg, c.test),
    })),
    highLeverageList: highLeverage.map(({ c, u }) => ({
      fullPath: c.test.fullPath,
      file: c.test.file,
      uniqueUnits: u,
      coverageUnits: c.coverageUnits.size,
    })),
    perFileStats,
  };
}

function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Test uniqueness — \`${report.pkg}\``);
  lines.push('');
  lines.push(`Generated by \`scripts/test-uniqueness.ts\`. See \`docs/guides/trimming-tests.md\` for interpretation.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total tests analyzed: **${report.totals.tests}**`);
  lines.push(`- Pure-redundant (deletable without losing line coverage): **${report.totals.redundant}** (${pct(report.totals.redundant, report.totals.tests)})`);
  lines.push(`- Required (after greedy reduction): **${report.totals.required}**`);
  lines.push(`- Source lines covered (union across all tests): **${report.totals.coverageUnits}**`);
  lines.push(`- Lines the redundant tests touched (all also covered by required): **${report.totals.redundantCoverageUnits}**`);
  lines.push('');
  lines.push('> Per-test attribution uses line coverage (DA records, hit > 0). Same signal as the aggregate threshold gate, so deleting pure-redundant tests is line-coverage-safe by definition. **Caveat:** branch coverage is finer-grained than line coverage; two tests covering the same line but taking different branches will both appear redundant under this signal but are not behaviorally equivalent. The aggregate gate also checks branch coverage (80% floor), so over-trimming will surface there if it occurs.');
  lines.push('');
  lines.push('## Pure-redundant tests');
  lines.push('');
  lines.push('Each row is a test whose covered lines are entirely covered by other tests. Line coverage is preserved if deleted. **Spot-check the assertion peek before deleting** — coverage equivalence does not imply behavioral equivalence; many redundancy candidates are parameter sweeps that share line coverage but assert distinct input→output mappings.');
  lines.push('');
  if (report.redundantList.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Lines | Test | Assertion peek |');
    lines.push('|------:|------|----------------|');
    for (const r of report.redundantList) {
      lines.push(`| ${r.coverageUnits} | \`${r.fullPath}\` | ${r.peek ? `\`${r.peek}\`` : ''} |`);
    }
  }
  lines.push('');
  lines.push('## Low-uniqueness required tests');
  lines.push('');
  lines.push('Tests that survived reduction but contribute ≤5 unique lines. Candidates if you want to trade small coverage drops for further reduction.');
  lines.push('');
  if (report.lowUniquenessList.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Unique | Total | Test | Assertion peek |');
    lines.push('|-------:|------:|------|----------------|');
    for (const r of report.lowUniquenessList) {
      lines.push(`| ${r.uniqueUnits} | ${r.coverageUnits} | \`${r.fullPath}\` | ${r.peek ? `\`${r.peek}\`` : ''} |`);
    }
  }
  lines.push('');
  lines.push('## High-leverage required tests');
  lines.push('');
  lines.push('Top 10 tests by uniquely-covered lines — the load-bearing tests for this package. Do not delete.');
  lines.push('');
  lines.push('| Unique | Total | Test |');
  lines.push('|-------:|------:|------|');
  for (const r of report.highLeverageList) {
    lines.push(`| ${r.uniqueUnits} | ${r.coverageUnits} | \`${r.fullPath}\` |`);
  }
  lines.push('');
  lines.push('## Per-file rollup');
  lines.push('');
  lines.push('| File | Tests | Redundant | % redundant |');
  lines.push('|------|------:|----------:|------------:|');
  for (const f of report.perFileStats) {
    lines.push(`| \`${f.file}\` | ${f.tests} | ${f.redundantTests} | ${pct(f.redundantTests, f.tests)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { pkg: pkgArg, opts } = parseArgs();
  const pkg = resolvePackage(pkgArg);

  console.log(`Package: ${pkg.name}`);
  console.log(`Test globs: ${pkg.testGlobs.join(', ')}`);
  console.log(`Workers: ${opts.workers}`);

  const cacheDir = path.join(pkg.dir, 'coverage', 'per-test');
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const manifest: CacheManifest = fs.existsSync(manifestPath)
    ? { entries: {}, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) }
    : { entries: {} };

  // Phase 1: enumerate
  const allTests = await discoverTests(pkg);
  console.log(`Discovered ${allTests.length} tests.`);

  let tests = opts.filter
    ? allTests.filter((t) => opts.filter!.test(t.fullPath))
    : allTests;
  if (opts.filter) {
    console.log(`Filtered to ${tests.length} matching tests.`);
  }
  if (tests.length === 0) {
    die('no tests to analyze');
  }

  // Skip tests whose --test-name-pattern would be ambiguous within the file.
  const collisions = findCollisions(tests);
  if (collisions.size > 0) {
    let skipped = 0;
    const colliding = new Set<TestRecord>();
    for (const arr of collisions.values()) {
      for (const t of arr) colliding.add(t);
      skipped += arr.length;
    }
    console.warn(`⚠ Skipping ${skipped} tests with ambiguous --test-name-pattern (suite-title spaces collide):`);
    for (const [key, arr] of collisions) {
      console.warn(`    ${arr[0].file}: ${arr.length}× pattern '${arr[0].suitePath.concat(arr[0].name).join(' ')}'`);
    }
    tests = tests.filter((t) => !colliding.has(t));
  }

  // Phase 2: per-test coverage (FNDA + BRDA records — see parseLcovHits).
  //   No baseline subtraction needed because function/branch records correctly
  //   reflect actual execution; line records (DA) are NOT used because V8/lcov
  //   marks them hit=1 for any reachable code in a loaded module.
  console.log('Running per-test coverage...');
  const coverages: TestCoverage[] = new Array(tests.length);
  await runPool(tests, opts.workers, async (t, i) => {
    coverages[i] = await runOneTest(t, pkg, cacheDir, manifest, opts.noCache);
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const fromCache = coverages.filter((c) => c.fromCache).length;
  const fresh = coverages.length - fromCache;
  console.log(`Coverage gathered: ${fresh} fresh, ${fromCache} cached.`);

  // Phase 3+4: matrix + reduction
  console.log('Computing redundancy...');
  const reduction = greedyReduce(coverages);

  // Phase 5: report
  const report = buildReport(pkg, coverages, reduction);
  console.log('');
  console.log(`✓ ${report.totals.tests} tests, ${report.totals.redundant} pure-redundant (${pct(report.totals.redundant, report.totals.tests)})`);
  console.log(`  Source lines covered (union): ${report.totals.coverageUnits}`);
  console.log(`  Top-redundant files:`);
  for (const f of report.perFileStats.slice(0, 5)) {
    console.log(`    ${f.file}: ${f.redundantTests}/${f.tests} redundant (${pct(f.redundantTests, f.tests)})`);
  }

  const outDir = path.join(REPO_ROOT, 'coverage', 'uniqueness');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = report.pkg.replace(/\//g, '-');
  if (!opts.jsonOnly) {
    const md = renderMarkdown(report);
    fs.writeFileSync(path.join(outDir, `${slug}.md`), md);
    console.log(`\nMarkdown report: coverage/uniqueness/${slug}.md`);
  }
  if (!opts.mdOnly) {
    fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(report, null, 2));
    console.log(`JSON dump:       coverage/uniqueness/${slug}.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
