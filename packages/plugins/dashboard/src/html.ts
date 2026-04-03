/**
 * Dashboard web UI — embedded HTML/CSS/JS as a single-file SPA.
 *
 * Returned by the server's root handler. All API calls go to /api/*.
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Guild Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#1a1d27;--surface2:#242736;--surface3:#2e3248;
  --border:#3a3f5c;--text:#e2e8f0;--muted:#8892a4;--accent:#6366f1;
  --accent2:#818cf8;--green:#22c55e;--yellow:#eab308;--red:#ef4444;
  --blue:#3b82f6;--orange:#f97316;--radius:6px;--font:'Inter',system-ui,sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent2);text-decoration:none}
button{cursor:pointer;font-family:inherit;font-size:13px;border:none;border-radius:var(--radius);padding:5px 12px;transition:opacity .15s}
button:hover{opacity:.85}
button:disabled{opacity:.4;cursor:default}
input,select,textarea{background:var(--surface3);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px;font-family:inherit;font-size:13px;outline:none;transition:border-color .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
select option{background:var(--surface2)}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:500;text-transform:uppercase;letter-spacing:.05em}
.btn-primary{background:var(--accent);color:#fff}
.btn-ghost{background:var(--surface3);color:var(--text);border:1px solid var(--border)}
.btn-danger{background:var(--red);color:#fff}
.btn-success{background:var(--green);color:#000}
.btn-warning{background:var(--yellow);color:#000}
.btn-sm{padding:3px 8px;font-size:12px}

/* Layout */
header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:16px;height:52px;flex-shrink:0}
header h1{font-size:16px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
header h1 .guild-name{color:var(--accent2)}
.header-meta{margin-left:auto;display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block}

nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:2px;flex-shrink:0}
.tab{padding:10px 16px;font-size:13px;font-weight:500;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer;transition:color .15s,border-color .15s;user-select:none;display:flex;align-items:center;gap:6px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent2);border-bottom-color:var(--accent2)}
.tab-badge{background:var(--surface3);color:var(--muted);font-size:10px;padding:1px 6px;border-radius:10px;font-weight:600}
.tab.active .tab-badge{background:var(--accent);color:#fff}

main{flex:1;overflow:auto;padding:24px}
.tab-panel{display:none}
.tab-panel.active{display:block}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.card-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.card-title svg{flex-shrink:0}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}

/* Stats */
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.stat-label{font-size:11px;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.stat-value{font-size:28px;font-weight:700;color:var(--text);line-height:1}
.stat-sub{font-size:11px;color:var(--muted);margin-top:4px}

/* Badges / status */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:lowercase;letter-spacing:.03em}
.badge-ready{background:#1e3a5f;color:#60a5fa}
.badge-active{background:#1a3a2a;color:#4ade80}
.badge-completed{background:#1a2a1a;color:#86efac}
.badge-failed{background:#3a1a1a;color:#f87171}
.badge-cancelled{background:#2a2a2a;color:#9ca3af}
.badge-running{background:#1a2a3a;color:#38bdf8;animation:pulse 2s infinite}
.badge-pending{background:#2a2a1a;color:#fbbf24}
.badge-ready-codex{background:#1e3a5f;color:#60a5fa}
.badge-cloning{background:#2a2a1a;color:#fbbf24}
.badge-error{background:#3a1a1a;color:#f87171}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}

/* Tables */
.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.toolbar-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.search-input{width:200px}
table{width:100%;border-collapse:collapse}
thead tr{border-bottom:1px solid var(--border)}
th{text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;padding:8px 12px;white-space:nowrap;cursor:pointer;user-select:none}
th:hover{color:var(--text)}
th .sort-icon{display:inline-block;margin-left:4px;opacity:.4}
th.sorted .sort-icon{opacity:1;color:var(--accent2)}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle;max-width:340px}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.td-id{font-family:monospace;font-size:11px;color:var(--muted);white-space:nowrap}
.td-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-time{font-size:12px;color:var(--muted);white-space:nowrap}
.td-actions{white-space:nowrap;display:flex;gap:6px;align-items:center}
.empty-state{text-align:center;padding:48px 16px;color:var(--muted)}
.empty-state h3{font-size:15px;margin-bottom:6px;color:var(--text)}
.empty-icon{font-size:32px;margin-bottom:12px}
.pagination{display:flex;align-items:center;gap:8px;margin-top:12px;justify-content:flex-end;font-size:12px;color:var(--muted)}
.page-btn{background:var(--surface3);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 10px;font-size:12px}
.page-btn:disabled{opacity:.35;cursor:default}

/* Expandable rows */
.row-detail{background:var(--surface2);padding:12px 16px;border-bottom:1px solid var(--border)}
.row-detail pre{font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:var(--surface);padding:10px;border-radius:4px;border:1px solid var(--border);margin-top:6px}
.detail-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:10px}
.detail-item{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px 10px}
.detail-item .k{font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.detail-item .v{font-size:12px;font-family:monospace;word-break:break-all}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;width:520px;max-width:95vw;max-height:90vh;overflow:auto}
.modal h2{font-size:16px;font-weight:600;margin-bottom:20px}
.modal-footer{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.form-group{margin-bottom:14px}
.form-group input,.form-group select,.form-group textarea{width:100%}
.form-group textarea{resize:vertical;min-height:80px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.error-msg{color:var(--red);font-size:12px;margin-top:6px;display:none}
.error-msg.show{display:block}
.success-msg{color:var(--green);font-size:12px;margin-top:6px}

/* Plugin list */
.plugin-list{display:flex;flex-direction:column;gap:6px}
.plugin-item{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius)}
.plugin-item .pi-name{font-weight:500;flex:1}
.plugin-item .pi-type{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600;text-transform:uppercase}
.pi-type-apparatus{background:#1e2a4a;color:#818cf8}
.pi-type-kit{background:#1a2a2a;color:#34d399}
.plugin-item .pi-ver{font-size:11px;color:var(--muted);font-family:monospace}

/* Config view */
.config-view{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;font-family:monospace;font-size:12px;color:var(--muted);white-space:pre-wrap;max-height:400px;overflow:auto;line-height:1.6}
.config-key{color:var(--accent2)}
.config-str{color:var(--green)}
.config-num{color:var(--orange)}
.config-bool{color:var(--yellow)}
.config-null{color:var(--muted)}

/* Engine pipeline */
.pipeline{display:flex;align-items:center;gap:0;overflow-x:auto;padding:4px 0}
.engine-chip{display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap}
.engine-arrow{color:var(--border);font-size:14px;margin:0 2px;flex-shrink:0}

/* Loading */
.loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--muted);gap:10px}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent2);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.refresh-btn{background:none;border:none;color:var(--muted);padding:4px;line-height:1;font-size:16px}
.refresh-btn:hover{color:var(--text)}
.toast-area{position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:200}
.toast{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 16px;font-size:13px;animation:slide-in .2s ease;max-width:340px}
.toast.success{border-color:var(--green);color:var(--green)}
.toast.error{border-color:var(--red);color:var(--red)}
@keyframes slide-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<header>
  <h1>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
    <span id="guild-title">Guild Dashboard</span>
  </h1>
  <div class="header-meta">
    <span class="status-dot"></span>
    <span id="header-status">Loading…</span>
    <button class="refresh-btn" onclick="refreshCurrent()" title="Refresh">↻</button>
  </div>
</header>

<nav id="tab-nav">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="clerk">Clerk <span class="tab-badge" id="badge-clerk">—</span></div>
  <div class="tab" data-tab="spider">Spider <span class="tab-badge" id="badge-spider">—</span></div>
  <div class="tab" data-tab="animator">Animator <span class="tab-badge" id="badge-animator">—</span></div>
  <div class="tab" data-tab="codexes">Codexes <span class="tab-badge" id="badge-codexes">—</span></div>
</nav>

<main>
  <!-- OVERVIEW -->
  <div class="tab-panel active" id="panel-overview">
    <div id="overview-loading" class="loading"><div class="spinner"></div>Loading…</div>
    <div id="overview-content" style="display:none">
      <div class="grid-4" id="overview-stats" style="margin-bottom:16px"></div>
      <div class="grid-2">
        <div>
          <div class="card">
            <div class="card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Guild Info
            </div>
            <div id="overview-info"></div>
          </div>
          <div class="card">
            <div class="card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 0 4.93 19.07M4.93 4.93a10 10 0 0 0 14.14 14.14"/></svg>
              Settings
            </div>
            <div id="overview-settings"></div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              Loaded Plugins
            </div>
            <div id="overview-plugins" class="plugin-list"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- CLERK -->
  <div class="tab-panel" id="panel-clerk">
    <div class="card" style="margin-bottom:0">
      <div class="toolbar">
        <select id="clerk-filter-status" onchange="loadWrits()">
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select id="clerk-filter-type" onchange="loadWrits()">
          <option value="">All types</option>
        </select>
        <input class="search-input" type="text" id="clerk-search" placeholder="Search title…" oninput="filterWritsLocal()">
        <div class="toolbar-right">
          <span id="clerk-count-label" style="color:var(--muted);font-size:12px"></span>
          <button class="btn-primary" onclick="openPostModal()">+ Post Commission</button>
        </div>
      </div>
      <div id="clerk-loading" class="loading" style="display:none"><div class="spinner"></div>Loading…</div>
      <div id="clerk-table-wrap">
        <table>
          <thead>
            <tr>
              <th onclick="sortWrits('id')" data-col="id">ID <span class="sort-icon">↕</span></th>
              <th onclick="sortWrits('type')" data-col="type">Type <span class="sort-icon">↕</span></th>
              <th onclick="sortWrits('title')" data-col="title">Title <span class="sort-icon">↕</span></th>
              <th onclick="sortWrits('status')" data-col="status">Status <span class="sort-icon">↕</span></th>
              <th onclick="sortWrits('createdAt')" data-col="createdAt">Created <span class="sort-icon">↕</span></th>
              <th onclick="sortWrits('updatedAt')" data-col="updatedAt">Updated <span class="sort-icon">↕</span></th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="clerk-tbody"></tbody>
        </table>
        <div id="clerk-empty" class="empty-state" style="display:none">
          <div class="empty-icon">📋</div>
          <h3>No writs found</h3>
          <p>Post a commission to create your first writ.</p>
        </div>
      </div>
      <div class="pagination">
        <button class="page-btn" id="clerk-prev" onclick="writPage(-1)" disabled>‹ Prev</button>
        <span id="clerk-page-info" style="font-size:12px;color:var(--muted)"></span>
        <button class="page-btn" id="clerk-next" onclick="writPage(1)">Next ›</button>
      </div>
    </div>
  </div>

  <!-- SPIDER -->
  <div class="tab-panel" id="panel-spider">
    <div class="card" style="margin-bottom:0">
      <div class="toolbar">
        <select id="spider-filter-status" onchange="loadRigs()">
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <div class="toolbar-right">
          <span id="spider-count-label" style="color:var(--muted);font-size:12px"></span>
        </div>
      </div>
      <div id="spider-loading" class="loading" style="display:none"><div class="spinner"></div>Loading…</div>
      <table>
        <thead>
          <tr>
            <th onclick="sortRigs('id')" data-col="id">Rig ID <span class="sort-icon">↕</span></th>
            <th onclick="sortRigs('writId')" data-col="writId">Writ <span class="sort-icon">↕</span></th>
            <th onclick="sortRigs('status')" data-col="status">Status <span class="sort-icon">↕</span></th>
            <th>Pipeline</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody id="spider-tbody"></tbody>
      </table>
      <div id="spider-empty" class="empty-state" style="display:none">
        <div class="empty-icon">⚙️</div>
        <h3>No rigs found</h3>
        <p>Rigs are created when the Spider processes writs.</p>
      </div>
    </div>
  </div>

  <!-- ANIMATOR -->
  <div class="tab-panel" id="panel-animator">
    <div class="card" style="margin-bottom:0">
      <div class="toolbar">
        <select id="animator-filter-status" onchange="loadSessions()">
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="timeout">Timeout</option>
        </select>
        <div class="toolbar-right">
          <span id="animator-count-label" style="color:var(--muted);font-size:12px"></span>
        </div>
      </div>
      <div id="animator-loading" class="loading" style="display:none"><div class="spinner"></div>Loading…</div>
      <table>
        <thead>
          <tr>
            <th onclick="sortSessions('id')" data-col="id">Session ID <span class="sort-icon">↕</span></th>
            <th onclick="sortSessions('status')" data-col="status">Status <span class="sort-icon">↕</span></th>
            <th onclick="sortSessions('provider')" data-col="provider">Provider <span class="sort-icon">↕</span></th>
            <th onclick="sortSessions('startedAt')" data-col="startedAt">Started <span class="sort-icon">↕</span></th>
            <th onclick="sortSessions('durationMs')" data-col="durationMs">Duration <span class="sort-icon">↕</span></th>
            <th>Tokens / Cost</th>
          </tr>
        </thead>
        <tbody id="animator-tbody"></tbody>
      </table>
      <div id="animator-empty" class="empty-state" style="display:none">
        <div class="empty-icon">✨</div>
        <h3>No sessions recorded</h3>
        <p>Sessions appear here when animas are animated.</p>
      </div>
      <div class="pagination">
        <button class="page-btn" id="animator-prev" onclick="sessionPage(-1)" disabled>‹ Prev</button>
        <span id="animator-page-info"></span>
        <button class="page-btn" id="animator-next" onclick="sessionPage(1)">Next ›</button>
      </div>
    </div>
  </div>

  <!-- CODEXES -->
  <div class="tab-panel" id="panel-codexes">
    <div id="codexes-loading" class="loading"><div class="spinner"></div>Loading…</div>
    <div id="codexes-content" style="display:none">
      <div class="toolbar" style="margin-bottom:16px">
        <div class="toolbar-right">
          <span id="codexes-count-label" style="color:var(--muted);font-size:12px"></span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Remote URL</th>
            <th>Status</th>
            <th>Active Drafts</th>
          </tr>
        </thead>
        <tbody id="codexes-tbody"></tbody>
      </table>
      <div id="codexes-empty" class="empty-state" style="display:none">
        <div class="empty-icon">📚</div>
        <h3>No codexes registered</h3>
        <p>Add a codex with <code>nsg codex add &lt;name&gt; &lt;url&gt;</code>.</p>
      </div>
      <div id="drafts-section" style="margin-top:24px;display:none">
        <div class="card">
          <div class="card-title">Active Drafts</div>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Codex</th>
                <th>Branch</th>
                <th>Associated With</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody id="drafts-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</main>

<!-- POST COMMISSION MODAL -->
<div class="modal-overlay" id="post-modal">
  <div class="modal">
    <h2>Post Commission</h2>
    <div class="form-row">
      <div class="form-group">
        <label for="pm-type">Type</label>
        <select id="pm-type"></select>
      </div>
      <div class="form-group">
        <label for="pm-codex">Codex (optional)</label>
        <select id="pm-codex">
          <option value="">None</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label for="pm-title">Title</label>
      <input type="text" id="pm-title" placeholder="Short description of the work">
    </div>
    <div class="form-group">
      <label for="pm-body">Body</label>
      <textarea id="pm-body" placeholder="Detailed description, requirements, context…" rows="5"></textarea>
    </div>
    <div id="pm-error" class="error-msg"></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="closePostModal()">Cancel</button>
      <button class="btn-primary" id="pm-submit" onclick="submitPost()">Post Commission</button>
    </div>
  </div>
</div>

<!-- TRANSITION MODAL -->
<div class="modal-overlay" id="trans-modal">
  <div class="modal" style="width:420px">
    <h2 id="trans-title">Transition Writ</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px" id="trans-desc"></p>
    <div class="form-group" id="trans-resolution-wrap" style="display:none">
      <label for="trans-resolution">Resolution (optional)</label>
      <textarea id="trans-resolution" rows="3" placeholder="Brief summary of how this writ resolved…"></textarea>
    </div>
    <div id="trans-error" class="error-msg"></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="closeTransModal()">Cancel</button>
      <button class="btn-primary" id="trans-submit" onclick="submitTransition()">Confirm</button>
    </div>
  </div>
</div>

<div class="toast-area" id="toast-area"></div>

<script>
// ── State ────────────────────────────────────────────────────────
let activeTab = 'overview';
let overview = null;
let writs = [];
let writsTotal = 0;
let writsPage = 0;
const WRIT_PAGE_SIZE = 20;
let writSort = { col: 'createdAt', dir: 'desc' };
let rigs = [];
let rigSort = { col: 'id', dir: 'desc' };
let sessions = [];
let sessionsTotal = 0;
let sessionsPage = 0;
const SESSION_PAGE_SIZE = 20;
let sessionSort = { col: 'startedAt', dir: 'desc' };
let transData = null;

// ── Tabs ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + id));
  loadTab(id);
}

function loadTab(id) {
  if (id === 'overview') loadOverview();
  else if (id === 'clerk') loadWrits();
  else if (id === 'spider') loadRigs();
  else if (id === 'animator') loadSessions();
  else if (id === 'codexes') loadCodexes();
}

function refreshCurrent() { loadTab(activeTab); }

// ── API helpers ──────────────────────────────────────────────────
async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  if (!r.ok) {
    const t = await r.text().catch(() => 'Unknown error');
    throw new Error(t || r.statusText);
  }
  return r.json();
}

async function apiPost(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── Toast ────────────────────────────────────────────────────────
function toast(msg, type='success') {
  const area = document.getElementById('toast-area');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  area.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── OVERVIEW ─────────────────────────────────────────────────────
async function loadOverview() {
  document.getElementById('overview-loading').style.display = 'flex';
  document.getElementById('overview-content').style.display = 'none';
  try {
    overview = await api('/overview');
    renderOverview(overview);
    document.getElementById('header-status').textContent = overview.guild.name + ' · nexus ' + overview.guild.nexus;
    document.getElementById('guild-title').innerHTML =
      'Guild Dashboard · <span class="guild-name">' + esc(overview.guild.name) + '</span>';
  } catch(e) {
    document.getElementById('overview-loading').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    return;
  }
  document.getElementById('overview-loading').style.display = 'none';
  document.getElementById('overview-content').style.display = 'block';
}

function renderOverview(data) {
  // Stats
  const stats = [
    { label: 'Plugins', value: data.plugins.length, sub: data.plugins.filter(p=>p.type==='apparatus').length + ' apparatus' },
    { label: 'Writs', value: data.counts.writs ?? '—', sub: (data.counts.ready ?? 0) + ' ready · ' + (data.counts.active ?? 0) + ' active' },
    { label: 'Sessions', value: data.counts.sessions ?? '—', sub: (data.counts.runningSessions ?? 0) + ' running' },
    { label: 'Rigs', value: data.counts.rigs ?? '—', sub: (data.counts.runningRigs ?? 0) + ' running' },
  ];
  document.getElementById('overview-stats').innerHTML = stats.map(s =>
    '<div class="stat-card"><div class="stat-label">' + esc(s.label) + '</div><div class="stat-value">' + esc(String(s.value)) + '</div><div class="stat-sub">' + esc(s.sub) + '</div></div>'
  ).join('');

  // Info
  const g = data.guild;
  document.getElementById('overview-info').innerHTML = kv([
    ['Name', g.name],
    ['Nexus Version', g.nexus],
    ['Model', g.settings?.model ?? '(default)'],
    ['Auto Migrate', g.settings?.autoMigrate !== false ? 'Yes' : 'No'],
  ]);

  // Settings — show full clockworks if present
  let settingsHtml = '';
  if (g.clockworks?.standingOrders?.length) {
    settingsHtml += '<div class="detail-label" style="margin-bottom:8px">Standing Orders</div>';
    settingsHtml += g.clockworks.standingOrders.map(o => {
      const trigger = 'on: ' + o.on;
      const action = o.run ? 'run: ' + o.run : o.summon ? 'summon: ' + o.summon : 'brief: ' + o.brief;
      return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);display:flex;gap:8px"><span style="color:var(--muted);font-family:monospace">' + esc(trigger) + '</span><span style="color:var(--accent2);font-family:monospace">' + esc(action) + '</span></div>';
    }).join('');
  }
  if (g.clerk?.writTypes?.length) {
    settingsHtml += '<div class="detail-label" style="margin:12px 0 6px">Writ Types</div>';
    settingsHtml += g.clerk.writTypes.map(t =>
      '<span class="badge badge-ready" style="margin:2px">' + esc(t.name) + '</span>'
    ).join(' ');
  }
  if (!settingsHtml) settingsHtml = '<span style="color:var(--muted);font-size:12px">No additional configuration</span>';
  document.getElementById('overview-settings').innerHTML = settingsHtml;

  // Plugins
  document.getElementById('overview-plugins').innerHTML = data.plugins.map(p =>
    '<div class="plugin-item">' +
    '<span class="pi-type ' + (p.type==='apparatus'?'pi-type-apparatus':'pi-type-kit') + '">' + esc(p.type) + '</span>' +
    '<span class="pi-name">' + esc(p.id) + '</span>' +
    '<span class="pi-ver">' + esc(p.version) + '</span>' +
    '</div>'
  ).join('');

  // Update badges
  if (data.counts.writs !== undefined) setBadge('clerk', data.counts.writs);
  if (data.counts.rigs !== undefined) setBadge('spider', data.counts.rigs);
  if (data.counts.sessions !== undefined) setBadge('animator', data.counts.sessions);
  if (data.counts.codexes !== undefined) setBadge('codexes', data.counts.codexes);
}

function kv(pairs) {
  return pairs.map(([k,v]) =>
    '<div style="display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">' +
    '<span style="font-size:11px;font-weight:600;color:var(--muted);min-width:110px;text-transform:uppercase;letter-spacing:.05em">' + esc(k) + '</span>' +
    '<span style="font-size:13px">' + esc(String(v ?? '—')) + '</span>' +
    '</div>'
  ).join('');
}

function setBadge(tab, val) {
  const el = document.getElementById('badge-' + tab);
  if (el) el.textContent = String(val);
}

// ── CLERK ─────────────────────────────────────────────────────────
async function loadWrits() {
  const status = document.getElementById('clerk-filter-status').value;
  const type   = document.getElementById('clerk-filter-type').value;
  document.getElementById('clerk-loading').style.display = 'flex';
  document.getElementById('clerk-table-wrap').style.display = 'none';
  try {
    const params = new URLSearchParams({ limit: WRIT_PAGE_SIZE, offset: writsPage * WRIT_PAGE_SIZE });
    if (status) params.set('status', status);
    if (type)   params.set('type', type);
    const data = await api('/writs?' + params);
    writs = data.writs;
    writsTotal = data.total;
    // Populate type filter (once)
    if (data.types?.length && document.getElementById('clerk-filter-type').options.length <= 1) {
      data.types.forEach(t => {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        document.getElementById('clerk-filter-type').appendChild(o);
      });
    }
    // Populate type select in modal
    if (data.types?.length) {
      const sel = document.getElementById('pm-type');
      sel.innerHTML = '';
      data.types.forEach(t => {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        sel.appendChild(o);
      });
    }
    renderWrits();
    setBadge('clerk', writsTotal);
    document.getElementById('clerk-count-label').textContent = writsTotal + ' writ' + (writsTotal!==1?'s':'');
  } catch(e) {
    document.getElementById('clerk-loading').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    return;
  }
  document.getElementById('clerk-loading').style.display = 'none';
  document.getElementById('clerk-table-wrap').style.display = 'block';
}

function renderWrits() {
  const search = (document.getElementById('clerk-search').value || '').toLowerCase();
  let rows = writs.filter(w => !search || w.title.toLowerCase().includes(search));
  rows = stableSort(rows, writSort.col, writSort.dir);
  updateSortHeaders('clerk-tbody', writSort);

  const tbody = document.getElementById('clerk-tbody');
  tbody.innerHTML = rows.map(w =>
    '<tr>' +
    '<td class="td-id">' + esc(w.id) + '</td>' +
    '<td><code style="font-size:11px;color:var(--muted)">' + esc(w.type) + '</code></td>' +
    '<td class="td-title" title="' + esc(w.title) + '">' + esc(w.title) + '</td>' +
    '<td>' + statusBadge(w.status) + '</td>' +
    '<td class="td-time">' + fmtDate(w.createdAt) + '</td>' +
    '<td class="td-time">' + fmtDate(w.updatedAt) + '</td>' +
    '<td class="td-actions">' + writActions(w) + '</td>' +
    '</tr>'
  ).join('');

  document.getElementById('clerk-empty').style.display = rows.length ? 'none' : 'block';

  // Pagination
  const totalPages = Math.ceil(writsTotal / WRIT_PAGE_SIZE);
  document.getElementById('clerk-prev').disabled = writsPage <= 0;
  document.getElementById('clerk-next').disabled = writsPage >= totalPages - 1;
  document.getElementById('clerk-page-info').textContent = totalPages > 1
    ? 'Page ' + (writsPage+1) + ' of ' + totalPages : '';
}

function filterWritsLocal() { renderWrits(); }

function writActions(w) {
  const btns = [];
  if (w.status === 'ready') {
    btns.push('<button class="btn-success btn-sm" onclick="openTrans(\'' + w.id + '\',\'active\')">Accept</button>');
    btns.push('<button class="btn-danger btn-sm" onclick="openTrans(\'' + w.id + '\',\'cancelled\')">Cancel</button>');
  } else if (w.status === 'active') {
    btns.push('<button class="btn-success btn-sm" onclick="openTrans(\'' + w.id + '\',\'completed\')">Complete</button>');
    btns.push('<button class="btn-danger btn-sm" onclick="openTrans(\'' + w.id + '\',\'failed\')">Fail</button>');
    btns.push('<button class="btn-ghost btn-sm" onclick="openTrans(\'' + w.id + '\',\'cancelled\')">Cancel</button>');
  }
  return btns.join('') || '<span style="color:var(--muted);font-size:11px">Terminal</span>';
}

function sortWrits(col) {
  if (writSort.col === col) writSort.dir = writSort.dir === 'asc' ? 'desc' : 'asc';
  else { writSort.col = col; writSort.dir = 'desc'; }
  renderWrits();
}

function writPage(delta) {
  writsPage = Math.max(0, writsPage + delta);
  loadWrits();
}

// ── POST COMMISSION MODAL ─────────────────────────────────────────
function openPostModal() {
  document.getElementById('pm-title').value = '';
  document.getElementById('pm-body').value = '';
  document.getElementById('pm-error').className = 'error-msg';
  // Populate codexes
  const sel = document.getElementById('pm-codex');
  sel.innerHTML = '<option value="">None</option>';
  if (overview?.counts?.codexNames) {
    overview.counts.codexNames.forEach(n => {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
  }
  document.getElementById('post-modal').classList.add('open');
  document.getElementById('pm-title').focus();
}

function closePostModal() {
  document.getElementById('post-modal').classList.remove('open');
}

async function submitPost() {
  const title  = document.getElementById('pm-title').value.trim();
  const body   = document.getElementById('pm-body').value.trim();
  const type   = document.getElementById('pm-type').value;
  const codex  = document.getElementById('pm-codex').value || undefined;
  const errEl  = document.getElementById('pm-error');
  errEl.className = 'error-msg';

  if (!title) { errEl.textContent = 'Title is required.'; errEl.className = 'error-msg show'; return; }
  if (!body)  { errEl.textContent = 'Body is required.'; errEl.className = 'error-msg show'; return; }

  document.getElementById('pm-submit').disabled = true;
  try {
    await apiPost('/writs', { title, body, type, codex });
    closePostModal();
    toast('Commission posted!');
    writsPage = 0;
    loadWrits();
    loadOverview();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.className = 'error-msg show';
  } finally {
    document.getElementById('pm-submit').disabled = false;
  }
}

// ── TRANSITION MODAL ──────────────────────────────────────────────
function openTrans(id, to) {
  transData = { id, to };
  const labels = { active:'Accept', completed:'Complete', failed:'Fail', cancelled:'Cancel' };
  const descs = {
    active:    'Accept this writ and begin working on it.',
    completed: 'Mark this writ as completed.',
    failed:    'Mark this writ as failed.',
    cancelled: 'Cancel this writ.',
  };
  document.getElementById('trans-title').textContent = labels[to] + ' Writ';
  document.getElementById('trans-desc').textContent = descs[to] || '';
  const showRes = to === 'completed' || to === 'failed' || to === 'cancelled';
  document.getElementById('trans-resolution-wrap').style.display = showRes ? 'block' : 'none';
  document.getElementById('trans-resolution').value = '';
  document.getElementById('trans-error').className = 'error-msg';
  const btn = document.getElementById('trans-submit');
  btn.className = 'btn-primary';
  if (to === 'failed' || to === 'cancelled') btn.className = 'btn-danger';
  if (to === 'completed') btn.className = 'btn-success';
  btn.textContent = labels[to];
  document.getElementById('trans-modal').classList.add('open');
}

function closeTransModal() {
  document.getElementById('trans-modal').classList.remove('open');
  transData = null;
}

async function submitTransition() {
  if (!transData) return;
  const { id, to } = transData;
  const resolution = document.getElementById('trans-resolution').value.trim() || undefined;
  const errEl = document.getElementById('trans-error');
  errEl.className = 'error-msg';
  document.getElementById('trans-submit').disabled = true;
  try {
    await apiPost('/writs/' + id + '/transition', { to, ...(resolution ? { resolution } : {}) });
    closeTransModal();
    toast('Writ transitioned to ' + to);
    loadWrits();
    loadOverview();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.className = 'error-msg show';
  } finally {
    document.getElementById('trans-submit').disabled = false;
  }
}

// ── SPIDER ────────────────────────────────────────────────────────
async function loadRigs() {
  const status = document.getElementById('spider-filter-status').value;
  document.getElementById('spider-loading').style.display = 'flex';
  try {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const data = await api('/rigs?' + params);
    rigs = data.rigs;
    renderRigs();
    setBadge('spider', rigs.length);
    document.getElementById('spider-count-label').textContent = rigs.length + ' rig' + (rigs.length!==1?'s':'');
  } catch(e) {
    document.getElementById('spider-loading').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    return;
  }
  document.getElementById('spider-loading').style.display = 'none';
}

function renderRigs() {
  const rows = stableSort(rigs, rigSort.col, rigSort.dir);
  const tbody = document.getElementById('spider-tbody');
  tbody.innerHTML = rows.map(r => {
    const engines = r.engines || [];
    const done = engines.filter(e => e.status==='completed' || e.status==='failed').length;
    const total = engines.length;
    const pct = total ? Math.round(done/total*100) : 0;
    return '<tr>' +
      '<td class="td-id">' + esc(r.id) + '</td>' +
      '<td class="td-id">' + esc(r.writId) + '</td>' +
      '<td>' + statusBadge(r.status) + '</td>' +
      '<td><div class="pipeline">' + engines.map((e,i) =>
        (i>0?'<span class="engine-arrow">›</span>':'')+
        '<div class="engine-chip">' + statusDot(e.status) + ' ' + esc(e.id) + '</div>'
      ).join('') + '</div></td>' +
      '<td><div style="font-size:11px;color:var(--muted)">' + done + '/' + total + ' engines</div>' +
        '<div style="height:4px;background:var(--surface3);border-radius:2px;margin-top:4px;width:80px">' +
        '<div style="height:4px;background:' + (r.status==='failed'?'var(--red)':r.status==='completed'?'var(--green)':'var(--accent)') + ';border-radius:2px;width:' + pct + '%"></div>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join('');
  document.getElementById('spider-empty').style.display = rows.length ? 'none' : 'block';
}

function sortRigs(col) {
  if (rigSort.col === col) rigSort.dir = rigSort.dir === 'asc' ? 'desc' : 'asc';
  else { rigSort.col = col; rigSort.dir = 'desc'; }
  renderRigs();
}

// ── ANIMATOR ─────────────────────────────────────────────────────
async function loadSessions() {
  const status = document.getElementById('animator-filter-status').value;
  document.getElementById('animator-loading').style.display = 'flex';
  try {
    const params = new URLSearchParams({ limit: SESSION_PAGE_SIZE, offset: sessionsPage * SESSION_PAGE_SIZE });
    if (status) params.set('status', status);
    const data = await api('/sessions?' + params);
    sessions = data.sessions;
    sessionsTotal = data.total;
    renderSessions();
    setBadge('animator', sessionsTotal);
    document.getElementById('animator-count-label').textContent = sessionsTotal + ' session' + (sessionsTotal!==1?'s':'');
  } catch(e) {
    document.getElementById('animator-loading').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    return;
  }
  document.getElementById('animator-loading').style.display = 'none';
}

function renderSessions() {
  const rows = stableSort(sessions, sessionSort.col, sessionSort.dir);
  const tbody = document.getElementById('animator-tbody');
  tbody.innerHTML = rows.map(s => {
    const tokens = s.tokenUsage
      ? (s.tokenUsage.inputTokens||0) + '↑ ' + (s.tokenUsage.outputTokens||0) + '↓'
      : '—';
    const cost = s.costUsd != null ? '$' + s.costUsd.toFixed(4) : '—';
    return '<tr>' +
      '<td class="td-id">' + esc(s.id) + '</td>' +
      '<td>' + statusBadge(s.status) + '</td>' +
      '<td style="font-size:12px;color:var(--muted)">' + esc(s.provider||'—') + '</td>' +
      '<td class="td-time">' + fmtDate(s.startedAt) + '</td>' +
      '<td class="td-time">' + fmtDuration(s.durationMs) + '</td>' +
      '<td style="font-size:11px;color:var(--muted);font-family:monospace">' + esc(tokens) + ' · ' + esc(cost) + '</td>' +
    '</tr>';
  }).join('');
  document.getElementById('animator-empty').style.display = rows.length ? 'none' : 'block';

  const totalPages = Math.ceil(sessionsTotal / SESSION_PAGE_SIZE);
  document.getElementById('animator-prev').disabled = sessionsPage <= 0;
  document.getElementById('animator-next').disabled = sessionsPage >= totalPages - 1;
  document.getElementById('animator-page-info').textContent = totalPages > 1
    ? 'Page ' + (sessionsPage+1) + ' of ' + totalPages : '';
}

function sortSessions(col) {
  if (sessionSort.col === col) sessionSort.dir = sessionSort.dir === 'asc' ? 'desc' : 'asc';
  else { sessionSort.col = col; sessionSort.dir = 'desc'; }
  renderSessions();
}

function sessionPage(delta) {
  sessionsPage = Math.max(0, sessionsPage + delta);
  loadSessions();
}

// ── CODEXES ───────────────────────────────────────────────────────
async function loadCodexes() {
  document.getElementById('codexes-loading').style.display = 'flex';
  document.getElementById('codexes-content').style.display = 'none';
  try {
    const data = await api('/codexes');
    renderCodexes(data);
    setBadge('codexes', data.codexes.length);
    document.getElementById('codexes-count-label').textContent = data.codexes.length + ' codex' + (data.codexes.length!==1?'es':'');
  } catch(e) {
    document.getElementById('codexes-loading').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    return;
  }
  document.getElementById('codexes-loading').style.display = 'none';
  document.getElementById('codexes-content').style.display = 'block';
}

function renderCodexes(data) {
  const tbody = document.getElementById('codexes-tbody');
  tbody.innerHTML = data.codexes.map(c =>
    '<tr>' +
    '<td style="font-weight:500">' + esc(c.name) + '</td>' +
    '<td style="font-size:11px;font-family:monospace;color:var(--muted);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(c.remoteUrl) + '">' + esc(c.remoteUrl) + '</td>' +
    '<td>' + codexStatusBadge(c.cloneStatus) + '</td>' +
    '<td style="text-align:center">' + (c.activeDrafts || 0) + '</td>' +
    '</tr>'
  ).join('');
  document.getElementById('codexes-empty').style.display = data.codexes.length ? 'none' : 'block';

  // Drafts
  const allDrafts = data.drafts || [];
  document.getElementById('drafts-section').style.display = allDrafts.length ? 'block' : 'none';
  if (allDrafts.length) {
    document.getElementById('drafts-tbody').innerHTML = allDrafts.map(d =>
      '<tr>' +
      '<td class="td-id">' + esc(d.id) + '</td>' +
      '<td>' + esc(d.codexName) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(d.branch) + '</td>' +
      '<td class="td-id">' + esc(d.associatedWith || '—') + '</td>' +
      '<td class="td-time">' + fmtDate(d.createdAt) + '</td>' +
      '</tr>'
    ).join('');
  }
}

function codexStatusBadge(s) {
  const map = { ready:'badge-ready', cloning:'badge-cloning', error:'badge-error' };
  return '<span class="badge ' + (map[s]||'badge-cancelled') + '">' + esc(s) + '</span>';
}

// ── Utilities ────────────────────────────────────────────────────
function statusBadge(s) {
  return '<span class="badge badge-' + s + '">' + esc(s) + '</span>';
}

function statusDot(s) {
  const colors = { pending:'var(--yellow)', running:'var(--blue)', completed:'var(--green)', failed:'var(--red)' };
  return '<span style="width:7px;height:7px;border-radius:50%;background:' + (colors[s]||'var(--muted)') + ';display:inline-block;flex-shrink:0"></span>';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
}

function stableSort(arr, col, dir) {
  return [...arr].sort((a, b) => {
    const av = a[col] ?? '', bv = b[col] ?? '';
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function updateSortHeaders(tbodyId, sort) {
  const table = document.getElementById(tbodyId)?.closest('table');
  if (!table) return;
  table.querySelectorAll('th').forEach(th => {
    const col = th.dataset?.col;
    th.classList.toggle('sorted', col === sort.col);
    const icon = th.querySelector('.sort-icon');
    if (icon && col === sort.col) icon.textContent = sort.dir === 'asc' ? '↑' : '↓';
    else if (icon) icon.textContent = '↕';
  });
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

// ── Init ─────────────────────────────────────────────────────────
loadOverview();
</script>
</body>
</html>`;
}
