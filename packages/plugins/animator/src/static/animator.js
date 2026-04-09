/* Animator — Oculus dashboard page */
/* Vanilla JS IIFE — no framework, no modules */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────

  var sessions = [];
  var currentSessionId = null;
  var pollTimer = null;
  var sessionEventSource = null;

  // ── Badge class mapping ─────────────────────────────────────────────

  var badgeClass = {
    completed: 'badge badge--success',
    running: 'badge badge--active',
    failed: 'badge badge--error',
    timeout: 'badge badge--warning',
    cancelled: 'badge badge--cancelled',
  };

  // ── Utilities ───────────────────────────────────────────────────────

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function formatDuration(ms) {
    if (ms == null) return '-';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    s = s % 60;
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + 'h ' + m + 'm ' + s + 's';
  }

  function formatCost(costUsd) {
    if (costUsd == null) return '-';
    return '$' + Number(costUsd).toFixed(4);
  }

  function renderTranscript(messages) {
    if (!messages || !messages.length) return '(no transcript)';
    var lines = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          lines.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (var j = 0; j < msg.content.length; j++) {
            var block = msg.content[j];
            if (block.type === 'text') {
              lines.push(block.text);
            } else if (block.type === 'tool_use') {
              lines.push('[tool: ' + (block.name || block.tool || 'unknown') + ']');
            } else if (block.type === 'tool_result') {
              lines.push('[result: ' + (block.name || block.tool || 'unknown') + ']');
            }
          }
        }
      }
    }
    return lines.join('\n');
  }

  function stopSessionStream() {
    if (sessionEventSource) {
      sessionEventSource.close();
      sessionEventSource = null;
    }
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Fetch session list ──────────────────────────────────────────────

  function fetchList() {
    var params = [];
    var statusVal = document.getElementById('status-filter').value;
    var fromVal = document.getElementById('date-from').value;
    var toVal = document.getElementById('date-to').value;

    if (statusVal) params.push('status=' + encodeURIComponent(statusVal));
    if (fromVal) params.push('from=' + encodeURIComponent(fromVal));
    if (toVal) params.push('to=' + encodeURIComponent(toVal));

    var url = '/api/animator/sessions';
    if (params.length) url += '?' + params.join('&');

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        sessions = data;
        renderList();
      })
      .catch(function (err) {
        console.error('[animator] fetch sessions error:', err);
      });
  }

  // ── Render session list ─────────────────────────────────────────────

  function renderList() {
    var tbody = document.getElementById('sessions-tbody');
    var empty = document.getElementById('sessions-empty');
    if (!tbody) return;

    if (!sessions.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var cls = badgeClass[s.status] || 'badge';

      // Cost cell with tooltip
      var costHtml = '-';
      if (s.costUsd != null) {
        var tooltipLines = [];
        if (s.tokenUsage) {
          if (s.tokenUsage.inputTokens != null) tooltipLines.push('Input: ' + s.tokenUsage.inputTokens);
          if (s.tokenUsage.outputTokens != null) tooltipLines.push('Output: ' + s.tokenUsage.outputTokens);
          if (s.tokenUsage.cacheReadTokens != null) tooltipLines.push('Cache Read: ' + s.tokenUsage.cacheReadTokens);
          if (s.tokenUsage.cacheWriteTokens != null) tooltipLines.push('Cache Write: ' + s.tokenUsage.cacheWriteTokens);
        }
        var tooltipHtml = tooltipLines.length
          ? '<span class="cost-tooltip">' + esc(tooltipLines.join(' | ')) + '</span>'
          : '';
        costHtml = '<span class="cost-cell">' + esc(formatCost(s.costUsd)) + tooltipHtml + '</span>';
      }

      // Cancel button for running sessions
      var actionHtml = '';
      if (s.status === 'running') {
        actionHtml = '<button class="cancel-btn" data-session-id="' + esc(s.id) + '">Cancel</button>';
      }

      html += '<tr data-session-id="' + esc(s.id) + '">'
        + '<td><span class="' + cls + '">' + esc(s.status) + '</span></td>'
        + '<td>' + esc(s.role || '-') + '</td>'
        + '<td>' + esc(s.writTitle || '-') + '</td>'
        + '<td>' + costHtml + '</td>'
        + '<td>' + esc(formatDuration(s.durationMs)) + '</td>'
        + '<td>' + esc(formatDate(s.startedAt)) + '</td>'
        + '<td>' + actionHtml + '</td>'
        + '</tr>';
    }
    tbody.innerHTML = html;
  }

  // ── Cancel session ──────────────────────────────────────────────────

  function cancelSession(sessionId, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Cancelling...';
    }
    fetch('/api/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Cancel failed: ' + r.status);
        fetchList();
      })
      .catch(function (err) {
        console.error('[animator] cancel error:', err);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Cancel';
        }
      });
  }

  // ── Show detail view ────────────────────────────────────────────────

  function showDetail(sessionId) {
    currentSessionId = sessionId;
    stopSessionStream();

    document.getElementById('list-view').style.display = 'none';
    document.getElementById('detail-view').style.display = '';
    document.getElementById('detail-title').textContent = 'Session ' + sessionId;

    var logTextarea = document.getElementById('session-log');
    var transcriptArea = document.getElementById('transcript-area');
    var spinner = document.getElementById('session-log-spinner');

    if (logTextarea) logTextarea.value = '';
    if (transcriptArea) transcriptArea.value = '';

    // Fetch session metadata and transcript in parallel
    var metaPromise = fetch('/api/session/show?id=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); });

    var transcriptPromise = fetch('/api/animator/session-transcript?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); });

    // Render metadata
    metaPromise.then(function (session) {
      var metaTable = document.getElementById('detail-meta');
      if (!metaTable) return;
      var rows = '';
      rows += '<tr><td>ID</td><td>' + esc(session.id || '-') + '</td></tr>';
      rows += '<tr><td>Status</td><td><span class="' + (badgeClass[session.status] || 'badge') + '">' + esc(session.status || '-') + '</span></td></tr>';
      rows += '<tr><td>Provider</td><td>' + esc(session.provider || '-') + '</td></tr>';
      rows += '<tr><td>Started</td><td>' + esc(formatDate(session.startedAt)) + '</td></tr>';
      rows += '<tr><td>Ended</td><td>' + esc(formatDate(session.endedAt)) + '</td></tr>';
      rows += '<tr><td>Duration</td><td>' + esc(formatDuration(session.durationMs)) + '</td></tr>';
      if (session.costUsd != null) {
        rows += '<tr><td>Cost (USD)</td><td>' + esc(formatCost(session.costUsd)) + '</td></tr>';
      }
      if (session.tokenUsage) {
        var tu = session.tokenUsage;
        if (tu.inputTokens != null) rows += '<tr><td>Input Tokens</td><td>' + esc(String(tu.inputTokens)) + '</td></tr>';
        if (tu.outputTokens != null) rows += '<tr><td>Output Tokens</td><td>' + esc(String(tu.outputTokens)) + '</td></tr>';
        if (tu.cacheReadTokens != null) rows += '<tr><td>Cache Read Tokens</td><td>' + esc(String(tu.cacheReadTokens)) + '</td></tr>';
        if (tu.cacheWriteTokens != null) rows += '<tr><td>Cache Write Tokens</td><td>' + esc(String(tu.cacheWriteTokens)) + '</td></tr>';
      }
      if (session.metadata) {
        var meta = session.metadata;
        if (meta.role) rows += '<tr><td>Role</td><td>' + esc(String(meta.role)) + '</td></tr>';
        if (meta.writId) rows += '<tr><td>Writ ID</td><td>' + esc(String(meta.writId)) + '</td></tr>';
        if (meta.engineId) rows += '<tr><td>Engine ID</td><td>' + esc(String(meta.engineId)) + '</td></tr>';
      }
      if (session.error) {
        rows += '<tr><td>Error</td><td style="color:var(--red,#f7768e)">' + esc(session.error) + '</td></tr>';
      }
      metaTable.innerHTML = rows;
    }).catch(function (err) {
      console.error('[animator] fetch session detail error:', err);
    });

    // Render transcript from REST endpoint
    transcriptPromise.then(function (data) {
      if (transcriptArea && data.messages && data.messages.length) {
        transcriptArea.value = renderTranscript(data.messages);
        transcriptArea.scrollTop = transcriptArea.scrollHeight;
      }
    }).catch(function (err) {
      console.error('[animator] fetch transcript error:', err);
    });

    // Open SSE stream for real-time updates
    if (spinner) {
      spinner.className = 'badge badge--active';
      spinner.textContent = 'connecting\u2026';
      spinner.style.display = '';
    }

    // Track whether the stream completed normally so the onerror handler
    // (which fires when EventSource auto-reconnects after connection close)
    // does not show a spurious "disconnected" badge.
    var streamDone = false;

    sessionEventSource = new EventSource(
      '/api/animator/session-stream?sessionId=' + encodeURIComponent(sessionId)
    );

    sessionEventSource.addEventListener('chunk', function (e) {
      var chunk;
      try { chunk = JSON.parse(e.data); } catch (err) { return; }
      if (!logTextarea) return;
      if (chunk.type === 'text') {
        logTextarea.value += chunk.text;
      } else if (chunk.type === 'tool_use') {
        logTextarea.value += '\n[tool: ' + chunk.tool + ']\n';
      } else if (chunk.type === 'tool_result') {
        logTextarea.value += '[result: ' + chunk.tool + ']\n';
      }
      logTextarea.scrollTop = logTextarea.scrollHeight;
      if (spinner) {
        spinner.className = 'badge badge--active';
        spinner.textContent = 'connected';
      }
    });

    sessionEventSource.addEventListener('transcript', function (e) {
      var data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      if (transcriptArea) {
        transcriptArea.value = renderTranscript(data.messages || []);
        transcriptArea.scrollTop = transcriptArea.scrollHeight;
      }
    });

    sessionEventSource.addEventListener('done', function (e) {
      var data;
      try { data = JSON.parse(e.data); } catch (err) { data = {}; }
      // Mark stream as intentionally done before closing to prevent the
      // onerror handler from showing a spurious "disconnected" badge.
      streamDone = true;
      stopSessionStream();
      if (spinner) {
        spinner.style.display = 'none';
      }
      // If no live stream available, fetch transcript via REST fallback
      if (data.noStream) {
        fetch('/api/animator/session-transcript?sessionId=' + encodeURIComponent(sessionId))
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (transcriptArea) {
              transcriptArea.value = renderTranscript(res.messages || []);
              transcriptArea.scrollTop = transcriptArea.scrollHeight;
            }
          })
          .catch(function () { /* ignore */ });
      }
    });

    sessionEventSource.addEventListener('error', function (e) {
      if (streamDone) return;
      var data;
      try { data = JSON.parse(/** @type {MessageEvent} */(e).data || '{}'); } catch (err) { data = {}; }
      if (spinner) {
        spinner.className = 'badge badge--error';
        spinner.textContent = data.error ? 'error: ' + data.error : 'error';
        spinner.style.display = '';
      }
      stopSessionStream();
    });

    sessionEventSource.onerror = function () {
      // Network-level error (browser fires this on connection failure / premature close).
      // Skip if the stream completed normally — the connection close is expected.
      if (streamDone) return;
      if (sessionEventSource) {
        stopSessionStream();
        if (spinner && spinner.style.display !== 'none') {
          spinner.className = 'badge badge--error';
          spinner.textContent = 'disconnected';
          spinner.style.display = '';
        }
      }
    };
  }

  // ── Back to list ────────────────────────────────────────────────────

  function showList() {
    stopSessionStream();
    currentSessionId = null;
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('list-view').style.display = '';
    fetchList();
  }

  // ── Event wiring ────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Back button
    var backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.addEventListener('click', showList);

    // Refresh button
    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', fetchList);

    // Status filter
    var statusFilter = document.getElementById('status-filter');
    if (statusFilter) statusFilter.addEventListener('change', fetchList);

    // Date filters
    var dateFrom = document.getElementById('date-from');
    var dateTo = document.getElementById('date-to');
    if (dateFrom) dateFrom.addEventListener('change', fetchList);
    if (dateTo) dateTo.addEventListener('change', fetchList);

    // Click delegation on table body for row clicks and cancel buttons
    var tbody = document.getElementById('sessions-tbody');
    if (tbody) {
      tbody.addEventListener('click', function (e) {
        // Check if cancel button was clicked
        var cancelBtn = e.target.closest('.cancel-btn');
        if (cancelBtn) {
          e.stopPropagation();
          var sid = cancelBtn.getAttribute('data-session-id');
          if (sid) cancelSession(sid, cancelBtn);
          return;
        }

        // Row click — show detail
        var row = e.target.closest('tr[data-session-id]');
        if (row) {
          var sessionId = row.getAttribute('data-session-id');
          if (sessionId) showDetail(sessionId);
        }
      });
    }

    // Initial load
    fetchList();

    // Auto-refresh every 12 seconds
    pollTimer = setInterval(fetchList, 12000);
  });
})();
