/**
 * Starts sessions for open issues and keeps issue status in step with the goal
 * of the session that works on them. Free of harness imports: everything
 * harness-specific arrives through the `sessions` adapter.
 */
import path from 'node:path'
import { goalObjective, issuePrompt } from './prompts.mjs'
import { projectKey } from './store.mjs'

export const DEFAULTS = Object.freeze({
  maxConcurrent: 2,
  maxPerProject: 1,
  isolation: 'auto',
  maxGoalRounds: 64,
  maxAttempts: 3,
  completeStatus: 'needs_review',
  resumeOnStart: true,
})

const PAUSED = 'paused'
const SUMMARY_LIMIT = 4000

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export class Dispatcher {
  #store
  #sessions
  #git
  #config
  #log
  #running
  #again = false
  #stopped = false
  #pendingSummary = new Set()
  #lastText = new Map()
  #goalWork = Promise.resolve()

  /**
   * @param {object} options
   * @param {import('./store.mjs').IssueStore} options.store
   * @param {{ start(request: object): Promise<{ sessionId: string, goalId?: string }>, resume(sessionId: string, options: { rearm: boolean }): Promise<object>, halt(sessionId: string): Promise<void> }} options.sessions
   * @param {{ repoRoot(dir: string): Promise<string | undefined>, ensureWorktree(options: object): Promise<{ path: string, branch: string }> }} options.git
   * @param {Partial<typeof DEFAULTS> & { worktreeRoot?: string, baseRef?: string }} [options.config]
   * @param {{ info?: Function, warn?: Function }} [options.logger]
   */
  constructor({ store, sessions, git, config = {}, logger = {} }) {
    this.#store = store
    this.#sessions = sessions
    this.#git = git
    this.#config = { ...DEFAULTS, ...config }
    this.#log = logger
  }

  /** Run one dispatch pass; concurrent calls coalesce into at most one extra pass. */
  tick() {
    if (this.#stopped) return Promise.resolve()
    if (this.#running !== undefined) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false
          await this.#pass()
        } while (this.#again && !this.#stopped)
      } finally {
        this.#running = undefined
      }
    })()
    return this.#running
  }

  /** Stop dispatching and wait for the pass in flight. */
  async stop() {
    this.#stopped = true
    await this.#running
  }

  async #pass() {
    const active = this.#store.list({ status: 'in_progress', limit: Number.MAX_SAFE_INTEGER })
    let total = active.length
    const perProject = new Map()
    for (const issue of active) {
      const key = projectKey(issue.project)
      perProject.set(key, (perProject.get(key) ?? 0) + 1)
    }
    for (const candidate of this.#store.queue()) {
      if (this.#stopped || total >= this.#config.maxConcurrent) return
      let plan
      try {
        plan = await this.#plan(candidate)
      } catch (error) {
        await this.#block(candidate, 'cannot-start', describe(error))
        continue
      }
      const key = projectKey(candidate.project)
      const limit = plan.mode === 'none' ? 1 : this.#config.maxPerProject
      if ((perProject.get(key) ?? 0) >= limit) continue
      if (await this.#launch(candidate, plan)) {
        total += 1
        perProject.set(key, (perProject.get(key) ?? 0) + 1)
      }
    }
  }

  async #plan(issue) {
    const repo = await this.#git.repoRoot(issue.project)
    const { isolation } = this.#config
    if (isolation === 'worktree' && repo === undefined) {
      throw new Error(`isolation is "worktree" but ${issue.project} is not inside a git repository`)
    }
    const mode = isolation === 'none' || repo === undefined ? 'none' : 'worktree'
    return { mode, repo, relative: repo === undefined ? '' : path.relative(repo, path.resolve(issue.project)) }
  }

  async #block(issue, code, message) {
    try {
      await this.#store.transition(issue.id, 'blocked', { from: 'open', reason: { code, message } })
      this.#log.warn?.(`dsh-issues: ${issue.id} blocked (${code}): ${message}`)
    } catch (error) {
      this.#log.warn?.(`dsh-issues: could not block ${issue.id}: ${describe(error)}`)
    }
  }

  async #launch(candidate, plan) {
    const issue = await this.#store.claim(candidate.id)
    if (issue === undefined) return false
    let started
    try {
      let workdir = issue.project
      let branch
      let worktreePath
      let baseBranch
      if (plan.mode === 'worktree') {
        baseBranch = issue.baseBranch ?? await this.#git.currentBranch?.(plan.repo)
        const worktree = await this.#git.ensureWorktree({
          repo: plan.repo,
          worktreeRoot: this.#config.worktreeRoot,
          baseRef: issue.baseRef ?? this.#config.baseRef,
          issue,
        })
        branch = worktree.branch
        worktreePath = worktree.path
        workdir = path.join(worktree.path, plan.relative)
      }
      started = await this.#sessions.start({
        issueId: issue.id,
        workspacePath: workdir,
        title: `${issue.id} · ${issue.title}`.slice(0, 100),
        prompt: issuePrompt(issue, { workdir, projectPath: issue.project, branch, isolation: plan.mode }),
        objective: goalObjective(issue, { branch, isolation: plan.mode }),
        maxGoalRounds: this.#config.maxGoalRounds,
      })
      await this.#store.attach(issue.id, { sessionId: started.sessionId, goalId: started.goalId, branch, worktreePath, baseBranch })
      await this.#store.addComment(issue.id, {
        author: 'system',
        text: `Session ${started.sessionId} started${branch === undefined ? '' : ` on branch ${branch}`}.`,
      })
      this.#log.info?.(`dsh-issues: ${issue.id} started in session ${started.sessionId}`)
      return true
    } catch (error) {
      if (started !== undefined) await this.#sessions.halt(started.sessionId).catch(() => undefined)
      await this.#failStart(issue, error)
      return false
    }
  }

  async #failStart(issue, error) {
    const message = describe(error)
    const failures = (issue.failedStarts ?? 0) + 1
    this.#log.warn?.(`dsh-issues: starting ${issue.id} failed: ${message}`)
    if (failures >= this.#config.maxAttempts) {
      await this.#store.release(issue.id, {
        to: 'blocked',
        failed: true,
        reason: { code: 'start-failed', message: `Could not start after ${failures} attempts: ${message}` },
        comment: `Start failed (attempt ${failures}): ${message}`,
      })
    } else {
      await this.#store.release(issue.id, {
        to: 'open',
        failed: true,
        comment: `Start failed (attempt ${failures}), will retry: ${message}`,
      })
    }
  }

  /**
   * Re-attach to issues that were running when the process stopped. A goal that
   * finished while nobody listened is applied; an active but disarmed goal is
   * re-armed when `resumeOnStart` is on.
   */
  async resumeInterrupted() {
    for (const issue of this.#store.list({ status: 'in_progress', limit: Number.MAX_SAFE_INTEGER })) {
      if (this.#stopped) return
      try {
        if (issue.sessionId === undefined) {
          await this.#store.release(issue.id, { to: 'open', comment: 'Interrupted before a session was attached; re-queued.' })
          continue
        }
        const result = await this.#sessions.resume(issue.sessionId, { rearm: this.#config.resumeOnStart })
        if (!result.ok) {
          if (result.reason === 'not-found') {
            await this.#failStart(issue, new Error(`session ${issue.sessionId} no longer exists`))
          } else {
            this.#log.warn?.(`dsh-issues: ${issue.id} session unavailable after restart: ${result.message}`)
          }
          continue
        }
        if (result.rearmed) {
          await this.#store.addComment(issue.id, { author: 'system', text: 'Goal re-armed after a restart.' })
        }
        await this.#applyGoal(issue, result.goal)
      } catch (error) {
        this.#log.warn?.(`dsh-issues: could not recover ${issue.id}: ${describe(error)}`)
      }
    }
  }

  /** Goal mutation reported by the harness. */
  async onGoalChanged({ sessionId, change }) {
    const work = this.#goalWork.then(async () => {
      const issue = this.#store.bySession(sessionId)
      if (issue !== undefined) await this.#applyGoal(issue, change?.goal)
    })
    this.#goalWork = work.catch(() => undefined)
    await work
  }

  async #applyGoal(issue, goal) {
    const resumedFromPause = issue.status === 'blocked' && issue.blockedReason?.code === PAUSED
    if (issue.status !== 'in_progress' && !resumedFromPause) return
    try {
      if (goal === undefined || goal === null) {
        if (issue.status === 'in_progress') {
          await this.#store.transition(issue.id, 'blocked', { reason: { code: 'goal-cleared', message: 'The session goal was cleared.' } })
        }
        return
      }
      if (goal.phase === 'complete') {
        await this.#store.transition(issue.id, this.#config.completeStatus, {
          comment: `Goal complete after ${goal.roundsStarted ?? '?'} round(s).`,
        })
        this.#pendingSummary.add(issue.id)
      } else if (goal.phase === 'blocked') {
        await this.#store.transition(issue.id, 'blocked', {
          reason: goal.blockedReason ?? { code: 'blocked', message: 'The goal reported a blocker.' },
        })
        this.#pendingSummary.add(issue.id)
      } else if (goal.phase === 'paused') {
        if (issue.status === 'in_progress') {
          await this.#store.transition(issue.id, 'blocked', {
            reason: { code: PAUSED, message: 'The session goal was paused; resume it in the session to continue.' },
          })
        }
      } else if (goal.phase === 'active' && resumedFromPause) {
        await this.#store.transition(issue.id, 'in_progress')
      }
    } catch (error) {
      this.#log.warn?.(`dsh-issues: could not apply goal state to ${issue.id}: ${describe(error)}`)
    }
  }

  /** Remember the latest assistant text of a session; used as the closing summary. */
  onAssistantMessage(sessionId, body) {
    if (typeof body !== 'string' || body.trim() === '') return
    this.#lastText.delete(sessionId)
    this.#lastText.set(sessionId, body.trim())
    if (this.#lastText.size > 200) this.#lastText.delete(this.#lastText.keys().next().value)
  }

  /** The agent went idle: attach its closing message to an issue that just finished or blocked. */
  async onAgentIdle(sessionId) {
    await this.#goalWork
    const issue = this.#store.bySession(sessionId)
    if (issue === undefined || !this.#pendingSummary.has(issue.id)) return
    this.#pendingSummary.delete(issue.id)
    const summary = this.#lastText.get(sessionId)
    if (summary === undefined) return
    try {
      await this.#store.addComment(issue.id, { author: 'agent', text: summary.slice(0, SUMMARY_LIMIT) })
    } catch (error) {
      this.#log.warn?.(`dsh-issues: could not store the summary of ${issue.id}: ${describe(error)}`)
    }
  }

  /** Cancel an issue and pause its running goal. */
  async cancel(id) {
    const before = this.#store.get(id)
    const cancelled = await this.#store.transition(id, 'cancelled')
    if (before?.sessionId !== undefined) await this.#sessions.halt(before.sessionId).catch(() => undefined)
    return cancelled
  }
}
