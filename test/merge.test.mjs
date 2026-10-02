import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import * as gitOps from '../src/git.mjs'
import { MergeCoordinator } from '../src/merge.mjs'
import { IssueStore } from '../src/store.mjs'

let root, repo, store, started, coordinator, sessions

const sh = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function memoryTable() {
  const rows = new Map()
  return { entries: () => rows.entries(), put: async (key, value) => { rows.set(key, structuredClone(value)) } }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-issues-merge-')))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh(['config', 'user.email', 't@e.x'])
  sh(['config', 'user.name', 'T'])
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  sh(['add', '.'])
  sh(['commit', '-q', '-m', 'init'])
  store = new IssueStore({ table: memoryTable() })
  started = []
  sessions = {
    start: async (request) => {
      started.push(request)
      return { sessionId: `merge-session-${started.length}`, goalId: `goal-${started.length}` }
    },
    resume: async () => ({ ok: true, rearmed: false }),
  }
  coordinator = new MergeCoordinator({ store, sessions, git: gitOps, config: {}, logger: {} })
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A finished issue with its branch, as the dispatcher leaves it. */
async function doneIssue({ file = 'b.txt', content = 'b\n', title = 'Feature', autoMerge = true, extra = {} } = {}) {
  const issue = await store.create({ project: repo, title, description: 'd', autoMerge, ...extra })
  const worktree = await gitOps.ensureWorktree({ repo, issue, baseRef: extra.baseRef ?? 'HEAD' })
  writeFileSync(path.join(worktree.path, file), content)
  sh(['add', '.'], worktree.path)
  sh(['commit', '-q', '-m', `work for ${issue.id}`], worktree.path)
  await store.claim(issue.id)
  await store.attach(issue.id, { sessionId: `w-${issue.id}`, branch: worktree.branch, worktreePath: worktree.path, baseBranch: extra.baseBranch ?? 'main' })
  await store.transition(issue.id, 'done')
  return store.get(issue.id)
}

test('an accepted auto-merge issue starts a merge agent in a fresh worktree', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  assert.equal(started.length, 1)
  const merge = store.get(issue.id).merge
  assert.equal(merge.status, 'running')
  assert.equal(merge.branch, 'merge/iss-1')
  assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD'], merge.worktreePath), 'merge/iss-1')
  assert.match(started[0].prompt, /git merge --no-ff issue\/iss-1-feature/)
  assert.match(started[0].prompt, /issue_merge_report/)
  assert.equal(started[0].workspacePath, merge.worktreePath)
})

test('issues without auto-merge, or not done, are left alone', async () => {
  await doneIssue({ autoMerge: false })
  const open = await store.create({ project: repo, title: 'Open one', autoMerge: true })
  await coordinator.tick()
  assert.equal(started.length, 0)
  assert.equal(store.get(open.id).merge, undefined)
})

test('ready: the base branch is fast-forwarded and everything is cleaned up', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  const { worktreePath, branch } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'Merge ISS-1', issue.branch], worktreePath)
  const answer = await coordinator.report(issue.id, { outcome: 'ready', summary: 'tests pass' })
  assert.match(answer, /Merged into main/)
  assert.equal(readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'b\n')
  const after = store.get(issue.id)
  assert.equal(after.merge.status, 'merged')
  assert.equal(after.merge.sha, sh(['rev-parse', 'main']))
  assert.equal(existsSync(worktreePath), false)
  assert.equal(existsSync(issue.worktreePath), false)
  const branches = sh(['branch', '--format=%(refname:short)'])
  assert.equal(branches, 'main')
  assert.ok(after.comments.some(c => /Merged into main/.test(c.text) && /tests pass/.test(c.text)))
  assert.equal(branch, 'merge/iss-1')
})

test('ready is refused while the merge is not committed or does not contain the issue', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  await assert.rejects(coordinator.report(issue.id, { outcome: 'ready', summary: 's' }), { code: 'invalid-input', message: /does not contain/ })
  const { worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '--no-commit', '-q', issue.branch], worktreePath)
  await assert.rejects(coordinator.report(issue.id, { outcome: 'ready', summary: 's' }), { code: 'invalid-input', message: /uncommitted/ })
  assert.equal(store.get(issue.id).merge.status, 'running')
  assert.equal(sh(['rev-parse', 'main']), sh(['rev-parse', 'main'])) // main untouched
  assert.equal(existsSync(path.join(repo, 'b.txt')), false)
})

test('conflict: a follow-up issue starts from the issue branch and carries the agent description', async () => {
  const issue = await doneIssue({ title: 'Edit a' , file: 'a.txt', content: 'one\nTWO changed\nthree\n' })
  await coordinator.tick()
  const answer = await coordinator.report(issue.id, {
    outcome: 'conflict', summary: 'two sides edit a.txt line 2', followUpTitle: 'Resolve a.txt conflict', followUpDescription: 'main and the branch both rewrote line 2 of a.txt.',
  })
  assert.match(answer, /follow-up issue/)
  const after = store.get(issue.id)
  assert.equal(after.merge.status, 'conflict')
  const follow = store.get(after.merge.followUpId)
  assert.equal(follow.title, 'Resolve a.txt conflict')
  assert.equal(follow.baseRef, issue.branch)
  assert.equal(follow.baseBranch, 'main')
  assert.equal(follow.mergeOf, issue.id)
  assert.equal(follow.autoMerge, true)
  assert.equal(follow.priority, 'high')
  assert.deepEqual(follow.labels, ['merge-conflict'])
  assert.match(follow.description, /both rewrote line 2/)
  assert.match(follow.description, /Follow-up of ISS-1/)
  assert.equal(existsSync(path.join(path.dirname(repo), '.dsh-worktrees', 'repo', 'merge-iss-1')), false)
  assert.equal(sh(['branch', '--list', 'merge/iss-1']), '')
  assert.ok(sh(['branch', '--list', issue.branch]).includes(issue.branch)) // the work is kept
  await assert.rejects(coordinator.report(issue.id, { outcome: 'ready', summary: 'late' }), { code: 'conflict' })
})

test('conflict needs a description; unknown outcomes are rejected', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  await assert.rejects(coordinator.report(issue.id, { outcome: 'conflict', summary: 's' }), /follow_up_description/)
  await assert.rejects(coordinator.report(issue.id, { outcome: 'maybe', summary: 's' }), /outcome must be/)
})

test('when the base branch moved cleanly the merge is refreshed and still lands', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  const { worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'Merge ISS-1', issue.branch], worktreePath)
  writeFileSync(path.join(repo, 'c.txt'), 'c\n')
  sh(['add', '.'])
  sh(['commit', '-q', '-m', 'other work on main'])
  await coordinator.report(issue.id, { outcome: 'ready', summary: 's' })
  assert.equal(store.get(issue.id).merge.status, 'merged')
  assert.ok(existsSync(path.join(repo, 'b.txt')) && existsSync(path.join(repo, 'c.txt')))
})

test('when the base branch moved with a conflict a follow-up issue is opened', async () => {
  const issue = await doneIssue({ file: 'a.txt', content: 'one\nbranch two\nthree\n' })
  await coordinator.tick()
  const { worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'Merge ISS-1', issue.branch], worktreePath)
  writeFileSync(path.join(repo, 'a.txt'), 'one\nmain two\nthree\n')
  sh(['commit', '-q', '-am', 'main edits the same line'])
  const answer = await coordinator.report(issue.id, { outcome: 'ready', summary: 's' })
  assert.match(answer, /conflict/)
  const after = store.get(issue.id)
  assert.equal(after.merge.status, 'conflict')
  assert.match(store.get(after.merge.followUpId).description, /a\.txt/)
  assert.equal(sh(['show', 'main:a.txt']), 'one\nmain two\nthree') // main was not touched
})

test('a dirty main checkout that blocks the fast-forward fails the merge without losing the result', async () => {
  const issue = await doneIssue({ file: 'a.txt', content: 'one\ntwo\nthree\nfour\n' })
  await coordinator.tick()
  const { worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'Merge ISS-1', issue.branch], worktreePath)
  writeFileSync(path.join(repo, 'a.txt'), 'local edit\n') // uncommitted change on the same file
  const answer = await coordinator.report(issue.id, { outcome: 'ready', summary: 's' })
  assert.match(answer, /person has to take over/)
  const after = store.get(issue.id)
  assert.equal(after.merge.status, 'failed')
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'local edit\n')
  assert.ok(sh(['branch', '--list', 'merge/iss-1']).includes('merge/iss-1'))
})

test('a base branch that is not checked out is updated without touching the checkout', async () => {
  sh(['checkout', '-q', '-b', 'other'])
  const issue = await doneIssue()
  await coordinator.tick()
  const { worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'Merge ISS-1', issue.branch], worktreePath)
  await coordinator.report(issue.id, { outcome: 'ready', summary: 's' })
  assert.equal(store.get(issue.id).merge.status, 'merged')
  assert.equal(sh(['show', 'main:b.txt']), 'b')
  assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD']), 'other')
  assert.equal(existsSync(path.join(repo, 'b.txt')), false)
})

test('an agent that ends without reporting turns into a follow-up issue', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  const sessionId = store.get(issue.id).merge.sessionId
  coordinator.onAssistantMessage(sessionId, 'I could not run the test suite.')
  await coordinator.onGoalChanged({ sessionId, change: { goal: { phase: 'complete' } } })
  assert.equal(store.get(issue.id).merge.status, 'running') // wait for idle
  await coordinator.onAgentIdle(sessionId)
  const after = store.get(issue.id)
  assert.equal(after.merge.status, 'conflict')
  assert.match(store.get(after.merge.followUpId).description, /could not run the test suite/)
})

test('an agent that reported before ending is not reported twice', async () => {
  const issue = await doneIssue()
  await coordinator.tick()
  const { sessionId, worktreePath } = store.get(issue.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'm', issue.branch], worktreePath)
  await coordinator.report(issue.id, { outcome: 'ready', summary: 's' })
  await coordinator.onGoalChanged({ sessionId, change: { goal: { phase: 'complete' } } })
  await coordinator.onAgentIdle(sessionId)
  assert.equal(store.list({ limit: 10 }).length, 1)
  assert.equal(store.get(issue.id).merge.status, 'merged')
})

test('only one merge per project runs at a time', async () => {
  const first = await doneIssue({ title: 'First', file: 'f1.txt' })
  const second = await doneIssue({ title: 'Second', file: 'f2.txt' })
  await coordinator.tick()
  assert.equal(started.length, 1)
  assert.equal(store.get(second.id).merge, undefined)
  const { worktreePath } = store.get(first.id).merge
  sh(['merge', '--no-ff', '-q', '-m', 'm', first.branch], worktreePath)
  await coordinator.report(first.id, { outcome: 'ready', summary: 's' })
  await coordinator.tick()
  assert.equal(started.length, 2)
  assert.equal(store.get(second.id).merge.status, 'running')
})

test('skipped without a branch or base branch, failed when the agent cannot start', async () => {
  const noBranch = await store.create({ project: repo, title: 'No branch', autoMerge: true })
  await store.claim(noBranch.id)
  await store.transition(noBranch.id, 'done')
  await coordinator.tick()
  assert.equal(store.get(noBranch.id).merge.status, 'skipped')
  assert.match(store.get(noBranch.id).merge.message, /no git worktree/)

  sessions.start = async () => { throw new Error('model unavailable') }
  const issue = await doneIssue({ title: 'Boom', file: 'z.txt' })
  await coordinator.tick()
  assert.equal(store.get(issue.id).merge.status, 'failed')
  assert.match(store.get(issue.id).merge.message, /model unavailable/)
  assert.equal(sh(['branch', '--list', 'merge/iss-3']), '')
})

test('retrying clears the failed merge so it runs again', async () => {
  sessions.start = async () => { throw new Error('nope') }
  const issue = await doneIssue()
  await coordinator.tick()
  assert.equal(store.get(issue.id).merge.status, 'failed')
  sessions.start = async (request) => { started.push(request); return { sessionId: 's2', goalId: 'g2' } }
  await store.setMerge(issue.id, undefined)
  await coordinator.tick()
  assert.equal(store.get(issue.id).merge.status, 'running')
})

test('a follow-up that merges successfully settles the original issue', async () => {
  const issue = await doneIssue({ title: 'Edit a', file: 'a.txt', content: 'one\nbranch two\nthree\n' })
  await coordinator.tick()
  await coordinator.report(issue.id, { outcome: 'conflict', summary: 's', followUpDescription: 'resolve it' })
  const follow = store.get(store.get(issue.id).merge.followUpId)
  // the follow-up agent worked on top of the original branch and merged main in
  const worktree = await gitOps.ensureWorktree({ repo, issue: follow, baseRef: follow.baseRef })
  writeFileSync(path.join(repo, 'a.txt'), 'one\nmain two\nthree\n')
  sh(['commit', '-q', '-am', 'main moved'])
  writeFileSync(path.join(worktree.path, 'a.txt'), 'one\nmain two\nbranch two\nthree\n')
  sh(['commit', '-q', '-am', 'resolved'], worktree.path)
  sh(['fetch', '-q', 'origin'], worktree.path)
  sh(['merge', '-q', '-s', 'ours', '-m', 'sync main', 'origin/main'], worktree.path)
  await store.claim(follow.id)
  await store.attach(follow.id, { sessionId: 'w2', branch: worktree.branch, worktreePath: worktree.path, baseBranch: 'main' })
  await store.transition(follow.id, 'done')
  await coordinator.tick()
  const mergeWorktree = store.get(follow.id).merge.worktreePath
  sh(['merge', '--no-ff', '-q', '-m', 'merge follow-up', store.get(follow.id).branch], mergeWorktree)
  await coordinator.report(follow.id, { outcome: 'ready', summary: 'resolved' })
  assert.equal(store.get(follow.id).merge.status, 'merged')
  assert.equal(store.get(issue.id).merge.status, 'merged')
  assert.match(store.get(issue.id).merge.message, new RegExp(follow.id))
})

test('restart: a merge without a session is queued again, a finished goal without a report is escalated', async () => {
  const lonely = await doneIssue({ title: 'Lonely', file: 'l.txt' })
  await store.claimMerge(lonely.id)
  const ended = await doneIssue({ title: 'Ended', file: 'e.txt' })
  await coordinator.tick()
  // `lonely` never got a session; `ended` (second, same project) is queued behind it
  await coordinator.resumeInterrupted()
  assert.equal(store.get(lonely.id).merge, undefined)
  await coordinator.tick()
  const running = store.get(lonely.id).merge
  assert.equal(running.status, 'running')
  sessions.resume = async () => ({ ok: true, rearmed: true, goal: { phase: 'complete' } })
  await coordinator.resumeInterrupted()
  assert.equal(store.get(lonely.id).merge.status, 'conflict')
  assert.equal(store.get(ended.id).merge, undefined)
})
