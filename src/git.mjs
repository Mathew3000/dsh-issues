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
