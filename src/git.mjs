/** Git helpers: one worktree and branch per issue. No shell is involved; arguments are passed as an array. */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Run git and return trimmed stdout.
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number }} [options]
 */
export async function git(args, { cwd, timeout = 60_000 } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * Top-level directory of the repository containing `dir`.
 * @returns {Promise<string | undefined>} undefined when `dir` is not inside a git work tree
 */
export async function repoRoot(dir) {
  return (await inspectRepo(dir)).root
}

/**
 * Like {@link repoRoot} but tells why a directory is not usable.
 * `notRepo` is true only when git ran and said the directory is not in a work tree;
 * every other failure (git missing, "dubious ownership", permissions) is an `error`.
 * @returns {Promise<{ root: string } | { notRepo: true } | { error: string }>}
 */
export async function inspectRepo(dir) {
  if (!existsSync(dir)) return { error: `${dir} does not exist` }
  try {
    return { root: path.resolve(await git(['rev-parse', '--show-toplevel'], { cwd: dir })) }
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    if (error?.code === 'ENOENT' && error?.syscall?.includes('spawn')) {
      return { error: 'git could not be started (is git installed and on the PATH of the process running dsh?)' }
    }
    if (/not a git repository/i.test(stderr)) return { notRepo: true }
    if (/dubious ownership|safe\.directory/i.test(stderr)) {
      return { error: `git refuses this folder (dubious ownership). Run: git config --global --add safe.directory "${dir.replaceAll('\\', '/')}"` }
    }
    return { error: stderr || String(error?.message ?? error) }
  }
}

/** Lowercase `[a-z0-9-]` slug for branch names. */
export function slugify(value, max = 40) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '')
  return slug === '' ? 'work' : slug
}

/** Branch used for an issue, e.g. `issue/iss-12-fix-login-crash`. */
export function branchName(issue) {
  return `issue/${issue.id.toLowerCase()}-${slugify(issue.title)}`
}

function sameDirectory(a, b) {
  const norm = value => path.resolve(value).replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** Name a checkout folder must have: `iss-<n>` for an issue, `merge-iss-<n>` for a merge. */
const CHECKOUT_NAME = /^(merge-)?iss-\d+$/

/** Settings copied from the project so commits made in a clone look like commits made in the project. */
const COPIED_CONFIG = ['user.name', 'user.email', 'core.autocrlf', 'core.eol']

const LONG = 10 * 60_000

/** One git write into a project repository at a time: parallel fetches into the same ref fail on its lock file. */
const queues = new Map()
function serialized(repo, work) {
  const key = path.resolve(repo)
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
  queues.set(key, run)
  return run.finally(() => { if (queues.get(key) === run) queues.delete(key) })
}

/** True for a folder created by `git worktree add` (its `.git` is a file that points into the project's `.git`). */
function isLinkedWorktree(target) {
  try {
    return statSync(path.join(target, '.git')).isFile()
  } catch {
    return false
  }
}

/**
 * Private clone of the project at `sha` with `branch` checked out.
 *
 * It is a clone, not a `git worktree`, on purpose: a linked worktree keeps its index, refs and
 * objects in the project's own `.git`, which lies outside the folder a sandboxed agent may write to,
 * so every commit would need the user's approval. A clone has a `.git` of its own inside its folder.
 * Objects are hard-linked where the file system allows it, so it is quick and small.
 */
async function cloneAt({ repo, target, sha, branch }) {
  await git(['clone', '--local', '--no-checkout', '--quiet', repo, target], { timeout: LONG })
  await git(['checkout', '--quiet', '-b', branch, sha], { cwd: target, timeout: LONG })
  for (const key of COPIED_CONFIG) {
    const value = await git(['config', '--get', key], { cwd: repo }).catch(() => '')
    if (value !== '') await git(['config', key, value], { cwd: target })
  }
  // The agent may read the project through `origin` (fetch), but cannot push to it.
  await git(['remote', 'set-url', '--push', 'origin', 'push-disabled-by-dsh-issues'], { cwd: target })
}

/**
 * Create the working copy for an issue, or reuse the one from an earlier attempt.
 * @param {{ repo: string, worktreeRoot?: string, baseRef?: string, issue: { id: string, title: string } }} options
 * @returns {Promise<{ path: string, branch: string, reused: boolean }>}
 */
export async function ensureWorktree({ repo, worktreeRoot, baseRef = 'HEAD', issue }) {
  const root = worktreeRoot ?? path.join(path.dirname(repo), '.dsh-worktrees', path.basename(repo))
  const target = path.join(root, issue.id.toLowerCase())
  const branch = branchName(issue)

  if (existsSync(target)) {
    // The checked-out branch wins over the name derived from the current title: the issue may have been renamed.
    if (isLinkedWorktree(target)) return { path: target, branch: await currentBranch(target) ?? branch, reused: true }
    const origin = await git(['config', '--get', 'remote.origin.url'], { cwd: target }).catch(() => '')
    if (origin !== '' && sameDirectory(origin, repo)) return { path: target, branch: await currentBranch(target) ?? branch, reused: true }
    throw new Error(`${target} exists but is not a checkout of ${repo}; remove it or choose another worktreeRoot`)
  }
  // registrations of older linked worktrees whose folder is gone
  await git(['worktree', 'prune'], { cwd: repo }).catch(() => undefined)
  await mkdir(root, { recursive: true })
  const start = await exists(repo, `refs/heads/${branch}`) ? `refs/heads/${branch}` : baseRef
  const sha = await git(['rev-parse', '--verify', `${start}^{commit}`], { cwd: repo })
  await cloneAt({ repo, target, sha, branch })
  return { path: target, branch, reused: false }
}

/**
 * Copy a branch from a working copy into the project's repository, so it can be reviewed and merged there.
 * Only a fast-forward is accepted unless `force` is set (merge branches are disposable).
 * A working copy that is gone, or a legacy linked worktree, already shares the project's branches.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export function importBranch(options) {
  return serialized(options.repo, () => importNow(options))
}

async function importNow({ repo, clone, branch, force = false }) {
  // checked inside the queue: the clone may have been removed by a cleanup that ran first
  if (clone === undefined || !existsSync(clone) || isLinkedWorktree(clone)) return { ok: true }
  try {
    await git(['fetch', '--no-tags', '--quiet', clone, `${force ? '+' : ''}refs/heads/${branch}:refs/heads/${branch}`], { cwd: repo, timeout: LONG })
    return { ok: true }
  } catch (error) {
    const reason = String(error?.stderr ?? error?.message ?? error).trim().split('\n').filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: `could not copy branch ${branch} from ${clone} into ${repo}: ${reason}` }
  }
}

/** Name of the checked-out branch, or undefined for a detached HEAD. */
export async function currentBranch(repo) {
  try {
    const name = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo })
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

async function exists(repo, ref) {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], { cwd: repo })
    return true
  } catch {
    return false
  }
}

export async function isAncestor(repo, ancestor, descendant) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo })
    return true
  } catch {
    return false
  }
}

/** Branch the merge agent builds the merge on, e.g. `merge/iss-12`. */
export function mergeBranchName(issue) {
  return `merge/${issue.id.toLowerCase()}`
}

/**
 * Fresh working copy for a merge agent: a clone with a new branch cut from the current tip of the
 * base branch, and the issue branch available as a local branch. Leftovers of an earlier attempt are
 * discarded; they only ever held a merge attempt.
 * @returns {Promise<{ path: string, branch: string }>}
 */
export async function ensureMergeWorktree({ repo, worktreeRoot, baseBranch, issueBranch, issue }) {
  const root = worktreeRoot ?? path.join(path.dirname(repo), '.dsh-worktrees', path.basename(repo))
  const target = path.join(root, `merge-${issue.id.toLowerCase()}`)
  const branch = mergeBranchName(issue)
  await removeCheckout(repo, target)
  if (await exists(repo, `refs/heads/${branch}`)) await git(['branch', '-D', branch], { cwd: repo })
  await mkdir(root, { recursive: true })
  const sha = await git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`], { cwd: repo })
  await cloneAt({ repo, target, sha, branch })
  if (issueBranch !== undefined) {
    await git(['fetch', '--no-tags', '--quiet', repo, `refs/heads/${issueBranch}:refs/heads/${issueBranch}`], { cwd: target, timeout: LONG })
  }
  return { path: target, branch }
}

/**
 * Delete a working copy: a clone is removed as a folder, a legacy linked worktree through git.
 * Only folders the tracker itself names (`iss-<n>`, `merge-iss-<n>`) are ever deleted.
 */
async function removeCheckout(repo, target) {
  if (!CHECKOUT_NAME.test(path.basename(target))) throw new Error(`refusing to delete ${target}: not a folder created by dsh-issues`)
  if (isLinkedWorktree(target)) {
    try {
      await git(['worktree', 'remove', '--force', target], { cwd: repo })
    } catch {
      // not a registered worktree, or already gone
    }
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  await git(['worktree', 'prune'], { cwd: repo }).catch(() => undefined)
}

/**
 * Bring the base branch's newest commits into the merge branch (used when the base moved while the merge agent worked).
 * @returns {Promise<{ ok: true } | { ok: false, files: string[] }>}
 */
export async function refreshMergeBranch({ repo, mergeWorktree, baseBranch }) {
  try {
    await git(['fetch', '--no-tags', '--quiet', repo, `refs/heads/${baseBranch}`], { cwd: mergeWorktree, timeout: LONG })
    await git(['merge', '--no-edit', 'FETCH_HEAD'], { cwd: mergeWorktree })
    return { ok: true }
  } catch {
    let files = []
    try {
      files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: mergeWorktree })).split(/\r?\n/).filter(Boolean)
    } catch { /* keep empty */ }
    await git(['merge', '--abort'], { cwd: mergeWorktree }).catch(() => undefined)
    return { ok: false, files }
  }
}

/**
 * Move the base branch to the finished merge, fast-forward only. Nothing is forced:
 * a checked-out base branch is advanced with `merge --ff-only` (which refuses to overwrite local changes),
 * any other base branch with a compare-and-set `update-ref`.
 * @returns {Promise<{ ok: true, sha: string, changed: boolean } | { ok: false, code: string, message: string }>}
 */
export async function integrate({ repo, baseBranch, mergeBranch, issueBranch, mergeWorktree }) {
  try {
    if (mergeWorktree !== undefined) {
      const dirty = await git(['status', '--porcelain'], { cwd: mergeWorktree })
      if (dirty !== '') return { ok: false, code: 'uncommitted', message: 'The merge worktree has uncommitted changes or an unfinished merge; commit or abort it first.' }
      const imported = await importBranch({ repo, clone: mergeWorktree, branch: mergeBranch, force: true })
      if (!imported.ok) return { ok: false, code: 'git-error', message: imported.message }
    }
    const base = await git(['rev-parse', `refs/heads/${baseBranch}`], { cwd: repo })
    const merged = await git(['rev-parse', `refs/heads/${mergeBranch}`], { cwd: repo })
    const issueTip = await git(['rev-parse', `refs/heads/${issueBranch}`], { cwd: repo })
    if (!await isAncestor(repo, issueTip, merged)) {
      return { ok: false, code: 'not-merged', message: `Branch ${mergeBranch} does not contain all commits of ${issueBranch}.` }
    }
    if (merged === base) return { ok: true, sha: base, changed: false }
    if (!await isAncestor(repo, base, merged)) {
      return { ok: false, code: 'base-moved', message: `${baseBranch} gained new commits since the merge branch was created.` }
    }
    if (await currentBranch(repo) === baseBranch) {
      try {
        await git(['merge', '--ff-only', merged], { cwd: repo })
      } catch (error) {
        return { ok: false, code: 'ff-failed', message: `Could not fast-forward the checked-out ${baseBranch}: ${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]}` }
      }
    } else {
      try {
        await git(['update-ref', `refs/heads/${baseBranch}`, merged, base], { cwd: repo })
      } catch (error) {
        return { ok: false, code: 'ff-failed', message: `Could not update ${baseBranch}: ${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]}` }
      }
    }
    return { ok: true, sha: merged, changed: true }
  } catch (error) {
    return { ok: false, code: 'git-error', message: String(error?.stderr ?? error?.message ?? error).trim() }
  }
}

/**
 * Remove merge leftovers. A branch is only deleted when its tip is contained in the base branch.
 * @returns {Promise<string[]>} warnings for steps that did not work
 */
export async function cleanupAfterMerge({ repo, baseBranch, mergeWorktree, mergeBranch, issueWorktree, issueBranch }) {
  const warnings = []
  for (const target of [mergeWorktree, issueWorktree]) {
    if (target === undefined) continue
    await removeCheckout(repo, target).catch(error => warnings.push(String(error?.message ?? error)))
    if (existsSync(target)) warnings.push(`could not remove ${target}`)
  }
  for (const branch of [mergeBranch, issueBranch]) {
    if (branch === undefined || !await exists(repo, `refs/heads/${branch}`)) continue
    if (!await isAncestor(repo, `refs/heads/${branch}`, `refs/heads/${baseBranch}`)) {
      warnings.push(`kept branch ${branch}: not contained in ${baseBranch}`)
      continue
    }
    try {
      await git(['branch', '-D', branch], { cwd: repo })
    } catch (error) {
      warnings.push(`could not delete branch ${branch}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  return warnings
}

/** Remove a merge worktree and its branch without any merge having happened (conflict or failure). */
export async function discardMerge({ repo, mergeWorktree, mergeBranch }) {
  if (mergeWorktree !== undefined) await removeCheckout(repo, mergeWorktree)
  if (mergeBranch !== undefined && await exists(repo, `refs/heads/${mergeBranch}`)) {
    await git(['branch', '-D', mergeBranch], { cwd: repo }).catch(() => undefined)
  }
}

/**
 * Remove a working copy unless it holds uncommitted work. With `branch`, its commits are first
 * copied into the project's repository; the copy stays when that does not work.
 * @returns {Promise<{ removed: boolean, reason?: string }>}
 */
export function removeWorktreeIfClean({ repo, target, branch }) {
  return serialized(repo, async () => {
    if (existsSync(target)) {
      try {
        const dirty = await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: target })
        if (dirty !== '') return { removed: false, reason: 'it has uncommitted changes (commit or discard them, then remove the folder yourself)' }
      } catch (error) {
        return { removed: false, reason: `its state could not be read: ${String(error?.message ?? error).split('\n')[0]}` }
      }
      if (branch !== undefined) {
        const imported = await importNow({ repo, clone: target, branch })
        if (!imported.ok) return { removed: false, reason: imported.message }
      }
    }
    try {
      await removeCheckout(repo, target)
    } catch (error) {
      return { removed: false, reason: String(error?.message ?? error) }
    }
    return existsSync(target) ? { removed: false, reason: 'the folder could not be removed' } : { removed: true }
  })
}
