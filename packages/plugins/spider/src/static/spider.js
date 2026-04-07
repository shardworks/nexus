/**
 * Spider dashboard — vanilla JS IIFE.
 * No framework, no modules, no imports.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  var rigs = [];
  var currentRig = null;
  var selectedEngineId = null;
  var sortField = 'createdAt';
  var sortDir = 'desc';
  var configData = null;
  var currentStatusFilter = '';

  // ── Badge mapping ──────────────────────────────────────────────────────

  function badgeClass(status) {
    switch (status) {
      case 'completed': return 'badge--success';
      case 'running':   return 'badge--active';
      case 'failed':    return 'badge--error';
      case 'blocked':   return 'badge--warning';
      case 'pending':
      case 'cancelled':
      default:          return '';
    }
  }

  function badgeHtml(status) {
    var cls = badgeClass(status);
    var fullCls = cls ? 'badge ' + cls : 'badge';
    return '<span class="' + fullCls + '">' + esc(status) + '</span>';
  }

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

  function engineSummary(engines) {
    if (!engines || engines.length === 0) return '0/0';
    var completed = engines.filter(function (e) { return e.status === 'completed'; }).length;
    return completed + '/' + engines.length + ' completed';
  }

  // ── Fetch rigs ─────────────────────────────────────────────────────────

  function fetchRigs(statusFilter) {
    currentStatusFilter = statusFilter || '';
    var url = '/api/rig/list?limit=100';
    if (statusFilter) {
      url += '&status=' + encodeURIComponent(statusFilter);
    }
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        rigs = Array.isArray(data) ? data : [];
        renderRigList();
      })
      .catch(function (err) {
        console.error('Failed to fetch rigs:', err);
        rigs = [];
        renderRigList();
      });
  }

  // ── Render rig list ────────────────────────────────────────────────────

  function renderRigList() {
    var writFilter = (document.getElementById('writ-filter') || {}).value || '';
    var dateFrom = (document.getElementById('date-from') || {}).value || '';
    var dateTo = (document.getElementById('date-to') || {}).value || '';

    var filtered = rigs.filter(function (rig) {
      // WritId filter (case-insensitive)
      if (writFilter && !(rig.writId || '').toLowerCase().includes(writFilter.toLowerCase())) {
        return false;
      }
      // Date range filter
      if (dateFrom && rig.createdAt < dateFrom) {
        return false;
      }
      if (dateTo && rig.createdAt > dateTo + 'T23:59:59') {
        return false;
      }
      return true;
    });

    // Sort
    filtered.sort(function (a, b) {
      var av = a[sortField] || '';
      var bv = b[sortField] || '';
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    var tbody = document.getElementById('rig-tbody');
    var empty = document.getElementById('rig-empty');
    var table = document.getElementById('rig-table');

    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      if (table) table.style.display = 'none';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';

    var rows = filtered.map(function (rig) {
      return '<tr>' +
        '<td><a class="rig-link" href="#" data-rig-id="' + esc(rig.id) + '">' + esc(rig.id) + '</a></td>' +
        '<td><a href="/pages/clerk/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td>' +
        '<td>' + badgeHtml(rig.status) + '</td>' +
        '<td>' + esc(engineSummary(rig.engines)) + '</td>' +
        '<td>' + esc(formatDate(rig.createdAt)) + '</td>' +
        '</tr>';
    });

    tbody.innerHTML = rows.join('');

    // Wire rig-link clicks
    var links = tbody.querySelectorAll('.rig-link');
    for (var i = 0; i < links.length; i++) {
      (function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var rigId = link.getAttribute('data-rig-id');
          var rig = rigs.find(function (r) { return r.id === rigId; });
          if (rig) showRigDetail(rig);
        });
      })(links[i]);
    }
  }

  // ── Show rig detail ────────────────────────────────────────────────────

  function showRigDetail(rig) {
    currentRig = rig;
    selectedEngineId = null;

    document.getElementById('rig-list-view').style.display = 'none';
    document.getElementById('rig-detail-view').style.display = '';

    document.getElementById('detail-title').textContent = 'Rig: ' + rig.id;

    var metaTable = document.getElementById('detail-meta');
    metaTable.innerHTML =
      '<tbody>' +
      '<tr><th>ID</th><td>' + esc(rig.id) + '</td></tr>' +
      '<tr><th>Writ</th><td><a href="/pages/clerk/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td></tr>' +
      '<tr><th>Status</th><td>' + badgeHtml(rig.status) + '</td></tr>' +
      '<tr><th>Created</th><td>' + esc(formatDate(rig.createdAt)) + '</td></tr>' +
      '</tbody>';

    renderPipeline(rig);

    var engineDetail = document.getElementById('engine-detail');
    if (engineDetail) engineDetail.style.display = 'none';
  }

  // ── Render pipeline ────────────────────────────────────────────────────

  function topoSort(engines) {
    var order = [];
    var visited = {};
    function visit(e) {
      if (visited[e.id]) return;
      visited[e.id] = true;
      (e.upstream || []).forEach(function (uid) {
        var up = engines.find(function (x) { return x.id === uid; });
        if (up) visit(up);
      });
      order.push(e);
    }
    engines.forEach(visit);
    return order;
  }

  function renderPipeline(rig) {
    var pipeline = document.getElementById('pipeline');
    if (!pipeline) return;
    pipeline.innerHTML = '';

    var engines = rig.engines || [];
    if (engines.length === 0) {
      pipeline.textContent = 'No engines.';
      return;
    }

    var sorted = topoSort(engines);

    sorted.forEach(function (engine, idx) {
      // Add arrow before node (except first)
      if (idx > 0) {
        var arrow = document.createElement('div');
        arrow.className = 'pipeline-arrow';
        arrow.textContent = '\u2192';
        pipeline.appendChild(arrow);
      }

      var node = document.createElement('div');
      node.className = 'pipeline-node' + (engine.id === selectedEngineId ? ' selected' : '');
      node.setAttribute('data-engine-id', engine.id);

      var idSpan = document.createElement('span');
      idSpan.className = 'node-id';
      idSpan.textContent = engine.id;
      node.appendChild(idSpan);

      var badgeEl = document.createElement('span');
      var bc = badgeClass(engine.status);
      badgeEl.className = bc ? 'badge ' + bc : 'badge';
      badgeEl.textContent = engine.status;
      node.appendChild(badgeEl);

      // Show upstream list if this engine has upstreams beyond the previous node
      if (engine.upstream && engine.upstream.length > 1) {
        var upEl = document.createElement('span');
        upEl.style.fontSize = '10px';
        upEl.style.color = 'var(--text-dim, #888)';
        upEl.textContent = '\u2191 ' + engine.upstream.join(', ');
        node.appendChild(upEl);
      }

      node.addEventListener('click', function () {
        showEngineDetail(engine);
      });

      pipeline.appendChild(node);
    });
  }

  // ── Show engine detail ─────────────────────────────────────────────────

  function showEngineDetail(engine) {
    selectedEngineId = engine.id;

    // Update pipeline node selection
    var nodes = document.querySelectorAll('.pipeline-node');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-engine-id') === engine.id) {
        n.classList.add('selected');
      } else {
        n.classList.remove('selected');
      }
    }

    var panel = document.getElementById('engine-detail');
    var title = document.getElementById('engine-detail-title');
    var body = document.getElementById('engine-detail-body');

    if (!panel || !title || !body) return;

    title.textContent = 'Engine: ' + engine.id;
    panel.style.display = '';

    var html = '<dl class="engine-detail-field">';

    html += '<dt>Status</dt><dd>' + badgeHtml(engine.status) + '</dd>';
    html += '<dt>Design ID</dt><dd>' + esc(engine.designId) + '</dd>';
    html += '<dt>Upstream</dt><dd>' + esc((engine.upstream || []).join(', ') || '(none)') + '</dd>';
    html += '<dt>Started At</dt><dd>' + esc(formatDate(engine.startedAt) || '—') + '</dd>';
    html += '<dt>Completed At</dt><dd>' + esc(formatDate(engine.completedAt) || '—') + '</dd>';

    if (engine.error) {
      html += '<dt>Error</dt><dd style="color:var(--red,#f55)">' + esc(engine.error) + '</dd>';
    }
    if (engine.sessionId) {
      html += '<dt>Session ID</dt><dd>' + esc(engine.sessionId) + '</dd>';
    }

    if (engine.block) {
      html += '<dt>Block Type</dt><dd>' + esc(engine.block.type) + '</dd>';
      html += '<dt>Blocked At</dt><dd>' + esc(formatDate(engine.block.blockedAt)) + '</dd>';
      if (engine.block.message) {
        html += '<dt>Block Message</dt><dd>' + esc(engine.block.message) + '</dd>';
      }
      if (engine.block.lastCheckedAt) {
        html += '<dt>Last Checked</dt><dd>' + esc(formatDate(engine.block.lastCheckedAt)) + '</dd>';
      }
      html += '<dt>Block Condition</dt><dd><pre style="margin:0;font-size:11px">' + esc(JSON.stringify(engine.block.condition, null, 2)) + '</pre></dd>';
    }

    html += '</dl>';

    // Collapsible givensSpec
    html += '<details class="collapsible"><summary>Givens Spec</summary>' +
      '<pre><code>' + esc(JSON.stringify(engine.givensSpec, null, 2)) + '</code></pre></details>';

    // Collapsible yields
    if (engine.yields !== undefined) {
      html += '<details class="collapsible"><summary>Yields</summary>' +
        '<pre><code>' + esc(JSON.stringify(engine.yields, null, 2)) + '</code></pre></details>';
    }

    body.innerHTML = html;
  }

  // ── Back to list ───────────────────────────────────────────────────────

  function backToList() {
    currentRig = null;
    selectedEngineId = null;
    document.getElementById('rig-detail-view').style.display = 'none';
    document.getElementById('rig-list-view').style.display = '';
  }

  // ── Config tab ─────────────────────────────────────────────────────────

  function fetchConfig() {
    fetch('/api/spider/config')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        configData = data;
        renderConfig();
      })
      .catch(function (err) {
        console.error('Failed to fetch config:', err);
      });
  }

  function renderConfig() {
    if (!configData) return;

    // Rig templates
    var templatesSection = document.getElementById('templates-section');
    if (templatesSection) {
      var rigTemplates = configData.rigTemplates || {};
      var keys = Object.keys(rigTemplates);
      if (keys.length === 0) {
        templatesSection.innerHTML = '<p class="empty-state">No rig templates configured.</p>';
      } else {
        templatesSection.innerHTML = keys.map(function (key) {
          return '<div class="template-block">' +
            '<h3>' + esc(key) + '</h3>' +
            '<pre><code>' + esc(JSON.stringify(rigTemplates[key], null, 2)) + '</code></pre>' +
            '</div>';
        }).join('');
      }
    }

    // Engine designs table
    var designsTbody = document.getElementById('designs-tbody');
    if (designsTbody) {
      var designs = configData.engineDesigns || [];
      if (designs.length === 0) {
        designsTbody.innerHTML = '<tr><td colspan="3" class="empty-state">No engine designs registered.</td></tr>';
      } else {
        designsTbody.innerHTML = designs.map(function (d) {
          return '<tr>' +
            '<td>' + esc(d.id) + '</td>' +
            '<td>' + esc(d.pluginId) + '</td>' +
            '<td>' + (d.hasCollect ? 'Yes' : 'No') + '</td>' +
            '</tr>';
        }).join('');
      }
    }

    // Block types table
    var blocktypesTbody = document.getElementById('blocktypes-tbody');
    if (blocktypesTbody) {
      var blockTypes = configData.blockTypes || [];
      if (blockTypes.length === 0) {
        blocktypesTbody.innerHTML = '<tr><td colspan="3" class="empty-state">No block types registered.</td></tr>';
      } else {
        blocktypesTbody.innerHTML = blockTypes.map(function (bt) {
          return '<tr>' +
            '<td>' + esc(bt.id) + '</td>' +
            '<td>' + esc(bt.pluginId) + '</td>' +
            '<td>' + (bt.pollIntervalMs != null ? esc(String(bt.pollIntervalMs)) : '—') + '</td>' +
            '</tr>';
        }).join('');
      }
    }
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Tab switching
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          var tabName = tab.getAttribute('data-tab');

          // Update active tab button
          for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.toggle('active', tabs[j] === tab);
          }

          // Show/hide tab contents
          var rigsTab = document.getElementById('rigs-tab');
          var configTab = document.getElementById('config-tab');
          if (rigsTab) rigsTab.style.display = tabName === 'rigs' ? '' : 'none';
          if (configTab) configTab.style.display = tabName === 'config' ? '' : 'none';

          // Lazy-load config
          if (tabName === 'config' && configData === null) {
            fetchConfig();
          }
        });
      })(tabs[i]);
    }

    // Status filter
    var statusFilter = document.getElementById('status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        fetchRigs(statusFilter.value);
      });
    }

    // WritId filter (client-side re-filter)
    var writFilter = document.getElementById('writ-filter');
    if (writFilter) {
      writFilter.addEventListener('input', function () {
        renderRigList();
      });
    }

    // Date range (client-side re-filter)
    var dateFrom = document.getElementById('date-from');
    var dateTo = document.getElementById('date-to');
    if (dateFrom) {
      dateFrom.addEventListener('change', function () { renderRigList(); });
    }
    if (dateTo) {
      dateTo.addEventListener('change', function () { renderRigList(); });
    }

    // Refresh button
    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        fetchRigs(currentStatusFilter);
      });
    }

    // Column sort headers
    var headers = document.querySelectorAll('#rig-table th[data-sort]');
    for (var k = 0; k < headers.length; k++) {
      (function (th) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', function () {
          var field = th.getAttribute('data-sort');
          if (sortField === field) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            sortField = field;
            sortDir = 'asc';
          }
          renderRigList();
        });
      })(headers[k]);
    }

    // Back button
    var backBtn = document.getElementById('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', backToList);
    }

    // Initial load
    fetchRigs('');
  });
})();
