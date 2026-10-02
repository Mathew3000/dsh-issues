/** Git helpers: one worktree and branch per issue. No shell is involved; arguments are passed as an array. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
  try {
    return path.resolve(await git(['rev-parse', '--show-toplevel'], { cwd: dir }))
  } catch {
    return undefined
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

/**
 * Create the worktree for an issue, or reuse the one from an earlier attempt.
 * @param {{ repo: string, worktreeRoot?: string, baseRef?: string, issue: { id: string, title: string } }} options
 * @returns {Promise<{ path: string, branch: string, reused: boolean }>}
 */
export async function ensureWorktree({ repo, worktreeRoot, baseRef = 'HEAD', issue }) {
  const root = worktreeRoot ?? path.join(path.dirname(repo), '.dsh-worktrees', path.basename(repo))
  const target = path.join(root, issue.id.toLowerCase())
  const branch = branchName(issue)

  const listing = await git(['worktree', 'list', '--porcelain'], { cwd: repo })
  const known = listing.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
  if (known.some(entry => sameDirectory(entry, target))) {
    if (!existsSync(target)) await git(['worktree', 'prune'], { cwd: repo })
    else return { path: target, branch, reused: true }
  }
  if (existsSync(target)) {
    throw new Error(`worktree path ${target} exists but is not a worktree of ${repo}; remove it or choose another worktreeRoot`)
  }

  await mkdir(root, { recursive: true })
  let branchExists = true
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
  } catch {
    branchExists = false
  }
  await git(branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, baseRef], { cwd: repo })
  return { path: target, branch, reused: false }
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
 * Fresh worktree for a merge agent: a new branch cut from the current tip of the
 * base branch. Leftovers of an earlier attempt are discarded; they only ever held a merge attempt.
 * @returns {Promise<{ path: string, branch: string }>}
 */
export async function ensureMergeWorktree({ repo, worktreeRoot, baseBranch, issue }) {
  const root = worktreeRoot ?? path.join(path.dirname(repo), '.dsh-worktrees', path.basename(repo))
  const target = path.join(root, `merge-${issue.id.toLowerCase()}`)
  const branch = mergeBranchName(issue)
  await removeWorktree(repo, target)
  if (await exists(repo, `refs/heads/${branch}`)) await git(['branch', '-D', branch], { cwd: repo })
  await mkdir(root, { recursive: true })
  await git(['worktree', 'add', '-b', branch, target, `refs/heads/${baseBranch}`], { cwd: repo })
  return { path: target, branch }
}

async function removeWorktree(repo, target) {
  try {
    await git(['worktree', 'remove', '--force', target], { cwd: repo })
  } catch {
    // not a registered worktree, or already gone
  }
  await git(['worktree', 'prune'], { cwd: repo }).catch(() => undefined)
}

/**
 * Bring the base branch's newest commits into the merge branch (used when the base moved while the merge agent worked).
 * @returns {Promise<{ ok: true } | { ok: false, files: string[] }>}
 */
export async function refreshMergeBranch({ mergeWorktree, baseBranch }) {
  try {
    await git(['merge', '--no-edit', `refs/heads/${baseBranch}`], { cwd: mergeWorktree })
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
    const base = await git(['rev-parse', `refs/heads/${baseBranch}`], { cwd: repo })
    const merged = await git(['rev-parse', `refs/heads/${mergeBranch}`], { cwd: repo })
    const issueTip = await git(['rev-parse', `refs/heads/${issueBranch}`], { cwd: repo })
    if (mergeWorktree !== undefined) {
      const dirty = await git(['status', '--porcelain'], { cwd: mergeWorktree })
      if (dirty !== '') return { ok: false, code: 'uncommitted', message: 'The merge worktree has uncommitted changes or an unfinished merge; commit or abort it first.' }
    }
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
    await removeWorktree(repo, target)
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
  if (mergeWorktree !== undefined) await removeWorktree(repo, mergeWorktree)
  if (mergeBranch !== undefined && await exists(repo, `refs/heads/${mergeBranch}`)) {
    await git(['branch', '-D', mergeBranch], { cwd: repo }).catch(() => undefined)
  }
}
