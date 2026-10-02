import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { branchName, ensureMergeWorktree, ensureWorktree, importBranch, inspectRepo, refreshMergeBranch, removeWorktreeIfClean, repoRoot, slugify } from '../src/git.mjs'

let root
let repo

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-issues-git-')))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
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

test('ensureWorktree makes a private clone whose git data lives inside its own folder', async () => {
  const first = await ensureWorktree({ repo, issue: { id: 'ISS-9', title: 'Own git dir' } })
  assert.ok(statSync(path.join(first.path, '.git')).isDirectory(), 'a real .git folder, not a pointer into the project')
  assert.equal(git(['config', '--get', 'user.email'], first.path), 'test@example.com')
  assert.throws(() => git(['push', 'origin', 'HEAD'], first.path), /push-disabled|fatal|does not appear/)
  // commits only write inside the folder
  writeFileSync(path.join(first.path, 'new.txt'), 'x\n')
  git(['add', '.'], first.path)
  git(['commit', '-q', '-m', 'inside'], first.path)
  assert.equal(git(['branch', '--list', first.branch]), '', 'the project repository does not see it yet')
})

test('importBranch copies the clone branch into the project, fast-forward only', async () => {
  const issue = { id: 'ISS-10', title: 'Import me' }
  const clone = await ensureWorktree({ repo, issue })
  writeFileSync(path.join(clone.path, 'f.txt'), '1\n')
  git(['add', '.'], clone.path)
  git(['commit', '-q', '-m', 'one'], clone.path)
  assert.deepEqual(await importBranch({ repo, clone: clone.path, branch: clone.branch }), { ok: true })
  assert.equal(git(['rev-parse', clone.branch]), git(['rev-parse', 'HEAD'], clone.path))
  writeFileSync(path.join(clone.path, 'f.txt'), '2\n')
  git(['commit', '-q', '-am', 'two'], clone.path)
  assert.deepEqual(await importBranch({ repo, clone: clone.path, branch: clone.branch }), { ok: true })
  assert.equal(git(['rev-parse', clone.branch]), git(['rev-parse', 'HEAD'], clone.path))
  // a branch that moved on in the project is refused, not overwritten
  git(['checkout', '-q', '-b', 'side', 'main'])
  writeFileSync(path.join(repo, 'side.txt'), 'x\n'); git(['add', '.']); git(['commit', '-q', '-m', 'side'])
  git(['branch', '-f', clone.branch, 'side']); git(['checkout', '-q', 'main'])
  writeFileSync(path.join(clone.path, 'f.txt'), '3\n'); git(['commit', '-q', '-am', 'three'], clone.path)
  const refused = await importBranch({ repo, clone: clone.path, branch: clone.branch })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /could not copy branch/)
  // a missing clone has nothing to import
  assert.deepEqual(await importBranch({ repo, clone: path.join(root, 'gone'), branch: 'x' }), { ok: true })
})

test('ensureWorktree starts again from the project branch after the clone was removed', async () => {
  const issue = { id: 'ISS-2', title: 'Second' }
  const first = await ensureWorktree({ repo, issue })
  writeFileSync(path.join(first.path, 'kept.txt'), 'kept\n')
  git(['add', '.'], first.path)
  git(['commit', '-q', '-m', 'work'], first.path)
  const removed = await removeWorktreeIfClean({ repo, target: first.path, branch: first.branch })
  assert.deepEqual(removed, { removed: true })
  assert.equal(existsSync(first.path), false)
  const second = await ensureWorktree({ repo, issue })
  assert.equal(second.reused, false)
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], second.path), first.branch)
  assert.ok(existsSync(path.join(second.path, 'kept.txt')), 'the committed work came back')
})

test('removeWorktreeIfClean keeps a clone with uncommitted work and refuses foreign folders', async () => {
  const dirty = await ensureWorktree({ repo, issue: { id: 'ISS-11', title: 'Dirty' } })
  writeFileSync(path.join(dirty.path, 'wip.txt'), 'x\n')
  const result = await removeWorktreeIfClean({ repo, target: dirty.path, branch: dirty.branch })
  assert.equal(result.removed, false)
  assert.match(result.reason, /uncommitted/)
  assert.ok(existsSync(dirty.path))
  const foreign = path.join(root, 'important')
  execFileSync('git', ['init', '-q', foreign])
  const refused = await removeWorktreeIfClean({ repo, target: foreign })
  assert.equal(refused.removed, false)
  assert.match(refused.reason, /not a folder created by dsh-issues/)
  assert.ok(existsSync(foreign))
})

test('a merge clone starts at the base branch, holds the issue branch, and can pick up newer base commits', async () => {
  const issue = { id: 'ISS-12', title: 'Merge me' }
  const work = await ensureWorktree({ repo, issue })
  writeFileSync(path.join(work.path, 'm.txt'), 'issue\n')
  git(['add', '.'], work.path); git(['commit', '-q', '-m', 'issue work'], work.path)
  await importBranch({ repo, clone: work.path, branch: work.branch })
  const merge = await ensureMergeWorktree({ repo, baseBranch: 'main', issueBranch: work.branch, issue })
  assert.ok(statSync(path.join(merge.path, '.git')).isDirectory())
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], merge.path), 'merge/iss-12')
  assert.equal(git(['rev-parse', work.branch], merge.path), git(['rev-parse', work.branch]))
  writeFileSync(path.join(repo, 'later.txt'), 'x\n')
  git(['add', '.']); git(['commit', '-q', '-m', 'main moved on'])
  assert.deepEqual(await refreshMergeBranch({ repo, mergeWorktree: merge.path, baseBranch: 'main' }), { ok: true })
  assert.ok(existsSync(path.join(merge.path, 'later.txt')))
})

test('ensureWorktree honors worktreeRoot and baseRef', async () => {
  git(['branch', 'base-x'])
  const customRoot = path.join(root, 'custom')
  const created = await ensureWorktree({ repo, worktreeRoot: customRoot, baseRef: 'base-x', issue: { id: 'ISS-5', title: 'Fifth' } })
  assert.equal(created.path, path.join(customRoot, 'iss-5'))
})
