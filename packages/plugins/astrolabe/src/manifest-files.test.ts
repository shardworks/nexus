/**
 * Tests for the manifest-files parser.
 *
 * Covers the brief-prescribed behavioural surface: counts distinct
 * task-scoped file-path tokens, deduplicates across tasks, ignores
 * non-task-scoped <files> elements, rejects URL-shaped tokens, and
 * never throws on malformed input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { countManifestFiles, extractManifestFilePaths } from './manifest-files.ts';

// ── Fixtures ──────────────────────────────────────────────────────────

function buildManifest(taskFiles: string[][]): string {
  const tasks = taskFiles.map((files, idx) => {
    const filesBlocks = files.map(f => `<files>${f}</files>`).join('\n    ');
    return `  <task id="t${idx + 1}">\n    <name>Task ${idx + 1}</name>\n    ${filesBlocks}\n  </task>`;
  }).join('\n');
  return `# Specification\n\nIntro prose here.\n\n<task-manifest>\n${tasks}\n</task-manifest>\n`;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('manifest-files parser', () => {
  it('counts 7 distinct paths from a single-task manifest', () => {
    const spec = buildManifest([[
      'packages/a/foo.ts',
      'packages/a/bar.ts',
      'packages/a/baz.ts',
      'packages/b/qux.ts',
      'packages/b/quux.ts',
      'docs/foo.md',
      'docs/bar.md',
    ]]);
    assert.equal(countManifestFiles(spec), 7);
  });

  it('counts 18 distinct paths across multiple tasks', () => {
    const taskA = [
      'packages/a/1.ts',
      'packages/a/2.ts',
      'packages/a/3.ts',
      'packages/a/4.ts',
      'packages/a/5.ts',
      'packages/a/6.ts',
    ];
    const taskB = [
      'packages/b/1.ts',
      'packages/b/2.ts',
      'packages/b/3.ts',
      'packages/b/4.ts',
      'packages/b/5.ts',
      'packages/b/6.ts',
    ];
    const taskC = [
      'docs/1.md',
      'docs/2.md',
      'docs/3.md',
      'docs/4.md',
      'docs/5.md',
      'docs/6.md',
    ];
    const spec = buildManifest([taskA, taskB, taskC]);
    assert.equal(countManifestFiles(spec), 18);
  });

  it('counts the same path repeated across tasks only once', () => {
    const shared = 'packages/shared/index.ts';
    const spec = buildManifest([
      [shared, 'packages/a/foo.ts'],
      [shared, 'packages/b/bar.ts'],
      [shared, 'packages/c/baz.ts'],
    ]);
    // 4 distinct paths: shared, a/foo, b/bar, c/baz
    assert.equal(countManifestFiles(spec), 4);
  });

  it('extracts backticked paths from free-form prose inside <files>', () => {
    const spec = `
<task-manifest>
  <task id="t1">
    <files>
      Modify \`packages/foo/bar.ts\` and \`packages/foo/baz.ts\` to add
      the new field. Touch \`docs/reference/event-catalog.md\` for the
      catalog entry.
    </files>
  </task>
</task-manifest>
`;
    const paths = extractManifestFilePaths(spec);
    assert.deepEqual(
      [...paths].sort(),
      [
        'docs/reference/event-catalog.md',
        'packages/foo/bar.ts',
        'packages/foo/baz.ts',
      ],
    );
    assert.equal(countManifestFiles(spec), 3);
  });

  it('returns 0 when no <task-manifest> block is present', () => {
    const spec = '# Specification\n\nThis spec has no task manifest at all.\n';
    assert.equal(countManifestFiles(spec), 0);
  });

  it('returns 0 for an empty string', () => {
    assert.equal(countManifestFiles(''), 0);
  });

  it('returns 0 when the manifest has no <task> children', () => {
    const spec = '<task-manifest>\n  <files>packages/foo.ts</files>\n</task-manifest>\n';
    // Manifest-level <files> is intentionally ignored (D8) — only
    // task-scoped predictions count.
    assert.equal(countManifestFiles(spec), 0);
  });

  it('returns 0 for malformed XML (unclosed manifest)', () => {
    const spec = '# Spec\n\n<task-manifest>\n  <task><files>packages/foo.ts</files></task>\n  garbage with no closing tag\n';
    // No closing </task-manifest> — the regex's lazy match fails to
    // find a complete block, so no manifest is recognised → count = 0.
    assert.equal(countManifestFiles(spec), 0);
  });

  it('does not count URL-shaped tokens', () => {
    const spec = `
<task-manifest>
  <task id="t1">
    <files>
      See https://example.com/specs/foo.md and
      http://internal.corp/docs/bar.md for context.
      Touch packages/foo/bar.ts.
    </files>
  </task>
</task-manifest>
`;
    const paths = extractManifestFilePaths(spec);
    assert.deepEqual([...paths], ['packages/foo/bar.ts']);
    assert.equal(countManifestFiles(spec), 1);
  });

  it('does not count manifest-level <files> elements outside any <task>', () => {
    const spec = `
<task-manifest>
  <files>packages/manifest-level/should-be-ignored.ts</files>
  <task id="t1">
    <files>packages/task-scoped/counted.ts</files>
  </task>
</task-manifest>
`;
    const paths = extractManifestFilePaths(spec);
    assert.deepEqual([...paths], ['packages/task-scoped/counted.ts']);
    assert.equal(countManifestFiles(spec), 1);
  });

  it('handles globs and unusual extensions', () => {
    const spec = `
<task-manifest>
  <task id="t1">
    <files>
      src/**/*.ts
      packages/{a,b}/*.tsx
      docs/*.unusual-ext
      bin/run
      config/.eslintrc.json
    </files>
  </task>
</task-manifest>
`;
    const paths = extractManifestFilePaths(spec);
    assert.equal(paths.size, 5);
    assert.ok(paths.has('src/**/*.ts'));
    assert.ok(paths.has('packages/{a,b}/*.tsx'));
    assert.ok(paths.has('docs/*.unusual-ext'));
    assert.ok(paths.has('bin/run'));
    assert.ok(paths.has('config/.eslintrc.json'));
  });

  it('does not throw on a non-string input (defensive)', () => {
    assert.equal(countManifestFiles(undefined as unknown as string), 0);
    assert.equal(countManifestFiles(null as unknown as string), 0);
  });

  it('strips trailing prose punctuation from path tokens', () => {
    const spec = `
<task-manifest>
  <task id="t1">
    <files>
      Modify packages/foo/bar.ts. Then touch packages/foo/baz.ts;
      finally update packages/foo/qux.ts, ok?
    </files>
  </task>
</task-manifest>
`;
    const paths = extractManifestFilePaths(spec);
    // Trailing `.`, `;`, `,` are stripped — three distinct paths.
    assert.equal(paths.size, 3);
    assert.ok(paths.has('packages/foo/bar.ts'));
    assert.ok(paths.has('packages/foo/baz.ts'));
    assert.ok(paths.has('packages/foo/qux.ts'));
  });

  it('returns 0 when the spec has a manifest but tokens lack any "/"', () => {
    const spec = `
<task-manifest>
  <task id="t1">
    <files>foo bar baz</files>
  </task>
</task-manifest>
`;
    assert.equal(countManifestFiles(spec), 0);
  });
});
