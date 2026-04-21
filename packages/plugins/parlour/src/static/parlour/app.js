/**
 * Parlour — chat UI application logic.
 *
 * Vanilla JS, no build step. Communicates with the Parlour API routes
 * via fetch(). SSE from POST /api/parlour/turn is read by manually
 * parsing the ReadableStream (EventSource only supports GET).
 */

// ── State ─────────────────────────────────────────────────────────────

let currentRole = null;
let currentCodex = '';       // empty = guild home
let currentConversationId = null;
let isStreaming = false;
let currentAnimaMessageEl = null;  // the anima message wrapper div being streamed
let currentAnimaTextEl = null;     // the text content element within the current anima bubble
let currentAnimaToolsEl = null;    // the tool-pills row element within the current anima bubble
let currentAnimaText = '';         // accumulated raw markdown text for the current anima turn

// Per-conversation cost aggregation (updated after each turn)
let turnCostData = [];  // [{ costUsd, inputTokens, outputTokens }, ...]

// ── DOM references ────────────────────────────────────────────────────

const roleSelect = document.getElementById('role-select');
const codexSelect = document.getElementById('codex-select');
const parlourMain = document.getElementById('parlour-main');
const newConvBtn = document.getElementById('new-conversation-btn');
const convListEl = document.getElementById('conversation-list');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const costCard = document.getElementById('cost-card');
const costDetails = document.getElementById('cost-details');

// ── Initialisation ────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadRoles(), loadCodexes()]);
}

async function loadRoles() {
  try {
    const res = await fetch('/api/parlour/roles');
    if (!res.ok) return;
    const roles = await res.json();
    roles.sort((a, b) => a.name.localeCompare(b.name));
    for (const role of roles) {
      const opt = document.createElement('option');
      opt.value = role.name;
      opt.textContent = role.name + (role.source === 'kit' ? ' (kit)' : '');
      roleSelect.appendChild(opt);
    }
  } catch {
    // Roles endpoint not available — silently omit
  }
}

async function loadCodexes() {
  try {
    const res = await fetch('/api/codex/list');
    if (!res.ok) return;
    const codexes = await res.json();
    for (const codex of codexes) {
      const opt = document.createElement('option');
      opt.value = codex.name;
      opt.textContent = codex.name;
      codexSelect.appendChild(opt);
    }
  } catch {
    // Codexes not installed — silently omit
  }
}

// ── Role / Codex selection ─────────────────────────────────────────────

roleSelect.addEventListener('change', () => {
  const role = roleSelect.value;
  if (!role) return;
  onRoleChange(role);
});

codexSelect.addEventListener('change', () => {
  currentCodex = codexSelect.value;
});

function onRoleChange(role) {
  currentRole = role;
  currentConversationId = null;
  currentAnimaMessageEl = null;
  currentAnimaTextEl = null;
  currentAnimaToolsEl = null;
  currentAnimaText = '';
  turnCostData = [];
  clearChat();
  parlourMain.classList.remove('hidden');
  costCard.classList.add('hidden');
  loadConversations(role);
}

// ── Conversations sidebar ─────────────────────────────────────────────

async function loadConversations(role) {
  try {
    const res = await fetch(`/api/parlour/conversations?role=${encodeURIComponent(role)}&status=active`);
    if (!res.ok) return;
    const convs = await res.json();
    renderConversationList(convs);
  } catch {
    // Silently ignore
  }
}

function renderConversationList(convs) {
  convListEl.innerHTML = '';
  for (const conv of convs) {
    appendConversationItem(conv);
  }
}

function appendConversationItem(conv) {
  const item = document.createElement('div');
  item.className = 'conversation-item';
  item.dataset.id = conv.id;

  const titleEl = document.createElement('span');
  titleEl.className = 'conversation-item__title';
  titleEl.textContent = conv.title;
  titleEl.title = conv.title;

  const endBtn = document.createElement('button');
  endBtn.className = 'end-btn';
  endBtn.textContent = 'End';
  endBtn.title = 'End this conversation';
  endBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onEndConversation(conv.id);
  });

  item.appendChild(titleEl);
  item.appendChild(endBtn);
  item.addEventListener('click', () => onSelectConversation(conv.id));

  if (conv.id === currentConversationId) {
    item.classList.add('conversation-item--active');
  }

  convListEl.appendChild(item);
}

function setActiveConversationInSidebar(id) {
  for (const item of convListEl.querySelectorAll('.conversation-item')) {
    if (item.dataset.id === id) {
      item.classList.add('conversation-item--active');
    } else {
      item.classList.remove('conversation-item--active');
    }
  }
}

// ── New conversation ───────────────────────────────────────────────────

newConvBtn.addEventListener('click', onNewConversation);

function onNewConversation() {
  currentConversationId = null;
  currentAnimaMessageEl = null;
  currentAnimaTextEl = null;
  currentAnimaToolsEl = null;
  currentAnimaText = '';
  turnCostData = [];
  clearChat();
  costCard.classList.add('hidden');
  setActiveConversationInSidebar(null);
  sendBtn.disabled = false;
  chatMessages.classList.remove('empty-state');
  chatMessages.textContent = '';

  // Show placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'message message--system';
  placeholder.textContent = 'New conversation — type a message to begin';
  chatMessages.appendChild(placeholder);
}

// ── End conversation ───────────────────────────────────────────────────

async function onEndConversation(id) {
  try {
    await fetch('/api/conversation/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, reason: 'concluded' }),
    });
  } catch {
    // Ignore
  }

  // Remove from sidebar
  const item = convListEl.querySelector(`[data-id="${id}"]`);
  if (item) item.remove();

  // If current conversation ended, go to new conversation state
  if (currentConversationId === id) {
    onNewConversation();
  }
}

// ── Select conversation ────────────────────────────────────────────────

async function onSelectConversation(id) {
  currentConversationId = id;
  currentAnimaMessageEl = null;
  currentAnimaTextEl = null;
  currentAnimaToolsEl = null;
  currentAnimaText = '';
  turnCostData = [];
  setActiveConversationInSidebar(id);

  try {
    const res = await fetch(`/api/conversation/show?id=${encodeURIComponent(id)}`);
    if (!res.ok) {
      showSystemMessage('Failed to load conversation history');
      return;
    }
    const detail = await res.json();
    renderConversationHistory(detail);
    sendBtn.disabled = false;
  } catch {
    showSystemMessage('Failed to load conversation history');
  }
}

function renderConversationHistory(detail) {
  clearChat();
  chatMessages.classList.remove('empty-state');

  if (!detail.turns || detail.turns.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'message message--system';
    placeholder.textContent = 'No messages yet';
    chatMessages.appendChild(placeholder);
  } else {
    for (const turn of detail.turns) {
      if (turn.sessionId === null) {
        // Human turn
        if (turn.message) {
          appendMessage({ role: 'human', author: 'User', text: turn.message });
        }
      } else {
        // Anima turn
        const text = turn.output || '[No response recorded]';
        appendMessage({
          role: 'anima',
          author: currentRole || 'Anima',
          text,
          dim: !turn.output,
        });

        // Collect cost data
        if (turn.costUsd !== null || turn.tokenUsage !== null) {
          turnCostData.push({
            costUsd: turn.costUsd ?? 0,
            inputTokens: turn.tokenUsage?.inputTokens ?? 0,
            outputTokens: turn.tokenUsage?.outputTokens ?? 0,
          });
        }
      }
    }
  }

  updateCostCard();
  scrollToBottom();
}

// ── Chat rendering ────────────────────────────────────────────────────

function clearChat() {
  chatMessages.innerHTML = '';
  chatMessages.className = 'empty-state';
}

/**
 * Convert a raw tool name into a human-friendly label.
 * MCP guild tools arrive as e.g. "mcp__nexus-guild__tools-list" —
 * strip the prefix and convert separators to spaces.
 */
function formatToolName(name) {
  if (!name) return 'tool';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    name = parts[parts.length - 1];
  }
  return name.replace(/[-_]/g, ' ');
}

/**
 * Render markdown text safely as HTML.
 * Falls back to plain-text (escaped) when marked.js is not loaded.
 */
function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text);
  }
  // Minimal fallback: escape HTML and convert newlines
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * Ensure the current anima streaming bubble exists and return it.
 * Creates the bubble (author + tool-pills row + text content) on first call.
 */
function ensureAnimaMessage() {
  if (currentAnimaMessageEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'message message--anima';

  const authorEl = document.createElement('div');
  authorEl.className = 'message-author';
  authorEl.textContent = currentRole || 'Anima';

  const toolsEl = document.createElement('div');
  toolsEl.className = 'tool-pills-row';

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content message-content--markdown';

  wrapper.appendChild(authorEl);
  wrapper.appendChild(toolsEl);
  wrapper.appendChild(contentEl);
  chatMessages.appendChild(wrapper);

  currentAnimaMessageEl = wrapper;
  currentAnimaToolsEl = toolsEl;
  currentAnimaTextEl = contentEl;
  currentAnimaText = '';
}

function appendMessage({ role, author, text, dim = false }) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message--${role}`;

  const authorEl = document.createElement('div');
  authorEl.className = 'message-author';
  authorEl.textContent = author;

  const contentEl = document.createElement('div');
  if (dim) contentEl.style.color = 'var(--text-dim, #787c99)';

  if (role === 'anima') {
    contentEl.className = 'message-content message-content--markdown';
    contentEl.innerHTML = renderMarkdown(text);
  } else {
    contentEl.className = 'message-content';
    contentEl.textContent = text;
  }

  wrapper.appendChild(authorEl);
  wrapper.appendChild(contentEl);
  chatMessages.appendChild(wrapper);
  return wrapper;
}

function showSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'message message--system';
  el.textContent = text;
  chatMessages.appendChild(el);
  scrollToBottom();
}

function showTypingIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.id = 'typing-indicator';
  indicator.innerHTML = '<span></span><span></span><span></span>';
  chatMessages.appendChild(indicator);
  scrollToBottom();
  return indicator;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) indicator.remove();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Cost card ─────────────────────────────────────────────────────────

function updateCostCard() {
  if (turnCostData.length === 0) {
    costCard.classList.add('hidden');
    return;
  }

  const totalCost = turnCostData.reduce((sum, t) => sum + (t.costUsd || 0), 0);
  const totalInput = turnCostData.reduce((sum, t) => sum + (t.inputTokens || 0), 0);
  const totalOutput = turnCostData.reduce((sum, t) => sum + (t.outputTokens || 0), 0);

  costDetails.innerHTML = `
    <div>
      <span class="badge">IN: ${window.NexusFormat.formatTokenCount(totalInput)}</span>
      <span class="badge">OUT: ${window.NexusFormat.formatTokenCount(totalOutput)}</span>
    </div>
    <div class="cost-usd">${window.NexusFormat.formatCostUsd(totalCost)}</div>
  `;

  costCard.classList.remove('hidden');
}

// ── Send message ──────────────────────────────────────────────────────

sendBtn.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
});

async function sendMessage() {
  if (isStreaming) return;

  const text = chatInput.value.trim();
  if (!text) return;

  isStreaming = true;
  sendBtn.disabled = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Remove empty-state class and content if present
  if (chatMessages.classList.contains('empty-state')) {
    chatMessages.classList.remove('empty-state');
    chatMessages.innerHTML = '';
  }

  // Render human message
  appendMessage({ role: 'human', author: 'User', text });

  // Show typing indicator
  showTypingIndicator();

  // Start anima message bubble (will be filled progressively)
  currentAnimaMessageEl = null;
  currentAnimaTextEl = null;
  currentAnimaToolsEl = null;
  currentAnimaText = '';

  // Build request body
  const body = {
    message: text,
    role: currentRole,
    ...(currentConversationId ? { conversationId: currentConversationId } : {}),
    ...(currentCodex ? { codexName: currentCodex } : {}),
  };

  try {
    const response = await fetch('/api/parlour/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      removeTypingIndicator();
      showSystemMessage(`Error: HTTP ${response.status}`);
      isStreaming = false;
      sendBtn.disabled = false;
      return;
    }

    await readSSEStream(response.body);
  } catch (err) {
    removeTypingIndicator();
    showSystemMessage(`Error: ${err.message}`);
    isStreaming = false;
    sendBtn.disabled = false;
  }
}

// ── SSE stream reader ─────────────────────────────────────────────────

/**
 * Read an SSE stream from a POST response body.
 * EventSource only supports GET, so we parse SSE manually.
 */
async function readSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (terminated by double newline)
      const messages = buffer.split(/\n\n/);
      buffer = messages.pop() ?? ''; // last element may be incomplete

      for (const message of messages) {
        processSSEMessage(message);
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      processSSEMessage(buffer);
    }
  } finally {
    reader.releaseLock();
    // Ensure streaming state is cleaned up
    if (isStreaming) {
      removeTypingIndicator();
      isStreaming = false;
      sendBtn.disabled = false;
    }
  }
}

function processSSEMessage(raw) {
  const lines = raw.split('\n');
  let event = 'message';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length).trim();
    } else if (line.startsWith('data: ')) {
      data = line.slice('data: '.length).trim();
    }
  }

  if (!data) return;

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  handleSSEEvent(event, parsed);
}

function handleSSEEvent(event, data) {
  switch (event) {
    case 'conversation_created':
      currentConversationId = data.conversationId;
      // Add new conversation to sidebar
      appendConversationItem({
        id: data.conversationId,
        title: 'New conversation…',
      });
      setActiveConversationInSidebar(data.conversationId);
      break;

    case 'chunk':
      handleChunk(data);
      break;

    case 'error':
      removeTypingIndicator();
      showSystemMessage(`Error: ${data.error || 'Unknown error'}`);
      isStreaming = false;
      sendBtn.disabled = false;
      break;

    default:
      break;
  }
}

function handleChunk(chunk) {
  switch (chunk.type) {
    case 'text': {
      removeTypingIndicator();
      ensureAnimaMessage();
      currentAnimaText += chunk.text;
      currentAnimaTextEl.innerHTML = renderMarkdown(currentAnimaText);
      scrollToBottom();
      break;
    }

    case 'tool_use': {
      removeTypingIndicator();
      ensureAnimaMessage();
      const pill = document.createElement('span');
      pill.className = 'tool-indicator';
      pill.textContent = `⚙ ${formatToolName(chunk.name)}`;
      currentAnimaToolsEl.appendChild(pill);
      scrollToBottom();
      break;
    }

    case 'tool_result': {
      if (currentAnimaToolsEl) {
        const pill = document.createElement('span');
        pill.className = 'tool-indicator tool-indicator--done';
        pill.textContent = `✓ ${formatToolName(chunk.name)}`;
        currentAnimaToolsEl.appendChild(pill);
        scrollToBottom();
      }
      break;
    }

    case 'turn_complete': {
      // Collect cost data for this turn
      if (chunk.costUsd !== undefined && chunk.costUsd !== null) {
        // We'll do a full refresh of cost after fetching conversation detail
        // For now, add a placeholder entry that will be replaced
        turnCostData.push({
          costUsd: chunk.costUsd,
          inputTokens: 0,
          outputTokens: 0,
        });
      }

      currentAnimaMessageEl = null;
      currentAnimaTextEl = null;
      currentAnimaToolsEl = null;
      currentAnimaText = '';
      isStreaming = false;
      sendBtn.disabled = false;

      // Refresh conversation detail for full token data
      if (currentConversationId) {
        refreshConversationCost(currentConversationId);
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Re-fetch conversation detail to get accurate token totals and refresh the cost card.
 */
async function refreshConversationCost(id) {
  try {
    const res = await fetch(`/api/conversation/show?id=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const detail = await res.json();

    // Rebuild cost data from full turn history
    turnCostData = [];
    for (const turn of detail.turns) {
      if (turn.sessionId !== null && (turn.costUsd !== null || turn.tokenUsage !== null)) {
        turnCostData.push({
          costUsd: turn.costUsd ?? 0,
          inputTokens: turn.tokenUsage?.inputTokens ?? 0,
          outputTokens: turn.tokenUsage?.outputTokens ?? 0,
        });
      }
    }

    updateCostCard();

    // Also update sidebar title if this was a new conversation
    refreshConversationTitle(id);
  } catch {
    // Ignore
  }
}

async function refreshConversationTitle(id) {
  try {
    const role = encodeURIComponent(currentRole || '');
    const res = await fetch(`/api/parlour/conversations?role=${role}&status=active`);
    if (!res.ok) return;
    const convs = await res.json();
    const conv = convs.find((c) => c.id === id);
    if (!conv) return;

    const item = convListEl.querySelector(`[data-id="${id}"]`);
    if (item) {
      const titleEl = item.querySelector('.conversation-item__title');
      if (titleEl) {
        titleEl.textContent = conv.title;
        titleEl.title = conv.title;
      }
    }
  } catch {
    // Ignore
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────

init();
