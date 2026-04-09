/**
 * Astrolabe Oculus page registration and page asset tests.
 *
 * Validates:
 * - supportKit declares the astrolabe page contribution (R1)
 * - package.json includes "pages" in files array (R18)
 * - Page assets exist on disk (R2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAstrolabe } from './astrolabe.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

type AnyApparatus = {
  apparatus: {
    supportKit?: Record<string, unknown>;
  };
};

describe('Astrolabe Oculus page', () => {
  const plugin = createAstrolabe();
  const kit = (plugin as AnyApparatus).apparatus.supportKit!;

  // ── R1: page contribution ──────────────────────────────────────────

  it('declares a pages array with one entry', () => {
    const pages = kit.pages as Array<{ id: string; title: string; dir: string }>;
    assert.ok(Array.isArray(pages), 'pages must be an array');
    assert.equal(pages.length, 1);
  });

  it('page entry has id "astrolabe", title "Astrolabe", dir "pages/astrolabe"', () => {
    const pages = kit.pages as Array<{ id: string; title: string; dir: string }>;
    const page = pages[0];
    assert.equal(page.id, 'astrolabe');
    assert.equal(page.title, 'Astrolabe');
    assert.equal(page.dir, 'pages/astrolabe');
  });

  // ── R18: package.json files ────────────────────────────────────────

  it('package.json files array includes "pages"', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8'));
    assert.ok(Array.isArray(pkg.files), 'files must be an array');
    assert.ok(pkg.files.includes('pages'), 'files must include "pages"');
  });

  // ── R2: page assets exist on disk ──────────────────────────────────

  it('index.html exists', () => {
    assert.ok(existsSync(resolve(pkgRoot, 'pages/astrolabe/index.html')));
  });

  it('astrolabe.js exists', () => {
    assert.ok(existsSync(resolve(pkgRoot, 'pages/astrolabe/astrolabe.js')));
  });

  it('astrolabe.css exists', () => {
    assert.ok(existsSync(resolve(pkgRoot, 'pages/astrolabe/astrolabe.css')));
  });

  // ── Page content checks ────────────────────────────────────────────

  it('index.html references astrolabe.js and astrolabe.css', () => {
    const html = readFileSync(resolve(pkgRoot, 'pages/astrolabe/index.html'), 'utf-8');
    assert.ok(html.includes('astrolabe.js'), 'must reference astrolabe.js');
    assert.ok(html.includes('astrolabe.css'), 'must reference astrolabe.css');
  });

  it('index.html contains list view and detail view containers', () => {
    const html = readFileSync(resolve(pkgRoot, 'pages/astrolabe/index.html'), 'utf-8');
    assert.ok(html.includes('id="plan-list-view"'), 'must have plan-list-view');
    assert.ok(html.includes('id="plan-detail-view"'), 'must have plan-detail-view');
  });

  it('index.html has status filter buttons for all statuses', () => {
    const html = readFileSync(resolve(pkgRoot, 'pages/astrolabe/index.html'), 'utf-8');
    const statuses = ['reading', 'analyzing', 'reviewing', 'writing', 'completed', 'failed'];
    for (const s of statuses) {
      assert.ok(html.includes('data-status="' + s + '"'), `must have filter for ${s}`);
    }
    // Also must have "All" button with empty status
    assert.ok(html.includes('data-status=""'), 'must have All filter');
  });

  it('index.html has tab bar with all five tabs', () => {
    const html = readFileSync(resolve(pkgRoot, 'pages/astrolabe/index.html'), 'utf-8');
    const tabs = ['inventory', 'scope', 'decisions', 'observations', 'spec'];
    for (const t of tabs) {
      assert.ok(html.includes('data-tab="' + t + '"'), `must have tab for ${t}`);
    }
  });
});
