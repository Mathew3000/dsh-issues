/**
 * Merges accepted issues into their base branch with a small "merge agent".
 *
 * The agent works in a throwaway worktree on `merge/iss-N` (cut from the base
 * branch) and reports `ready` or `conflict`. This module does everything that
 * must be exact itself: it verifies the result, fast-forwards the base branch
 * without forcing anything, cleans up, and turns a failed merge into a new issue.
 * Free of harness imports, like the dispatcher.
 */
import path from 'node:path'
import { IssueError, projectKey } from './store.mjs'
import { mergeObjective, mergePrompt } from './prompts.mjs'

export const MERGE_DEFAULTS = Object.freeze({
  maxMergeRounds: 24,
  maxConcurrentMerges: 2,
  cleanupAfterMerge: true,
  resumeOnStart: true,
})

const SUMMARY_LIMIT = 4000

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function clip(value, limit) {
  const textValue = String(value ?? '').trim()
  return textValue.length > limit ? `${textValue.slice(0, limit - 1)}…` : textValue
}

export class MergeCoordinator {
  #store
  #sessions
  #git
  #config
  #log
  #running
  #again = false
  #stopped = false
  #ended = new Map()
  #lastText = new Map()

  /**
   * @param {object} options
   * @param {import('./store.mjs').IssueStore} options.store
   * @param {{ start(request: object): Promise<{ sessionId: string, goalId?: string }>, resume(sessionId: string, options: { rearm: boolean }): Promise<object> }} options.sessions
   * @param {object} options.git helpers from git.mjs
   * @param {object} [options.config]
   * @param {{ info?: Function, warn?: Function }} [options.logger]
   */
  constructor({ store, sessions, git, config = {}, logger = {} }) {
    this.#store = store
    this.#sessions = sessions
    this.#git = git
    this.#config = { ...MERGE_DEFAULTS, ...config }
    this.#log = logger
  }

  /** Start waiting merges within the limits; concurrent calls coalesce into one extra pass. */
  tick() {
    if (this.#stopped) return Promise.resolve()
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
          this.#log.warn?.(`dsh-issues: merge pass failed: ${describe(error)}`)
        }
      } while (this.#again && !this.#stopped)
    })().finally(() => { this.#running = undefined })
    return this.#running
  }

  async stop() {
    this.#stopped = true
    await this.#running
  }

  #active() {
    return this.#store.list({ status: 'done', limit: Number.MAX_SAFE_INTEGER }).filter(issue => issue.merge?.status === 'running')
  }

  async #pass() {
    const active = this.#active()
    let total = active.length
    const busy = new Set(active.map(issue => projectKey(issue.project)))
    for (const candidate of this.#store.mergeQueue()) {
      if (this.#stopped || total >= this.#config.maxConcurrentMerges) return
      const key = projectKey(candidate.project)
      if (busy.has(key)) continue
      const issue = await this.#store.claimMerge(candidate.id)
      if (issue === undefined) continue
      busy.add(key)
      total += 1
      await this.#start(issue)
    }
  }

  async #skip(issue, message) {
    await this.#store.setMerge(issue.id, { status: 'skipped', message }, { comment: `Auto-merge skipped: ${message}` })
  }

  async #start(issue) {
    let worktree
    let repo
    try {
      if (issue.branch === undefined) return await this.#skip(issue, 'the issue was not worked on in its own branch (no git worktree).')
      if (issue.baseBranch === undefined) return await this.#skip(issue, 'the branch to merge into is unknown (detached HEAD when the work started).')
      repo = await this.#git.repoRoot(issue.project)
      if (repo === undefined) return await this.#skip(issue, `${issue.project} is no longer inside a git repository.`)
      // The issue's commits live in its own clone; bring them into the project repository first.
      const imported = await this.#git.importBranch({ repo, clone: issue.worktreePath, branch: issue.branch })
      if (!imported.ok) throw new Error(imported.message)
      worktree = await this.#git.ensureMergeWorktree({ repo, worktreeRoot: this.#config.worktreeRoot, baseBranch: issue.baseBranch, issueBranch: issue.branch, issue })
      const context = { workdir: worktree.path, mergeBranch: worktree.branch, issueBranch: issue.branch, baseBranch: issue.baseBranch, projectPath: issue.project }
      const started = await this.#sessions.start({
        issueId: issue.id,
        workspacePath: worktree.path,
        title: `Merge ${issue.id} · ${issue.title}`.slice(0, 100),
        prompt: mergePrompt(issue, context),
        objective: mergeObjective(issue, context),
        maxGoalRounds: this.#config.maxMergeRounds,
      })
      await this.#store.setMerge(issue.id, {
        status: 'running',
        startedAt: issue.merge?.startedAt,
        sessionId: started.sessionId,
        goalId: started.goalId,
        branch: worktree.branch,
        worktreePath: worktree.path,
        baseBranch: issue.baseBranch,
      }, { comment: `Merge agent started in session ${started.sessionId} (${issue.branch} → ${issue.baseBranch}).` })
      this.#log.info?.(`dsh-issues: merging ${issue.id} in session ${started.sessionId}`)
    } catch (error) {
      this.#log.warn?.(`dsh-issues: could not start the merge of ${issue.id}: ${describe(error)}`)
      if (repo !== undefined && worktree !== undefined) {
        await this.#git.discardMerge({ repo, mergeWorktree: worktree.path, mergeBranch: worktree.branch }).catch(() => undefined)
      }
      await this.#store.setMerge(issue.id, { status: 'failed', message: `Could not start the merge agent: ${describe(error)}` },
        { comment: `Auto-merge could not start: ${describe(error)}. Use "Retry merge" after fixing the cause.` }).catch(() => undefined)
    }
  }

  /**
   * Result reported by the merge agent through the issue_merge_report tool.
   * @returns {Promise<string>} text for the agent
   */
  async report(issueId, { outcome, summary, followUpTitle, followUpDescription }) {
    const issue = this.#store.get(issueId)
    if (issue === undefined || issue.merge?.status !== 'running') {
      throw new IssueError('conflict', `${issueId} has no merge in progress`)
    }
    const note = clip(summary, SUMMARY_LIMIT)
    if (outcome === 'ready') return await this.#complete(issue, note)
    if (outcome === 'conflict') {
      const description = clip(followUpDescription, 15_000)
      if (description === '') throw new IssueError('invalid-input', 'outcome "conflict" needs follow_up_description')
      await this.#conflict(issue, {
        title: clip(followUpTitle, 120) || `Resolve merge conflict of ${issue.id}`,
        description,
        note,
      })
      return 'Recorded. A follow-up issue was opened for the conflict and the merge worktree was removed. Stop here.'
    }
    throw new IssueError('invalid-input', 'outcome must be "ready" or "conflict"')
  }

  async #complete(issue, note) {
    const repo = await this.#git.repoRoot(issue.project)
    if (repo === undefined) throw new IssueError('conflict', `${issue.project} is not inside a git repository`)
    const args = {
      repo,
      baseBranch: issue.merge.baseBranch ?? issue.baseBranch,
      mergeBranch: issue.merge.branch,
      issueBranch: issue.branch,
      mergeWorktree: issue.merge.worktreePath,
    }
    let result = await this.#git.integrate(args)
    if (!result.ok && result.code === 'base-moved') {
      const refreshed = await this.#git.refreshMergeBranch({ repo, mergeWorktree: args.mergeWorktree, baseBranch: args.baseBranch })
      if (!refreshed.ok) {
        const files = refreshed.files.length === 0 ? '' : `\n\nConflicting files: ${refreshed.files.map(file => `\`${file}\``).join(', ')}`
        await this.#conflict(issue, {
          title: `Resolve merge conflict of ${issue.id}`,
          description: `While ${issue.id} was being merged, \`${args.baseBranch}\` received new commits that conflict with the issue's work.${files}`,
          note,
        })
        return 'Recorded: the base branch moved on and the new commits conflict; a follow-up issue was opened. Stop here.'
      }
      result = await this.#git.integrate(args)
    }
    if (!result.ok) {
      if (result.code === 'uncommitted' || result.code === 'not-merged') {
        throw new IssueError('invalid-input', `${result.message} Fix that and call issue_merge_report again.`)
      }
      await this.#store.setMerge(issue.id, { ...issue.merge, status: 'failed', message: result.message },
        { comment: `Auto-merge failed: ${result.message} The merged result is on branch ${args.mergeBranch} (worktree ${args.mergeWorktree}); finish it by hand, then use "Retry merge" if you like.` })
      return `The merged result could not be moved onto ${args.baseBranch}: ${result.message} A person has to take over. Stop here.`
    }
    let warnings = []
    if (this.#config.cleanupAfterMerge) {
      warnings = await this.#git.cleanupAfterMerge({
        repo,
        baseBranch: args.baseBranch,
        mergeWorktree: args.mergeWorktree,
        mergeBranch: args.mergeBranch,
        issueWorktree: issue.worktreePath,
        issueBranch: issue.branch,
      })
    }
    const short = result.sha.slice(0, 8)
    const message = result.changed ? `Merged into ${args.baseBranch} at ${short}.` : `Already contained in ${args.baseBranch} (${short}).`
    await this.#store.setMerge(issue.id, { ...issue.merge, status: 'merged', baseBranch: args.baseBranch, sha: result.sha, message },
      { comment: `${message}${note === '' ? '' : `\n\n${note}`}${warnings.length === 0 ? '' : `\n\nCleanup: ${warnings.join('; ')}`}` })
    if (issue.mergeOf !== undefined) {
      await this.#settleOrigin(issue, repo, args.baseBranch, result.sha)
    }
    return `Merged into ${args.baseBranch} (${short}). You are done; do not change anything else.`
  }

  /** A follow-up that resolved a conflict also settles the issue whose merge had failed. */
  async #settleOrigin(issue, repo, baseBranch, sha) {
    const origin = this.#store.get(issue.mergeOf)
    if (origin === undefined || origin.merge?.status !== 'conflict') return
    let warnings = []
    if (this.#config.cleanupAfterMerge) {
      warnings = await this.#git.cleanupAfterMerge({ repo, baseBranch, issueWorktree: origin.worktreePath, issueBranch: origin.branch })
    }
    await this.#store.setMerge(origin.id, { ...origin.merge, status: 'merged', baseBranch, sha, message: `Merged into ${baseBranch} through ${issue.id}.` },
      { comment: `Merged into ${baseBranch} through ${issue.id} (${sha.slice(0, 8)}).${warnings.length === 0 ? '' : ` Cleanup: ${warnings.join('; ')}`}` })
  }

  async #conflict(issue, { title, description, note }) {
    const repo = await this.#git.repoRoot(issue.project)
    if (repo !== undefined) {
      await this.#git.discardMerge({ repo, mergeWorktree: issue.merge?.worktreePath, mergeBranch: issue.merge?.branch })
    }
    const base = issue.merge?.baseBranch ?? issue.baseBranch
    const follow = await this.#store.create({
      project: issue.project,
      title,
      description: [
        description,
        '',
        '---',
        `Follow-up of ${issue.id} (${issue.title}). The accepted work is on branch \`${issue.branch}\`; this issue's branch starts from it.`,
        `Goal: bring the latest \`${base}\` into your branch (git fetch origin, then git merge origin/${base}), resolve the conflicts so both sides' intent survives, make the tests pass, and commit. Accepting this issue merges everything into \`${base}\` automatically.`,
      ].join('\n'),
      priority: 'high',
      labels: ['merge-conflict'],
      autoMerge: true,
      baseRef: issue.branch,
      baseBranch: base,
      mergeOf: issue.id,
    })
    await this.#store.setMerge(issue.id, { ...issue.merge, status: 'conflict', baseBranch: base, followUpId: follow.id, message: clip(note || description, 500) },
      { comment: `Merge into ${base} was not possible automatically. Follow-up issue ${follow.id} was opened.${note === '' ? '' : `\n\n${note}`}` })
    this.#log.info?.(`dsh-issues: merge of ${issue.id} conflicted; opened ${follow.id}`)
    return follow
  }

  /* ---------- events from the harness ---------- */

  onAssistantMessage(sessionId, body) {
    if (typeof body !== 'string' || body.trim() === '') return
    this.#lastText.delete(sessionId)
    this.#lastText.set(sessionId, body.trim())
    if (this.#lastText.size > 100) this.#lastText.delete(this.#lastText.keys().next().value)
  }

  /** The goal of a merge session ended; whether it reported is decided when the agent goes idle. */
  async onGoalChanged({ sessionId, change }) {
    const issue = this.#store.byMergeSession(sessionId, { running: true })
    if (issue === undefined) return
    const goal = change?.goal
    if (goal === undefined || goal === null || goal.phase === 'complete' || goal.phase === 'blocked') {
      this.#ended.set(sessionId, goal?.blockedReason?.message ?? goal?.phase ?? 'goal cleared')
    }
  }

  async onAgentIdle(sessionId) {
    if (!this.#ended.has(sessionId)) return
    const how = this.#ended.get(sessionId)
    this.#ended.delete(sessionId)
    const issue = this.#store.byMergeSession(sessionId, { running: true })
    if (issue === undefined) return
    await this.#unreported(issue, how)
  }

  async #unreported(issue, how) {
    const last = this.#lastText.get(issue.merge.sessionId)
    try {
      await this.#conflict(issue, {
        title: `Resolve merge conflict of ${issue.id}`,
        description: `The merge agent stopped (${how}) without reporting a result, so the merge of \`${issue.branch}\` into \`${issue.baseBranch}\` is not done.${last === undefined ? '' : `\n\nIts last message:\n\n${clip(last, 3000)}`}`,
        note: '',
      })
    } catch (error) {
      this.#log.warn?.(`dsh-issues: could not record the failed merge of ${issue.id}: ${describe(error)}`)
    }
  }

  /** After a restart: re-attach to merge agents that were running. */
  async resumeInterrupted() {
    for (const issue of this.#active()) {
      if (this.#stopped) return
      try {
        if (issue.merge.sessionId === undefined) {
          await this.#store.setMerge(issue.id, undefined, { comment: 'Merge was interrupted before an agent started; it will be started again.' })
          continue
        }
        const result = await this.#sessions.resume(issue.merge.sessionId, { rearm: this.#config.resumeOnStart })
        if (!result.ok) {
          if (result.reason === 'not-found') await this.#unreported(issue, 'its session no longer exists')
          else this.#log.warn?.(`dsh-issues: merge session of ${issue.id} unavailable after restart: ${result.message}`)
          continue
        }
        const phase = result.goal?.phase
        if (phase === 'complete' || phase === 'blocked') await this.#unreported(issue, `goal ${phase}`)
      } catch (error) {
        this.#log.warn?.(`dsh-issues: could not recover the merge of ${issue.id}: ${describe(error)}`)
      }
    }
  }
}
