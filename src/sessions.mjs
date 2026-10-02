/**
 * The only module that talks to harness services about sessions. It follows the
 * recipe of the webhook runtime (workspace, agent, attach, title, permission,
 * first message) and adds the goal that keeps the agent working.
 */
import { randomUUID } from 'node:crypto'
import { llm } from './harness.mjs'

const { boundContextSummary, createUserMessage } = llm
/** Session ids are branded strings with no runtime representation. */
const brandString = value => value

/** Producer-owned source kind written on the first message of a worker session. */
export const SOURCE_KIND = 'dsh-issues'

/** Pin the deployment's model selection (including reasoning effort) until the first request is recorded. */
function installInitialModelSelection(agentCtx, selection) {
  agentCtx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inherited, ...withoutEffort } = resolved
    return {
      ...withoutEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

async function release(scope) {
  const dispose = scope?.[Symbol.asyncDispose] ?? scope?.[Symbol.dispose]
  if (typeof dispose === 'function') await dispose.call(scope)
}

function goalSummary(goal) {
  if (goal === undefined) return undefined
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    blockedReason: goal.blockedReason,
    roundsStarted: goal.roundsStarted,
    armed: goal.activation === 'armed',
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ agentPreset: string, permissionPreset: string }} config
 */
export function createSessionsAdapter(ctx, config) {
  /** Live agent for a session, resuming a stored session when needed. */
  async function agentOf(sessionId, { resume }) {
    const id = brandString(sessionId)
    const live = ctx.agents.get(id)
    if (live !== undefined) return { agent: live }
    if (!resume) return { notLive: true }
    const found = await ctx.sessionController.resolveAgent(id)
    if ('agent' in found) return { agent: found.agent }
    const code = String(found.error?.code ?? '')
    return {
      error: {
        reason: code === 'session/not-found' ? 'not-found' : 'unavailable',
        message: String(found.error?.message ?? code),
      },
    }
  }

  return {
    /**
     * Create a worker session with its goal and first message.
     * @returns {Promise<{ sessionId: string, goalId: string }>}
     */
    async start({ issueId, workspacePath, title, prompt, objective, maxGoalRounds }) {
      ctx.permissionPresets.resolve(config.permissionPreset)
      const preset = await ctx.agentPresets.resolve(config.agentPreset)
      const scope = await ctx.agentPresets.acquireScope(preset.id)
      try {
        const selection = ctx.agentDefaultModel.currentSelection()
        const workspace = await ctx.workspaceRegistry.create(workspacePath)
        const sessionId = brandString(`issue-${randomUUID()}`)
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: workspace.path, agentPreset: preset.id },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
            installInitialModelSelection(agentCtx, { ...selection })
          },
        })
        let attached = false
        try {
          await workspace.attachSession(sessionId)
          attached = true
          ctx.permissionPresets.set(handle.agent.session, config.permissionPreset)
          ctx.sessionTitle.rename(handle.agent.session, title)
          const goal = ctx.goals.create(handle.agent, { objective, maxGoalRounds })
          handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: {
              kind: SOURCE_KIND,
              issueId,
              form: 'notice',
              summary: boundContextSummary(`issue ${issueId} dispatched`),
            },
          }))
          return { sessionId, goalId: goal.id }
        } catch (error) {
          if (attached) await workspace.detachSession(sessionId).catch(() => undefined)
          await handle.dispose().catch(() => undefined)
          throw error
        }
      } finally {
        await release(scope)
      }
    },

    /**
     * Bring a stored session back after a restart and optionally re-arm its goal.
     * @returns {Promise<{ ok: true, rearmed: boolean, goal?: object } | { ok: false, reason: 'not-found' | 'unavailable', message: string }>}
     */
    async resume(sessionId, { rearm }) {
      const found = await agentOf(sessionId, { resume: true })
      if (found.error !== undefined) return { ok: false, ...found.error }
      const { agent } = found
      let goal = ctx.goals.get(agent)
      let rearmed = false
      if (rearm && goal !== undefined && goal.phase === 'active' && goal.activation !== 'armed') {
        try {
          goal = ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
          rearmed = true
        } catch (error) {
          // for example an exhausted round cap: report the goal as it is
          ctx.logger.warn(`dsh-issues: could not re-arm the goal of ${sessionId}: ${String(error?.message ?? error)}`)
        }
      }
      return { ok: true, rearmed, goal: goalSummary(goal) }
    },

    /** Pause the goal of a session so it stops continuing on its own. */
    async halt(sessionId) {
      const found = await agentOf(sessionId, { resume: true })
      if (found.agent === undefined) return
      const goal = ctx.goals.get(found.agent)
      if (goal !== undefined && goal.phase === 'active') {
        ctx.goals.pause(found.agent, { id: goal.id, revision: goal.revision })
      }
    },
  }
}

/** Plain text of an assistant message, or undefined when it has none. */
export function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const parts = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)
  return parts.length === 0 ? undefined : parts.join('\n')
}
