// Browser half of dsh-issues: an "Issues" link in the session header that opens the tracker page.
window.__ModuleLoader__.load({
  id: 'dsh-issues',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function IssuesLink() {
      return h('a', {
        href: '/dsh-issues/',
        target: '_blank',
        rel: 'noopener',
        title: 'Open the issue tracker',
        'aria-label': 'Open the issue tracker',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px',
          borderRadius: 6, color: 'inherit', textDecoration: 'none', font: 'inherit', fontSize: 13,
        },
      },
      h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2 }),
        h('path', { d: 'M5 6.5l1.2 1.2L8.5 5.4M5 10.5h6', strokeLinecap: 'round', strokeLinejoin: 'round' })),
      'Issues');
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'dsh-issues', order: 0,
        }, IssuesLink));
      },
    };
  },
});
