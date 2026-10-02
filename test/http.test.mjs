import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createHandler } from '../src/http.mjs'
import { IssueStore } from '../src/store.mjs'

function memoryTable() {
  const rows = new Map()
  return { entries: () => rows.entries(), put: async (key, value) => { rows.set(key, value) } }
}

function setup({ admit = () => ({ peer: {} }) } = {}) {
  const store = new IssueStore({ table: memoryTable() })
  const cancelled = []
  const dispatcher = {
    ticks: 0,
    async tick() { this.ticks += 1 },
    async cancel(id) { cancelled.push(id); return store.transition(id, 'cancelled', { author: 'user' }) },
  }
  const handle = createHandler({ store, dispatcher, projects: () => ['/work/app'], connection: { admit } })
  async function call(method, url, body, headers = {}) {
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = Object.assign(Readable.from(raw), {
      method, url, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    })
    const res = { headers: {}, status: 0, body: '', headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      end(chunk) { this.body += chunk ?? '' } }
    await handle(req, res)
    return { ...res, json: () => JSON.parse(res.body) }
  }
  return { store, dispatcher, call, cancelled }
}

test('rejected connections get the harness status and nothing else', async () => {
  const { call } = setup({ admit: () => ({ rejection: 403 }) })
  assert.equal((await call('GET', '/dsh-issues/')).status, 403)
  assert.equal((await call('GET', '/dsh-issues/api/issues')).status, 403)
})

test('the page is served with a nonce based CSP', async () => {
  const { call } = setup()
  assert.equal((await call('GET', '/dsh-issues')).status, 308)
  const page = await call('GET', '/dsh-issues/')
  assert.equal(page.status, 200)
  const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(page.headers['content-security-policy'])[1]
  assert.ok(page.body.includes(`nonce="${nonce}"`))
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
})

test('issues can be created, listed, edited, commented and cancelled', async () => {
  const { call, cancelled, dispatcher } = setup()
  const created = await call('POST', '/dsh-issues/api/issues', { project: '/work/app', title: 'Crash', description: 'steps', labels: ['a', 'b'] })
  assert.equal(created.status, 201)
  const id = created.json().issue.id
  const list = (await call('GET', '/dsh-issues/api/issues?status=open')).json()
  assert.equal(list.issues.length, 1)
  assert.equal(list.counts.open, 1)
  const patched = await call('PATCH', `/dsh-issues/api/issues/${id}`, { priority: 'high', comment: 'soon' })
  assert.equal(patched.json().issue.priority, 'high')
  assert.equal(patched.json().issue.comments.at(-1).author, 'user')
  assert.equal((await call('POST', `/dsh-issues/api/issues/${id}/comments`, { text: 'more' })).status, 201)
  assert.equal((await call('POST', '/dsh-issues/api/dispatch', {})).status, 200)
  assert.equal(dispatcher.ticks, 1)
  const done = await call('PATCH', `/dsh-issues/api/issues/${id}`, { status: 'cancelled' })
  assert.equal(done.json().issue.status, 'cancelled')
  assert.deepEqual(cancelled, [id])
  const projects = (await call('GET', '/dsh-issues/api/projects')).json()
  assert.deepEqual(projects.projects, ['/work/app'])
})

test('errors map to status codes and bad input is refused', async () => {
  const { call } = setup()
  assert.equal((await call('GET', '/dsh-issues/api/issues/ISS-9')).status, 404)
  assert.equal((await call('POST', '/dsh-issues/api/issues', { project: '/elsewhere', title: 'x' })).status, 400)
  assert.equal((await call('POST', '/dsh-issues/api/issues', { project: '/work/app', title: '' })).status, 400)
  assert.equal((await call('POST', '/dsh-issues/api/issues', '{nope')).status, 400)
  assert.equal((await call('POST', '/dsh-issues/api/issues', '[]')).status, 400)
  const noType = await call('POST', '/dsh-issues/api/issues', '{}', { 'content-type': 'text/plain' })
  assert.equal(noType.status, 400)
  assert.equal((await call('GET', '/dsh-issues/api/issues?status=bogus')).status, 400)
  const { call: c2 } = setup()
  const made = (await c2('POST', '/dsh-issues/api/issues', { project: '/work/app', title: 't' })).json().issue.id
  assert.equal((await c2('PATCH', `/dsh-issues/api/issues/${made}`, { status: 'blocked' })).status, 400)
  assert.equal((await c2('GET', '/dsh-issues/nowhere')).status, 404)
})
