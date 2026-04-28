(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  var requests = [];
  var currentRequest = null;
  var localAnswers = {};
  var pollTimer = null;
  var debounceTimers = {};
  var activeTagFilters = {};

  // ── API endpoints ──────────────────────────────────────────────────────

  var API = {
    list:     '/api/input/request-list',
    show:     '/api/input/request-show',
    answer:   '/api/input/request-answer',
    complete: '/api/input/request-complete',
    reject:   '/api/input/request-reject'
  };

  // ── DOM refs ───────────────────────────────────────────────────────────

  var listView           = document.getElementById('list-view');
  var detailView         = document.getElementById('detail-view');
  var requestListEl      = document.getElementById('request-list');
  var listEmptyEl        = document.getElementById('list-empty');
  var statusFilterEl     = document.getElementById('status-filter');
  var backBtn            = document.getElementById('back-btn');
  var detailBanner       = document.getElementById('detail-banner');
  var detailMessage      = document.getElementById('detail-message');
  var questionsContainer = document.getElementById('questions-container');
  var actionBar          = document.getElementById('action-bar');
  var successToast       = document.getElementById('success-toast');

  // ── URL handling ───────────────────────────────────────────────────────
  //
  // All deep-linkable view state for this page rides on
  // `window.NexusUrl` — the shared helper auto-injected by oculus's
  // chrome pass. The earlier inline `currentUrlParams` / `updateUrl`
  // copies are gone (commission moix23w5).
  //
  // URL keys:
  //   ?status=        pending | completed | rejected
  //                   List-page status filter. Default 'pending'.
  //   ?feedback=ID    Detail deep-link; pushes (D5).
  //   ?tag=A&tag=B    Per-detail tag filter (D12). Repeated keys; clears
  //                   itself when the detail closes via the omit-defaults
  //                   rule.

  var STATUS_VALUES = ['pending', 'completed', 'rejected'];
  var DEFAULT_STATUS = 'pending';

  function showUrlError(msg) {
    var el = document.getElementById('url-error-banner');
    if (!el) return;
    var line = document.createElement('div');
    line.textContent = msg;
    el.appendChild(line);
    el.style.display = 'block';
  }

  function clearUrlErrors() {
    var el = document.getElementById('url-error-banner');
    if (!el) return;
    el.innerHTML = '';
    el.style.display = 'none';
  }

  /** Persist the list-page status filter to the URL (replace, D5). */
  function writeStatusFilterToUrl() {
    var status = statusFilterEl ? statusFilterEl.value : DEFAULT_STATUS;
    window.NexusUrl.update({
      status: status === DEFAULT_STATUS ? null : status,
    });
  }

  /** Persist the per-detail tag filter to the URL (replace, D5). */
  function writeTagFilterToUrl() {
    var keys = Object.keys(activeTagFilters);
    window.NexusUrl.update({
      tag: keys.length === 0 ? null : keys,
    });
  }

  /**
   * Read URL state into the page. Validates the status filter and any
   * tag values; unknowns fail loud (D6). Returns the deep-link
   * feedback id, if any.
   */
  function readUrlState() {
    clearUrlErrors();
    var params = window.NexusUrl.read();

    var status = params.get('status');
    if (status !== null) {
      if (STATUS_VALUES.indexOf(status) !== -1) {
        if (statusFilterEl) statusFilterEl.value = status;
      } else {
        showUrlError('Unknown feedback status "' + status + '". Expected one of: ' + STATUS_VALUES.join(', ') + '.');
      }
    }

    var tags = params.getAll('tag');
    activeTagFilters = {};
    for (var i = 0; i < tags.length; i++) {
      activeTagFilters[tags[i]] = true;
    }

    return params.get('feedback');
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function badgeClass(status) {
    switch (status) {
      case 'pending':   return 'badge--warning';
      case 'completed': return 'badge--success';
      case 'rejected':  return 'badge--error';
      default:          return '';
    }
  }

  function answerCount(request) {
    var total = Object.keys(request.questions).length;
    var answered = Object.keys(request.answers).length;
    return answered + '/' + total + ' answered';
  }

  function localAnswerCount() {
    var total = Object.keys(currentRequest.questions).length;
    var answered = Object.keys(localAnswers).length;
    return answered + '/' + total + ' answered';
  }

  // ── List fetching & rendering ──────────────────────────────────────────

  function fetchList() {
    var status = statusFilterEl.value;
    fetch(API.list + '?status=' + encodeURIComponent(status) + '&limit=100')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        requests = Array.isArray(data) ? data : (data.items || []);
        renderList();
      })
      .catch(function () {
        // silently retry on next poll
      });
  }

  function renderList() {
    var status = statusFilterEl.value;
    if (requests.length === 0) {
      requestListEl.innerHTML = '';
      listEmptyEl.textContent = 'No ' + status + ' requests.';
      listEmptyEl.style.display = '';
      return;
    }

    listEmptyEl.style.display = 'none';
    var html = '';
    for (var i = 0; i < requests.length; i++) {
      var req = requests[i];
      html += '<div class="request-card" data-request-index="' + i + '">'
        + '<span class="request-id">' + esc(req.id) + '</span>'
        + '<span class="badge ' + badgeClass(req.status) + '">' + esc(req.status) + '</span>'
        + '<div class="request-meta">'
        +   '<div class="request-message">' + esc(req.message || '') + '</div>'
        +   '<div class="request-ids">rig: ' + esc(req.rigId) + ' · engine: ' + esc(req.engineId) + '</div>'
        + '</div>'
        + '<span class="request-progress">' + answerCount(req) + '</span>'
        + '<span class="request-time">' + new Date(req.createdAt).toLocaleString() + '</span>'
        + '</div>';
    }
    requestListEl.innerHTML = html;
  }

  // ── Polling ────────────────────────────────────────────────────────────

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(fetchList, 12000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Detail view ────────────────────────────────────────────────────────

  /**
   * Render a "not found" empty state inside the detail view for a
   * deep-linked id that does not resolve. Per D16 the URL param is
   * preserved.
   */
  function renderFeedbackNotFound(id) {
    currentRequest = null;
    listView.style.display = 'none';
    detailView.style.display = '';
    detailBanner.innerHTML = '';
    detailMessage.innerHTML =
      '<div class="empty-state" style="padding:1.5rem">' +
      'No feedback request with id <code>' + esc(id) + '</code> exists. ' +
      'It may have been completed, rejected, or the id may be mistyped.</div>';
    questionsContainer.innerHTML = '';
    actionBar.innerHTML = '';
    var oldToolbar = document.getElementById('tag-filter-toolbar');
    if (oldToolbar) oldToolbar.remove();
  }

  function showDetail(index, opts) {
    var skipUrlPush = !!(opts && opts.skipUrlPush);
    currentRequest = requests[index];
    if (!currentRequest) return;

    // Centralised URL push (D12) — keyed on the request id so the URL
    // survives list reorderings between the 12 s polls. Translation
    // index → id happens here, not at the click site. Detail open is
    // a navigation event (push: true).
    if (!skipUrlPush) window.NexusUrl.update({ feedback: currentRequest.id }, { push: true });

    // Initialize local answers from server state
    localAnswers = {};
    var keys = Object.keys(currentRequest.answers);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var val = currentRequest.answers[k];
      // Normalize answer to local format
      if (typeof val === 'object' && val !== null) {
        // ChoiceAnswer: { selected: string } | { custom: string }
        localAnswers[k] = val;
      } else if (typeof val === 'boolean') {
        localAnswers[k] = val;
      } else if (typeof val === 'string') {
        // Could be a text answer or a boolean string
        localAnswers[k] = val;
      } else {
        localAnswers[k] = val;
      }
    }

    stopPoll();
    listView.style.display = 'none';
    detailView.style.display = '';
    renderDetail();
  }

  /**
   * Open the detail view for a request id. Looks up the local list
   * first; falls back to /api/input/request-show. On miss, renders the
   * not-found state without rewriting the URL (D16).
   */
  function showDetailById(id, opts) {
    var skipUrlPush = !!(opts && opts.skipUrlPush);
    var index = -1;
    for (var i = 0; i < requests.length; i++) {
      if (requests[i] && requests[i].id === id) { index = i; break; }
    }
    if (index >= 0) {
      showDetail(index, { skipUrlPush: skipUrlPush });
      return;
    }
    fetch(API.show + '?id=' + encodeURIComponent(id))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (req) {
        if (!req || !req.id) {
          if (!skipUrlPush) window.NexusUrl.update({ feedback: id }, { push: true });
          renderFeedbackNotFound(id);
          return;
        }
        // Splice the deep-linked request into `requests` so the
        // existing index-based UI path can resolve it. Append rather
        // than replace so the operator's filtered list stays intact.
        requests.push(req);
        showDetail(requests.length - 1, { skipUrlPush: skipUrlPush });
      })
      .catch(function () {
        if (!skipUrlPush) window.NexusUrl.update({ feedback: id }, { push: true });
        renderFeedbackNotFound(id);
      });
  }

  function renderDetail() {
    var req = currentRequest;
    var isPending = req.status === 'pending';

    // Banner
    if (!isPending) {
      var bannerText = req.status === 'completed'
        ? 'This request has been completed'
        : 'This request was rejected' + (req.rejectionReason ? ': ' + esc(req.rejectionReason) : '');
      detailBanner.innerHTML = '<div class="status-banner ' + esc(req.status) + '">'
        + bannerText + '</div>';
    } else {
      detailBanner.innerHTML = '';
    }

    // Message
    detailMessage.innerHTML = esc(req.message || req.id);

    // Questions
    var qKeys = Object.keys(req.questions);
    var html = '';
    for (var i = 0; i < qKeys.length; i++) {
      var qKey = qKeys[i];
      var spec = req.questions[qKey];
      var readonlyClass = isPending ? '' : ' readonly';

      if (spec.type === 'choice') {
        html += renderChoiceQuestion(qKey, spec, readonlyClass);
      } else if (spec.type === 'boolean') {
        html += renderBooleanQuestion(qKey, spec, readonlyClass);
      } else if (spec.type === 'text') {
        html += renderTextQuestion(qKey, spec, readonlyClass);
      }
    }
    questionsContainer.innerHTML = html;

    // Tag filter toolbar
    var oldToolbar = document.getElementById('tag-filter-toolbar');
    if (oldToolbar) oldToolbar.remove();

    var tagSet = {};
    for (var t = 0; t < qKeys.length; t++) {
      var qSpec = req.questions[qKeys[t]];
      if (qSpec.tags && qSpec.tags.length > 0) {
        for (var tt = 0; tt < qSpec.tags.length; tt++) {
          tagSet[qSpec.tags[tt]] = true;
        }
      }
    }
    var allTags = Object.keys(tagSet).sort();

    if (allTags.length > 0) {
      var toolbar = document.createElement('div');
      toolbar.id = 'tag-filter-toolbar';
      toolbar.className = 'toolbar';

      for (var b = 0; b < allTags.length; b++) {
        var btn = document.createElement('button');
        btn.className = 'tag-filter-btn' + (activeTagFilters[allTags[b]] ? ' active' : '');
        btn.setAttribute('data-tag', allTags[b]);
        btn.textContent = allTags[b];
        toolbar.appendChild(btn);
      }

      var countSpan = document.createElement('span');
      countSpan.className = 'tag-filter-count';
      countSpan.style.display = 'none';
      toolbar.appendChild(countSpan);

      var clearBtn = document.createElement('button');
      clearBtn.className = 'tag-filter-clear';
      clearBtn.textContent = 'Clear filters';
      clearBtn.style.display = 'none';
      toolbar.appendChild(clearBtn);

      toolbar.addEventListener('click', function (e) {
        if (e.target.matches('.tag-filter-btn')) {
          var tag = e.target.getAttribute('data-tag');
          if (activeTagFilters[tag]) {
            delete activeTagFilters[tag];
            e.target.classList.remove('active');
          } else {
            activeTagFilters[tag] = true;
            e.target.classList.add('active');
          }
          writeTagFilterToUrl();
          applyTagFilters();
        } else if (e.target.matches('.tag-filter-clear')) {
          activeTagFilters = {};
          var btns = toolbar.querySelectorAll('.tag-filter-btn');
          for (var j = 0; j < btns.length; j++) {
            btns[j].classList.remove('active');
          }
          writeTagFilterToUrl();
          applyTagFilters();
        }
      });

      questionsContainer.parentNode.insertBefore(toolbar, questionsContainer);
      applyTagFilters();
    }

    // Action bar
    if (isPending) {
      var total = qKeys.length;
      var answered = Object.keys(localAnswers).length;
      var disabled = answered < total ? ' disabled' : '';
      actionBar.innerHTML =
        '<button class="btn-complete"' + disabled + '>Complete</button>'
        + '<button class="btn-reject">Reject</button>'
        + '<span class="answer-count">' + localAnswerCount() + '</span>'
        + '<div id="reject-area"></div>';
    } else {
      actionBar.innerHTML =
        '<button class="btn-complete" disabled>Complete</button>'
        + '<button class="btn-reject" disabled>Reject</button>';
    }
  }

  // ── Choice question rendering ──────────────────────────────────────────

  function renderChoiceQuestion(qKey, spec, readonlyClass) {
    var answer = localAnswers[qKey]; // { selected: key } or { custom: text } or undefined
    var selectedKey = answer && answer.selected ? answer.selected : null;
    var customText = answer && answer.custom != null ? answer.custom : '';
    var isCustomSelected = answer != null && 'custom' in answer;

    var html = '<div class="question-card' + readonlyClass + '" data-question-key="' + esc(qKey) + '">'
      + '<div class="question-header"><span class="question-label">' + esc(spec.label) + '</span>' + renderTags(spec) + '</div>'
      + '<div class="options-list">';

    var optKeys = Object.keys(spec.options);
    for (var i = 0; i < optKeys.length; i++) {
      var optKey = optKeys[i];
      var optLabel = spec.options[optKey];
      var sel = (!isCustomSelected && selectedKey === optKey) ? ' selected' : '';
      html += '<div class="option' + sel + '" data-option-key="' + esc(optKey) + '">'
        + '<div class="option-radio"></div>'
        + '<span class="option-text">' + esc(optLabel) + '</span>'
        + '</div>';
    }

    if (spec.allowCustom) {
      var customSel = isCustomSelected ? ' selected' : '';
      var inputDisabled = isCustomSelected ? '' : ' disabled';
      html += '<div class="option' + customSel + '" data-option-key="__custom__">'
        + '<div class="option-radio"></div>'
        + '<span class="option-text">Custom</span>'
        + '</div>'
        + '<div class="custom-row">'
        + '<input type="text" placeholder="Enter custom answer..."'
        + ' data-question-key="' + esc(qKey) + '" data-custom-input="true"'
        + ' value="' + esc(customText) + '"' + inputDisabled + ' />'
        + '</div>';
    }

    html += '</div>';
    html += renderDetails(spec);
    html += '</div>';
    return html;
  }

  // ── Boolean question rendering ─────────────────────────────────────────

  function renderBooleanQuestion(qKey, spec, readonlyClass) {
    var answer = localAnswers[qKey];
    var stateClass = '';
    var icon = '';
    if (answer === true || answer === 'true') {
      stateClass = ' checked';
      icon = '✓';
    } else if (answer === false || answer === 'false') {
      stateClass = ' unchecked';
      icon = '✗';
    }
    // Unanswered: no class, no icon (indeterminate)

    var html = '<div class="question-card' + readonlyClass + '" data-question-key="' + esc(qKey) + '">'
      + '<div class="boolean-item' + stateClass + '" data-question-key="' + esc(qKey) + '">'
      + '<div class="boolean-toggle">' + icon + '</div>'
      + '<span class="boolean-label">' + esc(spec.label) + '</span>' + renderTags(spec)
      + '</div>';

    html += renderDetails(spec);
    html += '</div>';
    return html;
  }

  // ── Text question rendering ────────────────────────────────────────────

  function renderTextQuestion(qKey, spec, readonlyClass) {
    var answer = localAnswers[qKey] || '';
    var html = '<div class="question-card' + readonlyClass + '" data-question-key="' + esc(qKey) + '">'
      + '<div class="text-question">'
      + '<label>' + esc(spec.label) + '</label>'
      + renderTags(spec)
      + '<textarea data-question-key="' + esc(qKey) + '" data-text-input="true">'
      + esc(answer) + '</textarea>'
      + '</div>';

    html += renderDetails(spec);
    html += '</div>';
    return html;
  }

  // ── Shared tag badge renderer ───────────────────────────────────────────

  function renderTags(spec) {
    if (!spec.tags || spec.tags.length === 0) return '';
    var html = '';
    for (var i = 0; i < spec.tags.length; i++) {
      html += '<span class="tag">' + esc(spec.tags[i]) + '</span>';
    }
    return html;
  }

  // ── Shared details renderer ────────────────────────────────────────────

  function renderDetails(spec) {
    if (!spec.details) return '';
    return '<details>'
      + '<summary>Details</summary>'
      + '<div class="details-body">' + esc(spec.details) + '</div>'
      + '</details>';
  }

  // ── Tag filter application ─────────────────────────────────────────────

  function applyTagFilters() {
    var cards = questionsContainer.querySelectorAll('.question-card');
    var filterKeys = Object.keys(activeTagFilters);
    var toolbar = document.getElementById('tag-filter-toolbar');

    if (filterKeys.length === 0) {
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.display = '';
      }
      if (toolbar) {
        var countEl = toolbar.querySelector('.tag-filter-count');
        var clearEl = toolbar.querySelector('.tag-filter-clear');
        if (countEl) countEl.style.display = 'none';
        if (clearEl) clearEl.style.display = 'none';
      }
      return;
    }

    var visibleCount = 0;
    var totalCount = cards.length;
    for (var i = 0; i < cards.length; i++) {
      var qKey = cards[i].getAttribute('data-question-key');
      var spec = currentRequest.questions[qKey];
      var match = false;
      if (spec && spec.tags) {
        for (var j = 0; j < spec.tags.length; j++) {
          if (activeTagFilters[spec.tags[j]]) {
            match = true;
            break;
          }
        }
      }
      if (match) {
        cards[i].style.display = '';
        visibleCount++;
      } else {
        cards[i].style.display = 'none';
      }
    }

    if (toolbar) {
      var countEl = toolbar.querySelector('.tag-filter-count');
      var clearEl = toolbar.querySelector('.tag-filter-clear');
      if (countEl) {
        countEl.textContent = 'Showing ' + visibleCount + ' of ' + totalCount;
        countEl.style.display = '';
      }
      if (clearEl) clearEl.style.display = '';
    }
  }

  // ── Auto-save ──────────────────────────────────────────────────────────

  function saveAnswer(questionKey, body, newLocalVal) {
    // Check if answer actually changed
    var prev = localAnswers[questionKey];
    if (JSON.stringify(prev) === JSON.stringify(newLocalVal)) return;
    localAnswers[questionKey] = newLocalVal;
    updateAnswerCount();

    fetch(API.answer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Save failed'); });
    })
    .catch(function (err) {
      showSaveError(questionKey, err.message);
    });
  }

  function showSaveError(questionKey, message) {
    var card = questionsContainer.querySelector('[data-question-key="' + questionKey + '"].question-card');
    if (!card) return;

    // Remove any existing error on this card
    var existing = card.querySelector('.save-error');
    if (existing) existing.remove();

    var errEl = document.createElement('div');
    errEl.className = 'save-error';
    errEl.textContent = 'Save failed: ' + message;
    card.appendChild(errEl);

    setTimeout(function () {
      if (errEl.parentNode) errEl.remove();
    }, 4000);
  }

  function updateAnswerCount() {
    var countEl = actionBar.querySelector('.answer-count');
    if (countEl) countEl.textContent = localAnswerCount();

    var btn = actionBar.querySelector('.btn-complete');
    if (btn && currentRequest && currentRequest.status === 'pending') {
      var total = Object.keys(currentRequest.questions).length;
      var answered = Object.keys(localAnswers).length;
      btn.disabled = answered < total;
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────

  function showToast(message) {
    successToast.textContent = message;
    successToast.style.display = '';
    setTimeout(function () {
      successToast.style.display = 'none';
    }, 3000);
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  function navigateToList(opts) {
    var skipUrlPush = !!(opts && opts.skipUrlPush);
    currentRequest = null;
    localAnswers = {};
    // Clear debounce timers
    var dKeys = Object.keys(debounceTimers);
    for (var i = 0; i < dKeys.length; i++) {
      clearTimeout(debounceTimers[dKeys[i]]);
    }
    debounceTimers = {};
    activeTagFilters = {};

    detailView.style.display = 'none';
    listView.style.display = '';
    // D11: push a clean URL so deep-link entries survive the Back
    // button. Never pop history — the operator may have arrived
    // directly at ?feedback=ID. Closing the detail also drops the
    // per-detail tag filter via the omit-defaults rule (D12).
    if (!skipUrlPush) window.NexusUrl.update({ feedback: null, tag: null }, { push: true });
    fetchList();
    startPoll();
  }

  // ── Complete action ────────────────────────────────────────────────────

  function doComplete() {
    fetch(API.complete, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentRequest.id })
    })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Complete failed'); });
      navigateToList();
      showToast('Request completed');
    })
    .catch(function (err) {
      showSaveError(Object.keys(currentRequest.questions)[0] || '', err.message);
    });
  }

  // ── Reject action ─────────────────────────────────────────────────────

  function showRejectPrompt() {
    var rejectArea = document.getElementById('reject-area');
    if (!rejectArea) return;

    var existing = rejectArea.querySelector('.reject-prompt');
    if (existing) {
      // Toggle off — cancel
      rejectArea.innerHTML = '';
      var rejectBtn = actionBar.querySelector('.btn-reject');
      if (rejectBtn) rejectBtn.textContent = 'Reject';
      return;
    }

    rejectArea.innerHTML = '<div class="reject-prompt">'
      + '<input type="text" placeholder="Reason (optional)" id="reject-reason" />'
      + '<button class="reject-confirm">Confirm Reject</button>'
      + '</div>';

    var rejectBtn = actionBar.querySelector('.btn-reject');
    if (rejectBtn) rejectBtn.textContent = 'Cancel';
  }

  function doReject() {
    var reasonEl = document.getElementById('reject-reason');
    var reason = reasonEl ? reasonEl.value.trim() : '';
    var body = { id: currentRequest.id };
    if (reason) body.reason = reason;

    fetch(API.reject, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Reject failed'); });
      navigateToList();
      showToast('Request rejected');
    })
    .catch(function (err) {
      showSaveError(Object.keys(currentRequest.questions)[0] || '', err.message);
    });
  }

  // ── Event delegation: list view ────────────────────────────────────────

  requestListEl.addEventListener('click', function (e) {
    var card = e.target.closest('.request-card');
    if (!card) return;
    var index = parseInt(card.getAttribute('data-request-index'), 10);
    showDetail(index);
  });

  statusFilterEl.addEventListener('change', function () {
    writeStatusFilterToUrl();
    requests = [];
    renderList();
    fetchList();
    startPoll();
  });

  // ── Event delegation: back button ──────────────────────────────────────

  backBtn.addEventListener('click', function (e) {
    e.preventDefault();
    navigateToList();
  });

  // ── Event delegation: questions container (clicks) ─────────────────────

  questionsContainer.addEventListener('click', function (e) {
    // Choice option click
    var optionEl = e.target.closest('.option[data-option-key]');
    if (optionEl) {
      var card = optionEl.closest('.question-card[data-question-key]');
      if (!card || card.classList.contains('readonly')) return;
      var qKey = card.getAttribute('data-question-key');
      var optKey = optionEl.getAttribute('data-option-key');
      handleChoiceClick(qKey, optKey, card);
      return;
    }

    // Boolean toggle click
    var boolEl = e.target.closest('.boolean-item[data-question-key]');
    if (boolEl) {
      var card = boolEl.closest('.question-card');
      if (card && card.classList.contains('readonly')) return;
      var qKey = boolEl.getAttribute('data-question-key');
      handleBooleanClick(qKey);
      return;
    }
  });

  // ── Event delegation: questions container (input for text debounce) ────

  questionsContainer.addEventListener('input', function (e) {
    if (e.target.matches('textarea[data-text-input]')) {
      var qKey = e.target.getAttribute('data-question-key');
      handleTextInput(qKey, e.target.value);
    }
  });

  // ── Event delegation: questions container (blur/keydown for custom) ────

  questionsContainer.addEventListener('blur', function (e) {
    if (e.target.matches('input[data-custom-input]')) {
      var qKey = e.target.getAttribute('data-question-key');
      handleCustomSave(qKey, e.target.value);
    }
  }, true); // capture phase for blur

  questionsContainer.addEventListener('keydown', function (e) {
    if (e.target.matches('input[data-custom-input]') && e.key === 'Enter') {
      var qKey = e.target.getAttribute('data-question-key');
      handleCustomSave(qKey, e.target.value);
    }
  });

  // ── Event delegation: action bar ───────────────────────────────────────

  actionBar.addEventListener('click', function (e) {
    if (e.target.matches('.btn-complete') && !e.target.disabled) {
      doComplete();
      return;
    }
    if (e.target.matches('.btn-reject') && !e.target.disabled) {
      showRejectPrompt();
      return;
    }
    if (e.target.matches('.reject-confirm')) {
      doReject();
      return;
    }
  });

  // ── Choice interaction handler ─────────────────────────────────────────

  function handleChoiceClick(qKey, optKey, card) {
    var options = card.querySelectorAll('.option');
    for (var i = 0; i < options.length; i++) {
      options[i].classList.remove('selected');
    }

    var clicked = card.querySelector('.option[data-option-key="' + optKey + '"]');
    if (clicked) clicked.classList.add('selected');

    var customInput = card.querySelector('input[data-custom-input]');

    if (optKey === '__custom__') {
      // Custom radio selected
      if (customInput) {
        customInput.disabled = false;
        customInput.focus();
        var text = customInput.value.trim();
        if (text) {
          saveAnswer(qKey, { id: currentRequest.id, question: qKey, custom: text }, { custom: text });
        } else {
          // Mark as custom but no text yet — update local state
          localAnswers[qKey] = { custom: '' };
          updateAnswerCount();
        }
      }
    } else {
      // Regular option selected
      if (customInput) customInput.disabled = true;
      saveAnswer(qKey, { id: currentRequest.id, question: qKey, select: optKey }, { selected: optKey });
    }
  }

  // ── Custom input save handler ──────────────────────────────────────────

  function handleCustomSave(qKey, value) {
    var text = value.trim();
    if (!text) return;

    // Check if custom radio is currently selected
    var card = questionsContainer.querySelector('.question-card[data-question-key="' + qKey + '"]');
    if (!card) return;
    var customOpt = card.querySelector('.option[data-option-key="__custom__"]');
    if (!customOpt || !customOpt.classList.contains('selected')) return;

    saveAnswer(qKey, { id: currentRequest.id, question: qKey, custom: text }, { custom: text });
  }

  // ── Boolean interaction handler ────────────────────────────────────────

  function handleBooleanClick(qKey) {
    var current = localAnswers[qKey];
    var newVal;
    if (current === true || current === 'true') {
      newVal = false;
    } else {
      // unanswered or false → true
      newVal = true;
    }

    var strVal = newVal ? 'true' : 'false';
    saveAnswer(qKey, { id: currentRequest.id, question: qKey, value: strVal }, newVal);

    // Re-render the boolean item in place
    var boolItem = questionsContainer.querySelector('.boolean-item[data-question-key="' + qKey + '"]');
    if (boolItem) {
      boolItem.classList.remove('checked', 'unchecked');
      var toggle = boolItem.querySelector('.boolean-toggle');
      if (newVal) {
        boolItem.classList.add('checked');
        toggle.textContent = '✓';
      } else {
        boolItem.classList.add('unchecked');
        toggle.textContent = '✗';
      }
    }
  }

  // ── Text input debounce handler ────────────────────────────────────────

  function handleTextInput(qKey, value) {
    if (debounceTimers[qKey]) clearTimeout(debounceTimers[qKey]);
    debounceTimers[qKey] = setTimeout(function () {
      saveAnswer(qKey, { id: currentRequest.id, question: qKey, value: value }, value);
    }, 800);
  }

  // ── Browser navigation (popstate) ──────────────────────────────────────

  // Restore the full URL state on Back / Forward — ?status=,
  // ?feedback=, and ?tag= each round-trip independently. The
  // popstate-driven path uses skipUrlPush so it never re-pushes the
  // URL the browser already updated.
  window.addEventListener('popstate', function () {
    var feedbackId = readUrlState();
    if (feedbackId) {
      showDetailById(feedbackId, { skipUrlPush: true });
    } else {
      navigateToList({ skipUrlPush: true });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────
  //
  // Read URL state on first paint so the status filter, tag filter,
  // and ?feedback= deep-link survive refresh and copy-paste. The list
  // fetch already reads statusFilterEl.value, so updating that input
  // before fetchList() is enough to apply the URL-restored status.
  var initialFeedbackId = readUrlState();
  fetchList();
  startPoll();

  // Deep-link: ?feedback=ID — open that request's detail after the
  // first list fetch lands. On a miss, the /api/input/request-show
  // fallback inside showDetailById handles it. A missing/deleted/
  // mistyped id renders a "not found" state without rewriting the URL.
  if (initialFeedbackId) {
    showDetailById(initialFeedbackId, { skipUrlPush: true });
  }

})();
