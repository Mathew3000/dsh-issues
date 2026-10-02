/**
 * Loads the real plugin into a real cordis context with the real storage stack.
 * The agent-facing services are fakes. Runs only when the harness can be found
 * (set DSH_ISSUES_HARNESS_DIR to a directory inside a harness checkout/install).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'

let harness
try {
  harness = await import('../src/harness.mjs')
} catch {
  harness = undefined
}

test('plugin wires storage, tools, dispatch and goal events', { skip: harness === undefined && 'harness packages not found' }, async () => {
  const { load, cordis } = harness
  const { default: Plugin } = await import('../src/plugin.mjs')
  const Storage = (await load('@deepseek-ai/dsh-storage')).default
  const StorageJson = await load('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await load('@deepseek-ai/dsh-storage-domain')

  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-issues-int-')))
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@e.x'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'T'])
  writeFileSync(path.join(repo, 'a.txt'), 'x\n')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'])

  const ctx = new cordis.Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: path.join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })

    const registered = new Map()
    const calls = { created: [], followups: [], goals: [], titles: [], attached: [] }
    const agent = {
      session: { id: 'issue-test', requestHeader: () => undefined },
      followup: message => { calls.followups.push(message) },
    }
    ctx.provide('agents', { get: () => undefined, roots: () => [], create: async (options) => {
      calls.created.push(options)
      agent.session.id = options.sessionId
      return { agent, dispose: async () => {} }
    } })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
    ctx.provide('agentPresets', { resolve: async () => ({ id: 'standard' }), acquireScope: async () => ({}), mount: async () => {} })
    ctx.provide('permissionPresets', { resolve: () => ({}), set: () => {} })
    ctx.provide('sessionTitle', { rename: (_s, title) => { calls.titles.push(title) } })
    ctx.provide('workspaceRegistry', {
      list: () => [{ path: repo, title: 'repo', sessionIds: [] }],
      create: async (workspacePath) => ({
        path: workspacePath,
        attachSession: async id => { calls.attached.push([workspacePath, id]) },
        detachSession: async () => {},
      }),
    })
    ctx.provide('tools', { register: (tool) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } })
    ctx.provide('goals', {
      create: (_agent, request) => { calls.goals.push(request); return { id: 'goal-1' } },
      get: () => undefined,
    })
    ctx.provide('sessionController', { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) })

    await ctx.plugin(Plugin, { pollSeconds: 0, resumeOnStart: false })
    assert.deepEqual([...registered.keys()].sort(),
      ['issue_comment', 'issue_create', 'issue_dispatch', 'issue_get', 'issue_list', 'issue_update'])

    const exec = { agent: { session: { id: 'human-session' } }, signal: new AbortController().signal }
    const created = JSON.parse(await registered.get('issue_create').execute({ title: 'Fix login', description: 'It crashes', project: 'repo' }, exec))
    assert.equal(created.id, 'ISS-1')

    for (let i = 0; i < 100 && ctx.issues.store.get('ISS-1').status === 'open'; i++) await sleep(50)
    const issue = ctx.issues.store.get('ISS-1')
    assert.equal(issue.status, 'in_progress', JSON.stringify(issue))
    assert.equal(issue.branch, 'issue/iss-1-fix-login')
    assert.ok(issue.worktreePath.includes('.dsh-worktrees'))
    assert.equal(calls.goals.length, 1)
    assert.equal(calls.followups.length, 1)
    assert.equal(calls.created[0].meta.cwd, issue.worktreePath)
    assert.deepEqual(ctx.issues.listProjects(), [repo])

    ctx.emit('goal/changed', { agent, change: { operation: 'complete', ref: {}, goal: { phase: 'complete', roundsStarted: 3 } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Fixed it.' }] } } })
    ctx.emit('agent/status', { agent, status: 'idle' })
    for (let i = 0; i < 100 && ctx.issues.store.get('ISS-1').status === 'in_progress'; i++) await sleep(50)
    await sleep(100)
    const finished = ctx.issues.store.get('ISS-1')
    assert.equal(finished.status, 'needs_review')
    assert.equal(finished.comments.at(-1).text, 'Fixed it.')

    // a worker session may not create issues
    await assert.rejects(registered.get('issue_create').execute({ title: 'x' }, { ...exec, agent }), /may only read and comment|forbidden|works on/)
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
