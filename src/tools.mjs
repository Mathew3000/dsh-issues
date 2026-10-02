/**
 * Model-facing tools. A session that works on an issue may only read and
 * comment on its own issue; everything else is for sessions started by people.
 */
import { updateIssue, REQUESTABLE_STATUSES } from './actions.mjs'
import { IssueError, STATUSES } from './store.mjs'

const MODEL_STATUS_TARGETS = REQUESTABLE_STATUSES

function brief(issue) {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    project: issue.project,
    labels: issue.labels,
    ...issue.blockedReason === undefined ? {} : { blocked: issue.blockedReason },
  }
}

function detail(issue) {
  return {
    ...brief(issue),
    description: issue.description,
    branch: issue.branch,
    worktree: issue.worktreePath,
    session: issue.sessionId,
    attempts: issue.attempts,
    comments: issue.comments.slice(-8),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * @param {object} deps
 * @param {Function} deps.defineTool `defineTool` from `@deepseek-ai/dsh-tools`
 * @param {import('./store.mjs').IssueStore} deps.store
 * @param {import('./dispatcher.mjs').Dispatcher} deps.dispatcher
 * @param {() => { autoMerge?: boolean }} [deps.defaults] defaults for new issues
 * @param {(input: string | undefined, callerSessionId: string | undefined) => string} deps.resolveProject
 * @returns {object[]} tool definitions
 */
export function createTools({ defineTool, store, dispatcher, merges, defaults, resolveProject }) {
  const callerOf = exec => exec.agent?.session?.id
  const workerIssue = exec => callerOf(exec) === undefined ? undefined : store.bySession(callerOf(exec)) ?? store.byMergeSession(callerOf(exec))

  /** Reject mutations from worker sessions, except on-topic reads and comments. */
  function guardWorker(exec, { id, allowOwn = false }) {
    const own = workerIssue(exec)
    if (own === undefined) return
    if (allowOwn && id !== undefined && own.id === store.get(id)?.id) return
    throw new IssueError('forbidden', `This session works on ${own.id}; it may only read and comment on that issue.`)
  }

  return [
    defineTool({
      name: 'issue_create',
      description: 'Create an issue in the internal issue tracker. Open issues are picked up by the tracker, which starts an agent session for them. Use this to record a bug or task together with a description that is complete enough for someone without your context.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short summary, at most 200 characters.' },
        description: { type: 'string', description: 'What is wrong or wanted, how to reproduce it, and what done looks like.' },
        project: { type: 'string', description: 'Project title or absolute path. Defaults to the project of the current session.' },
        priority: { type: 'string', description: 'low, normal (default) or high.' },
        labels: { type: 'string', description: 'Comma-separated labels.' },
        auto_merge: { type: 'boolean', description: 'Merge the branch automatically once the issue is accepted.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        guardWorker(exec, {})
        const project = resolveProject(args.project, callerOf(exec))
        const issue = await store.create({ project, title: args.title, description: args.description, priority: args.priority, labels: args.labels, autoMerge: typeof args.auto_merge === 'boolean' ? args.auto_merge : defaults?.().autoMerge === true })
        return JSON.stringify(brief(issue))
      },
    }),
    defineTool({
      name: 'issue_list',
      description: 'List issues of the internal issue tracker, newest first.',
      parameters: {
        project: { type: 'string', description: 'Project title or absolute path. Omit to list all projects.' },
        status: { type: 'string', description: `Comma-separated statuses to include (${STATUSES.join(', ')}). Omit for all.` },
        limit: { type: 'number', description: 'Maximum number of issues, default 30.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        guardWorker(exec, {})
        const statuses = args.status === undefined ? undefined : args.status.split(',').map(value => value.trim()).filter(Boolean)
        for (const status of statuses ?? []) {
          if (!STATUSES.includes(status)) throw new IssueError('invalid-input', `unknown status "${status}"`)
        }
        const project = args.project === undefined ? undefined : resolveProject(args.project, callerOf(exec))
        const limit = Math.min(Math.max(Math.trunc(args.limit ?? 30), 1), 200)
        return JSON.stringify(store.list({ project, status: statuses, limit }).map(brief))
      },
    }),
    defineTool({
      name: 'issue_get',
      description: 'Show one issue with its description and recent comments.',
      parameters: { id: { type: 'string', required: true, description: 'Issue id such as ISS-12.' } },
      output: OUTPUT,
      async execute(args, exec) {
        guardWorker(exec, { id: args.id, allowOwn: true })
        const issue = store.get(args.id)
        if (issue === undefined) throw new IssueError('not-found', `Issue ${args.id} does not exist`)
        return JSON.stringify(detail(issue))
      },
    }),
    defineTool({
      name: 'issue_update',
      description: `Edit an issue or change its status. Status may be set to ${MODEL_STATUS_TARGETS.join(', ')}: open requeues it for an agent, done accepts the work, cancelled stops it. Other statuses are managed by the tracker.`,
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id such as ISS-12.' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', description: 'low, normal or high.' },
        labels: { type: 'string', description: 'Comma-separated labels; replaces the current ones.' },
        status: { type: 'string', description: MODEL_STATUS_TARGETS.join(', ') },
        auto_merge: { type: 'boolean', description: 'Merge the issue branch automatically once the issue is done.' },
        comment: { type: 'string', description: 'Optional comment recorded with the change.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        guardWorker(exec, { id: args.id })
        const { id, auto_merge: autoMerge, ...change } = args
        const issue = await updateIssue({ store, dispatcher }, id, { ...change, autoMerge })
        return JSON.stringify(brief(issue))
      },
    }),
    defineTool({
      name: 'issue_comment',
      description: 'Add a comment to an issue.',
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id such as ISS-12.' },
        text: { type: 'string', required: true },
      },
      output: OUTPUT,
      async execute(args, exec) {
        guardWorker(exec, { id: args.id, allowOwn: true })
        const own = workerIssue(exec)
        const issue = await store.addComment(args.id, { author: own === undefined ? 'user' : 'agent', text: args.text })
        return JSON.stringify(brief(issue))
      },
    }),
    defineTool({
      name: 'issue_merge_report',
      description: 'Only for merge agents: report the result of merging an accepted issue. "ready" means the merge is committed on your merge branch and the checks pass. "conflict" means it could not be merged safely; a follow-up issue is opened from follow_up_title and follow_up_description.',
      parameters: {
        outcome: { type: 'string', required: true, description: 'ready or conflict.' },
        summary: { type: 'string', required: true, description: 'What was merged and which checks ran, or why it could not be merged.' },
        follow_up_title: { type: 'string', description: 'Title of the follow-up issue (conflict only).' },
        follow_up_description: { type: 'string', description: 'Precise task for the follow-up issue: files, what each side intended, failing output (conflict only).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const issue = callerOf(exec) === undefined ? undefined : store.byMergeSession(callerOf(exec))
        if (issue === undefined) throw new IssueError('forbidden', 'Only the merge agent of an issue can report a merge result.')
        return await merges.report(issue.id, {
          outcome: args.outcome,
          summary: args.summary,
          followUpTitle: args.follow_up_title,
          followUpDescription: args.follow_up_description,
        })
      },
    }),
    defineTool({
      name: 'issue_dispatch',
      description: 'Start agent sessions for open issues now, within the configured concurrency limits, instead of waiting for the next automatic pass.',
      parameters: {},
      output: OUTPUT,
      async execute(_args, exec) {
        guardWorker(exec, {})
        await dispatcher.tick()
        return JSON.stringify(store.counts())
      },
    }),
  ]
}
