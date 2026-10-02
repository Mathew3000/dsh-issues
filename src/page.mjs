/** Single-page UI served by the HTTP plugin. All dynamic text is inserted with textContent. */

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1b1f24; --muted:#667085; --line:#d9dee5; --card:#f6f8fa; --accent:#2563eb; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1318; --fg:#e6e9ee; --muted:#9aa4b2; --line:#2a313b; --card:#171c23; --accent:#6ea0ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
header h1 { font-size:16px; margin:0 12px 0 0; }
main { display:grid; grid-template-columns:minmax(280px,420px) 1fr; min-height:calc(100vh - 57px); }
@media (max-width: 800px) { main { grid-template-columns:1fr; } }
#list { border-right:1px solid var(--line); overflow:auto; }
.row { padding:10px 16px; border-bottom:1px solid var(--line); cursor:pointer; }
.row:hover, .row.sel { background:var(--card); }
.row .t { font-weight:600; }
.meta { color:var(--muted); font-size:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.badge { border:1px solid var(--line); border-radius:999px; padding:0 8px; font-size:12px; }
.s-in_progress { color:var(--accent); border-color:var(--accent); }
.s-needs_review { color:var(--warn); border-color:var(--warn); }
.s-done { color:var(--ok); border-color:var(--ok); }
.s-blocked { color:var(--bad); border-color:var(--bad); }
#detail { padding:16px 20px; overflow:auto; }
#detail h2 { margin:0 0 6px; font-size:18px; }
pre { white-space:pre-wrap; word-break:break-word; background:var(--card); border:1px solid var(--line); border-radius:6px; padding:10px; margin:8px 0; font:13px/1.45 ui-monospace, monospace; }
.comment { border-left:3px solid var(--line); padding:2px 10px; margin:10px 0; }
.comment.agent { border-color:var(--accent); }
.comment .meta { margin-bottom:2px; }
button, select, input, textarea { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:5px 10px; }
button { cursor:pointer; background:var(--card); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
textarea { width:100%; min-height:90px; }
input[type=text] { width:100%; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; }
form.new { padding:12px 16px; border-bottom:1px solid var(--line); display:grid; gap:8px; background:var(--card); }
.hint { color:var(--muted); padding:16px; }
.err { color:var(--bad); padding:6px 16px; }
`

const SCRIPT = `
'use strict';
var BASE = location.pathname.replace(/\\/+$/, '');
var STATUSES = ['open','in_progress','blocked','needs_review','done','cancelled'];
var state = { projects: [], issues: [], counts: {}, selected: null, detail: null, project: '', status: '' };
var $ = function (sel) { return document.querySelector(sel); };

function h(tag, props) {
  var el = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    var value = props[key];
    if (key === 'class') el.className = value;
    else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) el.setAttribute(key, value === true ? '' : value);
  });
  Array.prototype.slice.call(arguments, 2).forEach(function add(child) {
    if (Array.isArray(child)) return child.forEach(add);
    if (child === null || child === undefined) return;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

function api(path, method, body) {
  return fetch(BASE + '/api' + path, {
    method: method || 'GET',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    });
  });
}

function fail(error) { $('#err').textContent = error ? String(error.message || error) : ''; }
function when(iso) { return new Date(iso).toLocaleString(); }
function short(p) { return p.split(/[\\\\/]/).filter(Boolean).slice(-2).join('/'); }
function badge(status) { return h('span', { class: 'badge s-' + status }, status.replace('_', ' ')); }

function loadList() {
  var query = [];
  if (state.project) query.push('project=' + encodeURIComponent(state.project));
  if (state.status) query.push('status=' + encodeURIComponent(state.status));
  return api('/issues' + (query.length ? '?' + query.join('&') : '')).then(function (data) {
    state.issues = data.issues; state.counts = data.counts; renderList(); fail();
  }).catch(fail);
}

function loadDetail(id) {
  return api('/issues/' + id).then(function (data) {
    var changed = !state.detail || state.detail.id !== data.issue.id || state.detail.updatedAt !== data.issue.updatedAt;
    state.detail = data.issue;
    if (changed) renderDetail();
  }).catch(fail);
}

function renderList() {
  var list = $('#list-items');
  list.replaceChildren();
  if (!state.issues.length) list.append(h('div', { class: 'hint' }, 'No issues.'));
  state.issues.forEach(function (issue) {
    list.append(h('div', { class: 'row' + (issue.id === state.selected ? ' sel' : ''), onclick: function () { select(issue.id); } },
      h('div', { class: 't' }, issue.id + '  ' + issue.title),
      h('div', { class: 'meta' }, badge(issue.status), issue.priority, short(issue.project), when(issue.updatedAt))));
  });
  $('#counts').textContent = STATUSES.map(function (s) { return s.replace('_', ' ') + ' ' + (state.counts[s] || 0); }).join(' · ');
}

function select(id) {
  state.selected = id; state.detail = null; renderList(); loadDetail(id);
}

function act(id, request) {
  return api('/issues/' + id, 'PATCH', request).then(function (data) { state.detail = data.issue; renderDetail(); return loadList(); }).catch(fail);
}

function renderDetail() {
  var box = $('#detail');
  var issue = state.detail;
  box.replaceChildren();
  if (!issue) { box.append(h('div', { class: 'hint' }, 'Select an issue or create a new one.')); return; }
  var buttons = [];
  var move = function (label, status, primary) {
    buttons.push(h('button', { class: primary ? 'primary' : '', onclick: function () { act(issue.id, { status: status }); } }, label));
  };
  if (issue.status === 'needs_review') move('Accept (done)', 'done', true);
  if (['blocked', 'needs_review', 'done', 'cancelled'].indexOf(issue.status) >= 0) move('Reopen', 'open', issue.status !== 'needs_review');
  if (['open', 'in_progress', 'blocked', 'needs_review'].indexOf(issue.status) >= 0) move('Cancel', 'cancelled');
  buttons.push(h('button', { onclick: function () { edit(issue); } }, 'Edit'));
  buttons.push(h('button', { onclick: function () { api('/dispatch', 'POST', {}).then(loadList).catch(fail); } }, 'Start waiting issues now'));

  var commentBox = h('textarea', { placeholder: 'Add a comment' });
  box.append(
    h('h2', {}, issue.id + '  ' + issue.title),
    h('div', { class: 'meta' }, badge(issue.status), 'priority ' + issue.priority, short(issue.project), (issue.labels || []).join(', ')),
    issue.blockedReason ? h('div', { class: 'err' }, issue.blockedReason.code + ': ' + issue.blockedReason.message) : null,
    h('pre', {}, issue.description || '(no description)'),
    h('div', { class: 'meta' },
      issue.branch ? 'branch ' + issue.branch : null,
      issue.worktreePath ? 'worktree ' + issue.worktreePath : null,
      issue.sessionId ? 'session ' + issue.sessionId : null),
    h('div', { class: 'actions' }, buttons),
    h('h3', {}, 'Activity'),
    issue.comments.map(function (c) {
      return h('div', { class: 'comment ' + c.author }, h('div', { class: 'meta' }, c.author, when(c.at)), h('div', {}, c.text));
    }),
    commentBox,
    h('div', { class: 'actions' }, h('button', { onclick: function () {
      if (!commentBox.value.trim()) return;
      api('/issues/' + issue.id + '/comments', 'POST', { text: commentBox.value }).then(function (data) { state.detail = data.issue; renderDetail(); }).catch(fail);
    } }, 'Comment')));
}

function edit(issue) {
  var title = h('input', { type: 'text', value: issue.title });
  var description = h('textarea', {}); description.value = issue.description;
  var priority = h('select', {}, ['low', 'normal', 'high'].map(function (p) { return h('option', { value: p, selected: p === issue.priority }, p); }));
  var labels = h('input', { type: 'text', value: (issue.labels || []).join(', ') });
  $('#detail').replaceChildren(h('h2', {}, 'Edit ' + issue.id), title, description, priority, labels,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: function () { act(issue.id, { title: title.value, description: description.value, priority: priority.value, labels: labels.value }); } }, 'Save'),
      h('button', { onclick: renderDetail }, 'Cancel')));
}

function renderControls() {
  var project = $('#f-project'); project.replaceChildren(h('option', { value: '' }, 'All projects'));
  state.projects.forEach(function (p) { project.append(h('option', { value: p.path }, p.title)); });
  project.value = state.project;
  var form = $('#new-project'); form.replaceChildren();
  state.projects.forEach(function (p) { form.append(h('option', { value: p.path }, p.title + '  (' + p.path + ')')); });
  form.append(h('option', { value: '' }, 'Other path...'));
}

function init() {
  $('#f-project').addEventListener('change', function (e) { state.project = e.target.value; loadList(); });
  $('#f-status').addEventListener('change', function (e) { state.status = e.target.value; loadList(); });
  $('#new-toggle').addEventListener('click', function () { $('#new-form').hidden = !$('#new-form').hidden; });
  $('#new-project').addEventListener('change', function (e) { $('#new-path').hidden = e.target.value !== ''; });
  $('#new-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var chosen = $('#new-project').value;
    api('/issues', 'POST', {
      project: chosen || $('#new-path').value,
      title: $('#new-title').value,
      description: $('#new-description').value,
      priority: $('#new-priority').value,
      labels: $('#new-labels').value
    }).then(function (data) {
      $('#new-form').reset(); $('#new-form').hidden = true;
      return loadList().then(function () { select(data.issue.id); });
    }).catch(fail);
  });
  api('/projects').then(function (data) {
    state.projects = data.projects; renderControls();
    $('#new-path').hidden = state.projects.length > 0;
  }).catch(fail);
  loadList();
  renderDetail();
  setInterval(function () {
    if (document.hidden) return;
    loadList();
    if (state.selected) loadDetail(state.selected);
  }, 5000);
}
init();
`

/**
 * @param {string} nonce per-response CSP nonce
 * @returns {string} HTML document
 */
export function renderPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issues</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
  <h1>Issues</h1>
  <select id="f-project" aria-label="Project"></select>
  <select id="f-status" aria-label="Status">
    <option value="">All statuses</option>
    <option value="open">open</option>
    <option value="in_progress">in progress</option>
    <option value="blocked">blocked</option>
    <option value="needs_review">needs review</option>
    <option value="done">done</option>
    <option value="cancelled">cancelled</option>
  </select>
  <button id="new-toggle" class="primary" type="button">New issue</button>
  <span id="counts" class="meta"></span>
</header>
<div id="err" class="err"></div>
<main>
  <section id="list">
    <form id="new-form" class="new" hidden>
      <select id="new-project" aria-label="Project"></select>
      <input id="new-path" type="text" placeholder="Absolute path of the project folder" hidden>
      <input id="new-title" type="text" placeholder="Title" required maxlength="200">
      <textarea id="new-description" placeholder="Description: what is wrong or wanted, how to reproduce it, what done looks like"></textarea>
      <select id="new-priority" aria-label="Priority"><option>normal</option><option>high</option><option>low</option></select>
      <input id="new-labels" type="text" placeholder="Labels, comma-separated">
      <button class="primary" type="submit">Create issue</button>
    </form>
    <div id="list-items"></div>
  </section>
  <section id="detail"></section>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
}
