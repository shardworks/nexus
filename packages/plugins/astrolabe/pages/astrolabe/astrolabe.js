/**
 * Astrolabe dashboard — vanilla JS IIFE.
 * No framework, no modules, no imports.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  var plans = [];
  var currentPlan = null;
  var activeTab = 'inventory';
  var currentStatusFilter = '';
  var offset = 0;
  var LIMIT = 20;
  var writTitleLookup = {};

  // ── Utility ────────────────────────────────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  // ── Status Badge ───────────────────────────────────────────────────────

  function statusBadge(status) {
    var map = {
      reading: 'badge badge--active',
      analyzing: 'badge badge--active',
      writing: 'badge badge--active',
      reviewing: 'badge badge--warning',
      completed: 'badge badge--success',
      failed: 'badge badge--error'
    };
    var cls = map[status] || 'badge';
    return '<span class="' + cls + '">' + esc(status) + '</span>';
  }

  // ── Markdown Rendering ─────────────────────────────────────────────────

  function renderMarkdown(md) {
    if (md == null || md === '') return '';

    // HTML-escape input first to prevent XSS
    var text = esc(md);

    // Fenced code blocks (``` ... ```)
    // After escaping, backticks are preserved
    var codeBlocks = [];
    text = text.replace(/```[\s\S]*?```/g, function (match) {
      // Remove opening ``` (with optional language tag) and closing ```
      var inner = match.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      var idx = codeBlocks.length;
      codeBlocks.push('<pre><code>' + inner + '</code></pre>');
      return '\x00CODEBLOCK' + idx + '\x00';
    });

    var lines = text.split('\n');
    var result = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // Check for code block placeholder
      var cbMatch = line.match(/^\x00CODEBLOCK(\d+)\x00$/);
      if (cbMatch) {
        result.push(codeBlocks[parseInt(cbMatch[1], 10)]);
        i++;
        continue;
      }

      // Headings
      var headingMatch = line.match(/^(#{1,6}) (.+)$/);
      if (headingMatch) {
        var level = headingMatch[1].length;
        var content = applyInline(headingMatch[2]);
        result.push('<h' + level + '>' + content + '</h' + level + '>');
        i++;
        continue;
      }

      // Unordered lists
      if (/^[\-\*] /.test(line)) {
        var items = [];
        while (i < lines.length && /^[\-\*] /.test(lines[i])) {
          items.push('<li>' + applyInline(lines[i].replace(/^[\-\*] /, '')) + '</li>');
          i++;
        }
        result.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      // Ordered lists
      if (/^\d+\. /.test(line)) {
        var olItems = [];
        while (i < lines.length && /^\d+\. /.test(lines[i])) {
          olItems.push('<li>' + applyInline(lines[i].replace(/^\d+\. /, '')) + '</li>');
          i++;
        }
        result.push('<ol>' + olItems.join('') + '</ol>');
        continue;
      }

      // Empty lines
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraphs: collect consecutive non-empty, non-special lines
      var para = [];
      while (i < lines.length && lines[i].trim() !== '' &&
             !/^#{1,6} /.test(lines[i]) &&
             !/^[\-\*] /.test(lines[i]) &&
             !/^\d+\. /.test(lines[i]) &&
             !/^\x00CODEBLOCK/.test(lines[i])) {
        para.push(applyInline(lines[i]));
        i++;
      }
      if (para.length > 0) {
        result.push('<p>' + para.join(' ') + '</p>');
      }
    }

    return '<div class="md-content">' + result.join('') + '</div>';
  }

  function applyInline(text) {
    // Bold: **text**
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text* or _text_
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    return text;
  }

  // ── DOM References ─────────────────────────────────────────────────────

  var listView = document.getElementById('plan-list-view');
  var detailView = document.getElementById('plan-detail-view');
  var tbody = document.getElementById('plan-tbody');
  var emptyState = document.getElementById('empty-state');
  var loadMoreBtn = document.getElementById('load-more-btn');
  var backBtn = document.getElementById('back-btn');
  var detailTitle = document.getElementById('detail-title');
  var metaCard = document.getElementById('meta-card');
  var tabContent = document.getElementById('tab-content');

  // ── Filter Buttons ─────────────────────────────────────────────────────

  var filterBtns = document.querySelectorAll('#status-filters .filter-btn');
  for (var fi = 0; fi < filterBtns.length; fi++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        currentStatusFilter = btn.getAttribute('data-status');
        for (var j = 0; j < filterBtns.length; j++) {
          filterBtns[j].classList.remove('active-filter');
        }
        btn.classList.add('active-filter');
        fetchPlans(true);
      });
    })(filterBtns[fi]);
  }

  // ── Load More Button ───────────────────────────────────────────────────

  loadMoreBtn.addEventListener('click', function () {
    fetchPlans(false);
  });

  // ── Back Button ────────────────────────────────────────────────────────

  backBtn.addEventListener('click', function () {
    backToList();
  });

  // ── Tab Clicks ─────────────────────────────────────────────────────────

  var tabBtns = document.querySelectorAll('#plan-tabs .tab');
  for (var ti = 0; ti < tabBtns.length; ti++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('data-disabled') === 'true') return;
        var tabName = btn.getAttribute('data-tab');
        activeTab = tabName;
        for (var j = 0; j < tabBtns.length; j++) {
          tabBtns[j].classList.remove('active');
        }
        btn.classList.add('active');
        renderTab(tabName);
      });
    })(tabBtns[ti]);
  }

  // ── Data Fetching ──────────────────────────────────────────────────────

  function fetchPlans(replace) {
    if (replace) {
      offset = 0;
      plans = [];
    }

    var url = '/api/plan/list?limit=' + LIMIT + '&offset=' + offset;
    if (currentStatusFilter) {
      url += '&status=' + encodeURIComponent(currentStatusFilter);
    }

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (replace) {
          plans = data;
        } else {
          plans = plans.concat(data);
        }
        offset += data.length;
        loadMoreBtn.style.display = data.length >= LIMIT ? '' : 'none';
        renderPlanList();
      })
      .catch(function (err) {
        console.error('Failed to fetch plans:', err);
      });
  }

  // ── List Rendering ─────────────────────────────────────────────────────

  function renderPlanList() {
    if (plans.length === 0) {
      tbody.innerHTML = '';
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';

    var html = '';
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i];
      var titleCell = writTitleLookup[p.id] !== undefined
        ? esc(writTitleLookup[p.id])
        : '<span class="text-dim">loading...</span>';

      html += '<tr data-idx="' + i + '">' +
        '<td>' + statusBadge(p.status) + '</td>' +
        '<td>' + esc(p.codex) + '</td>' +
        '<td class="writ-title-cell" data-plan-id="' + esc(p.id) + '">' + titleCell + '</td>' +
        '<td><code>' + esc(p.id) + '</code></td>' +
        '<td>' + formatDate(p.createdAt) + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;

    // Wire row click handlers
    var rows = tbody.querySelectorAll('tr');
    for (var ri = 0; ri < rows.length; ri++) {
      (function (row) {
        row.addEventListener('click', function () {
          var idx = parseInt(row.getAttribute('data-idx'), 10);
          showPlanDetail(plans[idx]);
        });
      })(rows[ri]);
    }

    // Fetch writ titles for plans that don't have one cached
    for (var wi = 0; wi < plans.length; wi++) {
      (function (plan) {
        if (writTitleLookup[plan.id] !== undefined) return;
        fetch('/api/writ/show?id=' + encodeURIComponent(plan.id))
          .then(function (r) { return r.json(); })
          .then(function (writ) {
            writTitleLookup[plan.id] = (writ && writ.title) ? writ.title : '\u2014';
            var cell = document.querySelector('.writ-title-cell[data-plan-id="' + plan.id + '"]');
            if (cell) cell.textContent = writTitleLookup[plan.id];
          })
          .catch(function () {
            writTitleLookup[plan.id] = '\u2014';
            var cell = document.querySelector('.writ-title-cell[data-plan-id="' + plan.id + '"]');
            if (cell) cell.textContent = '\u2014';
          });
      })(plans[wi]);
    }
  }

  // ── Detail View ────────────────────────────────────────────────────────

  function showPlanDetail(plan) {
    currentPlan = plan;
    listView.style.display = 'none';
    detailView.style.display = '';

    detailTitle.textContent = 'Plan: ' + plan.id;

    // Metadata card
    var briefLink = '<a href="/pages/clerk/?writ=' + encodeURIComponent(plan.id) + '">' + esc(plan.id) + '</a>';
    var mandateHtml = '';
    if (plan.generatedWritId) {
      mandateHtml = '<dt>Mandate Writ</dt><dd><a href="/pages/clerk/?writ=' +
        encodeURIComponent(plan.generatedWritId) + '">' + esc(plan.generatedWritId) + '</a></dd>';
    }

    metaCard.innerHTML =
      '<dl class="meta-grid">' +
        '<dt>Plan ID</dt><dd><code>' + esc(plan.id) + '</code></dd>' +
        '<dt>Status</dt><dd>' + statusBadge(plan.status) + '</dd>' +
        '<dt>Codex</dt><dd>' + esc(plan.codex) + '</dd>' +
        '<dt>Brief Writ</dt><dd>' + briefLink + '</dd>' +
        mandateHtml +
        '<dt>Created</dt><dd>' + formatDate(plan.createdAt) + '</dd>' +
        '<dt>Updated</dt><dd>' + formatDate(plan.updatedAt) + '</dd>' +
      '</dl>' +
      '<div id="cost-summary" style="margin-top:12px;"><span class="text-dim">Loading cost data...</span></div>';

    // Fetch cost data
    fetchCostData(plan.id);

    // Configure tabs — disable empty ones
    var tabFields = {
      inventory: plan.inventory,
      scope: plan.scope,
      decisions: plan.decisions,
      observations: plan.observations,
      spec: plan.spec
    };

    var firstAvailable = null;
    for (var ti = 0; ti < tabBtns.length; ti++) {
      var btn = tabBtns[ti];
      var tabName = btn.getAttribute('data-tab');
      var val = tabFields[tabName];
      var isEmpty = val == null || val === '' || (Array.isArray(val) && val.length === 0);

      if (isEmpty) {
        btn.style.opacity = '0.3';
        btn.style.cursor = 'default';
        btn.setAttribute('data-disabled', 'true');
        btn.classList.remove('active');
      } else {
        btn.style.opacity = '';
        btn.style.cursor = '';
        btn.setAttribute('data-disabled', 'false');
        if (!firstAvailable) firstAvailable = tabName;
      }
    }

    // Activate first available tab
    if (firstAvailable) {
      activeTab = firstAvailable;
      for (var ai = 0; ai < tabBtns.length; ai++) {
        tabBtns[ai].classList.remove('active');
        if (tabBtns[ai].getAttribute('data-tab') === firstAvailable) {
          tabBtns[ai].classList.add('active');
        }
      }
      renderTab(firstAvailable);
    } else {
      tabContent.innerHTML = '<p class="empty-state">No content available.</p>';
    }
  }

  // ── Cost Data ──────────────────────────────────────────────────────────

  function fetchCostData(planId) {
    var costEl = document.getElementById('cost-summary');

    fetch('/api/rig/list?limit=100')
      .then(function (r) { return r.json(); })
      .then(function (rigs) {
        var rig = rigs.find(function (r) { return r.writId === planId; });
        if (!rig) {
          renderCostUnavailable(costEl);
          return;
        }

        var sessionEngines = (rig.engines || []).filter(function (e) {
          return e.designId === 'anima-session' && e.sessionId;
        });

        if (sessionEngines.length === 0) {
          renderCostUnavailable(costEl);
          return;
        }

        var fetches = sessionEngines.map(function (e) {
          return fetch('/api/session/show?id=' + encodeURIComponent(e.sessionId))
            .then(function (r) { return r.json(); })
            .then(function (session) {
              return { engineId: e.id, session: session };
            })
            .catch(function () { return null; });
        });

        return Promise.all(fetches);
      })
      .then(function (results) {
        if (!results) return;
        var valid = results.filter(Boolean);
        if (valid.length === 0) {
          renderCostUnavailable(costEl);
          return;
        }
        renderCostTable(costEl, valid);
      })
      .catch(function () {
        renderCostUnavailable(costEl);
      });
  }

  function renderCostUnavailable(el) {
    if (el) el.innerHTML = '<span class="text-dim">Cost data not available</span>';
  }

  function renderCostTable(el, results) {
    var totalInput = 0;
    var totalOutput = 0;
    var totalCost = 0;

    var rows = '';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var s = r.session;
      var inputTokens = (s.tokenUsage && s.tokenUsage.inputTokens) || 0;
      var outputTokens = (s.tokenUsage && s.tokenUsage.outputTokens) || 0;
      var cost = s.costUsd || 0;

      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCost += cost;

      rows += '<tr>' +
        '<td>' + esc(r.engineId) + '</td>' +
        '<td>' + inputTokens.toLocaleString() + '</td>' +
        '<td>' + outputTokens.toLocaleString() + '</td>' +
        '<td>$' + cost.toFixed(4) + '</td>' +
        '</tr>';
    }

    rows += '<tr class="cost-total">' +
      '<td><strong>Total</strong></td>' +
      '<td><strong>' + totalInput.toLocaleString() + '</strong></td>' +
      '<td><strong>' + totalOutput.toLocaleString() + '</strong></td>' +
      '<td><strong>$' + totalCost.toFixed(4) + '</strong></td>' +
      '</tr>';

    el.innerHTML =
      '<table class="data-table cost-table">' +
        '<thead><tr>' +
          '<th>Step</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost (USD)</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  // ── Tab Rendering ──────────────────────────────────────────────────────

  function renderTab(tabName) {
    if (!currentPlan) return;

    switch (tabName) {
      case 'inventory':
        tabContent.innerHTML = renderMarkdown(currentPlan.inventory);
        break;
      case 'observations':
        tabContent.innerHTML = renderMarkdown(currentPlan.observations);
        break;
      case 'spec':
        tabContent.innerHTML = renderMarkdown(currentPlan.spec);
        break;
      case 'scope':
        tabContent.innerHTML = renderScopeTable(currentPlan.scope);
        break;
      case 'decisions':
        tabContent.innerHTML = renderDecisionsTable(currentPlan.decisions);
        wireDecisionRows();
        break;
      default:
        tabContent.innerHTML = '';
    }
  }

  // ── Scope Table ────────────────────────────────────────────────────────

  function renderScopeTable(scope) {
    if (!scope || scope.length === 0) return '<p class="empty-state">No scope items.</p>';
    var html = '<table class="data-table"><thead><tr>' +
      '<th>ID</th><th>Description</th><th>Status</th><th>Rationale</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < scope.length; i++) {
      var s = scope[i];
      var badge = s.included
        ? '<span class="badge badge--success">included</span>'
        : '<span class="badge badge--error">excluded</span>';
      html += '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.description) +
        '</td><td>' + badge + '</td><td>' + esc(s.rationale) + '</td></tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // ── Decisions Table ────────────────────────────────────────────────────

  function renderDecisionsTable(decisions) {
    if (!decisions || decisions.length === 0) return '<p class="empty-state">No decisions.</p>';
    var html = '<table class="data-table" id="decisions-table"><thead><tr>' +
      '<th>ID</th><th>Question</th><th>Selected</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < decisions.length; i++) {
      var d = decisions[i];
      html += '<tr class="decision-row" data-idx="' + i + '">' +
        '<td>' + esc(d.id) + '</td>' +
        '<td>' + esc(d.question) + '</td>' +
        '<td>' + esc(d.selected || '\u2014') + '</td></tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function wireDecisionRows() {
    var rows = document.querySelectorAll('.decision-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        row.addEventListener('click', function () {
          var idx = parseInt(row.getAttribute('data-idx'), 10);
          var existing = row.nextElementSibling;

          // Toggle: remove if already expanded
          if (existing && existing.classList.contains('decision-detail')) {
            existing.remove();
            return;
          }

          var d = currentPlan.decisions[idx];
          var detailHtml = '<td colspan="3">';

          if (d.context) {
            detailHtml += '<p><strong>Context:</strong> ' + esc(d.context) + '</p>';
          }

          // Options
          if (d.options && Object.keys(d.options).length > 0) {
            detailHtml += '<p><strong>Options:</strong></p><dl>';
            var keys = Object.keys(d.options);
            for (var k = 0; k < keys.length; k++) {
              detailHtml += '<dt>' + esc(keys[k]) + '</dt><dd>' + esc(d.options[keys[k]]) + '</dd>';
            }
            detailHtml += '</dl>';
          }

          if (d.recommendation) {
            detailHtml += '<p><strong>Recommendation:</strong> ' + esc(d.recommendation);
            if (d.rationale) detailHtml += ' &mdash; ' + esc(d.rationale);
            detailHtml += '</p>';
          }

          if (d.patronOverride) {
            detailHtml += '<p style="color:var(--yellow)"><strong>Patron Override:</strong> ' +
              esc(d.patronOverride) + '</p>';
          }

          detailHtml += '</td>';

          var detailTr = document.createElement('tr');
          detailTr.className = 'decision-detail';
          detailTr.innerHTML = detailHtml;
          row.insertAdjacentElement('afterend', detailTr);
        });
      })(rows[i]);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  function backToList() {
    detailView.style.display = 'none';
    listView.style.display = '';
    currentPlan = null;
  }

  // ── Deep Link ──────────────────────────────────────────────────────────

  function handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var planId = params.get('plan');

    if (planId) {
      // Deep link: fetch and show the specific plan
      fetch('/api/plan/show?planId=' + encodeURIComponent(planId))
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (plan) {
          showPlanDetail(plan);
        })
        .catch(function (err) {
          console.error('Deep-link plan not found:', planId, err);
          // Fallback: show list view
          fetchPlans(true);
        });
    } else {
      fetchPlans(true);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────

  handleDeepLink();
})();
