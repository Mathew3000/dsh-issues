import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

/** Run client.js against a stub loader and a stub slot registry, like the harness does in the browser. */
function load() {
  const registered = []
  let module
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useRef: () => ({ current: null }), useEffect: () => undefined }
  const sandbox = { window: { __ModuleLoader__: { load: entry => { module = entry } } } }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  const exported = module.factory(name => { assert.equal(name, 'react'); return React })
  const ctx = { slots: { inject: (_name, fn) => fn(), register: (options, component) => { registered.push({ options, component }) } } }
  exported.apply(ctx)
  return { module, exported, registered }
}

test('the client registers a sidebar entry below Plugins and Automation tasks and a page for it', () => {
  const { module, exported, registered } = load()
  assert.equal(module.id, 'dsh-issues')
  assert.deepEqual([...exported.inject], ['slots'])
  const entry = registered.find(item => item.options.name === 'sidebar.panellist')
  const page = registered.find(item => item.options.name === 'main')
  assert.equal(entry.options.id, 'dsh-issues')
  assert.equal(entry.options.label, 'Issues')
  assert.ok(entry.options.order > 10, 'after Plugins (0) and Automation tasks (10)')
  assert.equal(page.options.key, entry.options.id, 'the entry opens the page with the same id')
  assert.equal(registered.length, 2)
})

test('the page embeds the same-origin tracker in embed mode, the icon takes the requested size', () => {
  const { registered } = load()
  const page = registered.find(item => item.options.name === 'main').component()
  const frame = page.children[0]
  assert.equal(frame.type, 'iframe')
  assert.equal(frame.props.src, '/dsh-issues/?embed=1')
  const icon = registered.find(item => item.options.name === 'sidebar.panellist').component({ size: 18 })
  assert.equal(icon.props.width, 18)
})
