import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { IssueError, IssueStore, parseIssueId, projectKey } from '../src/store.mjs'

const PROJECT = path.resolve('/tmp/project-a')

function memoryTable(seed = []) {
  const map = new Map(seed.map(issue => [issue.id, issue]))
  return {
    puts: [],
    entries: () => map.entries(),
    async put(key, value) { this.puts.push(key); map.set(key, value) },
  }
}

function makeStore(table = memoryTable()) {
  let tick = 0
  return { table, store: new IssueStore({ table, now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, tick++)) }) }
}

test('parseIssueId accepts common spellings and rejects junk', () => {
  assert.equal(parseIssueId('12'), 'ISS-12')
  assert.equal(parseIssueId('#12'), 'ISS-12')
  assert.equal(parseIssueId('iss-12'), 'ISS-12')
  assert.throws(() => parseIssueId('abc'), { code: 'invalid-id' })
})

test('create numbers issues, validates input and persists before publishing', async () => {
  const { store, table } = makeStore()
  const seen = []
  store.onChange(event => seen.push(event.type))
  const first = await store.create({ project: PROJECT, title: '  Crash on login  ', description: 'Steps...', priority: 'high', labels: 'bug, auth, bug' })
  const second = await store.create({ project: PROJECT, title: 'Second' })
  assert.equal(first.id, 'ISS-1')
  assert.equal(second.id, 'ISS-2')
  assert.equal(first.title, 'Crash on login')
  assert.deepEqual(first.labels, ['bug', 'auth'])
  assert.equal(first.status, 'open')
  assert.deepEqual(table.puts, ['ISS-1', 'ISS-2'])
  assert.deepEqual(seen, ['created', 'created'])
  await assert.rejects(store.create({ project: 'relative/path', title: 'x' }), { code: 'invalid-input' })
  await assert.rejects(store.create({ project: PROJECT, title: '   ' }), { code: 'invalid-input' })
  await assert.rejects(store.create({ project: PROJECT, title: 'x', priority: 'urgent' }), { code: 'invalid-input' })
  assert.equal((await store.create({ project: PROJECT, title: 'third' })).id, 'ISS-3', 'failed creates do not burn numbers')
})

test('numbering continues after reload', async () => {
  const { table } = makeStore()
  const first = makeStore(table)
  await first.store.create({ project: PROJECT, title: 'one' })
  const reloaded = new IssueStore({ table })
  assert.equal((await reloaded.create({ project: PROJECT, title: 'two' })).id, 'ISS-2')
})

test('results are detached copies', async () => {
  const { store } = makeStore()
  const created = await store.create({ project: PROJECT, title: 'a' })
  created.title = 'mutated'
  assert.equal(store.get('ISS-1').title, 'a')
})

test('queue orders by priority then age; list filters by project and status', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'normal-old' })
  await store.create({ project: PROJECT, title: 'high', priority: 'high' })
  await store.create({ project: PROJECT, title: 'low', priority: 'low' })
  await store.create({ project: path.resolve('/tmp/other'), title: 'elsewhere' })
  await store.create({ project: PROJECT, title: 'normal-new' })
  assert.deepEqual(store.queue().map(issue => issue.title), ['high', 'normal-old', 'elsewhere', 'normal-new', 'low'])
  assert.deepEqual(store.list({ project: PROJECT, limit: 2 }).map(issue => issue.id), ['ISS-5', 'ISS-3'])
  await store.claim('ISS-2')
  assert.equal(store.list({ status: 'in_progress' }).length, 1)
  assert.equal(store.counts().open, 4)
})

test('claim is compare-and-set and counts attempts', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  const [one, two] = await Promise.all([store.claim('ISS-1'), store.claim('ISS-1')])
  assert.equal([one, two].filter(Boolean).length, 1)
  assert.equal(store.get('ISS-1').attempts, 1)
  assert.equal(store.get('ISS-1').status, 'in_progress')
})

test('transitions follow the state machine and clear session data when reopened', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  await store.claim('ISS-1')
  await store.attach('ISS-1', { sessionId: 's1', goalId: 'g1', branch: 'issue/iss-1-a', worktreePath: '/wt' })
  await assert.rejects(store.transition('ISS-1', 'blocked'), { code: 'invalid-input' }, 'blocked needs a reason')
  const review = await store.transition('ISS-1', 'needs_review', { comment: 'all good', author: 'agent' })
  assert.equal(review.status, 'needs_review')
  assert.equal(review.comments.at(-1).author, 'agent')
  await assert.rejects(store.transition('ISS-1', 'blocked', { reason: { code: 'x', message: 'y' } }), { code: 'invalid-transition' })
  const reopened = await store.transition('ISS-1', 'open')
  assert.equal(reopened.sessionId, undefined)
  assert.equal(reopened.goalId, undefined)
  assert.equal(reopened.branch, 'issue/iss-1-a', 'branch and worktree survive for the follow-up run')
  await assert.rejects(store.transition('ISS-1', 'done'), { code: 'invalid-transition' })
  await assert.rejects(store.transition('ISS-1', 'open', { from: 'done' }), { code: 'conflict' })
})

test('blocked keeps its reason until the status changes', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  const blocked = await store.transition('ISS-1', 'blocked', { reason: { code: 'cannot-start', message: 'not a repo' } })
  assert.deepEqual(blocked.blockedReason, { code: 'cannot-start', message: 'not a repo' })
  const open = await store.transition('ISS-1', 'open')
  assert.equal(open.blockedReason, undefined)
})

test('release counts failed starts and attach resets them', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  await store.claim('ISS-1')
  const released = await store.release('ISS-1', { comment: 'boom', failed: true })
  assert.equal(released.status, 'open')
  assert.equal(released.failedStarts, 1)
  await store.claim('ISS-1')
  const attached = await store.attach('ISS-1', { sessionId: 's' })
  assert.equal(attached.failedStarts, 0)
  assert.equal((await store.release('ISS-1', { comment: 'x' })).status, 'open')
  assert.equal((await store.release('ISS-1', { comment: 'x' })).status, 'open', 'releasing a non-running issue is a no-op')
})

test('update edits fields, rejects empty patches and notes edits during a run', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  await assert.rejects(store.update('ISS-1', {}), { code: 'invalid-input' })
  const edited = await store.update('ISS-1', { title: 'b', priority: 'low', labels: ['x'] })
  assert.equal(edited.title, 'b')
  await store.claim('ISS-1')
  const during = await store.update('ISS-1', { description: 'more detail' })
  assert.match(during.comments.at(-1).text, /not notified/)
})

test('comments are capped and validated', async () => {
  const { store } = makeStore()
  await store.create({ project: PROJECT, title: 'a' })
  await assert.rejects(store.addComment('ISS-1', { author: 'robot', text: 'x' }), { code: 'invalid-input' })
  await assert.rejects(store.addComment('ISS-1', { author: 'user', text: '  ' }), { code: 'invalid-input' })
  for (let i = 0; i < 510; i++) await store.addComment('ISS-1', { author: 'user', text: `c${i}` })
  assert.equal(store.get('ISS-1').comments.length, 500)
  assert.equal(store.get('ISS-1').comments.at(-1).text, 'c509')
})

test('a failing write leaves the in-memory state untouched and the queue alive', async () => {
  const table = memoryTable()
  const { store } = makeStore(table)
  await store.create({ project: PROJECT, title: 'a' })
  const original = table.put.bind(table)
  table.put = async () => { throw new Error('disk full') }
  await assert.rejects(store.transition('ISS-1', 'cancelled'), /disk full/)
  assert.equal(store.get('ISS-1').status, 'open')
  table.put = original
  assert.equal((await store.transition('ISS-1', 'cancelled')).status, 'cancelled')
})

test('listener failures never break a mutation', async () => {
  const { store } = makeStore()
  store.onChange(() => { throw new Error('bad listener') })
  store.onChange(async () => { throw new Error('bad async listener') })
  assert.equal((await store.create({ project: PROJECT, title: 'a' })).id, 'ISS-1')
})

test('unknown issues raise not-found', async () => {
  const { store } = makeStore()
  assert.equal(store.get('ISS-9'), undefined)
  await assert.rejects(store.update('ISS-9', { title: 'x' }), (error) => error instanceof IssueError && error.code === 'not-found')
})

test('projectKey ignores trailing separators', () => {
  assert.equal(projectKey(PROJECT + path.sep), projectKey(PROJECT))
})

test('auto-merge flag, merge state and reopening', async () => {
  const { store } = makeStore()
  const created = await store.create({ project: PROJECT, title: 'm', autoMerge: true, baseRef: 'issue/iss-1-x', baseBranch: 'main', mergeOf: '#1' })
  assert.equal(created.autoMerge, true)
  assert.equal(created.baseRef, 'issue/iss-1-x')
  assert.equal(created.mergeOf, 'ISS-1')
  assert.equal((await store.create({ project: PROJECT, title: 'plain' })).autoMerge, false)
  await assert.rejects(store.update(created.id, { autoMerge: 'yes' }), { code: 'invalid-input' })
  assert.equal((await store.update(created.id, { autoMerge: false })).autoMerge, false)
  await store.update(created.id, { autoMerge: true })

  assert.equal(await store.claimMerge(created.id), undefined) // not done yet
  await store.claim(created.id)
  await store.transition(created.id, 'done')
  assert.deepEqual(store.mergeQueue().map(issue => issue.id), [created.id])
  const claimed = await store.claimMerge(created.id)
  assert.equal(claimed.merge.status, 'running')
  assert.equal(await store.claimMerge(created.id), undefined) // only once
  assert.deepEqual(store.mergeQueue(), [])
  await store.setMerge(created.id, { status: 'running', sessionId: 's1' })
  assert.equal(store.byMergeSession('s1').id, created.id)
  await store.setMerge(created.id, { status: 'merged', sessionId: 's1' }, { comment: 'done' })
  assert.equal(store.byMergeSession('s1', { running: true }), undefined)
  assert.equal(store.byMergeSession('s1').id, created.id) // the session stays restricted to its issue
  assert.equal(store.get(created.id).comments.at(-1).text, 'done')
  const reopened = await store.transition(created.id, 'open')
  assert.equal(reopened.merge, undefined)
})
