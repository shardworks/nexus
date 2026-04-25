/**
 * Unit tests for the shared pid-helpers module.
 *
 * Covers the four public helpers without reaching into any daemon
 * code path. The `waitForExit` test spawns a tiny node child so we
 * have a real, signal-able pid that we control.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  isProcessAlive,
  readPidFile,
  tryUnlink,
  waitForExit,
} from './pid-helpers.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pid-helpers-'));
}

describe('isProcessAlive', () => {
  it('returns true for our own process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('returns false for a pid that does not exist', () => {
    // 999_999_999 is virtually guaranteed to be free on any host.
    assert.equal(isProcessAlive(999_999_999), false);
  });
});

describe('readPidFile', () => {
  it('returns null when the file does not exist', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'missing.pid');
    assert.equal(readPidFile(file), null);
  });

  it('returns the parsed pid for a valid pidfile', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'good.pid');
    fs.writeFileSync(file, '12345\n');
    assert.equal(readPidFile(file), 12345);
  });

  it('returns null for a malformed pidfile', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'bad.pid');
    fs.writeFileSync(file, 'not-a-number\n');
    assert.equal(readPidFile(file), null);
  });

  it('returns null for a non-positive pidfile', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'zero.pid');
    fs.writeFileSync(file, '0\n');
    assert.equal(readPidFile(file), null);
  });
});

describe('tryUnlink', () => {
  it('removes an existing file', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'present');
    fs.writeFileSync(file, 'x');
    tryUnlink(file);
    assert.equal(fs.existsSync(file), false);
  });

  it('does not throw when the file is missing', () => {
    const tmp = makeTmp();
    const file = path.join(tmp, 'absent');
    assert.doesNotThrow(() => tryUnlink(file));
  });
});

describe('waitForExit', () => {
  it('returns true once the process exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], {
      stdio: 'ignore',
    });
    if (typeof child.pid !== 'number') throw new Error('child has no pid');
    const exited = await waitForExit(child.pid, 5000);
    assert.equal(exited, true);
  });

  it('returns false when the process is still alive after the timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    if (typeof child.pid !== 'number') throw new Error('child has no pid');
    try {
      const exited = await waitForExit(child.pid, 200);
      assert.equal(exited, false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
