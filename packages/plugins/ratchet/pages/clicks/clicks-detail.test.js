/**
 * Unit tests for detail-pane rendering in clicks/index.html.
 *
 * Covers the D21 requirement:
 *   - detail-pane rendering (fields, children section, links section)
 *
 * The renderer (`buildDetailHtml`) is re-declared at the top of this file
 * because the page wraps it in an IIFE. Keep the implementation in sync with
 * `pages/clicks/index.html`. Supporting helpers (statusBadge, escHtml/escAttr,
 * linkDispatch, countChildrenByStatus, shortId, fmtDate) are likewise mirrored.
 *
 * We do not exercise DOM event wiring here — that depends on browser APIs and
 * the tests below validate the pure HTML string that feeds `innerHTML =`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Re-declared helpers (mirror index.html) ─────────────────────────

const ALL_STATUSES = ['live', 'parked', 'concluded', 'dropped'];
const LINK_TYPES = ['related', 'commissioned', 'supersedes', 'depends-on'];
const TERMINAL_STATUSES = new Set(['concluded', 'dropped']);

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return escHtml(s);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
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

function shortId(id) {
  const parts = String(id).split('-');
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : id;
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

function buildAmendConfirmHtml(currentGoal) {
  const confirmLabel = 'Amend';
  const prefill = currentGoal ?? '';
  const startDisabled = prefill.trim().length === 0;
  return `
        <div class="confirm-section">
          <label>New goal</label>
          <input type="text" id="confirm-input" value="${escAttr(prefill)}" placeholder="Refine the goal">
          <button class="btn" id="confirm-submit"${startDisabled ? ' disabled' : ''}>${confirmLabel}</button>
          <button class="btn" id="confirm-abort">Cancel</button>
          <div class="error-msg" id="confirm-error" style="display:none"></div>
        </div>`;
}

function renderLinkRow(link, direction) {
  const isOutbound = direction === 'outbound';
  const otherId = isOutbound ? link.targetId : link.sourceId;
  const dispatch = linkDispatch(otherId);
  let targetHtml;
  if (dispatch.kind === 'click') {
    targetHtml = `<a class="link-id" data-click-id="${escAttr(otherId)}">${escHtml(otherId)}</a>`;
  } else if (dispatch.kind === 'writ') {
    targetHtml = `<a class="link-id" href="${escAttr(dispatch.href)}">${escHtml(otherId)}</a>`;
  } else {
    targetHtml = `<span class="link-id plain">${escHtml(otherId)}</span>`;
  }
  return `<div class="link-row">
        <span class="link-dir">${isOutbound ? '→' : '←'}</span>
        ${targetHtml}
        <span class="link-meta" data-meta-for="${escAttr(otherId)}"></span>
        <span>(${escHtml(link.linkType)})</span>
        <button class="btn btn--danger" style="padding:0.1rem 0.5rem;font-size:0.75rem"
          data-action="unlink"
          data-source="${escAttr(link.sourceId)}"
          data-target="${escAttr(link.targetId)}"
          data-linktype="${escAttr(link.linkType)}">×</button>
      </div>`;
}

function buildDetailHtml(click) {
  const isTerminal = TERMINAL_STATUSES.has(click.status);
  const statusCounts = countChildrenByStatus(click.children?.items ?? []);
  let html = '';

  html += `<h2 style="margin-top:0">${escHtml(click.goal)}</h2>`;
  html += `<div style="margin-bottom:0.75rem;font-size:0.875rem;opacity:0.7">`;
  html += `<code id="detail-id">${escHtml(click.id)}</code> `;
  html += `<button class="btn tree-copy" id="detail-copy-btn" style="padding:0.1rem 0.35rem">📋</button>`;
  html += `</div>`;

  html += `<div class="detail-section"><h4>Details</h4><dl class="detail-grid">`;
  html += `<dt>Status</dt><dd>${statusBadge(click.status)}</dd>`;
  if (click.parent) {
    html += `<dt>Parent</dt><dd><a class="link-id" data-click-id="${escAttr(click.parent.id)}">${escHtml(click.parent.goal)}</a> ${statusBadge(click.parent.status)}</dd>`;
  }
  html += `<dt>Created</dt><dd>${fmtDate(click.createdAt)}</dd>`;
  if (click.resolvedAt) html += `<dt>Resolved</dt><dd>${fmtDate(click.resolvedAt)}</dd>`;
  if (click.createdSessionId) html += `<dt>Created by</dt><dd><code>${escHtml(click.createdSessionId)}</code></dd>`;
  if (click.resolvedSessionId) html += `<dt>Resolved by</dt><dd><code>${escHtml(click.resolvedSessionId)}</code></dd>`;
  html += `</dl>`;
  if (isTerminal && click.conclusion) {
    html += `<details style="margin-top:0.5rem"><summary>Conclusion</summary>`;
    html += `<div class="detail-conclusion">${escHtml(click.conclusion)}</div>`;
    html += `</details>`;
  }
  if (hasGoalHistory(click)) {
    const history = click.goalHistory;
    html += `<details class="prior-goals" style="margin-top:0.5rem"><summary>Prior goals (${history.length})</summary>`;
    for (const entry of history) {
      html += `<div class="prior-goal-entry">`;
      html += `<div class="detail-conclusion">${escHtml(entry.goal)}</div>`;
      html += `<div class="prior-goal-meta">${escHtml(fmtDate(entry.amendedAt))}`;
      if (entry.sessionId) html += ` · session: <code>${escHtml(entry.sessionId)}</code>`;
      html += `</div>`;
      html += `</div>`;
    }
    html += `</details>`;
  }
  html += `</div>`;

  if (!isTerminal) {
    html += `<div class="detail-section"><h4>Actions</h4>`;
    html += `<div class="action-buttons" id="detail-actions">`;
    if (click.status === 'live') {
      html += `<button class="btn" data-action="park">Park</button>`;
      html += `<button class="btn btn--success" data-action="conclude">Conclude…</button>`;
      html += `<button class="btn btn--danger" data-action="drop">Drop…</button>`;
      html += `<button class="btn" data-action="amend">Amend…</button>`;
    } else if (click.status === 'parked') {
      html += `<button class="btn" data-action="resume">Resume</button>`;
      html += `<button class="btn btn--success" data-action="conclude">Conclude…</button>`;
      html += `<button class="btn btn--danger" data-action="drop">Drop…</button>`;
    }
    html += `</div>`;
    html += `<div id="confirm-area"></div>`;
    html += `<div id="action-error" class="error-msg" style="display:none"></div>`;
    html += `</div>`;
  }

  const outbound = click.links?.outbound ?? [];
  const inbound = click.links?.inbound ?? [];
  html += `<div class="detail-section"><h4>Links</h4>`;
  if (outbound.length === 0 && inbound.length === 0) {
    html += `<p style="font-size:0.875rem;opacity:0.5;margin:0 0 0.5rem">No links.</p>`;
  }
  for (const l of outbound) html += renderLinkRow(l, 'outbound');
  for (const l of inbound) html += renderLinkRow(l, 'inbound');
  html += `<div class="add-link-form">`;
  html += `<input type="text" id="link-target-input" placeholder="Target ID (c-… or w-…)" style="width:180px">`;
  html += `<select id="link-type-select">`;
  for (const t of LINK_TYPES) html += `<option value="${t}">${t}</option>`;
  html += `</select>`;
  html += `<button class="btn" data-action="addlink">Link</button>`;
  html += `<div id="link-error" class="error-msg" style="display:none"></div>`;
  html += `</div>`;
  html += `</div>`;

  const items = click.children?.items ?? [];
  html += `<div class="detail-section"><h4>Children</h4>`;
  if (items.length === 0) {
    html += `<p style="font-size:0.875rem;opacity:0.5;margin:0">No children.</p>`;
  } else {
    html += `<div class="status-count-strip">`;
    for (const status of ALL_STATUSES) {
      const n = statusCounts[status] ?? 0;
      html += `${statusBadge(status)} <span>${n}</span>`;
    }
    html += `</div>`;
    html += `<table class="data-table children-table"><thead><tr>`;
    html += `<th>Status</th><th>Goal</th><th>ID</th>`;
    html += `</tr></thead><tbody>`;
    for (const child of items) {
      html += `<tr data-child-id="${escAttr(child.id)}">`;
      html += `<td>${statusBadge(child.status)}</td>`;
      html += `<td>${escHtml(child.goal)}</td>`;
      html += `<td><code>${escHtml(shortId(child.id))}</code></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;

  return html;
}

// ── Fixtures ────────────────────────────────────────────────────────

function liveClickFixture() {
  return {
    id: 'c-mo1mq8ry-abc123',
    goal: 'Ship the feature',
    status: 'live',
    createdAt: '2025-03-01T10:00:00Z',
    createdSessionId: 's-mo1lll00',
    parent: null,
    conclusion: null,
    resolvedAt: null,
    resolvedSessionId: null,
    links: { outbound: [], inbound: [] },
    children: { items: [] },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('hasGoalHistory — prior-goals predicate (mirrored)', () => {
  it('treats absent goalHistory as no history', () => {
    assert.strictEqual(hasGoalHistory(liveClickFixture()), false);
  });

  it('treats an empty goalHistory array as no history', () => {
    const click = { ...liveClickFixture(), goalHistory: [] };
    assert.strictEqual(hasGoalHistory(click), false);
  });

  it('returns true when goalHistory has at least one entry', () => {
    const click = {
      ...liveClickFixture(),
      goalHistory: [{ goal: 'older', amendedAt: '2025-03-01T10:30:00Z' }],
    };
    assert.strictEqual(hasGoalHistory(click), true);
  });
});

describe('buildDetailHtml — fields section (D24)', () => {
  it('renders goal as the heading and short+full id', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<h2 style="margin-top:0">Ship the feature</h2>'));
    assert.ok(html.includes('<code id="detail-id">c-mo1mq8ry-abc123</code>'));
  });

  it('renders status with the CSS badge class (not unicode)', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<dt>Status</dt><dd><span class="badge badge--active">live</span></dd>'));
  });

  it('renders creator session id but not resolver fields when unresolved', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<dt>Created by</dt>'));
    assert.ok(html.includes('<code>s-mo1lll00</code>'));
    assert.ok(!html.includes('<dt>Resolved</dt>'));
    assert.ok(!html.includes('<dt>Resolved by</dt>'));
  });

  it('renders resolver fields and the conclusion disclosure for terminal clicks', () => {
    const click = {
      ...liveClickFixture(),
      status: 'concluded',
      conclusion: 'Shipped with tests.',
      resolvedAt: '2025-03-02T15:30:00Z',
      resolvedSessionId: 's-mo2abc00',
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<dt>Resolved</dt>'));
    assert.ok(html.includes('<dt>Resolved by</dt>'));
    assert.ok(html.includes('<code>s-mo2abc00</code>'));
    // Conclusion goes into a <details>/<summary> collapsible block (D24).
    assert.ok(html.includes('<summary>Conclusion</summary>'));
    assert.ok(html.includes('Shipped with tests.'));
  });

  it('escapes HTML in the goal, id, and conclusion', () => {
    const click = {
      ...liveClickFixture(),
      goal: 'Fix <script>alert(1)</script>',
      conclusion: 'A & B & "C"',
      status: 'dropped',
    };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('Fix &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('A &amp; B &amp; &quot;C&quot;'));
  });

  it('renders a clickable Parent row with a badge when a parent exists', () => {
    const click = {
      ...liveClickFixture(),
      parent: { id: 'c-mo0zzz11-root', goal: 'Root goal', status: 'live' },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<dt>Parent</dt>'));
    // Clickable link with data-click-id so the page's event wiring can select it.
    assert.ok(html.includes('data-click-id="c-mo0zzz11-root"'));
    assert.ok(html.includes('>Root goal</a>'));
    // The parent row also shows its own status badge.
    assert.ok(html.match(/Parent.*badge--active[^<]*live/s), 'parent status badge rendered');
  });

  it('omits the Parent row for root clicks', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<dt>Parent</dt>'));
  });
});

describe('buildDetailHtml — prior-goals disclosure', () => {
  it('renders no disclosure when goalHistory is absent', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('Prior goals'));
    assert.ok(!html.includes('class="prior-goals"'));
  });

  it('renders no disclosure when goalHistory is an empty array', () => {
    const click = { ...liveClickFixture(), goalHistory: [] };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('Prior goals'));
  });

  it('renders a "Prior goals (N)" summary with the entry count', () => {
    const click = {
      ...liveClickFixture(),
      goalHistory: [
        { goal: 'first', amendedAt: '2025-03-01T10:00:00Z' },
        { goal: 'second', amendedAt: '2025-03-01T11:00:00Z' },
        { goal: 'third', amendedAt: '2025-03-01T12:00:00Z' },
      ],
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<summary>Prior goals (3)</summary>'));
  });

  it('renders entries in oldest-first storage order', () => {
    const click = {
      ...liveClickFixture(),
      goalHistory: [
        { goal: 'alpha', amendedAt: '2025-03-01T10:00:00Z' },
        { goal: 'bravo', amendedAt: '2025-03-01T11:00:00Z' },
        { goal: 'charlie', amendedAt: '2025-03-01T12:00:00Z' },
      ],
    };
    const html = buildDetailHtml(click);
    const iAlpha = html.indexOf('>alpha<');
    const iBravo = html.indexOf('>bravo<');
    const iCharlie = html.indexOf('>charlie<');
    assert.ok(iAlpha >= 0 && iBravo >= 0 && iCharlie >= 0, 'all three entries rendered');
    assert.ok(iAlpha < iBravo && iBravo < iCharlie, 'entries rendered oldest-first');
  });

  it('renders the formatted amendedAt timestamp for each entry', () => {
    const iso = '2025-03-01T10:00:00Z';
    const click = {
      ...liveClickFixture(),
      goalHistory: [{ goal: 'older', amendedAt: iso }],
    };
    const html = buildDetailHtml(click);
    const expected = fmtDate(iso);
    assert.ok(expected.length > 0, 'fmtDate produced a non-empty string');
    assert.ok(html.includes(expected), `formatted timestamp "${expected}" should appear`);
    // The raw ISO string shouldn't appear verbatim (fmtDate transforms it).
    assert.ok(!html.includes(iso));
  });

  it('renders sessionId when present and omits it when absent', () => {
    const click = {
      ...liveClickFixture(),
      goalHistory: [
        { goal: 'with-session', amendedAt: '2025-03-01T10:00:00Z', sessionId: 's-mo2abc00' },
        { goal: 'no-session',  amendedAt: '2025-03-01T11:00:00Z' },
      ],
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<code>s-mo2abc00</code>'));
    assert.ok(html.includes('session:'));
    // Only one "session:" marker — the entry without sessionId should not add one.
    const matches = html.match(/session:/g) ?? [];
    assert.strictEqual(matches.length, 1, 'only the entry with sessionId renders the session label');
  });

  it('escapes HTML in prior-goal text and sessionId', () => {
    const click = {
      ...liveClickFixture(),
      goalHistory: [
        {
          goal: '<script>alert(1)</script>',
          amendedAt: '2025-03-01T10:00:00Z',
          sessionId: 's-"injected"',
        },
      ],
    };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('s-&quot;injected&quot;'));
  });

  it('renders the disclosure on a terminal click with history (audit availability)', () => {
    const click = {
      ...liveClickFixture(),
      status: 'concluded',
      conclusion: 'shipped',
      resolvedAt: '2025-03-02T00:00:00Z',
      goalHistory: [{ goal: 'original', amendedAt: '2025-03-01T10:00:00Z' }],
    };
    const html = buildDetailHtml(click);
    // Both disclosures present, and they are siblings — no nesting.
    assert.ok(html.includes('<summary>Conclusion</summary>'));
    assert.ok(html.includes('<summary>Prior goals (1)</summary>'));
    const iConclusion = html.indexOf('<summary>Conclusion</summary>');
    const iPrior = html.indexOf('<summary>Prior goals (1)</summary>');
    // Conclusion is rendered first, Prior goals second — both inside the Details section.
    assert.ok(iConclusion >= 0 && iPrior >= 0);
    assert.ok(iConclusion < iPrior, 'Prior goals disclosure follows Conclusion disclosure');
  });
});

describe('buildDetailHtml — actions section (D11)', () => {
  it('shows Park / Conclude / Drop / Amend for live clicks (D2)', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('data-action="park"'));
    assert.ok(html.includes('data-action="conclude"'));
    assert.ok(html.includes('data-action="drop"'));
    assert.ok(html.includes('data-action="amend"'), 'live clicks must expose the amend affordance');
    assert.ok(!html.includes('data-action="resume"'));
  });

  it('shows Resume / Conclude / Drop for parked clicks and excludes Amend (D2)', () => {
    const click = { ...liveClickFixture(), status: 'parked' };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('data-action="resume"'));
    assert.ok(html.includes('data-action="conclude"'));
    assert.ok(html.includes('data-action="drop"'));
    assert.ok(!html.includes('data-action="park"'));
    assert.ok(!html.includes('data-action="amend"'), 'parked clicks must NOT expose amend — substrate rejects it');
  });

  it('renders no actions section for terminal clicks (concluded) and no Amend (D2)', () => {
    const click = {
      ...liveClickFixture(),
      status: 'concluded',
      conclusion: 'done',
      resolvedAt: '2025-03-02T00:00:00Z',
    };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<h4>Actions</h4>'));
    assert.ok(!html.includes('data-action="park"'));
    assert.ok(!html.includes('data-action="resume"'));
    assert.ok(!html.includes('data-action="conclude"'));
    assert.ok(!html.includes('data-action="drop"'));
    assert.ok(!html.includes('data-action="amend"'), 'concluded clicks must NOT expose amend');
  });

  it('renders no actions section for terminal clicks (dropped) and no Amend (D2)', () => {
    const click = {
      ...liveClickFixture(),
      status: 'dropped',
      conclusion: 'scope shift',
      resolvedAt: '2025-03-02T00:00:00Z',
    };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<h4>Actions</h4>'));
    assert.ok(!html.includes('data-action="amend"'), 'dropped clicks must NOT expose amend');
  });
});

describe('buildAmendConfirmHtml — inline confirm-section (D3, D4, D7, D8)', () => {
  it('pre-fills the input with the current goal (D4)', () => {
    const html = buildAmendConfirmHtml('Ship the feature');
    assert.ok(html.includes('value="Ship the feature"'));
  });

  it('escapes HTML-dangerous characters in the pre-filled value', () => {
    const html = buildAmendConfirmHtml('<script>"alert"</script>');
    assert.ok(!html.includes('<script>"alert"</script>'));
    assert.ok(html.includes('value="&lt;script&gt;&quot;alert&quot;&lt;/script&gt;"'));
  });

  it('renders submit disabled when pre-fill is empty (D8)', () => {
    const html = buildAmendConfirmHtml('');
    // With an empty trim the submit starts disabled — the JS input handler
    // keeps it in sync thereafter, but the rendered HTML must be truthful.
    assert.ok(/id="confirm-submit" disabled/.test(html));
  });

  it('renders submit disabled when pre-fill is whitespace-only (D8)', () => {
    const html = buildAmendConfirmHtml('   \t  ');
    assert.ok(/id="confirm-submit" disabled/.test(html));
  });

  it('renders submit enabled when pre-fill is non-empty after trim', () => {
    const html = buildAmendConfirmHtml('Ship it');
    // The submit must NOT carry a disabled attribute on the initial render
    // when the trimmed pre-fill is non-empty.
    assert.ok(!/id="confirm-submit" disabled/.test(html));
    assert.ok(html.includes('id="confirm-submit"'));
  });

  it('renders an Amend submit label, a Cancel button, and an inline error slot', () => {
    const html = buildAmendConfirmHtml('anything');
    assert.ok(html.includes('>Amend</button>'));
    assert.ok(html.includes('id="confirm-abort"'));
    assert.ok(html.includes('id="confirm-error"'));
  });

  it('renders a "New goal" label for the input', () => {
    const html = buildAmendConfirmHtml('anything');
    assert.ok(html.includes('<label>New goal</label>'));
  });

  it('tolerates a null/undefined currentGoal by treating it as empty', () => {
    const htmlNull = buildAmendConfirmHtml(null);
    const htmlUndef = buildAmendConfirmHtml(undefined);
    assert.ok(/value=""/.test(htmlNull));
    assert.ok(/value=""/.test(htmlUndef));
    assert.ok(/id="confirm-submit" disabled/.test(htmlNull));
    assert.ok(/id="confirm-submit" disabled/.test(htmlUndef));
  });
});

describe('buildDetailHtml — links section (D15, D16, D14)', () => {
  it('shows an empty-state message with the add-link form when there are no links', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<h4>Links</h4>'));
    assert.ok(html.includes('No links.'));
    // Add-link form is always present.
    assert.ok(html.includes('id="link-target-input"'));
    assert.ok(html.includes('id="link-type-select"'));
    assert.ok(html.includes('data-action="addlink"'));
  });

  it('renders the 4 link types as options in the dropdown (D14)', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    for (const t of LINK_TYPES) {
      assert.ok(html.includes(`<option value="${t}">${t}</option>`), `option ${t} missing`);
    }
    // And no extras beyond those 4.
    const optionMatches = html.match(/<option value="/g) ?? [];
    assert.strictEqual(optionMatches.length, LINK_TYPES.length);
  });

  it('routes a c-… outbound link target to an in-page link (dispatch kind=click)', () => {
    const click = {
      ...liveClickFixture(),
      links: {
        outbound: [{ sourceId: 'c-self', targetId: 'c-mo2abc00-xyz', linkType: 'related' }],
        inbound: [],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('data-click-id="c-mo2abc00-xyz"'));
    // The outbound marker must appear for this row.
    assert.ok(html.includes('→'));
  });

  it('routes a w-… outbound link target to the writs page (dispatch kind=writ)', () => {
    const click = {
      ...liveClickFixture(),
      links: {
        outbound: [{ sourceId: 'c-self', targetId: 'w-mo3def00', linkType: 'commissioned' }],
        inbound: [],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('href="/pages/writs/?writ=w-mo3def00"'));
    // Dispatch must NOT attach an in-page click handler for writ targets.
    assert.ok(!html.includes('data-click-id="w-mo3def00"'));
  });

  it('renders a plain-text target for unrecognised prefixes', () => {
    const click = {
      ...liveClickFixture(),
      links: {
        outbound: [{ sourceId: 'c-self', targetId: 'mystery-42', linkType: 'related' }],
        inbound: [],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<span class="link-id plain">mystery-42</span>'));
    assert.ok(!html.includes('data-click-id="mystery-42"'));
    assert.ok(!html.includes('/pages/writs/?writ=mystery-42'));
  });

  it('renders inbound links with a ← marker and preserves sourceId routing', () => {
    const click = {
      ...liveClickFixture(),
      links: {
        outbound: [],
        inbound: [{ sourceId: 'c-other-aaa', targetId: 'c-self', linkType: 'supersedes' }],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('←'));
    assert.ok(html.includes('data-click-id="c-other-aaa"'));
    assert.ok(html.includes('(supersedes)'));
  });

  it('renders an unlink button carrying the full triple (source/target/linkType)', () => {
    const click = {
      ...liveClickFixture(),
      links: {
        outbound: [{ sourceId: 'c-self', targetId: 'c-target', linkType: 'depends-on' }],
        inbound: [],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('data-action="unlink"'));
    assert.ok(html.includes('data-source="c-self"'));
    assert.ok(html.includes('data-target="c-target"'));
    assert.ok(html.includes('data-linktype="depends-on"'));
  });
});

describe('buildDetailHtml — children section (D22)', () => {
  it('renders "No children." when items is empty', () => {
    const click = liveClickFixture();
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<h4>Children</h4>'));
    assert.ok(html.includes('No children.'));
    assert.ok(!html.includes('children-table'));
  });

  it('renders the status-count strip with all four statuses when children exist', () => {
    const click = {
      ...liveClickFixture(),
      children: {
        items: [
          { id: 'c-k1-a', goal: 'k1', status: 'live' },
          { id: 'c-k2-b', goal: 'k2', status: 'live' },
          { id: 'c-k3-c', goal: 'k3', status: 'parked' },
          { id: 'c-k4-d', goal: 'k4', status: 'concluded' },
        ],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('status-count-strip'));
    // Zero-counts are still rendered so the strip stays consistent (D22).
    assert.ok(/badge--active[^<]*live<\/span>\s*<span>2<\/span>/.test(html));
    assert.ok(/badge--warning[^<]*parked<\/span>\s*<span>1<\/span>/.test(html));
    assert.ok(/badge--success[^<]*concluded<\/span>\s*<span>1<\/span>/.test(html));
    assert.ok(/badge--error[^<]*dropped<\/span>\s*<span>0<\/span>/.test(html));
  });

  it('renders a row per child with a clickable data-child-id hook', () => {
    const click = {
      ...liveClickFixture(),
      children: {
        items: [
          { id: 'c-k1-aaa', goal: 'First kid', status: 'live' },
          { id: 'c-k2-bbb', goal: 'Second kid', status: 'concluded' },
        ],
      },
    };
    const html = buildDetailHtml(click);
    const rows = html.match(/data-child-id="c-k\d-[a-z]+"/g) ?? [];
    assert.strictEqual(rows.length, 2);
    assert.ok(html.includes('data-child-id="c-k1-aaa"'));
    assert.ok(html.includes('data-child-id="c-k2-bbb"'));
    // The ID column renders the short (2-segment) form, not the full id.
    assert.ok(html.includes('<code>c-k1</code>'));
    assert.ok(html.includes('<code>c-k2</code>'));
  });

  it('renders the column headers Status, Goal, ID (no Actions per D11)', () => {
    const click = {
      ...liveClickFixture(),
      children: {
        items: [{ id: 'c-only-a', goal: 'Only child', status: 'live' }],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(html.includes('<th>Status</th><th>Goal</th><th>ID</th>'));
    // D11: NO per-row lifecycle buttons in the children table.
    assert.ok(!html.includes('<th>Actions</th>'));
  });

  it('escapes child goals', () => {
    const click = {
      ...liveClickFixture(),
      children: {
        items: [{ id: 'c-evil-x', goal: '<img src=x onerror=alert(1)>', status: 'live' }],
      },
    };
    const html = buildDetailHtml(click);
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});
