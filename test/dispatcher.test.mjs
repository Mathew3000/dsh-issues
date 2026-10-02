import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { Dispatcher } from '../src/dispatcher.mjs'
import { IssueStore } from '../src/store.mjs'

const REPO = path.resolve('/work/repo')
const PLAIN = path.resolve('/work/plain')

function memoryTable() {
  const map = new Map()
  return { entries: () => map.entries(), async put(key, value) { map.set(key, value) } }
}

function setup({ config = {}, startImpl, resumeImpl, inspect, repos = { [REPO]: REPO } } = {}) {
  const store = new IssueStore({ table: memoryTable() })
  const calls = { start: [], halt: [], resume: [], worktree: [] }
  let sessionCounter = 0
  const sessions = {
    async start(request) {
      calls.start.push(request)
      if (startImpl) return startImpl(request, calls.start.length)
      sessionCounter += 1
      return { sessionId: `s${sessionCounter}`, goalId: `g${sessionCounter}` }
    },
    async resume(sessionId, options) {
      calls.resume.push([sessionId, options])
      return resumeImpl ? resumeImpl(sessionId, options) : { ok: true, rearmed: false, goal: { phase: 'active' } }
    },
    async halt(sessionId) { calls.halt.push(sessionId) },
  }
  const git = {
    async repoRoot(dir) { return repos[path.resolve(dir)] },
    async inspectRepo(dir) {
      if (inspect) return inspect(dir)
      const root = repos[path.resolve(dir)]
      return root === undefined ? { notRepo: true } : { root }
    },
    async ensureWorktree({ repo, issue }) {
      calls.worktree.push(issue.id)
      return { path: path.join(repo, '..', '.wt', issue.id.toLowerCase()), branch: `issue/${issue.id.toLowerCase()}-x` }
    },
  }
  const warnings = []
  const dispatcher = new Dispatcher({ store, sessions, git, config, logger: { warn: m => warnings.push(m), info: () => undefined } })
  return { store, dispatcher, calls, warnings }
}

test('starts open issues in queue order within the concurrency limits', async () => {
  const { store, dispatcher, calls } = setup({ config: { maxConcurrent: 2, maxPerProject: 2 } })
  await store.create({ project: REPO, title: 'low', priority: 'low' })
  await store.create({ project: REPO, title: 'high', priority: 'high' })
  await store.create({ project: REPO, title: 'normal' })
  await dispatcher.tick()
  assert.deepEqual(calls.start.map(request => request.title), ['ISS-2 · high', 'ISS-3 · normal'])
  assert.equal(store.get('ISS-1').status, 'open', 'third issue waits for a free slot')
  const started = store.get('ISS-2')
  assert.equal(started.status, 'in_progress')
  assert.equal(started.sessionId, 's1')
  assert.equal(started.goalId, 'g1')
  assert.match(started.branch, /^issue\/iss-2-/)
  assert.ok(started.comments.some(comment => /Session s1 started/.test(comment.text)))
})

test('one issue per project by default, other projects run in parallel', async () => {
  const { store, dispatcher, calls } = setup({ repos: { [REPO]: REPO, [path.resolve('/work/other')]: path.resolve('/work/other') } })
  await store.create({ project: REPO, title: 'a' })
  await store.create({ project: REPO, title: 'b' })
  await store.create({ project: path.resolve('/work/other'), title: 'c' })
  await dispatcher.tick()
  assert.deepEqual(calls.start.map(request => request.title), ['ISS-1 · a', 'ISS-3 · c'])
})

test('worktree sessions run inside the worktree and keep the project subdirectory', async () => {
  const { store, dispatcher, calls } = setup({ repos: { [path.resolve('/work/repo/packages/app')]: REPO } })
  await store.create({ project: path.resolve('/work/repo/packages/app'), title: 'sub' })
  await dispatcher.tick()
  assert.equal(calls.start[0].workspacePath, path.join(REPO, '..', '.wt', 'iss-1', 'packages', 'app'))
  assert.match(calls.start[0].prompt, /private git clone/)
  assert.match(calls.start[0].objective, /ISS-1/)
})

test('non-git projects run in place and never in parallel', async () => {
  const { store, dispatcher, calls } = setup({ config: { isolation: 'auto', maxPerProject: 5 }, repos: {} })
  await store.create({ project: PLAIN, title: 'a' })
  await store.create({ project: PLAIN, title: 'b' })
  await dispatcher.tick()
  assert.equal(calls.start.length, 1)
  assert.equal(calls.start[0].workspacePath, PLAIN)
  assert.equal(calls.worktree.length, 0)
  assert.match(calls.start[0].prompt, /directly in the project checkout/)
})

test('in-place runs say so in the issue', async () => {
  const { store, dispatcher } = setup({ config: { isolation: 'auto' }, repos: {} })
  await store.create({ project: PLAIN, title: 'a' })
  await dispatcher.tick()
  assert.match(store.get('ISS-1').comments.at(-1).text, /IN PLACE .*not inside a git repository/)
})

test('auto does not fall back to in-place when git itself fails', async () => {
  const { store, dispatcher, calls } = setup({ config: { isolation: 'auto' }, repos: {}, inspect: () => ({ error: 'dubious ownership' }) })
  await store.create({ project: PLAIN, title: 'a' })
  await dispatcher.tick()
  assert.equal(calls.start.length, 0)
  assert.equal(store.get('ISS-1').status, 'blocked')
  assert.match(store.get('ISS-1').blocked?.message ?? JSON.stringify(store.get('ISS-1')), /dubious ownership/)
})

test('the default isolation is a worktree per issue and never runs on the main checkout', async () => {
  const { store, dispatcher, calls } = setup({ repos: {} })
  await store.create({ project: PLAIN, title: 'a' })
  await dispatcher.tick()
  assert.equal(calls.start.length, 0)
  assert.equal(store.get('ISS-1').status, 'blocked')
})

test('isolation "worktree" blocks issues of non-git projects', async () => {
  const { store, dispatcher, calls } = setup({ config: { isolation: 'worktree' }, repos: {} })
  await store.create({ project: PLAIN, title: 'a' })
  await dispatcher.tick()
  assert.equal(calls.start.length, 0)
  const issue = store.get('ISS-1')
  assert.equal(issue.status, 'blocked')
  assert.equal(issue.blockedReason.code, 'cannot-start')
})

test('failed starts retry, then block after maxAttempts', async () => {
  const { store, dispatcher } = setup({
    config: { maxAttempts: 2 },
    startImpl: async () => { throw new Error('model unavailable') },
  })
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  let issue = store.get('ISS-1')
  assert.equal(issue.status, 'open')
  assert.equal(issue.failedStarts, 1)
  assert.equal(issue.sessionId, undefined)
  await dispatcher.tick()
  issue = store.get('ISS-1')
  assert.equal(issue.status, 'blocked')
  assert.equal(issue.blockedReason.code, 'start-failed')
  assert.match(issue.blockedReason.message, /model unavailable/)
})

test('a session that started but could not be recorded is halted', async () => {
  const { store, dispatcher, calls } = setup()
  await store.create({ project: REPO, title: 'a' })
  const original = store.attach.bind(store)
  store.attach = async () => { throw new Error('disk full') }
  await dispatcher.tick()
  store.attach = original
  assert.deepEqual(calls.halt, ['s1'])
  assert.equal(store.get('ISS-1').status, 'open')
})

test('concurrent ticks never start the same issue twice', async () => {
  const { store, dispatcher, calls } = setup({ config: { maxConcurrent: 5, maxPerProject: 5 } })
  await store.create({ project: REPO, title: 'a' })
  await store.create({ project: REPO, title: 'b' })
  await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()])
  assert.equal(calls.start.length, 2)
  assert.equal(new Set(calls.start.map(request => request.title)).size, 2)
})

test('goal completion moves the issue to review and stores the closing message once', async () => {
  const { store, dispatcher } = setup()
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  dispatcher.onAssistantMessage('s1', 'Fixed the crash in login.ts; tests pass.')
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { operation: 'complete', goal: { phase: 'complete', roundsStarted: 3 } } })
  assert.equal(store.get('ISS-1').status, 'needs_review')
  await dispatcher.onAgentIdle('s1')
  await dispatcher.onAgentIdle('s1')
  const agentComments = store.get('ISS-1').comments.filter(comment => comment.author === 'agent')
  assert.deepEqual(agentComments.map(comment => comment.text), ['Fixed the crash in login.ts; tests pass.'])
})

test('a blocked goal blocks the issue with the reported reason', async () => {
  const { store, dispatcher } = setup()
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  await dispatcher.onGoalChanged({
    sessionId: 's1',
    change: { operation: 'block', goal: { phase: 'blocked', blockedReason: { code: 'missing-credentials', message: 'Needs an API key' } } },
  })
  const issue = store.get('ISS-1')
  assert.equal(issue.status, 'blocked')
  assert.deepEqual(issue.blockedReason, { code: 'missing-credentials', message: 'Needs an API key' })
})

test('pausing and resuming the goal toggles blocked(paused) and in_progress', async () => {
  const { store, dispatcher } = setup()
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { goal: { phase: 'paused' } } })
  assert.equal(store.get('ISS-1').blockedReason.code, 'paused')
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { goal: { phase: 'active' } } })
  assert.equal(store.get('ISS-1').status, 'in_progress')
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { operation: 'clear' } })
  assert.equal(store.get('ISS-1').blockedReason.code, 'goal-cleared')
})

test('goal events of unrelated or already settled issues are ignored', async () => {
  const { store, dispatcher } = setup()
  await dispatcher.onGoalChanged({ sessionId: 'unknown', change: { goal: { phase: 'complete' } } })
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  await dispatcher.cancel('ISS-1')
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { goal: { phase: 'complete' } } })
  assert.equal(store.get('ISS-1').status, 'cancelled')
})

test('completeStatus can close issues directly', async () => {
  const { store, dispatcher } = setup({ config: { completeStatus: 'done' } })
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  await dispatcher.onGoalChanged({ sessionId: 's1', change: { goal: { phase: 'complete', roundsStarted: 1 } } })
  assert.equal(store.get('ISS-1').status, 'done')
})

test('cancel pauses the running session', async () => {
  const { store, dispatcher, calls } = setup()
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.tick()
  const cancelled = await dispatcher.cancel('ISS-1')
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(calls.halt, ['s1'])
  await assert.rejects(dispatcher.cancel('ISS-99'), { code: 'not-found' })
})

test('restart: running issues are re-armed, finished goals are applied, lost sessions requeued', async () => {
  const byId = {
    's-armed': { ok: true, rearmed: true, goal: { phase: 'active' } },
    's-done': { ok: true, rearmed: false, goal: { phase: 'complete', roundsStarted: 2 } },
    's-gone': { ok: false, reason: 'not-found', message: 'gone' },
    's-busy': { ok: false, reason: 'unavailable', message: 'busy' },
  }
  const { store, dispatcher, calls, warnings } = setup({ resumeImpl: async sessionId => byId[sessionId] })
  for (const [title, sessionId] of [['armed', 's-armed'], ['done', 's-done'], ['gone', 's-gone'], ['busy', 's-busy'], ['orphan', undefined]]) {
    const { id } = await store.create({ project: REPO, title })
    await store.claim(id)
    if (sessionId !== undefined) await store.attach(id, { sessionId })
  }
  await dispatcher.resumeInterrupted()
  assert.equal(store.get('ISS-1').status, 'in_progress')
  assert.ok(store.get('ISS-1').comments.some(comment => /re-armed/.test(comment.text)))
  assert.equal(store.get('ISS-2').status, 'needs_review')
  assert.equal(store.get('ISS-3').status, 'open')
  assert.equal(store.get('ISS-3').failedStarts, 1)
  assert.equal(store.get('ISS-4').status, 'in_progress', 'an unreachable session is left alone')
  assert.equal(warnings.length, 2, 'one warning for the lost session, one for the unreachable one')
  assert.ok(warnings.some(message => /session unavailable after restart: busy/.test(message)))
  assert.equal(store.get('ISS-5').status, 'open')
  assert.equal(calls.resume.length, 4)
  assert.ok(calls.resume.every(([, options]) => options.rearm === true))
})

test('resumeOnStart=false only observes, it does not re-arm', async () => {
  const { store, dispatcher, calls } = setup({ config: { resumeOnStart: false } })
  const { id } = await store.create({ project: REPO, title: 'a' })
  await store.claim(id)
  await store.attach(id, { sessionId: 's1' })
  await dispatcher.resumeInterrupted()
  assert.deepEqual(calls.resume, [['s1', { rearm: false }]])
})

test('stop prevents further dispatching', async () => {
  const { store, dispatcher, calls } = setup()
  await store.create({ project: REPO, title: 'a' })
  await dispatcher.stop()
  await dispatcher.tick()
  assert.equal(calls.start.length, 0)
})
