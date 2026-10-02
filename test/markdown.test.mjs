import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const Markdown = createRequire(import.meta.url)('../src/web/markdown.cjs')
const types = nodes => nodes.map(node => node.type)

test('blocks: headings, paragraphs, rules, fenced code', () => {
  const tree = Markdown.parse('# Title\n\nline one\nline two\n\n---\n\n```js\nconst a = 1\n\n# not a heading\n```\n')
  assert.deepEqual(types(tree), ['heading', 'p', 'rule', 'code'])
  assert.equal(tree[0].level, 1)
  assert.deepEqual(types(tree[1].children), ['text', 'br', 'text'])
  assert.equal(tree[3].lang, 'js')
  assert.equal(tree[3].text, 'const a = 1\n\n# not a heading')
})

test('an unclosed fence runs to the end instead of swallowing nothing', () => {
  const tree = Markdown.parse('```\nopen\nstill code')
  assert.deepEqual(types(tree), ['code'])
  assert.equal(tree[0].text, 'open\nstill code')
})

test('lists: nesting, ordered start, task items', () => {
  const tree = Markdown.parse('- a\n  - b\n- [x] done\n- [ ] todo\n\n3. three\n4. four')
  assert.equal(tree[0].type, 'list')
  assert.equal(tree[0].items.length, 3)
  assert.equal(tree[0].items[0].children.at(-1).type, 'list')
  assert.equal(tree[0].items[1].checked, true)
  assert.equal(tree[0].items[2].checked, false)
  assert.equal(tree[1].ordered, true)
  assert.equal(tree[1].start, 3)
})

test('quotes and tables', () => {
  const tree = Markdown.parse('> quoted **text**\n> more\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |')
  assert.equal(tree[0].type, 'quote')
  assert.equal(tree[1].type, 'table')
  assert.deepEqual(tree[1].align, ['left', 'right'])
  assert.equal(tree[1].rows.length, 2)
})

test('inline: code, emphasis, strike, links, autolinks', () => {
  const nodes = Markdown.inline('`x*y` **bold** *em* ~~del~~ [t](https://a.b/c_d) https://e.f/g.')
  assert.deepEqual(types(nodes).filter(type => type !== 'text'), ['code', 'strong', 'em', 'del', 'link', 'link'])
  assert.equal(nodes[0].text, 'x*y')
  assert.equal(nodes.at(-2).url, 'https://e.f/g')
})

test('underscores inside words and unmatched markers stay literal', () => {
  const nodes = Markdown.inline('snake_case_name and 2 * 3 * 4 and **open')
  assert.deepEqual(types(nodes), ['text'])
})

test('only http, https and mailto links are live', () => {
  assert.equal(Markdown.safeUrl('https://x.y'), 'https://x.y')
  assert.equal(Markdown.safeUrl('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(Markdown.safeUrl('javascript:alert(1)'), null)
  assert.equal(Markdown.safeUrl('data:text/html,<script>'), null)
  assert.equal(Markdown.safeUrl('/relative'), null)
})

test('raw HTML stays text and parsing never throws on odd input', () => {
  const nodes = Markdown.parse('<script>alert(1)</script>\n\n[a](\n\n![x](y\n\n- \n\n|\n\n`')
  assert.ok(nodes.length > 0)
  assert.equal(nodes[0].children[0].text, '<script>alert(1)</script>')
  const deep = Markdown.parse('> '.repeat(200) + 'x')
  assert.ok(Array.isArray(deep))
})
