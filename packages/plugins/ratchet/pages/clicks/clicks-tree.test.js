/**
 * Unit tests for the pure tree helpers in clicks/index.html.
 *
 * Covers the D21 requirements that apply to the left-hand tree / scope /
 * breadcrumb logic:
 *   - tree-build from the JSON click-tree response (the page ingests the
 *     structured ClickTree[] returned by `/api/click/tree?format=json`, so the
 *     tests exercise that shape directly)
 *   - prune-by-status correctness including the subtree-hiding property
 *   - subtree scoping including breadcrumb derivation from the ancestor chain
 *   - link dispatch by prefix (c-…, w-…, other)
 *   - supporting helpers (countChildrenByStatus, shortId, statusBadge)
 *
 * The helpers under test are re-declared at the top of this file because the
 * page wraps them in an IIFE and does not export them. Keep the implementations
 * in sync with `pages/clicks/index.html`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Re-declared helpers (mirror index.html) ─────────────────────────

const ALL_STATUSES = ['live', 'parked', 'concluded', 'dropped'];

function pruneByStatus(forestIn, statusSet) {
  if (!statusSet || statusSet.size === ALL_STATUSES.length) return forestIn;
  const out = [];
  for (const node of forestIn) {
    if (!statusSet.has(node.click.status)) continue;
    out.push({
      click: node.click,
      children: pruneByStatus(node.children, statusSet),
    });
  }
  return out;
}

function findInForest(forestIn, id) {
  for (const node of forestIn) {
    if (node.click.id === id) return node;
    const found = findInForest(node.children, id);
    if (found) return found;
  }
  return null;
}

function ancestorPath(forestIn, id, acc) {
  acc = acc ?? [];
  for (const node of forestIn) {
    const next = acc.concat([node]);
    if (node.click.id === id) return next;
    const deep = ancestorPath(node.children, id, next);
    if (deep.length > 0) return deep;
  }
  return [];
}

function linkDispatch(targetId) {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    return { kind: 'plain', id: String(targetId ?? '') };
  }
  if (targetId.startsWith('c-')) return { kind: 'click', id: targetId };
  if (targetId.startsWith('w-')) {
    return { kind: 'writ', id: targetId, href: `/pages/writs/?writ=${encodeURIComponent(targetId)}` };
  }
  return { kind: 'plain', id: targetId };
}

function countChildrenByStatus(children) {
  const out = { live: 0, parked: 0, concluded: 0, dropped: 0 };
  for (const c of children) {
    if (out[c.status] === undefined) out[c.status] = 0;
    out[c.status] += 1;
  }
  return out;
}

function hasGoalHistory(click) {
  return Array.isArray(click?.goalHistory) && click.goalHistory.length > 0;
}

function treeHistoryMarkerProps(click) {
  if (!hasGoalHistory(click)) return null;
  const count = click.goalHistory.length;
  return {
    className: 'tree-history',
    text: '✎',
    title: `Has prior goals (${count})`,
  };
}

function shortId(id) {
  const parts = String(id).split('-');
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : id;
}

function statusBadge(status) {
  const map = {
    live: 'badge badge--active',
    parked: 'badge badge--warning',
    concluded: 'badge badge--success',
    dropped: 'badge badge--error',
  };
  const cls = map[status] ?? 'badge';
  return `<span class="${cls}">${status}</span>`;
}

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * Build a small fixture forest shaped like the server response:
 *
 *   c-a  (live)
 *   ├── c-a1  (live)
 *   │   └── c-a1a (concluded)
 *   └── c-a2  (parked)
 *       └── c-a2a (dropped)
 *   c-b  (concluded)
 *       └── c-b1 (live)   <- live descendant under a terminal root
 */
function makeForest() {
  return [
    {
      click: { id: 'c-a', status: 'live', goal: 'A root' },
      children: [
        {
          click: { id: 'c-a1', status: 'live', goal: 'A1' },
          children: [
            { click: { id: 'c-a1a', status: 'concluded', goal: 'A1a' }, children: [] },
          ],
        },
        {
          click: { id: 'c-a2', status: 'parked', goal: 'A2' },
          children: [
            { click: { id: 'c-a2a', status: 'dropped', goal: 'A2a' }, children: [] },
          ],
        },
      ],
    },
    {
      click: { id: 'c-b', status: 'concluded', goal: 'B root' },
      children: [
        { click: { id: 'c-b1', status: 'live', goal: 'B1' }, children: [] },
      ],
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────

describe('pruneByStatus — status filter semantics', () => {
  it('returns the forest unchanged when all statuses are active', () => {
    const forest = makeForest();
    const out = pruneByStatus(forest, new Set(ALL_STATUSES));
    assert.strictEqual(out, forest, 'no-op when all statuses match');
  });

  it('returns the forest unchanged when statusSet is null/undefined', () => {
    const forest = makeForest();
    assert.strictEqual(pruneByStatus(forest, null), forest);
    assert.strictEqual(pruneByStatus(forest, undefined), forest);
  });

  it('drops nodes whose status does not match the filter', () => {
    const forest = makeForest();
    const out = pruneByStatus(forest, new Set(['live']));
    // c-b (concluded) root pruned entirely — even though c-b1 is live.
    const ids = out.map((n) => n.click.id);
    assert.deepEqual(ids, ['c-a']);
  });

  it('hides the subtree of a pruned ancestor (subtree-hiding property)', () => {
    const forest = makeForest();
    // Filter only live. c-b is concluded → its live descendant c-b1 must NOT
    // surface in the output. This is the critical D6 prune semantic.
    const out = pruneByStatus(forest, new Set(['live']));
    const ids = [];
    function collect(nodes) {
      for (const n of nodes) {
        ids.push(n.click.id);
        collect(n.children);
      }
    }
    collect(out);
    assert.ok(!ids.includes('c-b1'), 'live descendant of a pruned terminal root must be hidden');
    assert.ok(!ids.includes('c-b'), 'terminal root itself must be hidden');
    // And parked/dropped siblings of c-a must also be pruned.
    assert.ok(!ids.includes('c-a2'), 'parked sibling pruned');
    assert.ok(!ids.includes('c-a2a'), 'dropped child pruned');
    // c-a1a (concluded) must be pruned even though its parent matches.
    assert.ok(!ids.includes('c-a1a'), 'concluded child of a surviving parent must also be pruned');
    // c-a and c-a1 (both live) must survive.
    assert.deepEqual(ids, ['c-a', 'c-a1']);
  });

  it('passes terminal-only filter through to the correct nodes', () => {
    const forest = makeForest();
    const out = pruneByStatus(forest, new Set(['concluded', 'dropped']));
    const ids = out.map((n) => n.click.id);
    // c-a (live) does not match → its c-a1a (concluded) and c-a2a (dropped)
    // descendants must not surface either.
    assert.deepEqual(ids, ['c-b'], 'only c-b matches at the root level');
    // c-b's child c-b1 (live) should be dropped by the subtree-hiding rule.
    assert.deepEqual(out[0].children, []);
  });

  it('returns empty array when nothing matches', () => {
    const forest = makeForest();
    const out = pruneByStatus(forest, new Set([]));
    // Empty Set has size 0, which is not equal to ALL_STATUSES.length, so
    // the filter runs. Nothing matches, so we get an empty forest.
    assert.deepEqual(out, []);
  });

  it('preserves the original forest (does not mutate)', () => {
    const forest = makeForest();
    const before = JSON.stringify(forest);
    pruneByStatus(forest, new Set(['live']));
    assert.strictEqual(JSON.stringify(forest), before, 'input forest must not be mutated');
  });
});

describe('findInForest — subtree lookup', () => {
  it('finds a root node', () => {
    const forest = makeForest();
    const node = findInForest(forest, 'c-a');
    assert.ok(node);
    assert.strictEqual(node.click.id, 'c-a');
  });

  it('finds a deep descendant', () => {
    const forest = makeForest();
    const node = findInForest(forest, 'c-a1a');
    assert.ok(node);
    assert.strictEqual(node.click.id, 'c-a1a');
    assert.strictEqual(node.click.status, 'concluded');
  });

  it('returns null when the id is absent', () => {
    const forest = makeForest();
    assert.strictEqual(findInForest(forest, 'c-missing'), null);
  });

  it('returns null on an empty forest', () => {
    assert.strictEqual(findInForest([], 'c-a'), null);
  });
});

describe('ancestorPath — breadcrumb derivation', () => {
  it('returns a single-element path for a root node', () => {
    const forest = makeForest();
    const path = ancestorPath(forest, 'c-a');
    const ids = path.map((n) => n.click.id);
    assert.deepEqual(ids, ['c-a']);
  });

  it('returns the full chain top-down for a deep descendant', () => {
    const forest = makeForest();
    const path = ancestorPath(forest, 'c-a1a');
    const ids = path.map((n) => n.click.id);
    // Topmost ancestor first, target node last — matches how the breadcrumb
    // renders "Show all › A root › A1 › A1a".
    assert.deepEqual(ids, ['c-a', 'c-a1', 'c-a1a']);
  });

  it('returns empty array when the id is not in the forest', () => {
    const forest = makeForest();
    assert.deepEqual(ancestorPath(forest, 'c-missing'), []);
  });

  it('works across sibling root subtrees', () => {
    const forest = makeForest();
    const path = ancestorPath(forest, 'c-b1');
    const ids = path.map((n) => n.click.id);
    assert.deepEqual(ids, ['c-b', 'c-b1']);
  });

  it('breadcrumb segments carry goals for clickable labels', () => {
    // The breadcrumb renders node.click.goal — make sure ancestorPath hands
    // back nodes with the goal intact (not stripped down to ids).
    const forest = makeForest();
    const path = ancestorPath(forest, 'c-a1');
    const labels = path.map((n) => n.click.goal);
    assert.deepEqual(labels, ['A root', 'A1']);
  });
});

describe('subtree scoping — findInForest + pruneByStatus compose', () => {
  it('scoping to c-a and filtering by live only shows the live chain', () => {
    const forest = makeForest();
    const scopedRoot = findInForest(forest, 'c-a');
    const scoped = scopedRoot ? [scopedRoot] : [];
    const pruned = pruneByStatus(scoped, new Set(['live']));
    const ids = [];
    function collect(nodes) {
      for (const n of nodes) { ids.push(n.click.id); collect(n.children); }
    }
    collect(pruned);
    assert.deepEqual(ids, ['c-a', 'c-a1']);
  });

  it('scoping to a missing id yields an empty pruned forest', () => {
    const forest = makeForest();
    const scopedRoot = findInForest(forest, 'c-ghost');
    const scoped = scopedRoot ? [scopedRoot] : [];
    const pruned = pruneByStatus(scoped, new Set(ALL_STATUSES));
    assert.deepEqual(pruned, []);
  });
});

describe('linkDispatch — prefix routing', () => {
  it('routes c-… to in-page click selection', () => {
    const r = linkDispatch('c-mo1mq8ry-abc123');
    assert.deepEqual(r, { kind: 'click', id: 'c-mo1mq8ry-abc123' });
  });

  it('routes w-… to the writs page with a ?writ= href', () => {
    const r = linkDispatch('w-mo2abcde-def456');
    assert.strictEqual(r.kind, 'writ');
    assert.strictEqual(r.id, 'w-mo2abcde-def456');
    assert.strictEqual(r.href, '/pages/writs/?writ=w-mo2abcde-def456');
  });

  it('URL-encodes the writ id in the generated href', () => {
    const r = linkDispatch('w-weird id');
    assert.strictEqual(r.kind, 'writ');
    assert.ok(r.href.includes('%20'), 'spaces must be percent-encoded');
  });

  it('routes anything else to plain text', () => {
    assert.deepEqual(linkDispatch('m-something'), { kind: 'plain', id: 'm-something' });
    assert.deepEqual(linkDispatch('freeform'), { kind: 'plain', id: 'freeform' });
  });

  it('treats empty / non-string input as plain', () => {
    assert.deepEqual(linkDispatch(''), { kind: 'plain', id: '' });
    assert.deepEqual(linkDispatch(null), { kind: 'plain', id: '' });
    assert.deepEqual(linkDispatch(undefined), { kind: 'plain', id: '' });
    assert.deepEqual(linkDispatch(123), { kind: 'plain', id: '123' });
  });
});

describe('countChildrenByStatus — status-count strip', () => {
  it('returns zero counts for an empty list', () => {
    const counts = countChildrenByStatus([]);
    assert.deepEqual(counts, { live: 0, parked: 0, concluded: 0, dropped: 0 });
  });

  it('tallies mixed statuses', () => {
    const children = [
      { status: 'live' },
      { status: 'live' },
      { status: 'parked' },
      { status: 'concluded' },
    ];
    const counts = countChildrenByStatus(children);
    assert.deepEqual(counts, { live: 2, parked: 1, concluded: 1, dropped: 0 });
  });

  it('tolerates unknown statuses by adding a key', () => {
    const counts = countChildrenByStatus([{ status: 'mystery' }]);
    assert.strictEqual(counts.mystery, 1);
  });
});

describe('shortId — c-{prefix}-{base36ts} trimming', () => {
  it('trims to two segments', () => {
    assert.strictEqual(shortId('c-mo1mq8ry-abc123def'), 'c-mo1mq8ry');
  });

  it('returns the original id when it has fewer than two segments', () => {
    assert.strictEqual(shortId('noDash'), 'noDash');
  });

  it('handles IDs with extra segments gracefully', () => {
    assert.strictEqual(shortId('w-abc-def-ghi-jkl'), 'w-abc');
  });
});

describe('hasGoalHistory — prior-goals predicate', () => {
  it('returns false when goalHistory is absent', () => {
    assert.strictEqual(hasGoalHistory({ id: 'c-a', goal: 'g', status: 'live' }), false);
  });

  it('returns false when goalHistory is an empty array', () => {
    assert.strictEqual(
      hasGoalHistory({ id: 'c-a', goal: 'g', status: 'live', goalHistory: [] }),
      false,
    );
  });

  it('returns true when goalHistory is a non-empty array', () => {
    const click = {
      id: 'c-a',
      goal: 'current',
      status: 'live',
      goalHistory: [{ goal: 'older', amendedAt: '2025-03-01T00:00:00Z' }],
    };
    assert.strictEqual(hasGoalHistory(click), true);
  });

  it('returns false when goalHistory is not an array (defensive)', () => {
    assert.strictEqual(
      hasGoalHistory({ id: 'c-a', goal: 'g', status: 'live', goalHistory: 'nope' }),
      false,
    );
    assert.strictEqual(
      hasGoalHistory({ id: 'c-a', goal: 'g', status: 'live', goalHistory: null }),
      false,
    );
  });

  it('returns false for null / undefined input', () => {
    assert.strictEqual(hasGoalHistory(null), false);
    assert.strictEqual(hasGoalHistory(undefined), false);
  });
});

describe('treeHistoryMarkerProps — "has prior goals" marker (D18–D21)', () => {
  function makeClick(status, goalHistory) {
    return {
      id: 'c-a',
      goal: 'current goal',
      status,
      ...(goalHistory !== undefined ? { goalHistory } : {}),
    };
  }

  it('returns null when goalHistory is absent (no marker rendered)', () => {
    assert.strictEqual(treeHistoryMarkerProps(makeClick('live')), null);
  });

  it('returns null when goalHistory is an empty array', () => {
    assert.strictEqual(treeHistoryMarkerProps(makeClick('live', [])), null);
  });

  it('returns a descriptor carrying the tree-history class and a title tooltip when history exists', () => {
    const click = makeClick('live', [
      { goal: 'older', amendedAt: '2025-03-01T10:00:00Z' },
    ]);
    const props = treeHistoryMarkerProps(click);
    assert.ok(props);
    assert.strictEqual(props.className, 'tree-history');
    assert.ok(props.title.length > 0, 'title tooltip must be non-empty');
  });

  it('includes the exact entry count in the title tooltip (D21)', () => {
    const click = makeClick('live', [
      { goal: 'a', amendedAt: '2025-03-01T10:00:00Z' },
      { goal: 'b', amendedAt: '2025-03-01T11:00:00Z' },
      { goal: 'c', amendedAt: '2025-03-01T12:00:00Z' },
    ]);
    const props = treeHistoryMarkerProps(click);
    assert.ok(props.title.includes('(3)'), `title "${props.title}" should carry count (3)`);
  });

  it('renders the marker regardless of status (D19)', () => {
    for (const status of ALL_STATUSES) {
      const click = makeClick(status, [
        { goal: 'older', amendedAt: '2025-03-01T10:00:00Z' },
      ]);
      const props = treeHistoryMarkerProps(click);
      assert.ok(props, `status=${status} with history must yield a marker`);
      assert.strictEqual(props.className, 'tree-history');
    }
  });

  it('never yields a marker when status varies but history is absent', () => {
    for (const status of ALL_STATUSES) {
      assert.strictEqual(
        treeHistoryMarkerProps(makeClick(status)),
        null,
        `status=${status} without history must yield null`,
      );
      assert.strictEqual(
        treeHistoryMarkerProps(makeClick(status, [])),
        null,
        `status=${status} with empty history must yield null`,
      );
    }
  });
});

describe('statusBadge — CSS class mapping (D12)', () => {
  it('maps live to badge--active', () => {
    assert.strictEqual(statusBadge('live'), '<span class="badge badge--active">live</span>');
  });

  it('maps parked to badge--warning', () => {
    assert.strictEqual(statusBadge('parked'), '<span class="badge badge--warning">parked</span>');
  });

  it('maps concluded to badge--success', () => {
    assert.strictEqual(statusBadge('concluded'), '<span class="badge badge--success">concluded</span>');
  });

  it('maps dropped to badge--error', () => {
    assert.strictEqual(statusBadge('dropped'), '<span class="badge badge--error">dropped</span>');
  });

  it('falls through to a plain badge for unknown statuses', () => {
    assert.strictEqual(statusBadge('mystery'), '<span class="badge">mystery</span>');
  });

  it('never uses a Unicode glyph (D12 forbids it)', () => {
    for (const status of ALL_STATUSES) {
      const html = statusBadge(status);
      // Rendered HTML should contain only ASCII + the status word itself.
      // D12 specifically bans emoji / geometric glyphs here.
      assert.ok(
        !/[^\x00-\x7f]/.test(html),
        `statusBadge(${status}) must not contain non-ASCII characters`,
      );
    }
  });
});
