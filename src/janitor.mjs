/**
 * Housekeeping for what the tracker creates: git worktrees of finished issues and the
 * workspace entries the harness keeps for them. Nothing is removed while an agent still
 * runs in the workspace, work that is not committed is never thrown away, and branches
 * are not touched here (a branch holds the work until it is merged).
 */
import { existsSync } from 'node:fs'
import { projectKey } from './store.mjs'

export const JANITOR_DEFAULTS = {
  /** Remove the worktree of an issue once it is done or cancelled (the branch stays). */
  cleanupOnClose: true,
  /** Remove the harness workspace entries of removed worktrees. */
  forgetWorkspaces: true,
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export class Janitor {
  #store
  #git
  #workspaces
  #config
  #log
  #running
  #again = false
  #warned = new Set()

  /**
   * @param {object} options
   * @param {import('./store.mjs').IssueStore} options.store
   * @param {{ repoRoot(dir: string): Promise<string | undefined>, removeWorktreeIfClean(options: { repo: string, target: string, branch?: string }): Promise<{ removed: boolean, reason?: string }> }} options.git
   * @param {{ list(): Array<{ id: string, path: string }>, busy(workspace: { id: string, path: string }): boolean, remove(id: string): Promise<unknown>, isMissing(workspace: { id: string, path: string }): Promise<boolean> }} options.workspaces
   * @param {Partial<typeof JANITOR_DEFAULTS>} [options.config]
   * @param {{ info?: Function, warn?: Function }} [options.logger]
   */
  constructor({ store, git, workspaces, config = {}, logger = {} }) {
    this.#store = store
    this.#git = git
    this.#workspaces = workspaces
    this.#config = { ...JANITOR_DEFAULTS, ...config }
    this.#log = logger
  }

  /** Run one sweep; concurrent calls coalesce into at most one extra sweep. */
  sweep() {
    if (this.#running !== undefined) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      do {
        this.#again = false
        try {
          await this.#pass()
        } catch (error) {
          this.#log.warn?.(`dsh-issues: cleanup failed: ${describe(error)}`)
        }
      } while (this.#again)
    })().finally(() => { this.#running = undefined })
    return this.#running
  }

  async stop() {
    await this.#running
  }

  #workspaceAt(target) {
    const key = projectKey(target)
    return this.#workspaces.list().find(workspace => projectKey(workspace.path) === key)
  }

  async #pass() {
    const issues = this.#store.list({ limit: Number.MAX_SAFE_INTEGER })
    const ours = new Set()
    for (const issue of issues) {
      if (issue.worktreePath !== undefined) ours.add(projectKey(issue.worktreePath))
      if (issue.merge?.worktreePath !== undefined) ours.add(projectKey(issue.merge.worktreePath))
    }

    // 1. Worktrees of closed issues and finished merges.
    if (this.#config.cleanupOnClose) {
      for (const issue of issues) {
        if (!['done', 'cancelled'].includes(issue.status)) continue
        if (issue.worktreePath !== undefined && !issue.worktreeRemoved) {
          await this.#remove(issue, issue.worktreePath, issue.branch, 'the issue worktree', () => this.#store.setWorktreeRemoved(issue.id, 'issue'))
        }
        const merge = issue.merge
        if (merge?.worktreePath !== undefined && merge.status !== 'running' && !merge.worktreeRemoved) {
          await this.#remove(issue, merge.worktreePath, undefined, 'the merge worktree', () => this.#store.setWorktreeRemoved(issue.id, 'merge'))
        }
      }
    }

    // 2. Workspace entries whose directory is gone.
    if (this.#config.forgetWorkspaces) {
      for (const workspace of this.#workspaces.list()) {
        if (!ours.has(projectKey(workspace.path)) && !isWorktreeDir(workspace.path)) continue
        if (this.#workspaces.busy(workspace)) continue
        if (!await this.#workspaces.isMissing(workspace)) continue
        try {
          await this.#workspaces.remove(workspace.id)
          this.#log.info?.(`dsh-issues: removed the workspace entry of ${workspace.path}`)
        } catch (error) {
          this.#log.warn?.(`dsh-issues: could not remove the workspace entry of ${workspace.path}: ${describe(error)}`)
        }
      }
    }
  }

  async #remove(issue, target, branch, what, mark) {
    const workspace = this.#workspaceAt(target)
    if (workspace !== undefined && this.#workspaces.busy(workspace)) return
    if (existsSync(target)) {
      const repo = await this.#git.repoRoot(issue.project)
      if (repo === undefined) return
      const result = await this.#git.removeWorktreeIfClean({ repo, target, branch })
      if (!result.removed) {
        const key = `${issue.id}:${target}`
        if (!this.#warned.has(key)) {
          this.#warned.add(key)
          await this.#store.addComment(issue.id, {
            author: 'system',
            text: `Kept ${what} ${target}: ${result.reason ?? 'it could not be removed'}.`,
          }).catch(() => undefined)
        }
        return
      }
    }
    await mark().catch(error => this.#log.warn?.(`dsh-issues: could not record the cleanup of ${issue.id}: ${describe(error)}`))
  }
}

function isWorktreeDir(workspacePath) {
  return workspacePath.split(/[\\/]/).includes('.dsh-worktrees')
}
