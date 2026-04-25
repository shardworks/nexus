/**
 * Tests for the bootstrap-emit helper used by `pluginInstall` /
 * `pluginRemove`.
 *
 * The full happy path (createGuild → resolve clockworks → emit) is
 * covered by the end-to-end integration test that runs against a real
 * guild with the Clockworks installed. Here we cover the
 * warn-and-succeed contract from D20:
 *
 *   - A bootstrap failure (no guild.json present) logs a warn and does
 *     not throw — the install/remove still exits successfully.
 *   - A guild that doesn't have the Clockworks installed logs a
 *     "skipping emission" warn and does not throw.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bootstrapEmitToolEvent } from './plugin-bootstrap-emit.ts';
import { makeTmpDir, makeGuild, cleanupTestState } from './test-helpers.ts';

afterEach(() => cleanupTestState());

describe('bootstrap-emit helper — warn-and-succeed contract (D20)', () => {
  it('does not throw when the directory has no guild.json', async () => {
    const tmp = makeTmpDir('plugin-bootstrap');
    // Intentionally NO guild.json here.
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      // Should not throw.
      await bootstrapEmitToolEvent(
        'tool.installed',
        { pluginId: 'whatever' },
        tmp,
      );
    } finally {
      console.warn = orig;
    }
    assert.ok(
      warns.some((w) => /Bootstrap-emit/.test(w) || /Clockworks is not installed/.test(w)),
      `expected a warn breadcrumb; got: ${warns.join('\n')}`,
    );
  });

  it('does not throw when a guild has no Clockworks installed', async () => {
    const tmp = makeTmpDir('plugin-bootstrap');
    makeGuild(tmp, { plugins: [] });

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      await bootstrapEmitToolEvent(
        'tool.installed',
        { pluginId: 'a-plugin' },
        tmp,
      );
    } finally {
      console.warn = orig;
    }

    // The guild started cleanly (no plugins to fail), then the
    // Clockworks was missing — the helper logs a "Clockworks is not
    // installed" breadcrumb and returns successfully.
    assert.ok(
      warns.some((w) => /Clockworks is not installed/.test(w)),
      `expected a "Clockworks is not installed" warn; got: ${warns.join('\n')}`,
    );

    // No mutation of the guild root happened.
    assert.ok(fs.existsSync(path.join(tmp, 'guild.json')));
  });
});
