import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { branchName, ensureWorktree, inspectRepo, repoRoot, slugify } from '../src/git.mjs'

let root
let repo

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-issues-git-')))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
})

after(() => { rmSync(root, { recursive: true, force: true }) })

test('slugify and branchName produce safe branch names', () => {
  assert.equal(slugify('Fix: crash on  login!! (v2)'), 'fix-crash-on-login-v2')
  assert.equal(slugify('###'), 'work')
  assert.equal(slugify('x'.repeat(100)).length, 40)
  assert.equal(branchName({ id: 'ISS-12', title: 'Fix login' }), 'issue/iss-12-fix-login')
})

test('inspectRepo separates "not a repository" from real failures', async () => {
  assert.deepEqual(await inspectRepo(repo), { root: repo })
  assert.deepEqual(await inspectRepo(root), { notRepo: true })
  assert.match((await inspectRepo(path.join(root, 'missing'))).error, /does not exist/)
})

test('repoRoot finds the top level and returns undefined outside a repository', async () => {
  assert.equal(await repoRoot(repo), repo)
  assert.equal(await repoRoot(root), undefined)
})

test('ensureWorktree creates a branch worktree and reuses it on the next attempt', async () => {
  const issue = { id: 'ISS-1', title: 'Fix login' }
  const first = await ensureWorktree({ repo, issue })
  assert.equal(first.reused, false)
  assert.equal(first.branch, 'issue/iss-1-fix-login')
  assert.equal(first.path, path.join(root, '.dsh-worktrees', 'repo', 'iss-1'))
  assert.ok(existsSync(path.join(first.path, 'a.txt')))
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], first.path), first.branch)
  const again = await ensureWorktree({ repo, issue })
  assert.equal(again.reused, true)
  assert.equal(again.path, first.path)
})

test('ensureWorktree reattaches an existing branch after the worktree was removed', async () => {
  const issue = { id: 'ISS-2', title: 'Second' }
  const first = await ensureWorktree({ repo, issue })
  git(['worktree', 'remove', '--force', first.path])
  const second = await ensureWorktree({ repo, issue })
  assert.equal(second.reused, false)
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], second.path), first.branch)
})

test('ensureWorktree recovers when the directory vanished without git knowing', async () => {
  const issue = { id: 'ISS-3', title: 'Third' }
  const first = await ensureWorktree({ repo, issue })
  rmSync(first.path, { recursive: true, force: true })
  const second = await ensureWorktree({ repo, issue })
  assert.ok(existsSync(path.join(second.path, 'a.txt')))
})

test('ensureWorktree refuses a foreign directory at the target path', async () => {
  const issue = { id: 'ISS-4', title: 'Fourth' }
  const target = path.join(root, '.dsh-worktrees', 'repo', 'iss-4')
  execFileSync('git', ['init', '-q', target])
  await assert.rejects(ensureWorktree({ repo, issue }), /not a worktree of/)
})

test('ensureWorktree honors worktreeRoot and baseRef', async () => {
  git(['branch', 'base-x'])
  const customRoot = path.join(root, 'custom')
  const created = await ensureWorktree({ repo, worktreeRoot: customRoot, baseRef: 'base-x', issue: { id: 'ISS-5', title: 'Fifth' } })
  assert.equal(created.path, path.join(customRoot, 'iss-5'))
})
