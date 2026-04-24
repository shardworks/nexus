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

  // Rig-level elapsed ticker — a sibling of the engine elapsed ticker. Runs
  // while a running/non-terminal rig is being viewed; stopped on rig switch,
  // back-to-list, or transition to a terminal status.
  var rigElapsedTimer = null;
  var rigElapsedTimerStartedAt = null;

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

  // ── Cost / token formatting ────────────────────────────────────────────
  //
  // Cost and token formatting routes through the shared window.NexusFormat
  // namespace (served by oculus and auto-injected into every dashboard
  // page, so it is defined before this IIFE runs). The namespace is the
  // single source of truth — no local redefinitions here.

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

  /**
   * Reset the session-log surface to a clean slate (T7 / D5):
   *  - hide `#session-log-section`
   *  - clear the `#session-log` textarea value
   *  - null out the in-memory transcript poll state
   *
   * Called as the first step of every engine switch, rig switch, and
   * back-to-list — before any render or poll start. This is the single
   * code path that owns session-log lifecycle; all other mutations of
   * #session-log-section visibility or #session-log value must route
   * through `startSessionTranscriptPoll` (which calls into this reset
   * via stopSessionTranscriptPoll in its stop-path).
   */
  function resetSessionLog() {
    stopSessionTranscriptPoll();
    var section = document.getElementById('session-log-section');
    if (section) section.style.display = 'none';
    var ta = document.getElementById('session-log');
    if (ta) ta.value = '';
    var spinner = document.getElementById('session-log-spinner');
    if (spinner) spinner.style.display = 'none';
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

  // ── Rig-level elapsed ticker ───────────────────────────────────────────

  /**
   * Start a 1 s ticker that refreshes the #rig-elapsed text with the
   * running elapsed from `startedAt` (rig.createdAt) to now. Managed
   * alongside — but separately from — the engine elapsed ticker, because
   * the rig-level ticker's lifecycle spans the whole detail view while
   * the engine ticker is bound to engine selection.
   */
  function startRigElapsedTimer(startedAt) {
    if (!startedAt) { stopRigElapsedTimer(); return; }
    if (rigElapsedTimer !== null && rigElapsedTimerStartedAt === startedAt) return;

    stopRigElapsedTimer();
    rigElapsedTimerStartedAt = startedAt;
    var tick = function () {
      var el = document.getElementById('rig-elapsed');
      if (!el) return;
      el.textContent = formatElapsed(startedAt, new Date().toISOString());
    };
    tick();
    rigElapsedTimer = setInterval(tick, ELAPSED_TICK_INTERVAL);
  }

  function stopRigElapsedTimer() {
    if (rigElapsedTimer !== null) {
      clearInterval(rigElapsedTimer);
      rigElapsedTimer = null;
    }
    rigElapsedTimerStartedAt = null;
  }

  function isRigTerminal(rig) {
    return rig && (rig.status === 'completed' || rig.status === 'failed' || rig.status === 'cancelled' || rig.status === 'stuck');
  }

  /**
   * End time for the rig, used in formatElapsed for terminal rigs.
   *
   * Read order:
   *   1. rig.terminalAt — the authoritative terminal-event timestamp,
   *      written by the Spider the first time the rig enters a terminal
   *      status.
   *   2. max(engine.completedAt) — legacy fallback for rigs persisted
   *      before terminalAt existed and for non-terminal rigs being
   *      surfaced through this helper.
   *   3. rig.createdAt — last-resort fallback for degenerate terminal
   *      rigs whose engines never completed (D3).
   */
  function rigEndTime(rig) {
    if (rig.terminalAt) return rig.terminalAt;
    var maxCompletedAt = null;
    var engines = rig.engines || [];
    for (var i = 0; i < engines.length; i++) {
      var ca = engines[i].completedAt;
      if (ca && (maxCompletedAt === null || ca > maxCompletedAt)) {
        maxCompletedAt = ca;
      }
    }
    return maxCompletedAt || rig.createdAt;
  }

  function countCompletedEngines(engines) {
    var count = 0;
    var list = engines || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'completed') count++;
    }
    return count;
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

        // Update the meta table via stable-id skeleton writes only — never
        // rebuild the innerHTML (that would flicker and tear down any
        // liveness signals).
        updateRigMeta(rig);

        // Stop the rig elapsed ticker when the rig reaches a terminal
        // status; the last ticked value stays as the final elapsed.
        if (isRigTerminal(rig)) {
          stopRigElapsedTimer();
          // Write the final elapsed in case no tick has happened since the
          // terminal transition.
          var rigElapsedEl = document.getElementById('rig-elapsed');
          if (rigElapsedEl) {
            rigElapsedEl.textContent = formatElapsed(rig.createdAt, rigEndTime(rig));
          }
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

    // Index existing row children by rig id (mirrors renderPipelineInto).
    var existingRows = {};
    var existingList = tbody.children;
    for (var i = 0; i < existingList.length; i++) {
      var existingId = existingList[i].getAttribute('data-rig-id');
      if (existingId) existingRows[existingId] = existingList[i];
    }

    // Fast path: same rig set in the same order. Patch each row in place
    // without touching the parent's child list — the common case during
    // the 2 s poll when nothing has been added or removed.
    var orderUnchanged =
      existingList.length === filtered.length &&
      filtered.every(function (rig, idx) {
        return existingList[idx].getAttribute('data-rig-id') === rig.id;
      });

    if (orderUnchanged) {
      for (var f = 0; f < filtered.length; f++) {
        updateRigRow(existingList[f], filtered[f]);
      }
      return;
    }

    // Slow path: rig set or order changed. Detach every row (without
    // `innerHTML = ''`, which would drop the nodes we want to reuse),
    // then re-append matched rows via createRigRow / updateRigRow in the
    // new filtered order. Rows for rig ids not in the incoming list are
    // simply not re-attached and fall out of scope.
    while (tbody.firstChild) {
      tbody.removeChild(tbody.firstChild);
    }

    filtered.forEach(function (rig) {
      var row = existingRows[rig.id];
      if (!row) {
        row = createRigRow(rig);
      }
      updateRigRow(row, rig);
      tbody.appendChild(row);
    });
  }

  // ── Rig-row construction + in-place update ─────────────────────────────

  /**
   * Build a new <tr> for the given rig. Modeled one-for-one on
   * createPipelineNode: data-rig-id on the outer node (D3), per-cell class
   * hooks on the mutating <td>s (D4), and rig-link click handlers wired
   * once per anchor with a closure over rig.id (D5/D6). The live rig is
   * resolved inside the handler via rigs.find so reused rows pick up the
   * latest payload without needing their listeners re-attached.
   */
  function createRigRow(rig) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-rig-id', rig.id);

    // Cell 1: Status. A stable <span class="badge"> child is patched in
    // place by updateRigRow — the className toggles the variant, the
    // textContent is the status word.
    var statusTd = document.createElement('td');
    statusTd.className = 'rig-row-status';
    var statusBadge = document.createElement('span');
    statusBadge.className = 'badge';
    statusTd.appendChild(statusBadge);
    tr.appendChild(statusTd);

    // Cell 2: Writ title (rig-link anchor). Writ title text is written by
    // updateRigRow on every poll (D9) so writLookup refreshes are visible.
    var writTitleTd = document.createElement('td');
    var writTitleAnchor = document.createElement('a');
    writTitleAnchor.className = 'rig-link';
    writTitleAnchor.href = '#';
    writTitleAnchor.setAttribute('data-rig-id', rig.id);
    writTitleAnchor.addEventListener('click', function (e) {
      e.preventDefault();
      var live = rigs.find(function (r) { return r.id === rig.id; });
      if (live) showRigDetail(live);
    });
    writTitleTd.appendChild(writTitleAnchor);
    tr.appendChild(writTitleTd);

    // Cell 3: Cost.
    var costTd = document.createElement('td');
    costTd.className = 'rig-row-cost';
    tr.appendChild(costTd);

    // Cell 4: Engines.
    var enginesTd = document.createElement('td');
    enginesTd.className = 'rig-row-engines';
    tr.appendChild(enginesTd);

    // Cell 5: Rig id (rig-link anchor). The id text never changes for a
    // given row, so it's written once at create time.
    var rigIdTd = document.createElement('td');
    var rigIdAnchor = document.createElement('a');
    rigIdAnchor.className = 'rig-link';
    rigIdAnchor.href = '#';
    rigIdAnchor.setAttribute('data-rig-id', rig.id);
    rigIdAnchor.textContent = rig.id;
    rigIdAnchor.addEventListener('click', function (e) {
      e.preventDefault();
      var live = rigs.find(function (r) { return r.id === rig.id; });
      if (live) showRigDetail(live);
    });
    rigIdTd.appendChild(rigIdAnchor);
    tr.appendChild(rigIdTd);

    // Cell 6: Writ deep-link to the Clerk writs page. Stable per row.
    var writIdTd = document.createElement('td');
    var writIdAnchor = document.createElement('a');
    writIdAnchor.href = '/pages/writs/?writ=' + encodeURIComponent(rig.writId || '');
    writIdAnchor.textContent = rig.writId || '';
    writIdTd.appendChild(writIdAnchor);
    tr.appendChild(writIdTd);

    // Cell 7: Created timestamp (stable per row).
    var createdTd = document.createElement('td');
    createdTd.textContent = formatDate(rig.createdAt);
    tr.appendChild(createdTd);

    return tr;
  }

  /**
   * Patch the mutating cells of an existing rig row in place. Safe to
   * call on every 2 s poll — writes only happen when values actually
   * changed, mirroring the idempotent-write pattern used by setText /
   * updatePipelineNode. Cells touched: status (badge class + text), writ
   * title (anchor textContent — re-read from writLookup each call per
   * D9), cost, engines.
   */
  function updateRigRow(row, rig) {
    // Status badge — class + text, both idempotent.
    var statusTd = row.querySelector('.rig-row-status');
    if (statusTd) {
      var badgeEl = statusTd.querySelector('.badge');
      if (badgeEl) {
        var bc = badgeClass(rig.status);
        var nextClass = bc ? 'badge ' + bc : 'badge';
        if (badgeEl.className !== nextClass) badgeEl.className = nextClass;
        if (badgeEl.textContent !== rig.status) badgeEl.textContent = rig.status;
      }
    }

    // Writ title — re-read from writLookup on every call (D9). The
    // writ-title anchor is the first .rig-link in the row; the rig-id
    // anchor appears later and is not touched here.
    var writTitle = (writLookup[rig.writId] && writLookup[rig.writId].title) || '\u2014';
    var writTitleAnchor = row.querySelector('.rig-link');
    if (writTitleAnchor && writTitleAnchor.textContent !== writTitle) {
      writTitleAnchor.textContent = writTitle;
    }

    // Cost — D7/D11 fallback to 0 when costSummary is absent so the cell
    // always renders $0.00 rather than blank.
    var costTd = row.querySelector('.rig-row-cost');
    if (costTd) {
      var costUsd = (rig.costSummary && typeof rig.costSummary.costUsd === 'number') ? rig.costSummary.costUsd : 0;
      var costText = window.NexusFormat.formatCostUsd(costUsd);
      if (costTd.textContent !== costText) costTd.textContent = costText;
    }

    // Engine summary.
    var enginesTd = row.querySelector('.rig-row-engines');
    if (enginesTd) {
      var enginesText = engineSummary(rig.engines);
      if (enginesTd.textContent !== enginesText) enginesTd.textContent = enginesText;
    }
  }

  // ── Rig meta skeleton + updater ────────────────────────────────────────

  /**
   * Build the stable-id skeleton for the rig meta table exactly once per
   * rig-detail entry. Subsequent polls (updateRigMeta) and the 1 s rig
   * elapsed ticker write text into these stable nodes — never rebuilding
   * the markup, which would flicker and force a reset-flash at the 2 s
   * boundary.
   *
   * Mirrors the `buildEngineDetailSkeleton` pattern.
   */
  function buildRigMetaSkeleton() {
    var metaTable = document.getElementById('detail-meta');
    if (!metaTable) return;

    var html = '<tbody>';
    html += '<tr><th>ID</th><td id="rig-meta-id"></td></tr>';
    html += '<tr><th>Writ</th><td id="rig-meta-writ"></td></tr>';
    html += '<tr><th>Status</th><td id="rig-meta-status"></td></tr>';
    html += '<tr><th>Created</th><td id="rig-meta-created"></td></tr>';
    html += '<tr><th>Completed Engines</th><td id="rig-meta-engine-count"></td></tr>';
    html += '<tr><th>Elapsed</th><td id="rig-elapsed"></td></tr>';
    html += '<tr><th>Cost</th><td id="rig-meta-cost"></td></tr>';
    html += '</tbody>';
    metaTable.innerHTML = html;
  }

  /**
   * Write rig meta values into the stable skeleton. Safe to call on every
   * rig poll — only the value cells are mutated.
   */
  function updateRigMeta(rig) {
    if (!rig) return;
    setText('rig-meta-id', rig.id);
    setHtml('rig-meta-writ', '<a href="/pages/writs/?writ=' + esc(rig.writId) + '">' + esc(rig.writId) + '</a>');
    setHtml('rig-meta-status', badgeHtml(rig.status));
    setText('rig-meta-created', formatDate(rig.createdAt));

    var engines = rig.engines || [];
    var completed = countCompletedEngines(engines);
    setText('rig-meta-engine-count', completed + ' of ' + engines.length);

    // Elapsed — for non-terminal rigs, the ticker keeps this fresh. For
    // terminal rigs, write the final value here (the ticker is stopped).
    var elapsedEl = document.getElementById('rig-elapsed');
    if (elapsedEl) {
      if (isRigTerminal(rig)) {
        elapsedEl.textContent = formatElapsed(rig.createdAt, rigEndTime(rig));
      } else if (!rigElapsedTimer) {
        // No ticker running — paint an initial value so the cell isn't
        // blank until the first tick.
        elapsedEl.textContent = formatElapsed(rig.createdAt, new Date().toISOString());
      }
    }

    // Cost — D7: always render $0.00 when no data exists; omit
    // parenthetical when token totals are absent.
    var summary = rig.costSummary;
    var costUsd = summary ? summary.costUsd : 0;
    var inputTokens = summary ? summary.inputTokens : undefined;
    var outputTokens = summary ? summary.outputTokens : undefined;
    setText('rig-meta-cost', window.NexusFormat.formatCostWithTokens(costUsd, inputTokens, outputTokens));
  }

  // ── Show rig detail ────────────────────────────────────────────────────

  function showRigDetail(rig) {
    currentRig = rig;
    selectedEngineId = null;

    // Reset the session-log surface BEFORE any render (T7): hides the
    // section, clears the textarea, and nulls transcript state.
    resetSessionLog();
    stopElapsedTimer();
    stopRigElapsedTimer();
    stopCurrentRigPoll();

    document.getElementById('rig-list-view').style.display = 'none';
    document.getElementById('rig-detail-view').style.display = '';

    document.getElementById('detail-title').textContent = 'Rig: ' + rig.id;

    // Build the stable-id skeleton for the rig meta table once on detail
    // entry. Every subsequent poll / tick writes text into these stable
    // nodes via updateRigMeta.
    buildRigMetaSkeleton();
    updateRigMeta(rig);

    // Start the rig-level elapsed ticker for non-terminal rigs. Terminal
    // rigs show final static values (no ticking — per D16).
    if (!isRigTerminal(rig)) {
      startRigElapsedTimer(rig.createdAt);
    }

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

    // Session-log surface reset is already owned by resetSessionLog()
    // above — do not redundantly hide the section here.

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
    // Cost row — single combined format (`$x.yy (N input, M output)`).
    // Shown only for engines whose rig-show payload reports a per-engine
    // cost entry (anima engines — i.e. engines with a sessionId). Hidden
    // for clockwork engines.
    html += '<dt id="ed-cost-dt" style="display:none">Cost</dt>';
    html += '<dd id="ed-cost" style="display:none"></dd>';
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
   * containers. Does not touch the writ fetch. Cost is read from the
   * enriched rig-show payload — no per-engine fetch is triggered here.
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

    // Cost — read from the enriched rig-show payload. Shown only when the
    // rig view includes a per-engine cost entry for this engine (which
    // means the engine has a sessionId — i.e. is an anima engine).
    // Updates on the 2 s rig poll cadence without any per-engine fetch.
    var engineCost = (currentRig && currentRig.engineCosts) ? currentRig.engineCosts[engine.id] : undefined;
    if (engineCost) {
      setText('ed-cost', window.NexusFormat.formatCostWithTokens(engineCost.costUsd, engineCost.inputTokens, engineCost.outputTokens));
      setRowDisplay('ed-cost-dt', 'ed-cost', true);
    } else {
      setText('ed-cost', '');
      setRowDisplay('ed-cost-dt', 'ed-cost', false);
    }

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

    // Reset the session-log surface BEFORE any render (T7) when actually
    // switching to a different engine. A same-engine click is a no-op
    // re-render and must not disturb the in-flight transcript poll —
    // startSessionTranscriptPoll's dedupe inside updateEngineDetail keeps
    // the existing loop alive in that case.
    if (engineChanged) {
      resetSessionLog();
    }

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
    // T7: explicit session-log reset on back-to-list. resetSessionLog
    // itself calls stopSessionTranscriptPoll and clears the textarea
    // so the list → detail → list → detail cycle never leaks a stale
    // transcript across rigs.
    resetSessionLog();
    stopElapsedTimer();
    stopRigElapsedTimer();
    stopCurrentRigPoll();
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

  // ── Animator pause banner ─────────────────────────────────────────────
  //
  // Independent polling timer — fires every ANIMATOR_STATUS_POLL_INTERVAL
  // regardless of whether rigs are in flight. The banner MUST update
  // precisely when no rigs are running (that is often why they're not
  // running), so we do not piggyback on the rig-list poll.

  var ANIMATOR_STATUS_POLL_INTERVAL = 10_000;
  var animatorStatusPollTimer = null;

  function renderAnimatorBanner(status) {
    var banner = document.getElementById('animator-pause-banner');
    if (!banner) return;
    var detail = document.getElementById('animator-pause-banner-detail');
    if (!status || status.state !== 'paused' || !status.pausedUntil) {
      banner.style.display = 'none';
      return;
    }
    var untilMs = new Date(status.pausedUntil).getTime();
    if (!isFinite(untilMs) || untilMs <= Date.now()) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    if (detail) {
      var parts = [];
      parts.push((status.pauseReason || 'rate-limit') + '.');
      parts.push('Dispatch resumes at ' + status.pausedUntil);
      var secs = Math.ceil((untilMs - Date.now()) / 1000);
      if (secs > 0) parts.push('(~' + secs + 's from now)');
      if (status.lastTriggeringSession) {
        parts.push('- triggered by session ' + status.lastTriggeringSession);
      }
      detail.textContent = parts.join(' ');
    }
  }

  function fetchAnimatorStatus() {
    fetch('/api/animator/status')
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (status) { renderAnimatorBanner(status); })
      .catch(function (err) {
        // Non-fatal — Oculus may be starting up or the route may be
        // unregistered in tests. Hide the banner rather than flicker.
        console.warn('[spider] animator status poll error:', err);
        var banner = document.getElementById('animator-pause-banner');
        if (banner) banner.style.display = 'none';
      });
  }

  function startAnimatorStatusPoll() {
    if (animatorStatusPollTimer !== null) return;
    // Fire once immediately so the banner is truthful before the first
    // tick elapses, then settle into the interval cadence.
    fetchAnimatorStatus();
    animatorStatusPollTimer = setInterval(fetchAnimatorStatus, ANIMATOR_STATUS_POLL_INTERVAL);
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

    // Start the independent Animator pause-banner poll. Runs on every
    // tab (rigs/config) regardless of rig activity (D23 — the banner
    // must be truthful precisely when no rigs are running).
    startAnimatorStatusPoll();
  });
})();
