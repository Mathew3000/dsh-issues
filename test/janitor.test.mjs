import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import * as gitOps from '../src/git.mjs'
import { Janitor } from '../src/janitor.mjs'
import { IssueStore } from '../src/store.mjs'

let root
let repo

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-issues-janitor-')))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
})

after(() => { rmSync(root, { recursive: true, force: true }) })

function memoryTable() {
  const map = new Map()
  return { entries: () => map.entries(), async put(key, value) { map.set(key, value) } }
}

/** A store with one issue worked on in a real worktree, plus a fake workspace registry that knows that worktree. */
async function setup({ config, busy = false } = {}) {
  const store = new IssueStore({ table: memoryTable() })
  const issue = await store.create({ project: repo, title: `work ${Math.random()}` })
  const worktree = await gitOps.ensureWorktree({ repo, worktreeRoot: path.join(root, 'wt'), issue })
  await store.claim(issue.id)
  await store.attach(issue.id, { sessionId: 's1', branch: worktree.branch, worktreePath: worktree.path, baseBranch: 'main' })
  const registry = [{ id: 'w1', path: worktree.path, sessionIds: ['s1'] }, { id: 'w0', path: repo, sessionIds: [] }]
  const removed = []
  const state = { busy }
  const workspaces = {
    list: () => registry.map(entry => ({ ...entry })),
    busy: () => state.busy,
    isMissing: async workspace => !existsSync(workspace.path),
    async remove(id) {
      removed.push(id)
      registry.splice(registry.findIndex(entry => entry.id === id), 1)
    },
  }
  const janitor = new Janitor({ store, git: gitOps, workspaces, config })
  return { store, issue, worktree, janitor, removed, state, registry }
}

test('a done issue loses its worktree and workspace entry, but keeps its branch', async () => {
  const { store, issue, worktree, janitor, removed } = await setup()
  await store.transition(issue.id, 'done', { from: 'in_progress' })
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), false)
  assert.deepEqual(removed, ['w1'])
  assert.equal(store.get(issue.id).worktreeRemoved, true)
  assert.ok(git(['branch', '--list', worktree.branch]).includes(worktree.branch))
  await janitor.sweep()
  assert.deepEqual(removed, ['w1'])
})

test('nothing is removed while an agent is still running in the workspace', async () => {
  const { store, issue, worktree, janitor, removed, state } = await setup({ busy: true })
  await store.transition(issue.id, 'done', { from: 'in_progress' })
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), true)
  assert.deepEqual(removed, [])
  state.busy = false
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), false)
  assert.deepEqual(removed, ['w1'])
})

test('uncommitted work is kept and the issue says so once', async () => {
  const { store, issue, worktree, janitor, removed } = await setup()
  writeFileSync(path.join(worktree.path, 'wip.txt'), 'unsaved\n')
  await store.transition(issue.id, 'done', { from: 'in_progress' })
  await janitor.sweep()
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), true)
  assert.deepEqual(removed, [])
  const notes = store.get(issue.id).comments.filter(comment => /Kept the issue worktree/.test(comment.text))
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /uncommitted/)
})

test('issues in review or in progress keep their worktree', async () => {
  const { store, issue, worktree, janitor, removed } = await setup()
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), true)
  await store.transition(issue.id, 'needs_review', { from: 'in_progress' })
  await janitor.sweep()
  assert.equal(existsSync(worktree.path), true)
  assert.deepEqual(removed, [])
})

test('the project workspace itself is never removed', async () => {
  const { store, issue, janitor, removed } = await setup()
  await store.transition(issue.id, 'cancelled', { from: 'in_progress' })
  await janitor.sweep()
  assert.ok(!removed.includes('w0'))
})

test('workspace entries of worktrees that were already deleted (for example after a merge) are forgotten', async () => {
  const { store, issue, worktree, janitor, removed } = await setup()
  await gitOps.cleanupAfterMerge({ repo, baseBranch: 'main', issueWorktree: worktree.path, issueBranch: worktree.branch })
  await store.transition(issue.id, 'done', { from: 'in_progress' })
  await janitor.sweep()
  assert.deepEqual(removed, ['w1'])
})

test('the options turn each kind of cleanup off', async () => {
  const keepTrees = await setup({ config: { cleanupOnClose: false, forgetWorkspaces: true } })
  await keepTrees.store.transition(keepTrees.issue.id, 'done', { from: 'in_progress' })
  await keepTrees.janitor.sweep()
  assert.equal(existsSync(keepTrees.worktree.path), true)
  assert.deepEqual(keepTrees.removed, [])

  const keepEntries = await setup({ config: { forgetWorkspaces: false } })
  await keepEntries.store.transition(keepEntries.issue.id, 'done', { from: 'in_progress' })
  await keepEntries.janitor.sweep()
  assert.equal(existsSync(keepEntries.worktree.path), false)
  assert.deepEqual(keepEntries.removed, [])
})

test('a reopened issue gets a fresh worktree that is cleaned up again', async () => {
  const { store, issue, janitor, removed } = await setup()
  await store.transition(issue.id, 'done', { from: 'in_progress' })
  await janitor.sweep()
  const again = await gitOps.ensureWorktree({ repo, worktreeRoot: path.join(root, 'wt'), issue })
  assert.equal(existsSync(again.path), true)
  await store.attach(issue.id, { worktreePath: again.path })
  assert.equal(store.get(issue.id).worktreeRemoved, undefined)
  await janitor.sweep()
  assert.equal(existsSync(again.path), false)
  assert.ok(removed.length >= 1)
})
