#!/usr/bin/env node
/**
 * coverage-report.ts — Aggregate per-package lcov coverage into a single
 * monorepo-wide report.
 *
 * Reads each `packages/<pkg>/coverage/lcov.info` produced by `pnpm test:coverage`,
 * computes per-package + aggregate line/branch/function coverage stats, writes
 * a merged lcov to `coverage/lcov.info` at the repo root, and prints a summary
 * table sorted by line coverage (ascending — lowest first, easiest to spot
 * candidates for the trim).
 *
 * Run via:
 *   pnpm coverage:report   (assumes test:coverage already ran)
 *   pnpm coverage          (runs test:coverage then this)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Repo root resolution ───────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ── Lcov parsing ───────────────────────────────────────────────────────────

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
  branchesFound: number;
  branchesHit: number;
}

interface PackageCoverage {
  pkg: string;
  files: FileCoverage[];
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
  branchesFound: number;
  branchesHit: number;
  raw: string;
}

/**
 * Parse an lcov.info text blob into per-file records. The lcov format is a
 * sequence of records terminated by `end_of_record`, each beginning with `SF:`
 * (source file) and containing summary counters `LF/LH/FNF/FNH/BRF/BRH`.
 */
function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let cur: Partial<FileCoverage> | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      cur = {
        file: line.slice(3).trim(),
        linesFound: 0,
        linesHit: 0,
        funcsFound: 0,
        funcsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('LF:')) {
      cur.linesFound = Number(line.slice(3));
    } else if (line.startsWith('LH:')) {
      cur.linesHit = Number(line.slice(3));
    } else if (line.startsWith('FNF:')) {
      cur.funcsFound = Number(line.slice(4));
    } else if (line.startsWith('FNH:')) {
      cur.funcsHit = Number(line.slice(4));
    } else if (line.startsWith('BRF:')) {
      cur.branchesFound = Number(line.slice(4));
    } else if (line.startsWith('BRH:')) {
      cur.branchesHit = Number(line.slice(4));
    } else if (line === 'end_of_record') {
      files.push(cur as FileCoverage);
      cur = null;
    }
  }

  return files;
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Find all packages under packages/ with a coverage/lcov.info.
 */
function discoverPackages(): { pkg: string; lcovPath: string }[] {
  const out: { pkg: string; lcovPath: string }[] = [];
  const roots = ['framework', 'plugins'];
  for (const root of roots) {
    const rootDir = path.join(REPO_ROOT, 'packages', root);
    if (!fs.existsSync(rootDir)) continue;
    for (const entry of fs.readdirSync(rootDir)) {
      const pkgDir = path.join(rootDir, entry);
      const lcovPath = path.join(pkgDir, 'coverage', 'lcov.info');
      if (fs.existsSync(lcovPath)) {
        out.push({ pkg: `${root}/${entry}`, lcovPath });
      }
    }
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

// ── Aggregation ────────────────────────────────────────────────────────────

function aggregatePackage(pkg: string, lcovPath: string): PackageCoverage {
  const raw = fs.readFileSync(lcovPath, 'utf8');
  const files = parseLcov(raw);

  // Rewrite SF: paths in the merged lcov to be repo-root relative so external
  // tooling (coverage viewers, codecov, etc.) can resolve them. Lcov SF: lines
  // from node:test are emitted relative to the package's cwd (e.g. "src/foo.ts").
  const pkgRel = path.join('packages', pkg);
  const rewritten = raw.replace(
    /^SF:(.+)$/gm,
    (_, p) => `SF:${path.join(pkgRel, p)}`,
  );

  return {
    pkg,
    files,
    raw: rewritten,
    linesFound: files.reduce((s, f) => s + f.linesFound, 0),
    linesHit: files.reduce((s, f) => s + f.linesHit, 0),
    funcsFound: files.reduce((s, f) => s + f.funcsFound, 0),
    funcsHit: files.reduce((s, f) => s + f.funcsHit, 0),
    branchesFound: files.reduce((s, f) => s + f.branchesFound, 0),
    branchesHit: files.reduce((s, f) => s + f.branchesHit, 0),
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────

function pct(hit: number, found: number): string {
  if (found === 0) return '   —  ';
  return `${((hit / found) * 100).toFixed(2).padStart(6)}`;
}

function printSummary(pkgs: PackageCoverage[]): void {
  // Sort ascending by line coverage so lowest-covered packages appear first —
  // those are the most interesting for the trim discussion.
  const sorted = [...pkgs].sort((a, b) => {
    const aPct = a.linesFound ? a.linesHit / a.linesFound : 1;
    const bPct = b.linesFound ? b.linesHit / b.linesFound : 1;
    return aPct - bPct;
  });

  const header = ` Package                                     Lines    Branches Funcs   Files`;
  const rule = '─'.repeat(header.length);
  console.log('');
  console.log('Coverage by package (sorted: lowest line % first):');
  console.log(rule);
  console.log(header);
  console.log(rule);
  for (const p of sorted) {
    const name = p.pkg.padEnd(40);
    console.log(
      ` ${name} ${pct(p.linesHit, p.linesFound)}%  ${pct(
        p.branchesHit,
        p.branchesFound,
      )}%  ${pct(p.funcsHit, p.funcsFound)}%  ${String(p.files.length).padStart(5)}`,
    );
  }
  console.log(rule);

  // Aggregate row
  const tot = pkgs.reduce(
    (acc, p) => ({
      linesFound: acc.linesFound + p.linesFound,
      linesHit: acc.linesHit + p.linesHit,
      funcsFound: acc.funcsFound + p.funcsFound,
      funcsHit: acc.funcsHit + p.funcsHit,
      branchesFound: acc.branchesFound + p.branchesFound,
      branchesHit: acc.branchesHit + p.branchesHit,
      files: acc.files + p.files.length,
    }),
    {
      linesFound: 0,
      linesHit: 0,
      funcsFound: 0,
      funcsHit: 0,
      branchesFound: 0,
      branchesHit: 0,
      files: 0,
    },
  );
  console.log(
    ` ${'TOTAL'.padEnd(40)} ${pct(tot.linesHit, tot.linesFound)}%  ${pct(
      tot.branchesHit,
      tot.branchesFound,
    )}%  ${pct(tot.funcsHit, tot.funcsFound)}%  ${String(tot.files).padStart(5)}`,
  );
  console.log(rule);
  console.log('');
  console.log(
    `Raw counters: ${tot.linesHit}/${tot.linesFound} lines, ` +
      `${tot.branchesHit}/${tot.branchesFound} branches, ` +
      `${tot.funcsHit}/${tot.funcsFound} functions across ${tot.files} files in ${pkgs.length} packages.`,
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const discovered = discoverPackages();
  if (discovered.length === 0) {
    console.error(
      'No coverage/lcov.info files found. Run `pnpm test:coverage` first.',
    );
    process.exit(1);
  }

  const pkgs = discovered.map(({ pkg, lcovPath }) =>
    aggregatePackage(pkg, lcovPath),
  );

  // Write merged lcov at repo root
  const outDir = path.join(REPO_ROOT, 'coverage');
  fs.mkdirSync(outDir, { recursive: true });
  const merged = pkgs.map((p) => p.raw).join('');
  const outPath = path.join(outDir, 'lcov.info');
  fs.writeFileSync(outPath, merged);
  console.log(`Merged lcov written to ${path.relative(REPO_ROOT, outPath)}`);

  printSummary(pkgs);
}

main();
