import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Exercise the init tool's handler directly, bypassing the CLI.
 * init does not use guild() — it creates a new guild from scratch.
 */
import initTool from './init.ts';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-init-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('nsg init', () => {
  it('creates guild.json with correct shape', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'my-guild');

    await initTool.handler({ path: guildPath });

    const config = JSON.parse(fs.readFileSync(path.join(guildPath, 'guild.json'), 'utf-8'));
    assert.equal(config.name, 'my-guild');
    assert.equal(config.settings?.model, 'sonnet');
    assert.deepEqual(config.plugins, []);
    assert.deepEqual(config.baseTools, []);
    assert.deepEqual(config.roles, {});
    // V2: no tools/engines/curricula/temperaments registries
    assert.equal(config.tools, undefined);
    assert.equal(config.engines, undefined);
  });

  it('creates package.json', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'test-guild');

    await initTool.handler({ path: guildPath });

    const pkg = JSON.parse(fs.readFileSync(path.join(guildPath, 'package.json'), 'utf-8'));
    assert.equal(pkg.name, 'guild-test-guild');
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, 'module');
  });

  it('creates .gitignore', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'g');

    await initTool.handler({ path: guildPath });

    const gitignore = fs.readFileSync(path.join(guildPath, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('node_modules/'));
    assert.ok(gitignore.includes('.nexus/'));
  });

  it('scaffolds directories', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'g');

    await initTool.handler({ path: guildPath });

    assert.ok(fs.existsSync(path.join(guildPath, '.nexus')));
    assert.ok(fs.existsSync(path.join(guildPath, 'roles')));
    assert.ok(fs.existsSync(path.join(guildPath, 'codex')));
  });

  it('respects --name override', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'dir-name');

    await initTool.handler({ path: guildPath, name: 'custom-name' });

    const config = JSON.parse(fs.readFileSync(path.join(guildPath, 'guild.json'), 'utf-8'));
    assert.equal(config.name, 'custom-name');
  });

  it('respects --model override', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'g');

    await initTool.handler({ path: guildPath, model: 'opus' });

    const config = JSON.parse(fs.readFileSync(path.join(guildPath, 'guild.json'), 'utf-8'));
    assert.equal(config.settings?.model, 'opus');
  });

  it('fails on non-empty directory', async () => {
    const tmp = makeTmpDir();
    const guildPath = path.join(tmp, 'exists');
    fs.mkdirSync(guildPath);
    fs.writeFileSync(path.join(guildPath, 'file.txt'), 'not empty');

    await assert.rejects(
      async () => initTool.handler({ path: guildPath }),
      /not empty/,
    );
  });
});
