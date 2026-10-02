/**
 * DeepSeek Harness issue tracker: durable issues per project; open issues are
 * picked up by agent sessions that work on them with a goal.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { cordis, schemastery as z, storageDomain, tools as toolkit } from './harness.mjs'
import { zodSchema } from './schema.mjs'
import { Dispatcher, DEFAULTS } from './dispatcher.mjs'
import { MergeCoordinator, MERGE_DEFAULTS } from './merge.mjs'
import * as gitOps from './git.mjs'
import { assistantText, createSessionsAdapter } from './sessions.mjs'
import { IssueError, IssueStore, projectKey } from './store.mjs'
import { createTools } from './tools.mjs'

const { Service } = cordis
const { defineDomain, domainTable } = storageDomain
const { defineTool } = toolkit

const WORKTREE_DIR = '.dsh-worktrees'

const issueDomain = defineDomain({
  name: 'issues',
  version: 1,
  tables: { issues: domainTable(zodSchema) },
})

export default class IssuesService extends Service {
  static inject = [
    'agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle',
    'workspaceRegistry', 'storageDomain', 'tools', 'goals', 'sessionController',
  ]

  static Config = z.object({
    agentPreset: z.string().default('standard'),
    permissionPreset: z.string().default('workspace-write'),
    maxConcurrent: z.number().step(1).min(1).max(16).default(DEFAULTS.maxConcurrent),
    maxPerProject: z.number().step(1).min(1).max(16).default(DEFAULTS.maxPerProject),
    isolation: z.union(['auto', 'worktree', 'none']).default(DEFAULTS.isolation),
    worktreeRoot: z.string().default(''),
    baseRef: z.string().default('HEAD'),
    maxGoalRounds: z.number().step(1).min(1).max(1000).default(DEFAULTS.maxGoalRounds),
    maxAttempts: z.number().step(1).min(1).max(20).default(DEFAULTS.maxAttempts),
    completeStatus: z.union(['needs_review', 'done']).default(DEFAULTS.completeStatus),
    autoStart: z.boolean().default(true),
    resumeOnStart: z.boolean().default(DEFAULTS.resumeOnStart),
    pollSeconds: z.number().step(1).min(0).max(86_400).default(60),
    autoMerge: z.boolean().default(false),
    cleanupAfterMerge: z.boolean().default(MERGE_DEFAULTS.cleanupAfterMerge),
    maxMergeRounds: z.number().step(1).min(1).max(200).default(MERGE_DEFAULTS.maxMergeRounds),
    maxConcurrentMerges: z.number().step(1).min(1).max(8).default(MERGE_DEFAULTS.maxConcurrentMerges),
  })

  /** @type {IssueStore | undefined} */
  store
  /** @type {Dispatcher | undefined} */
  dispatcher
  /** @type {MergeCoordinator | undefined} */
  merges
  #config

  constructor(ctx, config) {
    super(ctx, 'issues')
    this.#config = config
    const log = ctx.logger

    // Events can arrive before storage is open; they are no-ops until then.
    ctx.on('goal/changed', ({ agent, change }) => {
      const sessionId = String(agent.session.id)
      void this.dispatcher?.onGoalChanged({ sessionId, change })
      void this.merges?.onGoalChanged({ sessionId, change })
    })
    ctx.on('session/event', (session, event) => {
      if (this.dispatcher === undefined || event?.type !== 'assistant/message') return
      const text = assistantText(event.data?.message)
      if (text === undefined) return
      this.dispatcher.onAssistantMessage(String(session.id), text)
      this.merges?.onAssistantMessage(String(session.id), text)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      void this.dispatcher?.onAgentIdle(String(agent.session.id))
      void this.merges?.onAgentIdle(String(agent.session.id))
    })

    this.initialized = ctx.effect(async () => {
      ctx.permissionPresets.resolve(config.permissionPreset)
      await ctx.agentPresets.resolve(config.agentPreset)
      const domain = await ctx.storageDomain.open(issueDomain)
      let timer
      try {
        const store = new IssueStore({ table: domain.table('issues') })
        const dispatcher = new Dispatcher({
          store,
          sessions: createSessionsAdapter(ctx, config),
          git: gitOps,
          config: { ...config, worktreeRoot: config.worktreeRoot || undefined },
          logger: log,
        })
        const sessions = createSessionsAdapter(ctx, config)
        const merges = new MergeCoordinator({
          store,
          sessions,
          git: gitOps,
          config: { ...config, worktreeRoot: config.worktreeRoot || undefined },
          logger: log,
        })
        this.store = store
        this.dispatcher = dispatcher
        this.merges = merges

        const autoStart = () => {
          if (!config.autoStart) return
          void dispatcher.tick()
          void merges.tick()
        }
        const offChange = store.onChange(({ type, issue, previous }) => {
          const queued = issue.status === 'open' && previous?.status !== 'open'
          const freed = previous?.status === 'in_progress' && issue.status !== 'in_progress'
          if (type === 'created' || queued || freed) autoStart()
          // Merges are not held back by autoStart: accepting an issue with auto-merge is an explicit request.
          const wantsMerge = issue.status === 'done' && issue.autoMerge === true && issue.merge === undefined
          const finishedMerge = previous?.merge?.status === 'running' && issue.merge?.status !== 'running'
          if (wantsMerge || finishedMerge) void merges.tick()
        })
        if (config.autoStart && config.pollSeconds > 0) {
          timer = setInterval(autoStart, config.pollSeconds * 1000)
          timer.unref?.()
        }
        const disposers = createTools({
          defineTool,
          store,
          dispatcher,
          merges,
          defaults: () => this.defaults(),
          resolveProject: (input, caller) => this.resolveProject(input, caller),
        }).map(tool => ctx.tools.register(tool))

        const cleanup = ctx.effect(() => async () => {
          clearInterval(timer)
          offChange()
          for (const dispose of disposers) dispose()
          await dispatcher.stop()
          await merges.stop()
          this.dispatcher = undefined
          this.merges = undefined
          this.store = undefined
          await domain.close()
        })
        // Pick up work that was interrupted by a restart, then anything waiting.
        void (async () => {
          try {
            if (config.resumeOnStart) {
              await dispatcher.resumeInterrupted()
              await merges.resumeInterrupted()
            }
            autoStart()
            void merges.tick()
          } catch (error) {
            log.warn(`dsh-issues: startup recovery failed: ${String(error?.message ?? error)}`)
          }
        })()
        return cleanup
      } catch (error) {
        clearInterval(timer)
        await domain.close()
        throw error
      }
    })
  }

  async [Service.init]() {
    await this.initialized
  }

  /** Defaults the web page applies to new issues. */
  defaults() {
    return { autoMerge: this.#config.autoMerge === true }
  }

  /** Projects with their display titles. */
  listProjectInfo() {
    const paths = new Set(this.listProjects())
    return this.ctx.workspaceRegistry.list()
      .filter(workspace => paths.has(workspace.path))
      .map(workspace => ({ path: workspace.path, title: String(workspace.title || path.basename(workspace.path)) }))
  }

  /** Workspaces that are real projects (worktrees created for issues are hidden). */
  listProjects() {
    const hidden = new Set((this.store?.list({ limit: 100000 }) ?? [])
      .map(issue => issue.worktreePath).filter(Boolean).map(projectKey))
    return this.ctx.workspaceRegistry.list()
      .map(workspace => workspace.path)
      .filter(workspacePath => !hidden.has(projectKey(workspacePath))
        && !workspacePath.split(/[\\/]/).includes(WORKTREE_DIR))
  }

  /**
   * Resolve a project from an absolute path, a workspace title or folder name,
   * the caller's own workspace, or the only workspace there is.
   */
  resolveProject(input, callerSessionId) {
    const projects = this.listProjects()
    if (typeof input === 'string' && input.trim() !== '') {
      const value = input.trim()
      if (path.isAbsolute(value)) {
        if (!existsSync(value) || !statSync(value).isDirectory()) {
          throw new IssueError('invalid-input', `project directory does not exist: ${value}`)
        }
        return value
      }
      const wanted = value.toLowerCase()
      const matches = this.ctx.workspaceRegistry.list().filter(workspace => projects.includes(workspace.path)
        && (String(workspace.title).toLowerCase() === wanted || path.basename(workspace.path).toLowerCase() === wanted))
      if (matches.length === 1) return matches[0].path
      throw new IssueError('invalid-input', matches.length === 0
        ? `no project matches "${value}"; known: ${projects.join(', ') || 'none'}`
        : `"${value}" matches several projects; pass an absolute path`)
    }
    if (callerSessionId !== undefined) {
      const own = this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds?.includes(callerSessionId))
      if (own !== undefined && projects.includes(own.path)) return own.path
    }
    if (projects.length === 1) return projects[0]
    throw new IssueError('invalid-input', 'project is required (absolute path or workspace title)')
  }
}
