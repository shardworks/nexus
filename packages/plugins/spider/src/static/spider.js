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
  var rigListPollTimer = null;
  var currentRigPollTimer = null;

  // Session transcript polling state.
  // transcriptPollSessionId tracks the sessionId the current 2 s polling
  // loop is bound to. startSessionTranscriptPoll dedupes against this so
  // repeat calls with the same id are no-ops (letting updateEngineDetail
  // call it every rig poll without tearing down the timer). Cleared by
  // stopSessionTranscriptPoll. Nothing else should touch it.
  var transcriptPollSessionId = null;
  var TRANSCRIPT_POLL_INTERVAL = 2000;

  // Elapsed ticker — for a running engine, we refresh the Elapsed field
  // locally every second so the UI has a visible live pulse without
  // needing a server roundtrip per tick. Set up by updateEngineDetail
  // when it sees a running engine; torn down on transition, engine
  // switch, and rig-switch.
  var elapsedTimer = null;
  var elapsedTimerStartedAt = null;  // ISO string of the engine the timer is running for
  var ELAPSED_TICK_INTERVAL = 1000;

  // Tracks engines for which the per-session cost has already been fetched.
  // Reset when navigating to a new rig. Used to gate the cost fetch so each
  // engine's /api/session/show is requested at most once.
  var costFetchedFor = {};
  // Tracks the engine's status from the previous tick so the poll updater
  // can detect a transition into 'completed' and trigger the cost fetch.
  var engineStatusByEngineId = {};

  var RIG_POLL_INTERVAL = 2000;

  // ── Badge mapping ──────────────────────────────────────────────────────

  function badgeClass(status) {
    switch (status) {
      case 'completed': return 'badge--success';
      case 'running':   return 'badge--active';
      case 'failed':    return 'badge--error';
      case 'stuck':     return 'badge--warning';
      case 'blocked':   return 'badge--warning';
      case 'cancelled': return 'badge--cancelled';
      case 'pending':
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

  // ── Session transcript polling ─────────────────────────────────────────

  /**
   * Fetch the transcript snapshot for sessionId and render it into the
   * textarea, preserving scroll pin-to-bottom. Updates the spinner badge
   * based on the returned sessionStatus. Stops polling on terminal.
   */
  function fetchAndRenderTranscript(sessionId) {
    fetch('/api/spider/session-transcript?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        // Bail if polling has been retargeted to a different session.
        if (transcriptPollSessionId !== sessionId) return;
        var ta = document.getElementById('session-log');
        if (ta) {
          // Preserve scroll position if the user has scrolled away from
          // the bottom; otherwise stick to the tail.
          var atBottom =
            ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 4;
          ta.value = renderTranscript(res.messages || []);
          if (atBottom) {
            ta.scrollTop = ta.scrollHeight;
          }
        }
        var status = res && res.sessionStatus;
        var terminal = status && status !== 'running' && status !== 'pending';
        var spinnerEl = document.getElementById('session-log-spinner');
        if (terminal) {
          stopSessionTranscriptPoll();
          if (spinnerEl) spinnerEl.style.display = 'none';
        } else if (spinnerEl) {
          spinnerEl.className = 'badge badge--active';
          spinnerEl.textContent = 'polling\u2026';
          spinnerEl.style.display = '';
        }
      })
      .catch(function () { /* ignore transient errors, keep polling */ });
  }

  /**
   * Start (or retarget) the transcript polling loop for the given
   * sessionId. Safe to call every rig poll — if the sessionId matches
   * the one we're already polling, this is a no-op. Passing null closes
   * any active poll and hides the session-log UI.
   */
  function startSessionTranscriptPoll(sessionId) {
    if (sessionId === transcriptPollSessionId) return;

    stopSessionTranscriptPoll();

    if (!sessionId) {
      var sectionEmpty = document.getElementById('session-log-section');
      if (sectionEmpty) sectionEmpty.style.display = 'none';
      return;
    }

    transcriptPollSessionId = sessionId;

    var sessionLogSection = document.getElementById('session-log-section');
    var sessionLogSpinner = document.getElementById('session-log-spinner');
    var sessionLogTextarea = document.getElementById('session-log');

    if (sessionLogSection) sessionLogSection.style.display = '';
    if (sessionLogTextarea) sessionLogTextarea.value = '';

    if (sessionLogSpinner) {
      sessionLogSpinner.className = 'badge badge--active';
      sessionLogSpinner.textContent = 'polling\u2026';
      sessionLogSpinner.style.display = '';
    }

    // Fire immediately so the user sees transcript content without
    // waiting for the first interval tick.
    fetchAndRenderTranscript(sessionId);
    sessionPollTimer = setInterval(function () {
      fetchAndRenderTranscript(sessionId);
    }, TRANSCRIPT_POLL_INTERVAL);
  }

  function stopSessionTranscriptPoll() {
    transcriptPollSessionId = null;
    stopSessionPoll();
  }

  // ── Elapsed ticker ─────────────────────────────────────────────────────

  /**
   * Start a 1 s ticker that refreshes the #ed-elapsed text using
   * formatElapsed(startedAt, now). Safe to call repeatedly — if the
   * ticker is already running for the same startedAt, no-op. Passing a
   * different startedAt restarts the ticker so the displayed value
   * comes from the correct engine's start time.
   */
  function startElapsedTimer(startedAt) {
    if (!startedAt) { stopElapsedTimer(); return; }
    if (elapsedTimer !== null && elapsedTimerStartedAt === startedAt) return;

    stopElapsedTimer();
    elapsedTimerStartedAt = startedAt;
    var tick = function () {
      var el = document.getElementById('ed-elapsed');
      if (!el) return;
      el.innerHTML = esc(formatElapsed(startedAt, new Date().toISOString()));
    };
    tick();
    elapsedTimer = setInterval(tick, ELAPSED_TICK_INTERVAL);
  }

  function stopElapsedTimer() {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    elapsedTimerStartedAt = null;
  }

  // ── Rig polling helpers ────────────────────────────────────────────────

  function isRigInFlight(rig) {
    return rig.status === 'running' || rig.status === 'blocked';
  }

  function stopRigListPoll() {
    if (rigListPollTimer !== null) {
      clearInterval(rigListPollTimer);
      rigListPollTimer = null;
    }
  }

  function stopCurrentRigPoll() {
    if (currentRigPollTimer !== null) {
      clearInterval(currentRigPollTimer);
      currentRigPollTimer = null;
    }
  }

  function startRigListPollIfNeeded() {
    stopRigListPoll();
    var hasInFlight = rigs.some(isRigInFlight);
    if (!hasInFlight) return;
    rigListPollTimer = setInterval(function () {
      fetchRigListQuiet();
    }, RIG_POLL_INTERVAL);
  }

  /** Refetch rig list without resetting filters — silent background refresh. */
  function fetchRigListQuiet() {
    var rigUrl = '/api/rig/list?limit=100';
    if (currentStatusFilter) {
      rigUrl += '&status=' + encodeURIComponent(currentStatusFilter);
    }

    var rigPromise = fetch(rigUrl).then(function (r) { return r.json(); });
    var writPromise = fetch('/api/writ/list?limit=100').then(function (r) { return r.json(); });

    Promise.all([rigPromise, writPromise]).then(function (results) {
      rigs = Array.isArray(results[0]) ? results[0] : [];
      buildWritLookup(Array.isArray(results[1]) ? results[1] : []);
      renderRigList();

      // Re-evaluate whether polling should continue
      var hasInFlight = rigs.some(isRigInFlight);
      if (!hasInFlight) {
        stopRigListPoll();
      }
    }).catch(function (err) {
      console.error('[spider] rig list poll error:', err);
    });
  }

  function startCurrentRigPoll() {
    stopCurrentRigPoll();
    if (!currentRig || !isRigInFlight(currentRig)) return;
    currentRigPollTimer = setInterval(function () {
      fetchCurrentRigQuiet();
    }, RIG_POLL_INTERVAL);
  }

  /**
   * Refetch the currently-viewed rig and update detail + pipeline in place.
   *
   * The poll path must NOT call showEngineDetail directly — that function
   * rebuilds the engine-detail body wholesale and re-opens the SSE stream,
   * causing flicker, collapsing <details> blocks, and yanking textarea
   * scroll. Instead, we call updateEngineDetail which does targeted writes
   * into the stable field containers established on the click path.
   */
  function fetchCurrentRigQuiet() {
    if (!currentRig) { stopCurrentRigPoll(); return; }
    fetch('/api/rig/show?id=' + encodeURIComponent(currentRig.id))
      .then(function (r) { return r.json(); })
      .then(function (rig) {
        if (!currentRig || currentRig.id !== rig.id) return; // navigated away
        currentRig = rig;

        // Update the meta table
        var metaTable = document.getElementById('detail-meta');
        if (metaTable) {
          metaTable.innerHTML =
            '<tbody>' +
            '<tr><th>ID</th><td>' + esc(rig.id) + '</td></tr>' +
            '<tr><th>Writ</th><td><a href="/pages/writs/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td></tr>' +
            '<tr><th>Status</th><td>' + badgeHtml(rig.status) + '</td></tr>' +
            '<tr><th>Created</th><td>' + esc(formatDate(rig.createdAt)) + '</td></tr>' +
            '</tbody>';
        }

        // Re-render pipeline using keyed in-place update (no flicker).
        renderPipeline(rig);

        // If an engine was selected, update engine detail with fresh data
        // via the targeted updater — never rebuild the panel from a poll.
        if (selectedEngineId) {
          var updatedEngine = (rig.engines || []).find(function (e) {
            return e.id === selectedEngineId;
          });
          if (updatedEngine) {
            updateEngineDetail(updatedEngine);
          }
        }

        // Stop polling once terminal
        if (!isRigInFlight(rig)) {
          stopCurrentRigPoll();
        }
      })
      .catch(function (err) {
        console.error('[spider] current rig poll error:', err);
      });
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
      startRigListPollIfNeeded();
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
        '<td><a class="rig-link" href="#" data-rig-id="' + esc(rig.id) + '">' + esc(writTitle) + '</a></td>' +
        '<td>' + esc(engineSummary(rig.engines)) + '</td>' +
        '<td><a class="rig-link" href="#" data-rig-id="' + esc(rig.id) + '">' + esc(rig.id) + '</a></td>' +
        '<td><a href="/pages/writs/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td>' +
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

    stopSessionTranscriptPoll();
    stopElapsedTimer();
    stopCurrentRigPoll();

    // Reset per-rig caches so the new rig's engines refetch cost cleanly
    // and status transitions are tracked from a clean slate.
    costFetchedFor = {};
    engineStatusByEngineId = {};

    document.getElementById('rig-list-view').style.display = 'none';
    document.getElementById('rig-detail-view').style.display = '';

    document.getElementById('detail-title').textContent = 'Rig: ' + rig.id;

    var metaTable = document.getElementById('detail-meta');
    metaTable.innerHTML =
      '<tbody>' +
      '<tr><th>ID</th><td>' + esc(rig.id) + '</td></tr>' +
      '<tr><th>Writ</th><td><a href="/pages/writs/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a></td></tr>' +
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

    // Switching rigs: clear pipeline so any reused-id collisions can't reuse
    // stale click handlers from a previous rig's nodes. The keyed-update
    // path only kicks in for subsequent polls of the same rig.
    var pipeline = document.getElementById('pipeline');
    if (pipeline) pipeline.innerHTML = '';

    renderPipeline(rig);

    var engineDetail = document.getElementById('engine-detail');
    if (engineDetail) engineDetail.style.display = 'none';

    // Clear the engine-detail body so the next selection rebuilds the
    // skeleton from scratch (no leftover stable-id containers from a
    // previously-selected engine of the previous rig).
    var engineDetailBody = document.getElementById('engine-detail-body');
    if (engineDetailBody) engineDetailBody.innerHTML = '';

    startCurrentRigPoll();
  }

  // ── Render pipeline (generic, keyed in-place update) ───────────────────

  /**
   * Render or update a pipeline of engines into the given container.
   *
   * Uses a keyed in-place update strategy indexed by engine.id:
   *   - Existing nodes are reused (preserving any internal DOM state).
   *   - The status badge text/class and selection class are patched in place.
   *   - Only nodes for previously-unseen engine ids are created.
   *   - Nodes for engines no longer in the list are dropped on rebuild.
   *
   * Also serves the Config tab's template-pipeline preview; first invocation
   * on an empty container is the degenerate "all new nodes" case.
   */
  function renderPipelineInto(containerId, engines, detailConfig) {
    var pipeline = document.getElementById(containerId);
    if (!pipeline) return;

    if (!engines || engines.length === 0) {
      pipeline.innerHTML = '';
      pipeline.textContent = 'No engines.';
      return;
    }

    var sorted = topoSort(engines);

    // Index existing pipeline-node children by engine id.
    // (We deliberately do NOT touch arrow elements — they have no state.)
    var existingNodes = {};
    var existingList = pipeline.querySelectorAll('.pipeline-node');
    for (var i = 0; i < existingList.length; i++) {
      var existingId = existingList[i].getAttribute('data-engine-id');
      if (existingId) existingNodes[existingId] = existingList[i];
    }

    // Fast path: same engine set in the same order. Patch each node in
    // place without touching the parent's child list. This is the common
    // case during rig polls.
    var orderUnchanged =
      existingList.length === sorted.length &&
      sorted.every(function (e, idx) {
        return existingList[idx].getAttribute('data-engine-id') === e.id;
      });

    if (orderUnchanged) {
      sorted.forEach(function (engine) {
        var node = existingNodes[engine.id];
        if (node) {
          updatePipelineNode(node, engine);
        }
      });
      return;
    }

    // Slow path: engine set or order changed. Detach existing nodes,
    // rebuild arrow markers, and re-attach reused nodes (creating fresh
    // ones for previously-unseen engine ids). Stale nodes are dropped.
    pipeline.innerHTML = '';
    pipeline.textContent = '';

    sorted.forEach(function (engine, idx) {
      if (idx > 0) {
        var arrow = document.createElement('div');
        arrow.className = 'pipeline-arrow';
        arrow.textContent = '\u2192';
        pipeline.appendChild(arrow);
      }
      var node = existingNodes[engine.id];
      if (!node) {
        node = createPipelineNode(engine, detailConfig);
      }
      updatePipelineNode(node, engine);
      pipeline.appendChild(node);
    });
  }

  function createPipelineNode(engine, detailConfig) {
    var node = document.createElement('div');
    node.className = 'pipeline-node';
    node.setAttribute('data-engine-id', engine.id);

    var idSpan = document.createElement('span');
    idSpan.className = 'node-id';
    idSpan.textContent = engine.id;
    node.appendChild(idSpan);

    var badgeEl = document.createElement('span');
    badgeEl.className = 'badge pipeline-node-status';
    node.appendChild(badgeEl);

    var upEl = document.createElement('span');
    upEl.className = 'pipeline-node-upstream';
    upEl.style.fontSize = '10px';
    upEl.style.color = 'var(--text-dim, #888)';
    upEl.style.display = 'none';
    node.appendChild(upEl);

    // Stash an engine-ref box on the node so the click handler reads the
    // *latest* engine object after subsequent updates, not a stale closure.
    node.__engineRef = { engine: engine };
    node.addEventListener('click', function () {
      detailConfig.onClick(node.__engineRef.engine);
    });

    return node;
  }

  function updatePipelineNode(node, engine) {
    if (node.__engineRef) {
      node.__engineRef.engine = engine;
    }

    var badgeEl = node.querySelector('.pipeline-node-status');
    if (badgeEl) {
      var bc = badgeClass(engine.status);
      var nextClass = 'badge pipeline-node-status' + (bc ? ' ' + bc : '');
      if (badgeEl.className !== nextClass) badgeEl.className = nextClass;
      if (badgeEl.textContent !== engine.status) badgeEl.textContent = engine.status;
    }

    var upEl = node.querySelector('.pipeline-node-upstream');
    if (upEl) {
      if (engine.upstream && engine.upstream.length > 1) {
        var upText = '\u2191 ' + engine.upstream.join(', ');
        if (upEl.textContent !== upText) upEl.textContent = upText;
        if (upEl.style.display === 'none') upEl.style.display = '';
      } else if (upEl.style.display !== 'none') {
        upEl.style.display = 'none';
      }
    }

    // Selection class
    if (engine.id === selectedEngineId) {
      if (!node.classList.contains('selected')) node.classList.add('selected');
    } else if (node.classList.contains('selected')) {
      node.classList.remove('selected');
    }
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

  // ── Engine detail skeleton + updater ───────────────────────────────────

  /**
   * Build the stable-id skeleton for the engine-detail panel exactly once
   * per engine selection. Subsequent rig polls call updateEngineDetail to
   * write only the value text into these containers — never rebuilding the
   * markup, which would tear down <details> open state and <pre> scroll.
   *
   * Each value-bearing field has a stable id (#ed-*); the corresponding
   * <dt> labels also have ids so we can hide entire rows when the field is
   * absent (e.g. block-* rows for non-blocked engines).
   *
   * The cancel button sits inside #ed-cancel-container (toggled via
   * style.display) so we never regenerate it across updates while the
   * engine remains cancellable, keeping its click handler intact.
   */
  function buildEngineDetailSkeleton(body) {
    var html = '';

    html += '<div id="ed-cancel-container" style="display:none">';
    html += '<button class="btn btn--danger" id="cancel-engine-btn">Cancel Rig</button>';
    html += '</div>';

    html += '<dl class="engine-detail-field">';
    html += '<dt>Status</dt><dd id="ed-status"></dd>';
    html += '<dt>Design ID</dt><dd id="ed-design-id"></dd>';
    html += '<dt>Upstream</dt><dd id="ed-upstream"></dd>';
    html += '<dt>Started At</dt><dd id="ed-started-at"></dd>';
    html += '<dt>Completed At</dt><dd id="ed-completed-at"></dd>';
    html += '<dt id="ed-elapsed-dt" style="display:none">Elapsed</dt>';
    html += '<dd id="ed-elapsed" style="display:none"></dd>';
    html += '<dt id="ed-error-dt" style="display:none">Error</dt>';
    html += '<dd id="ed-error" style="display:none;color:var(--red,#f55)"></dd>';
    html += '<dt id="ed-session-id-dt" style="display:none">Session ID</dt>';
    html += '<dd id="ed-session-id" style="display:none"></dd>';
    html += '<dt id="ed-block-type-dt" style="display:none">Block Type</dt>';
    html += '<dd id="ed-block-type" style="display:none"></dd>';
    html += '<dt id="ed-block-blocked-at-dt" style="display:none">Blocked At</dt>';
    html += '<dd id="ed-block-blocked-at" style="display:none"></dd>';
    html += '<dt id="ed-block-message-dt" style="display:none">Block Message</dt>';
    html += '<dd id="ed-block-message" style="display:none"></dd>';
    html += '<dt id="ed-block-last-checked-dt" style="display:none">Last Checked</dt>';
    html += '<dd id="ed-block-last-checked" style="display:none"></dd>';
    html += '<dt id="ed-block-condition-dt" style="display:none">Block Condition</dt>';
    html += '<dd id="ed-block-condition" style="display:none">';
    html += '<pre id="ed-block-condition-pre" style="margin:0;font-size:11px"></pre></dd>';
    // Explicit cost-row containers replace the old #cost-placeholder trick.
    html += '<dt id="ed-cost-input-dt" style="display:none">Input Tokens</dt>';
    html += '<dd id="ed-cost-input" style="display:none"></dd>';
    html += '<dt id="ed-cost-output-dt" style="display:none">Output Tokens</dt>';
    html += '<dd id="ed-cost-output" style="display:none"></dd>';
    html += '<dt id="ed-cost-usd-dt" style="display:none">Cost (USD)</dt>';
    html += '<dd id="ed-cost-usd" style="display:none"></dd>';
    html += '</dl>';

    // Stable <details> nodes — open/closed state and <pre> scroll inside
    // these are preserved across polls because we never replace the nodes.
    html += '<details class="collapsible" id="ed-givens-details">';
    html += '<summary>Givens Spec</summary>';
    html += '<pre><code id="ed-givens-code"></code></pre></details>';
    html += '<details class="collapsible" id="ed-yields-details" style="display:none">';
    html += '<summary>Yields</summary>';
    html += '<pre><code id="ed-yields-code"></code></pre></details>';

    body.innerHTML = html;

    // Wire the cancel button click handler exactly once per skeleton build.
    // The button itself is not regenerated on update, so this handler
    // survives across polls.
    var cancelBtn = document.getElementById('cancel-engine-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!currentRig) return;
        var rigIdAtClick = currentRig.id;
        var engineIdAtClick = selectedEngineId;
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling\u2026';
        fetch('/api/rig/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rigId: rigIdAtClick }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('Cancel failed: ' + r.status);
            return r.json();
          })
          .then(function (rig) {
            currentRig = rig;
            renderPipeline(currentRig);
            var updatedEngine = (currentRig.engines || []).find(function (en) {
              return en.id === engineIdAtClick;
            });
            if (updatedEngine) updateEngineDetail(updatedEngine);
          })
          .catch(function (err) {
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancel Rig';
            console.error('[spider] cancel error:', err);
          });
      });
    }
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  function setRowDisplay(dtId, ddId, visible) {
    var dt = document.getElementById(dtId);
    var dd = document.getElementById(ddId);
    var disp = visible ? '' : 'none';
    if (dt && dt.style.display !== disp) dt.style.display = disp;
    if (dd && dd.style.display !== disp) dd.style.display = disp;
  }

  /**
   * Update only the value text of the existing engine-detail field
   * containers. Does not touch the SSE stream, does not re-fetch the
   * writ, and does not unconditionally re-fetch session cost — cost
   * fetch is gated on a transition into 'completed' (see costFetchedFor).
   *
   * MUST be safe to call on every rig poll: any mutation that would
   * disturb <details> open state, <pre> scroll, or the cancel-button
   * click handler must NOT happen here.
   */
  function updateEngineDetail(engine) {
    if (!engine) return;

    // Decide cancel button visibility (in-place; never re-creates the button).
    var showCancel = false;
    if (currentRig && (currentRig.status === 'running' || currentRig.status === 'blocked' || currentRig.status === 'stuck')) {
      showCancel = true;
    }
    if (engine.status === 'running' && engine.sessionId) {
      showCancel = true;
    }
    if (currentRig && (currentRig.status === 'completed' || currentRig.status === 'failed' || currentRig.status === 'cancelled')) {
      showCancel = false;
    }
    var cancelContainer = document.getElementById('ed-cancel-container');
    if (cancelContainer) {
      var nextDisp = showCancel ? '' : 'none';
      if (cancelContainer.style.display !== nextDisp) cancelContainer.style.display = nextDisp;
    }

    // Always-present fields
    setHtml('ed-status', badgeHtml(engine.status));
    setText('ed-design-id', engine.designId == null ? '' : String(engine.designId));
    setText('ed-upstream', (engine.upstream || []).join(', ') || '(none)');
    setText('ed-started-at', formatDate(engine.startedAt) || '\u2014');
    setText('ed-completed-at', formatDate(engine.completedAt) || '\u2014');

    // Elapsed (only shown for completed-with-times or running-with-start).
    // For completed engines we write the final elapsed once and tear down
    // the ticker. For running engines we start a 1 s ticker that keeps
    // #ed-elapsed fresh locally without a server roundtrip per tick.
    var showElapsed = false;
    if (engine.status === 'completed' && engine.startedAt && engine.completedAt) {
      stopElapsedTimer();
      setHtml('ed-elapsed', esc(formatElapsed(engine.startedAt, engine.completedAt)));
      showElapsed = true;
    } else if (engine.status === 'running' && engine.startedAt) {
      startElapsedTimer(engine.startedAt);
      showElapsed = true;
    } else {
      stopElapsedTimer();
      setHtml('ed-elapsed', '');
    }
    setRowDisplay('ed-elapsed-dt', 'ed-elapsed', showElapsed);

    // Error (only when present)
    if (engine.error) {
      setText('ed-error', String(engine.error));
      setRowDisplay('ed-error-dt', 'ed-error', true);
    } else {
      setText('ed-error', '');
      setRowDisplay('ed-error-dt', 'ed-error', false);
    }

    // Session ID (only when present)
    if (engine.sessionId) {
      setText('ed-session-id', String(engine.sessionId));
      setRowDisplay('ed-session-id-dt', 'ed-session-id', true);
    } else {
      setText('ed-session-id', '');
      setRowDisplay('ed-session-id-dt', 'ed-session-id', false);
    }

    // Block info
    if (engine.block) {
      setText('ed-block-type', String(engine.block.type || ''));
      setRowDisplay('ed-block-type-dt', 'ed-block-type', true);

      setText('ed-block-blocked-at', formatDate(engine.block.blockedAt) || '');
      setRowDisplay('ed-block-blocked-at-dt', 'ed-block-blocked-at', true);

      if (engine.block.message) {
        setText('ed-block-message', String(engine.block.message));
        setRowDisplay('ed-block-message-dt', 'ed-block-message', true);
      } else {
        setRowDisplay('ed-block-message-dt', 'ed-block-message', false);
      }

      if (engine.block.lastCheckedAt) {
        setText('ed-block-last-checked', formatDate(engine.block.lastCheckedAt));
        setRowDisplay('ed-block-last-checked-dt', 'ed-block-last-checked', true);
      } else {
        setRowDisplay('ed-block-last-checked-dt', 'ed-block-last-checked', false);
      }

      var condText = JSON.stringify(engine.block.condition, null, 2);
      var condPre = document.getElementById('ed-block-condition-pre');
      if (condPre && condPre.textContent !== condText) condPre.textContent = condText;
      setRowDisplay('ed-block-condition-dt', 'ed-block-condition', true);
    } else {
      setRowDisplay('ed-block-type-dt', 'ed-block-type', false);
      setRowDisplay('ed-block-blocked-at-dt', 'ed-block-blocked-at', false);
      setRowDisplay('ed-block-message-dt', 'ed-block-message', false);
      setRowDisplay('ed-block-last-checked-dt', 'ed-block-last-checked', false);
      setRowDisplay('ed-block-condition-dt', 'ed-block-condition', false);
    }

    // Givens spec (always present)
    var givensCode = document.getElementById('ed-givens-code');
    if (givensCode) {
      var givensText = JSON.stringify(engine.givensSpec, null, 2);
      if (givensCode.textContent !== givensText) givensCode.textContent = givensText;
    }

    // Yields (only when defined)
    var yieldsDetails = document.getElementById('ed-yields-details');
    var yieldsCode = document.getElementById('ed-yields-code');
    if (engine.yields !== undefined) {
      if (yieldsCode) {
        var yieldsText = JSON.stringify(engine.yields, null, 2);
        if (yieldsCode.textContent !== yieldsText) yieldsCode.textContent = yieldsText;
      }
      if (yieldsDetails && yieldsDetails.style.display === 'none') {
        yieldsDetails.style.display = '';
      }
    } else if (yieldsDetails && yieldsDetails.style.display !== 'none') {
      yieldsDetails.style.display = 'none';
    }

    // Cost fetch — gated on a transition to 'completed' status. We use
    // costFetchedFor as the canonical guard so each engine's cost is
    // requested at most once. The previous-status check expresses the
    // "transition" intent and avoids re-firing once we've already fetched.
    var prevStatus = engineStatusByEngineId[engine.id];
    if (
      engine.sessionId &&
      engine.status === 'completed' &&
      !costFetchedFor[engine.id] &&
      (prevStatus === undefined || prevStatus !== 'completed')
    ) {
      costFetchedFor[engine.id] = true;
      fetchSessionCost(engine.id, engine.sessionId);
    }
    engineStatusByEngineId[engine.id] = engine.status;

    // Transcript polling target is driven off the current engine's
    // sessionId. The dedupe inside startSessionTranscriptPoll makes it
    // safe to call every rig poll — the loop is only torn down and
    // rebuilt when the sessionId actually changes (or becomes null).
    startSessionTranscriptPoll(engine.sessionId || null);

    // Pipeline-node selection class (kept in sync without a full re-render).
    var nodes = document.querySelectorAll('#pipeline .pipeline-node');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-engine-id') === engine.id) {
        if (!n.classList.contains('selected')) n.classList.add('selected');
      } else if (n.classList.contains('selected')) {
        n.classList.remove('selected');
      }
    }
  }

  function fetchSessionCost(engineId, sessionId) {
    fetch('/api/session/show?id=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (session) {
        // Bail out if the user has navigated away from this engine.
        if (selectedEngineId !== engineId) return;
        applyCostUpdate(session);
      })
      .catch(function () { /* ignore */ });
  }

  function applyCostUpdate(session) {
    var hasInput = session && session.tokenUsage && session.tokenUsage.inputTokens != null;
    var hasOutput = session && session.tokenUsage && session.tokenUsage.outputTokens != null;
    var hasCost = session && session.costUsd != null;

    if (hasInput) setText('ed-cost-input', String(session.tokenUsage.inputTokens));
    setRowDisplay('ed-cost-input-dt', 'ed-cost-input', !!hasInput);

    if (hasOutput) setText('ed-cost-output', String(session.tokenUsage.outputTokens));
    setRowDisplay('ed-cost-output-dt', 'ed-cost-output', !!hasOutput);

    if (hasCost) setText('ed-cost-usd', '$' + Number(session.costUsd).toFixed(4));
    setRowDisplay('ed-cost-usd-dt', 'ed-cost-usd', !!hasCost);
  }

  // ── Show engine detail (click path) ────────────────────────────────────

  /**
   * Click-path entry: build the skeleton (if needed), populate it via
   * updateEngineDetail, and reveal the panel. updateEngineDetail is
   * responsible for driving transcript polling and the elapsed ticker,
   * so no additional lifecycle work is needed here. The 2 s rig poll
   * calls updateEngineDetail directly via fetchCurrentRigQuiet, which
   * keeps the transcript loop alive without any click-path glue.
   */
  function showEngineDetail(engine) {
    var engineChanged = selectedEngineId !== engine.id;
    selectedEngineId = engine.id;

    var panel = document.getElementById('engine-detail');
    var title = document.getElementById('engine-detail-title');
    var body = document.getElementById('engine-detail-body');

    if (!panel || !title || !body) return;

    title.textContent = 'Engine: ' + engine.id;
    panel.style.display = '';

    // Ensure the stable-id skeleton is in place. We rebuild it whenever
    // the body is empty (initial selection after rig switch) or when the
    // user has selected a different engine — both cases need a fresh
    // cancel button handler bound to the new context.
    var hasSkeleton = !!document.getElementById('ed-status');
    if (!hasSkeleton || engineChanged) {
      buildEngineDetailSkeleton(body);
    }

    updateEngineDetail(engine);
  }

  // ── Back to list ───────────────────────────────────────────────────────

  function backToList() {
    stopSessionTranscriptPoll();
    stopElapsedTimer();
    stopCurrentRigPoll();
    currentRig = null;
    selectedEngineId = null;
    costFetchedFor = {};
    engineStatusByEngineId = {};
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

    // Switching templates: clear the preview pipeline so we don't reuse
    // pipeline-node DOM (with stale onClick wiring) from a different template.
    var templatePipeline = document.getElementById('template-pipeline');
    if (templatePipeline) templatePipeline.innerHTML = '';

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
        stopRigListPoll();
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
