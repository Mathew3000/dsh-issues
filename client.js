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

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, IssuesPage));
        // Order 20: after Plugins (0) and Automation tasks (10).
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Issues',
        }, IssuesIcon));
      },
    };
  },
});
