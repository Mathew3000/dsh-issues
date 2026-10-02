// Browser half of dsh-issues: an "Issues" entry in the harness sidebar (below Plugins and
// Automation tasks) that opens the tracker inside the harness window, in the harness theme.
window.__ModuleLoader__.load({
  id: 'dsh-issues',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-issues';
    const PAGE = '/dsh-issues/?embed=1';
    // Theme tokens the page needs. The harness defines them on <body> and switches them with
    // its light/dark setting; they are copied into the page's document as resolved values.
    const TOKENS = [
      'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3',
      'label-primary', 'label-secondary', 'label-tertiary', 'label-dimmed', 'label-primary-foreground',
      'border-l2', 'border-l3', 'border-l4',
      'interactive-bg-hover', 'interactive-bg-active',
      'state-business-primary', 'state-success-primary', 'state-error-primary', 'state-warn-primary',
      'button-primary-fill', 'button-primary-hover', 'markdown-code-block', 'link',
    ].map(name => '--dsw-alias-' + name);
    const EXTRAS = ['--dsw-font-family', '--ds-font-family-code', '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg'];

    /** Copy the harness theme into the embedded page. Same origin, so its document is reachable. */
    function syncTheme(frame) {
      let doc;
      try { doc = frame && frame.contentDocument; } catch (error) { return; }
      if (!doc || !doc.documentElement) return;
      const source = getComputedStyle(document.body);
      const root = doc.documentElement;
      for (const name of TOKENS.concat(EXTRAS)) {
        const value = source.getPropertyValue(name).trim();
        if (value) root.style.setProperty(name, value);
      }
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      root.style.setProperty('color-scheme', dark ? 'dark' : 'light');
    }

    let lastHash = '';

    function IssuesPage() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const sync = () => syncTheme(ref.current);
        const observer = new MutationObserver(sync);
        const options = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] };
        observer.observe(document.body, options);
        observer.observe(document.documentElement, options);
        const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
        if (media && media.addEventListener) media.addEventListener('change', sync);
        return () => {
          observer.disconnect();
          if (media && media.removeEventListener) media.removeEventListener('change', sync);
        };
      }, []);
      const onLoad = () => {
        const frame = ref.current;
        syncTheme(frame);
        try {
          // Remember the open issue (#ISS-n) so coming back to the page shows it again.
          // The page changes its address with replaceState, which raises no event, so wrap it.
          const win = frame.contentWindow;
          const replace = win.history.replaceState.bind(win.history);
          win.history.replaceState = function () { replace.apply(null, arguments); lastHash = win.location.hash; };
        } catch (error) { /* not reachable: nothing to remember */ }
      };
      return h('div', { style: { width: '100%', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)' } },
        h('iframe', {
          ref, src: PAGE + lastHash, title: 'Issues', onLoad,
          style: { display: 'block', width: '100%', height: '100%', border: 0, background: 'transparent' },
        }));
    }

    /** Sidebar glyph: the sidebar passes the edge it wants and styles the colour. */
    function IssuesIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('rect', { x: 2.25, y: 2.25, width: 11.5, height: 11.5, rx: 3 }),
      h('path', { d: 'M5.2 8.2l1.8 1.8 3.8-3.8' }));
    }


    // ---- Settings form on the plugin's page (Plugins > dsh-issues) ----
    const FIELDS = [
      { title: 'Agents', items: [
        { key: 'agentPreset', label: 'Agent preset', type: 'text', hint: 'Must exist in your composition.' },
        { key: 'permissionPreset', label: 'Permission preset', type: 'text', hint: 'workspace-write asks for approval outside the sandbox.' },
        { key: 'maxConcurrent', label: 'Max concurrent agents', type: 'number', min: 1, max: 16 },
        { key: 'maxPerProject', label: 'Max agents per project', type: 'number', min: 1, max: 16 },
        { key: 'maxGoalRounds', label: 'Max goal rounds', type: 'number', min: 1, max: 1000 },
        { key: 'maxAttempts', label: 'Max attempts per issue', type: 'number', min: 1, max: 20 },
        { key: 'completeStatus', label: 'Status when an agent finishes', type: 'select', options: ['needs_review', 'done'] },
      ] },
      { title: 'Isolation', items: [
        { key: 'isolation', label: 'Isolation', type: 'select', options: ['auto', 'worktree', 'none'], hint: 'worktree: private clone per issue. none: work in the project folder itself (one at a time).' },
        { key: 'worktreeRoot', label: 'Clone folder', type: 'text', hint: 'Empty: .dsh-worktrees inside the project.' },
        { key: 'baseRef', label: 'Base ref', type: 'text' },
      ] },
      { title: 'Scheduling', items: [
        { key: 'autoStart', label: 'Start open issues automatically', type: 'checkbox' },
        { key: 'resumeOnStart', label: 'Resume interrupted work on start', type: 'checkbox' },
        { key: 'pollSeconds', label: 'Poll interval (seconds, 0 = off)', type: 'number', min: 0, max: 86400 },
      ] },
      { title: 'Merging', items: [
        { key: 'autoMerge', label: 'Auto-merge accepted issues (default for new issues)', type: 'checkbox' },
        { key: 'cleanupAfterMerge', label: 'Remove clones after a merge', type: 'checkbox' },
        { key: 'maxMergeRounds', label: 'Max merge rounds', type: 'number', min: 1, max: 200 },
        { key: 'maxConcurrentMerges', label: 'Max concurrent merges', type: 'number', min: 1, max: 8 },
      ] },
      { title: 'Cleanup', items: [
        { key: 'cleanupOnClose', label: 'Remove clones when an issue is closed', type: 'checkbox' },
        { key: 'forgetWorkspaces', label: 'Forget workspace entries of removed clones', type: 'checkbox' },
      ] },
    ];

    const sx = {
      section: { margin: '0 0 20px' },
      title: { margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 },
      input: { minWidth: 180, padding: '5px 8px', fontSize: 13, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm, 6px)', fontFamily: 'inherit' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 },
    };

    function Field({ field, value, disabled, onSave }) {
      const [draft, setDraft] = React.useState(null);
      React.useEffect(() => { setDraft(null); }, [value]);
      const shown = draft === null ? value : draft;
      const commit = next => { if (next !== value) onSave(field.key, next); };
      let control;
      if (field.type === 'checkbox') {
        control = h('input', { type: 'checkbox', checked: value === true, disabled, onChange: e => commit(e.target.checked) });
      } else if (field.type === 'select') {
        control = h('select', { style: sx.input, value: value === undefined ? '' : value, disabled, onChange: e => commit(e.target.value) },
          field.options.map(option => h('option', { key: option, value: option }, option)));
      } else if (field.type === 'number') {
        control = h('input', {
          type: 'number', style: sx.input, min: field.min, max: field.max, step: 1, disabled,
          value: shown === undefined ? '' : shown,
          onChange: e => setDraft(e.target.value),
          onBlur: () => { if (draft === null || draft === '') return setDraft(null); commit(Number(draft)); },
          onKeyDown: e => { if (e.key === 'Enter') e.target.blur(); },
        });
      } else {
        control = h('input', {
          type: 'text', style: sx.input, disabled, value: shown === undefined ? '' : shown,
          onChange: e => setDraft(e.target.value),
          onBlur: () => { if (draft !== null) commit(draft); },
          onKeyDown: e => { if (e.key === 'Enter') e.target.blur(); },
        });
      }
      return h('label', { style: sx.row },
        h('span', null, h('div', { style: sx.label }, field.label), field.hint ? h('div', { style: sx.hint }, field.hint) : null),
        control);
    }

    function makeSettings(form) {
      return function IssuesSettings() {
        const snap = React.useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot);
        const [error, setError] = React.useState('');
        const save = async (key, value) => {
          setError('');
          try {
            const ok = await form.set(key, value);
            if (!ok) setError('The change for "' + key + '" was not accepted.');
          } catch (err) { setError(String(err && err.message ? err.message : err)); }
        };
        if (snap.status === 'unavailable') return h('p', { style: sx.hint }, 'Settings are not available for this connection.');
        const values = snap.value || {};
        const disabled = snap.status !== 'ready' || !snap.writable;
        return h('div', { 'data-dsh-issues-settings': true },
          FIELDS.map(section => h('section', { key: section.title, style: sx.section },
            h('h4', { style: sx.title }, section.title),
            section.items.map(field => h(Field, { key: field.key, field, value: values[field.key], disabled, onSave: save })))),
          error ? h('div', { style: sx.error, role: 'alert' }, error) : null,
          h('div', { style: sx.hint }, 'Changes apply immediately; work already running keeps the settings it started with.'));
      };
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, IssuesPage));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-issues',
        }, makeSettings(ctx.configForms.get('dsh-issues'))));
        // Order 20: after Plugins (0) and Automation tasks (10).
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Issues',
        }, IssuesIcon));
      },
    };
  },
});
