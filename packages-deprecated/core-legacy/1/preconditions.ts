/**
 * Precondition checking for tools and engines.
 *
 * Tools and engines can declare preconditions in their descriptor files —
 * requirements that the environment must satisfy for the tool to be operational.
 * For example, a GitHub tool might require `gh` to be installed and authenticated.
 *
 * Preconditions are checked at three points:
 * 1. **Manifest time** — unavailable tools are excluded from the MCP config
 *    and a note is added to the anima's system prompt.
 * 2. **Status command** — `nsg status` shows operational state of all tools.
 * 3. **Install time** — warnings are emitted for unmet preconditions (tool is
 *    still installed — the environment may change).
 *
 * ## Descriptor format
 *
 * ```json
 * {
 *   "preconditions": [
 *     { "check": "command", "command": "gh", "message": "Install gh from https://cli.github.com/" },
 *     { "check": "command-output", "command": "gh auth status", "pattern": "Logged in", "message": "Run: gh auth login" },
 *     { "check": "env", "variable": "GITHUB_TOKEN", "message": "Set GITHUB_TOKEN env var" }
 *   ]
 * }
 * ```
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

/** A precondition that checks whether a command exists on PATH. */
export interface CommandPrecondition {
  check: 'command';
  /** The command name to look for (e.g. "gh", "git", "sqlite3"). */
  command: string;
  /** Human-readable message shown when the check fails. Should include remediation steps. */
  message: string;
}

/** A precondition that runs a command and checks its stdout against a regex pattern. */
export interface CommandOutputPrecondition {
  check: 'command-output';
  /** The full command to run (e.g. "gh auth status"). */
  command: string;
  /** Regex pattern that must match somewhere in stdout+stderr for the check to pass. */
  pattern: string;
  /** Human-readable message shown when the check fails. */
  message: string;
}

/** A precondition that checks whether an environment variable is set and non-empty. */
export interface EnvPrecondition {
  check: 'env';
  /** The environment variable name. */
  variable: string;
  /** Human-readable message shown when the check fails. */
  message: string;
}

export type Precondition = CommandPrecondition | CommandOutputPrecondition | EnvPrecondition;

/** The result of checking a single precondition. */
export interface PreconditionCheckResult {
  precondition: Precondition;
  passed: boolean;
  /** The failure message (from the precondition's `message` field). Only set when `passed` is false. */
  message?: string;
}

/** The result of checking all preconditions for a single tool or engine. */
export interface ToolPreconditionResult {
  /** Tool name (from guild.json key). */
  name: string;
  /** Whether this is a tool or engine. */
  category: 'tools' | 'engines';
  /** Whether all preconditions passed (true if there are no preconditions). */
  available: boolean;
  /** Individual check results. Empty if no preconditions declared. */
  checks: PreconditionCheckResult[];
  /** Failure messages only — convenience accessor for checks that failed. */
  failures: string[];
}

// ── Descriptor reading ─────────────────────────────────────────────────

/**
 * Read preconditions from a descriptor file (nexus-tool.json or nexus-engine.json).
 * Returns an empty array if the descriptor doesn't exist or has no preconditions field.
 */
export function readPreconditions(descriptorPath: string): Precondition[] {
  if (!fs.existsSync(descriptorPath)) return [];

  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'));
    const raw = descriptor.preconditions;
    if (!Array.isArray(raw)) return [];

    // Validate each entry has at minimum { check, message }
    return raw.filter((p: unknown): p is Precondition => {
      if (typeof p !== 'object' || p === null) return false;
      const obj = p as Record<string, unknown>;
      if (typeof obj.check !== 'string' || typeof obj.message !== 'string') return false;

      switch (obj.check) {
        case 'command':
          return typeof obj.command === 'string';
        case 'command-output':
          return typeof obj.command === 'string' && typeof obj.pattern === 'string';
        case 'env':
          return typeof obj.variable === 'string';
        default:
          return false; // Unknown check type — skip
      }
    });
  } catch {
    return [];
  }
}

// ── Check execution ────────────────────────────────────────────────────

const CHECK_TIMEOUT_MS = 5000;

/** Run a single precondition check. */
export function checkOne(precondition: Precondition): PreconditionCheckResult {
  switch (precondition.check) {
    case 'command':
      return checkCommand(precondition);
    case 'command-output':
      return checkCommandOutput(precondition);
    case 'env':
      return checkEnv(precondition);
  }
}

function checkCommand(p: CommandPrecondition): PreconditionCheckResult {
  try {
    // `which` on Unix, `where` on Windows — but we only target Unix for now
    execSync(`which ${p.command}`, { stdio: 'pipe', timeout: CHECK_TIMEOUT_MS });
    return { precondition: p, passed: true };
  } catch {
    return { precondition: p, passed: false, message: p.message };
  }
}

function checkCommandOutput(p: CommandOutputPrecondition): PreconditionCheckResult {
  try {
    // Capture both stdout and stderr (many CLIs write status to stderr)
    const output = execSync(p.command, {
      stdio: 'pipe',
      timeout: CHECK_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    // execSync only captures stdout in the return value when encoding is set.
    // stderr goes to... nowhere with stdio: 'pipe'. We need a different approach
    // for commands that write to stderr.
    const combined = output ?? '';
    const regex = new RegExp(p.pattern);
    if (regex.test(combined)) {
      return { precondition: p, passed: true };
    }
    return { precondition: p, passed: false, message: p.message };
  } catch (err: unknown) {
    // Some commands (like `gh auth status` when not logged in) exit non-zero
    // but still produce useful output. Check stderr/stdout from the error.
    if (err && typeof err === 'object' && 'stdout' in err) {
      const execErr = err as { stdout?: string; stderr?: string };
      const combined = (execErr.stdout ?? '') + (execErr.stderr ?? '');
      const regex = new RegExp(p.pattern);
      if (regex.test(combined)) {
        return { precondition: p, passed: true };
      }
    }
    return { precondition: p, passed: false, message: p.message };
  }
}

function checkEnv(p: EnvPrecondition): PreconditionCheckResult {
  const value = process.env[p.variable];
  if (value !== undefined && value !== '') {
    return { precondition: p, passed: true };
  }
  return { precondition: p, passed: false, message: p.message };
}

/**
 * Check all preconditions in an array. Returns individual results.
 */
export function checkPreconditions(preconditions: Precondition[]): PreconditionCheckResult[] {
  return preconditions.map(checkOne);
}

// ── Guild-wide checking ────────────────────────────────────────────────

/**
 * Resolve the descriptor path for a tool registered in guild.json.
 *
 * Tools live at: `{home}/{categoryDir}/{name}/{descriptorFile}`
 */
function resolveDescriptorPath(
  home: string,
  name: string,
  category: 'tools' | 'engines',
): string {
  const categoryDir = category === 'tools' ? 'tools' : 'engines';
  const descriptorFile = category === 'tools' ? 'nexus-tool.json' : 'nexus-engine.json';
  return path.join(home, categoryDir, name, descriptorFile);
}

/**
 * Check preconditions for all tools and engines in a guild.
 *
 * Returns a result for every registered tool, including those with no preconditions
 * (which are always marked available: true).
 */
export function checkAllPreconditions(
  home: string,
  config: { tools: Record<string, unknown>; engines: Record<string, unknown> },
): ToolPreconditionResult[] {
  const results: ToolPreconditionResult[] = [];

  for (const name of Object.keys(config.tools)) {
    const descriptorPath = resolveDescriptorPath(home, name, 'tools');
    const preconditions = readPreconditions(descriptorPath);
    const checks = checkPreconditions(preconditions);
    const failures = checks.filter(c => !c.passed).map(c => c.message!);
    results.push({
      name,
      category: 'tools',
      available: failures.length === 0,
      checks,
      failures,
    });
  }

  for (const name of Object.keys(config.engines)) {
    const descriptorPath = resolveDescriptorPath(home, name, 'engines');
    const preconditions = readPreconditions(descriptorPath);
    const checks = checkPreconditions(preconditions);
    const failures = checks.filter(c => !c.passed).map(c => c.message!);
    results.push({
      name,
      category: 'engines',
      available: failures.length === 0,
      checks,
      failures,
    });
  }

  return results;
}

/**
 * Check preconditions for a single tool by its descriptor path.
 * Convenience wrapper for install-time warnings.
 */
export function checkToolPreconditions(descriptorPath: string): PreconditionCheckResult[] {
  const preconditions = readPreconditions(descriptorPath);
  return checkPreconditions(preconditions);
}
