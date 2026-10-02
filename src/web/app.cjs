/* Issue tracker page. DOM is built with createElement/textContent only; issue text is shown through Markdown.render. */
(function () {
  var BASE = location.pathname.replace(/\/+$/, '');
  var STATUSES = ['open', 'in_progress', 'blocked', 'needs_review', 'done', 'cancelled'];
  var LABEL = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', needs_review: 'Needs review', done: 'Done', cancelled: 'Cancelled' };
  var state = { projects: [], issues: [], project: '', status: '', selected: null, drafts: {}, detailStamp: '' };
  var $ = function (sel) { return document.querySelector(sel); };

  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === false || value === null) return;
      if (key === 'class') el.className = value;
      else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    });
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  function append(el, children) {
    children.forEach(function (child) {
      if (Array.isArray(child)) return append(el, child);
      if (child === null || child === undefined || child === false) return;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return el;
  }
  function replace(el) { el.replaceChildren(); return append(el, Array.prototype.slice.call(arguments, 1)); }

  function api(path, method, body) {
    return fetch(BASE + '/api' + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  var toastTimer;
  function say(message, kind) {
    var box = $('#msg');
    box.textContent = message || '';
    box.className = 'err' + (kind === 'ok' ? ' toast' : '');
    box.hidden = !message;
    clearTimeout(toastTimer);
    if (message) toastTimer = setTimeout(function () { box.hidden = true; }, kind === 'ok' ? 2500 : 8000);
  }
  function fail(error) { say(error ? String(error.message || error) : ''); }

  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 14) return Math.floor(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }
  function abs(iso) { return new Date(iso).toLocaleString(); }
  function projectTitle(path) {
    var known = state.projects.filter(function (p) { return p.path === path; })[0];
    return known ? known.title : String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  }
  function badge(status) { return h('span', { class: 'badge s-' + status }, LABEL[status] || status); }
  function current() { return state.issues.filter(function (i) { return i.id === state.selected; })[0]; }

  /* ---------- markdown editor with Write / Preview ---------- */
  function mdEditor(options) {
    var area = h('textarea', { placeholder: options.placeholder || '', 'aria-label': options.label || 'Text', rows: options.rows || 10, spellcheck: 'true' });
    area.value = options.value || '';
    var preview = h('div', { class: 'preview md', hidden: true });
    var write = h('button', { type: 'button', class: 'tab on' }, 'Write');
    var view = h('button', { type: 'button', class: 'tab' }, 'Preview');
    var box = h('div', { class: 'editor' },
      h('div', { class: 'tabs' }, write, view, h('span', { class: 'hint' }, 'Markdown supported')), area, preview);
    if (options.minHeight) box.style.setProperty('--rows', options.minHeight + 'px');
    function show(previewing) {
      write.className = 'tab' + (previewing ? '' : ' on');
      view.className = 'tab' + (previewing ? ' on' : '');
      area.hidden = previewing; preview.hidden = !previewing;
      if (previewing) {
        if (area.value.trim()) { Markdown.render(document, preview, area.value); preview.className = 'preview md'; }
        else { preview.replaceChildren(document.createTextNode('Nothing to preview')); preview.className = 'preview none'; }
      } else area.focus();
    }
    write.addEventListener('click', function () { show(false); });
    view.addEventListener('click', function () { show(true); });
    if (options.oninput) area.addEventListener('input', function () { options.oninput(area.value); });
    return { el: box, area: area, value: function () { return area.value; }, reset: function () { area.value = ''; show(false); } };
  }

  /* ---------- new / edit dialog ---------- */
  function openEditor(issue) {
    var dialog = $('#editor');
    var editing = issue !== undefined;
    var title = h('input', { type: 'text', class: 'title-input', placeholder: 'Short summary', maxlength: '200', required: true, 'aria-label': 'Title', value: editing ? issue.title : '' });
    var description = mdEditor({
      label: 'Description', rows: 12, minHeight: 280, value: editing ? issue.description : '',
      placeholder: 'What is wrong or wanted? How can it be reproduced? What does done look like?\n\nMarkdown works: **bold**, `code`, lists, ``` code blocks ```, links.'
    });
    var priority = h('select', { 'aria-label': 'Priority' }, ['low', 'normal', 'high'].map(function (p) {
      var o = h('option', { value: p }, p.charAt(0).toUpperCase() + p.slice(1)); if (p === (editing ? issue.priority : 'normal')) o.selected = true; return o;
    }));
    var labels = h('input', { type: 'text', placeholder: 'bug, ui, ...', 'aria-label': 'Labels', value: editing ? (issue.labels || []).join(', ') : '' });

    var projectField = null, projectSelect = null, pathInput = null;
    if (!editing) {
      projectSelect = h('select', { 'aria-label': 'Project' });
      state.projects.forEach(function (p) { projectSelect.append(h('option', { value: p.path }, p.title + '  —  ' + p.path)); });
      projectSelect.append(h('option', { value: '' }, 'Another folder…'));
      pathInput = h('input', { type: 'text', placeholder: 'Absolute path of the project folder', 'aria-label': 'Project folder' });
      var preferred = state.project || (state.projects[0] && state.projects[0].path) || '';
      projectSelect.value = preferred;
      var syncPath = function () { pathInput.hidden = projectSelect.value !== ''; };
      projectSelect.addEventListener('change', syncPath); syncPath();
      projectField = h('div', { class: 'field' }, h('label', {}, 'Project'), projectSelect, pathInput);
    }

    var submit = h('button', { type: 'submit', class: 'primary' }, editing ? 'Save changes' : 'Create issue');
    var form = h('form', { method: 'dialog', novalidate: true },
      h('div', { class: 'dlg-head' }, editing ? 'Edit ' + issue.id : 'New issue'),
      h('div', { class: 'dlg-body' },
        projectField,
        h('div', { class: 'field' }, h('label', {}, 'Title'), title),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Description', h('span', { class: 'sub' }, 'what the agent will work from')), description.el),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, 'Priority'), priority),
          h('div', { class: 'field' }, h('label', {}, 'Labels', h('span', { class: 'sub' }, 'comma-separated')), labels))),
      h('div', { class: 'dlg-foot' },
        h('span', { class: 'hint' }, 'Ctrl/Cmd + Enter to ' + (editing ? 'save' : 'create')),
        h('button', { type: 'button', onclick: function () { dialog.close(); } }, 'Cancel'),
        submit));

    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!title.value.trim()) { title.focus(); say('A title is required.'); return; }
      submit.disabled = true;
      var request = editing
        ? api('/issues/' + issue.id, 'PATCH', { title: title.value, description: description.value(), priority: priority.value, labels: labels.value })
        : api('/issues', 'POST', {
          project: projectSelect.value || pathInput.value.trim(), title: title.value,
          description: description.value(), priority: priority.value, labels: labels.value
        });
      request.then(function (data) {
        say(editing ? 'Saved ' + data.issue.id : 'Created ' + data.issue.id, 'ok');
        dialog.close();
        state.status = ''; // make sure the new issue is visible
        return refresh().then(function () { select(data.issue.id); });
      }).catch(function (error) { submit.disabled = false; fail(error); });
    });

    replace(dialog, form);
    dialog.showModal();
    (editing ? description.area : title).focus();
  }

  /* ---------- list ---------- */
  function visibleIssues() {
    return state.issues.filter(function (i) { return !state.status || i.status === state.status; });
  }
  function renderChips() {
    var counts = {};
    state.issues.forEach(function (i) { counts[i.status] = (counts[i.status] || 0) + 1; });
    var chips = [h('button', { type: 'button', class: 'chip' + (state.status ? '' : ' on'), onclick: function () { setStatus(''); } }, 'All', h('b', {}, state.issues.length))];
    STATUSES.forEach(function (s) {
      if (!counts[s] && state.status !== s) return;
      chips.push(h('button', { type: 'button', class: 'chip' + (state.status === s ? ' on' : ''), onclick: function () { setStatus(s); } }, LABEL[s], h('b', {}, counts[s] || 0)));
    });
    replace($('#chips'), chips);
  }
  function renderList() {
    renderChips();
    var items = visibleIssues();
    var list = $('#list');
    if (!items.length) {
      replace(list, h('div', { class: 'empty' },
        h('p', {}, state.issues.length ? 'No issues with this status.' : 'No issues yet.'),
        state.issues.length ? null : h('button', { type: 'button', class: 'primary', onclick: function () { openEditor(); } }, 'Create the first issue')));
      return;
    }
    replace(list, items.map(function (issue) {
      return h('button', { type: 'button', class: 'row' + (issue.id === state.selected ? ' sel' : ''), onclick: function () { select(issue.id); } },
        h('div', { class: 't' }, h('span', { class: 'id' }, issue.id), h('span', {}, issue.title)),
        h('div', { class: 'm' }, badge(issue.status),
          issue.priority === 'high' ? h('span', { class: 'prio-high' }, 'High') : null,
          state.project ? null : h('span', {}, projectTitle(issue.project)),
          h('span', { title: abs(issue.updatedAt) }, ago(issue.updatedAt))));
    }));
  }

  /* ---------- detail ---------- */
  function fact(label, value) { return [h('span', {}, label), h('code', {}, value)]; }

  function renderDetail() {
    var box = $('#detail');
    var issue = current();
    if (!issue) {
      replace(box, h('div', { class: 'empty' }, h('p', {}, state.issues.length ? 'Select an issue from the list.' : 'Create an issue and agents will pick it up.'),
        h('button', { type: 'button', class: 'primary', onclick: function () { openEditor(); } }, 'New issue')));
      return;
    }
    var draftBefore = $('#comment-text') ? $('#comment-text').value : state.drafts[issue.id];
    var act = function (status) { return api('/issues/' + issue.id, 'PATCH', { status: status }).then(function () { return refresh(); }).catch(fail); };
    var buttons = [];
    if (issue.status === 'needs_review') buttons.push(h('button', { class: 'primary', onclick: function () { act('done'); } }, 'Accept as done'));
    if (['blocked', 'needs_review', 'done', 'cancelled'].indexOf(issue.status) >= 0) buttons.push(h('button', { class: issue.status === 'needs_review' ? '' : 'primary', onclick: function () { act('open'); } }, 'Reopen'));
    buttons.push(h('button', { onclick: function () { openEditor(issue); } }, 'Edit'));
    if (['open', 'in_progress', 'blocked', 'needs_review'].indexOf(issue.status) >= 0) buttons.push(h('button', { class: 'danger', onclick: function () { act('cancelled'); } }, 'Cancel issue'));

    var description = h('div', { class: 'card md' });
    if (issue.description && issue.description.trim()) Markdown.render(document, description, issue.description);
    else { description.className = 'card muted'; description.textContent = 'No description.'; }

    var work = [];
    if (issue.branch) work.push(fact('Branch', issue.branch));
    if (issue.worktreePath) work.push(fact('Worktree', issue.worktreePath));
    if (issue.sessionId) work.push(fact('Session', issue.sessionId));
    if (issue.attempts) work.push(fact('Attempts', String(issue.attempts)));

    var draft = mdEditor({
      label: 'Comment', rows: 5, minHeight: 110, value: draftBefore || '', placeholder: 'Leave a comment (Markdown supported)',
      oninput: function (value) { state.drafts[issue.id] = value; }
    });
    draft.area.id = 'comment-text';
    var post = h('button', { class: 'primary', type: 'button', onclick: send }, 'Comment');
    function send() {
      if (!draft.value().trim()) return;
      post.disabled = true;
      api('/issues/' + issue.id + '/comments', 'POST', { text: draft.value() }).then(function () {
        delete state.drafts[issue.id]; draft.reset(); return refresh();
      }).catch(function (e) { post.disabled = false; fail(e); });
    }
    draft.area.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

    replace(box,
      h('div', { class: 'd-head' },
        h('h2', {}, h('span', { class: 'id' }, issue.id), issue.title),
        h('div', { class: 'facts' }, badge(issue.status),
          h('span', {}, 'Priority: ', h('b', { class: issue.priority === 'high' ? 'prio-high' : '' }, issue.priority)),
          h('span', {}, 'Project: ', h('b', { title: issue.project }, projectTitle(issue.project))),
          (issue.labels || []).map(function (l) { return h('span', { class: 'tag' }, l); }),
          h('span', { title: abs(issue.createdAt) }, 'opened ' + ago(issue.createdAt)))),
      h('div', { class: 'actions' }, buttons),
      issue.blockedReason ? h('div', { class: 'banner' }, h('b', {}, 'Blocked: '), issue.blockedReason.message, ' ', h('code', {}, issue.blockedReason.code)) : null,
      description,
      work.length ? h('div', { class: 'work' }, work) : null,
      h('h3', { class: 'sec' }, 'Activity'),
      (issue.comments || []).length ? issue.comments.map(function (c) {
        var who = c.author === 'user' ? 'You' : c.author === 'agent' ? 'Agent' : 'Tracker';
        var body = h('div', { class: 'md' });
        Markdown.render(document, body, c.text);
        return h('div', { class: 'comment ' + c.author },
          h('div', { class: 'avatar' }, who.charAt(0)),
          h('div', { class: 'box' }, h('div', { class: 'who' }, h('b', {}, who), ' · ', h('span', { title: abs(c.at) }, ago(c.at))), body));
      }) : h('div', { class: 'card muted' }, 'No activity yet.'),
      h('div', { class: 'composer' }, draft.el, h('div', { class: 'actions' }, post)));
  }

  /* ---------- data ---------- */
  function select(id) {
    state.selected = id; state.detailStamp = '';
    if (history.replaceState) history.replaceState(null, '', BASE + '/' + (id ? '#' + id : ''));
    renderList(); renderDetail();
  }
  function setStatus(status) { state.status = status; renderList(); }
  function stamp() { var i = current(); return i ? i.id + i.updatedAt : ''; }

  function refresh() {
    var query = state.project ? '?project=' + encodeURIComponent(state.project) : '';
    return api('/issues' + query).then(function (data) {
      state.issues = data.issues;
      if (state.selected && !current()) state.selected = null;
      renderList();
      if (stamp() !== state.detailStamp) { state.detailStamp = stamp(); renderDetail(); }
      fail();
    }).catch(fail);
  }

  function init() {
    $('#f-project').addEventListener('change', function (e) { state.project = e.target.value; state.selected = null; refresh(); renderDetail(); });
    $('#new-issue').addEventListener('click', function () { openEditor(); });
    $('#run-queue').addEventListener('click', function () { api('/dispatch', 'POST', {}).then(function () { say('Started waiting issues.', 'ok'); return refresh(); }).catch(fail); });
    $('#editor').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('#editor').addEventListener('close', function () { $('#editor').replaceChildren(); });
    document.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '');
      if (e.key === 'n' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !$('#editor').open) { e.preventDefault(); openEditor(); }
    });
    state.selected = /^#(ISS-\d+)$/i.test(location.hash) ? location.hash.slice(1).toUpperCase() : null;
    api('/projects').then(function (data) {
      state.projects = data.projects;
      var select = $('#f-project');
      select.replaceChildren(h('option', { value: '' }, 'All projects'));
      state.projects.forEach(function (p) { select.append(h('option', { value: p.path }, p.title)); });
    }).catch(fail).then(function () { return refresh(); }).then(function () { if (!current()) renderDetail(); });
    setInterval(function () {
      if (document.hidden || $('#editor').open) return;
      refresh();
    }, 5000);
  }
  init();
})();
