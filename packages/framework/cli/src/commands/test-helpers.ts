/**
 * Shared test helpers for CLI command tests.
 *
 * Provides guild accessor setup, temp directory management, and minimal
 * guild.json scaffolding. Extracted from status.test.ts, version.test.ts,
 * and plugin.test.ts where these were copy-pasted identically.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setGuild, clearGuild } from '@shardworks/nexus-core';

/** Accumulates temp dirs for cleanup in afterEach. */
let tmpDirs: string[] = [];

/** Set up a minimal guild accessor pointing at the given directory. */
export function setupGuildAccessor(home: string): void {
  setGuild({
    home,
    apparatus: () => { throw new Error('not available in test'); },
    config: () => ({}) as never,
    writeConfig: () => { throw new Error('not available in test'); },
    guildConfig: () => ({}) as never,
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
    startupWarnings: () => [],
  });
}

/** Create a temp directory and register it for cleanup. */
export function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nsg-${prefix}-test-`));
  tmpDirs.push(dir);
  return dir;
}

/** Write a minimal guild.json to dir, with optional overrides. */
export function makeGuild(dir: string, overrides: Record<string, unknown> = {}): void {
  const config = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    settings: { model: 'sonnet' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'guild.json'), JSON.stringify(config, null, 2) + '\n');
}

/** Write a guild-root package.json declaring the given npm dependencies. */
export function makeGuildPackageJson(dir: string, deps: Record<string, string>): void {
  const pkg = { name: 'test-guild', version: '1.0.0', dependencies: deps };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

/** Clean up guild state and temp directories. Call from afterEach(). */
export function cleanupTestState(): void {
  clearGuild();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
}
