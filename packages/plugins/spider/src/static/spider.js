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
  var writLookup = {};
  var sessionPollTimer = null;
  var selectedTemplateName = null;

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

  function formatElapsed(startedAt, completedAt) {
    var diffMs = new Date(completedAt) - new Date(startedAt);
    if (diffMs < 1000) return '<1s';
    var totalSeconds = Math.floor(diffMs / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var parts = [];
    if (hours > 0) parts.push(hours + 'h');
    if (hours > 0 || minutes > 0) parts.push(minutes + 'm');
    parts.push(seconds + 's');
    return parts.join(' ');
  }

  function renderTranscript(messages) {
    var lines = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.type === 'assistant') {
        var content = (msg.message && msg.message.content) ? msg.message.content : [];
        for (var j = 0; j < content.length; j++) {
          var block = content[j];
          if (block.type === 'text') {
            lines.push(block.text);
          } else if (block.type === 'tool_use') {
            lines.push('[tool: ' + block.name + ']');
          }
        }
      } else if (msg.type === 'user') {
        var userContent = msg.content ? msg.content : [];
        for (var k = 0; k < userContent.length; k++) {
          var ublock = userContent[k];
          if (ublock.type === 'tool_result') {
            lines.push('[result: ' + ublock.tool_use_id + ']');
          }
        }
      }
      // 'result' messages are ignored
    }
    return lines.join('\n');
  }

  function buildWritLookup(writs) {
    writLookup = {};
    for (var i = 0; i < writs.length; i++) {
      writLookup[writs[i].id] = writs[i];
    }
  }

  function stopSessionPoll() {
    if (sessionPollTimer !== null) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }
  }

  // ── Fetch rigs ─────────────────────────────────────────────────────────

  function fetchRigs(statusFilter) {
    currentStatusFilter = statusFilter || '';
    var rigUrl = '/api/rig/list?limit=100';
    if (statusFilter) {
      rigUrl += '&status=' + encodeURIComponent(statusFilter);
    }

    var rigPromise = fetch(rigUrl).then(function (r) { return r.json(); });
    var writPromise = fetch('/api/writ/list?limit=100').then(function (r) { return r.json(); });

    Promise.all([rigPromise, writPromise]).then(function (results) {
      rigs = Array.isArray(results[0]) ? results[0] : [];
      buildWritLookup(Array.isArray(results[1]) ? results[1] : []);
      renderRigList();
    }).catch(function (err) {
      console.error('Failed to fetch rigs/writs:', err);
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
      // WritId/writ title filter (case-insensitive)
      if (writFilter) {
        var writTitle = (writLookup[rig.writId] && writLookup[rig.writId].title) || '';
        var matchesId = (rig.writId || '').toLowerCase().includes(writFilter.toLowerCase());
        var matchesTitle = writTitle.toLowerCase().includes(writFilter.toLowerCase());
        if (!matchesId && !matchesTitle) return false;
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
      var writTitle = (writLookup[rig.writId] && writLookup[rig.writId].title) || '\u2014';
      return '<tr>' +
        '<td>' + badgeHtml(rig.status) + '</td>' +
        '<td>' + esc(writTitle) + '</td>' +
        '<td>' + esc(engineSummary(rig.engines)) + '</td>' +
        '<td><a class="rig-link" href="#" data-rig-id="' + esc(rig.id) + '">' + esc(rig.id) + '</a></td>' +
        '<td><a href="/pages/clerk/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td>' +
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

    stopSessionPoll();

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

    // Fetch and display writ details
    var writDetailsCard = document.getElementById('writ-details-card');
    if (writDetailsCard) writDetailsCard.style.display = 'none';

    fetch('/api/writ/show?id=' + encodeURIComponent(rig.writId))
      .then(function (r) { return r.json(); })
      .then(function (writ) {
        var card = document.getElementById('writ-details-card');
        if (!card) return;
        var titleEl = document.getElementById('writ-detail-title');
        var bodyEl = document.getElementById('writ-detail-body');
        if (titleEl) titleEl.textContent = writ.title || '';
        if (bodyEl) bodyEl.value = writ.body || '';
        card.style.display = '';
      })
      .catch(function () {
        var card = document.getElementById('writ-details-card');
        if (card) card.style.display = 'none';
      });

    // Hide session log section
    var sessionLogSection = document.getElementById('session-log-section');
    if (sessionLogSection) sessionLogSection.style.display = 'none';

    renderPipeline(rig);

    var engineDetail = document.getElementById('engine-detail');
    if (engineDetail) engineDetail.style.display = 'none';
  }

  // ── Render pipeline (generic) ──────────────────────────────────────────

  function renderPipelineInto(containerId, engines, detailConfig) {
    var pipeline = document.getElementById(containerId);
    if (!pipeline) return;
    pipeline.innerHTML = '';

    if (engines.length === 0) {
      pipeline.textContent = 'No engines.';
      return;
    }

    var sorted = topoSort(engines);

    sorted.forEach(function (engine, idx) {
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

      if (engine.upstream && engine.upstream.length > 1) {
        var upEl = document.createElement('span');
        upEl.style.fontSize = '10px';
        upEl.style.color = 'var(--text-dim, #888)';
        upEl.textContent = '\u2191 ' + engine.upstream.join(', ');
        node.appendChild(upEl);
      }

      node.addEventListener('click', function () {
        detailConfig.onClick(engine);
      });

      pipeline.appendChild(node);
    });
  }

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
    renderPipelineInto('pipeline', rig.engines || [], {
      onClick: showEngineDetail,
    });
  }

  // ── Show engine detail ─────────────────────────────────────────────────

  function showEngineDetail(engine) {
    selectedEngineId = engine.id;

    // Update pipeline node selection
    var nodes = document.querySelectorAll('#pipeline .pipeline-node');
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
    html += '<dt>Started At</dt><dd>' + esc(formatDate(engine.startedAt) || '\u2014') + '</dd>';
    html += '<dt>Completed At</dt><dd>' + esc(formatDate(engine.completedAt) || '\u2014') + '</dd>';

    // Elapsed time
    if (engine.status === 'completed' && engine.startedAt && engine.completedAt) {
      html += '<dt>Elapsed</dt><dd>' + esc(formatElapsed(engine.startedAt, engine.completedAt)) + '</dd>';
    } else if (engine.status === 'running' && engine.startedAt) {
      html += '<dt>Elapsed</dt><dd><span class="elapsed-running">running\u2026</span></dd>';
    }

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

    // Cost placeholder for async insertion
    html += '<span id="cost-placeholder"></span>';

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

    // Session costs (completed engines with sessionId)
    if (engine.sessionId && engine.status === 'completed') {
      fetch('/api/session/show?id=' + encodeURIComponent(engine.sessionId))
        .then(function (r) { return r.json(); })
        .then(function (session) {
          var placeholder = document.getElementById('cost-placeholder');
          if (!placeholder) return;
          var costHtml = '';
          if (session.tokenUsage) {
            if (session.tokenUsage.inputTokens != null) {
              costHtml += '<dt>Input Tokens</dt><dd>' + esc(String(session.tokenUsage.inputTokens)) + '</dd>';
            }
            if (session.tokenUsage.outputTokens != null) {
              costHtml += '<dt>Output Tokens</dt><dd>' + esc(String(session.tokenUsage.outputTokens)) + '</dd>';
            }
          }
          if (session.costUsd != null) {
            costHtml += '<dt>Cost (USD)</dt><dd>$' + esc(Number(session.costUsd).toFixed(4)) + '</dd>';
          }
          if (costHtml) {
            placeholder.insertAdjacentHTML('beforebegin', costHtml);
          }
        })
        .catch(function () { /* ignore */ });
    }

    // Session log / transcript
    stopSessionPoll();
    var sessionLogSection = document.getElementById('session-log-section');
    var sessionLogSpinner = document.getElementById('session-log-spinner');
    var sessionLogTextarea = document.getElementById('session-log');

    if (sessionLogSection) sessionLogSection.style.display = 'none';

    if (engine.sessionId) {
      if (engine.status === 'running') {
        // Show log section with spinner, start polling
        if (sessionLogSection) sessionLogSection.style.display = '';
        if (sessionLogSpinner) sessionLogSpinner.style.display = '';
        if (sessionLogTextarea) sessionLogTextarea.value = '';

        sessionPollTimer = setInterval(function () {
          fetch('/api/spider/session-transcript?sessionId=' + encodeURIComponent(engine.sessionId))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.sessionStatus !== 'running') {
                stopSessionPoll();
                if (sessionLogSpinner) sessionLogSpinner.style.display = 'none';
                if (sessionLogTextarea) {
                  sessionLogTextarea.value = renderTranscript(data.messages || []);
                  sessionLogTextarea.scrollTop = sessionLogTextarea.scrollHeight;
                }
              }
              // While running, textarea stays empty, spinner shows
            })
            .catch(function () { /* ignore */ });
        }, 3000);

      } else if (engine.status === 'completed' || engine.status === 'failed') {
        // Fetch transcript once
        if (sessionLogSection) sessionLogSection.style.display = '';
        if (sessionLogSpinner) sessionLogSpinner.style.display = 'none';

        fetch('/api/spider/session-transcript?sessionId=' + encodeURIComponent(engine.sessionId))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (sessionLogTextarea) {
              sessionLogTextarea.value = renderTranscript(data.messages || []);
            }
          })
          .catch(function () { /* ignore */ });
      }
    }
  }

  // ── Back to list ───────────────────────────────────────────────────────

  function backToList() {
    stopSessionPoll();
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

    // Rig templates table
    var templates = configData.templates || [];
    var templateMappings = configData.templateMappings || {};

    // Build reverse mapping: templateName → [writType, ...]
    var reverseMappings = {};
    for (var writType in templateMappings) {
      if (!Object.prototype.hasOwnProperty.call(templateMappings, writType)) continue;
      var tname = templateMappings[writType];
      if (!reverseMappings[tname]) reverseMappings[tname] = [];
      reverseMappings[tname].push(writType);
    }

    var templateEmpty = document.getElementById('template-empty');
    var templatesTable = document.getElementById('templates-table');
    var templatesTbody = document.getElementById('templates-tbody');

    if (templates.length === 0) {
      if (templateEmpty) templateEmpty.style.display = '';
      if (templatesTable) templatesTable.style.display = 'none';
    } else {
      if (templateEmpty) templateEmpty.style.display = 'none';
      if (templatesTable) templatesTable.style.display = '';

      if (templatesTbody) {
        templatesTbody.innerHTML = templates.map(function (info) {
          var engineCount = (info.template && info.template.engines) ? info.template.engines.length : 0;
          var resEngine = (info.template && info.template.resolutionEngine) ? info.template.resolutionEngine : '\u2014';
          var writTypes = (reverseMappings[info.name] || []).join(', ') || '\u2014';
          return '<tr data-template-name="' + esc(info.name) + '">' +
            '<td>' + esc(info.name) + '</td>' +
            '<td>' + esc(info.source) + '</td>' +
            '<td>' + esc(String(engineCount)) + '</td>' +
            '<td>' + esc(resEngine) + '</td>' +
            '<td>' + esc(writTypes) + '</td>' +
            '</tr>';
        }).join('');

        // Wire row clicks
        var rows = templatesTbody.querySelectorAll('tr');
        for (var i = 0; i < rows.length; i++) {
          (function (row) {
            row.addEventListener('click', function () {
              var tname = row.getAttribute('data-template-name');
              var info = templates.find(function (t) { return t.name === tname; });
              if (info) {
                selectedTemplateName = tname;
                showTemplateDetail(info);
              }
            });
          })(rows[i]);
        }
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
            '<td>' + (bt.pollIntervalMs != null ? esc(String(bt.pollIntervalMs)) : '\u2014') + '</td>' +
            '</tr>';
        }).join('');
      }
    }
  }

  // ── Template detail ────────────────────────────────────────────────────

  function showTemplateDetail(info) {
    var detailDiv = document.getElementById('template-detail');
    var titleEl = document.getElementById('template-detail-title');
    var jsonEl = document.getElementById('template-json');
    var engineDetailEl = document.getElementById('template-engine-detail');

    if (detailDiv) detailDiv.style.display = '';
    if (titleEl) titleEl.textContent = 'Template: ' + info.name;
    if (jsonEl) jsonEl.textContent = JSON.stringify(info.template, null, 2);
    if (engineDetailEl) engineDetailEl.style.display = 'none';

    // Highlight selected row
    var rows = document.querySelectorAll('#templates-tbody tr');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-template-name') === info.name) {
        rows[i].classList.add('selected');
      } else {
        rows[i].classList.remove('selected');
      }
    }

    // Build synthetic engines from template
    var syntheticEngines = (info.template.engines || []).map(function (e) {
      return {
        id: e.id,
        designId: e.designId,
        status: 'pending',
        upstream: e.upstream || [],
        givensSpec: e.givens || {},
      };
    });

    renderPipelineInto('template-pipeline', syntheticEngines, {
      onClick: showTemplateEngineDetail,
    });
  }

  function showTemplateEngineDetail(engine) {
    var panel = document.getElementById('template-engine-detail');
    var title = document.getElementById('template-engine-detail-title');
    var body = document.getElementById('template-engine-detail-body');

    if (!panel || !title || !body) return;

    title.textContent = 'Engine: ' + engine.id;
    panel.style.display = '';

    var html = '<dl class="engine-detail-field">' +
      '<dt>Design ID</dt><dd>' + esc(engine.designId) + '</dd>' +
      '<dt>Upstream</dt><dd>' + esc((engine.upstream || []).join(', ') || '(none)') + '</dd>' +
      '</dl>' +
      '<details class="collapsible"><summary>Givens Spec</summary>' +
      '<pre><code>' + esc(JSON.stringify(engine.givensSpec, null, 2)) + '</code></pre></details>';

    body.innerHTML = html;
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
