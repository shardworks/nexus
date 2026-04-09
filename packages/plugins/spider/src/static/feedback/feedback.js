(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  var requests = [];
  var currentRequest = null;
  var localAnswers = {};
  var pollTimer = null;
  var debounceTimers = {};

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

  function showDetail(index) {
    currentRequest = requests[index];
    if (!currentRequest) return;

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
      + '<div class="question-header"><span class="question-label">' + esc(spec.label) + '</span></div>'
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
      + '<span class="boolean-label">' + esc(spec.label) + '</span>'
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
      + '<textarea data-question-key="' + esc(qKey) + '" data-text-input="true">'
      + esc(answer) + '</textarea>'
      + '</div>';

    html += renderDetails(spec);
    html += '</div>';
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

  function navigateToList() {
    currentRequest = null;
    localAnswers = {};
    // Clear debounce timers
    var dKeys = Object.keys(debounceTimers);
    for (var i = 0; i < dKeys.length; i++) {
      clearTimeout(debounceTimers[dKeys[i]]);
    }
    debounceTimers = {};

    detailView.style.display = 'none';
    listView.style.display = '';
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

  // ── Init ───────────────────────────────────────────────────────────────

  fetchList();
  startPoll();

})();
