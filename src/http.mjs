/** HTTP surface of the tracker: one HTML page plus a small JSON API under one prefix. */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { updateIssue } from './actions.mjs'
import { renderPage } from './page.mjs'
import { IssueError, STATUSES } from './store.mjs'

const MAX_BODY = 1024 * 1024
const STATUS_OF_CODE = { 'not-found': 404, conflict: 409, forbidden: 403, 'invalid-input': 400, 'invalid-transition': 409 }

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' })
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\b/i.test(type)) throw new IssueError('invalid-input', 'content-type must be application/json')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new IssueError('invalid-input', 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new IssueError('invalid-input', 'request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IssueError('invalid-input', 'request body must be a JSON object')
  }
  return value
}

function isDirectory(value) {
  try {
    return path.isAbsolute(value) && statSync(value).isDirectory()
  } catch {
    return false
  }
}

function baseName(value) {
  return String(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(value)
}

/** Projects as `{ path, title }`, from paths or objects, without duplicates. */
function projectList(known, issueProjects) {
  const byPath = new Map()
  for (const entry of [...known, ...issueProjects]) {
    const info = typeof entry === 'string' ? { path: entry, title: baseName(entry) } : { path: entry.path, title: entry.title || baseName(entry.path) }
    if (!byPath.has(info.path)) byPath.set(info.path, info)
  }
  return [...byPath.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * @param {object} deps
 * @param {import('./store.mjs').IssueStore} deps.store
 * @param {import('./dispatcher.mjs').Dispatcher} deps.dispatcher
 * @param {() => Array<string | { path: string, title?: string }>} deps.projects known projects
 * @param {{ admit(req: object): unknown }} deps.connection
 * @param {() => { autoMerge?: boolean }} [deps.defaults] defaults for new issues
 * @param {string} [deps.basePath]
 * @param {{ warn?: Function }} [deps.logger]
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHandler({ store, dispatcher, projects, defaults = () => ({}), connection, basePath = '/dsh-issues', logger = {} }) {
  const deps = { store, dispatcher }

  async function route(req, res, url) {
    const rest = url.pathname.slice(basePath.length)
    const method = req.method ?? 'GET'

    if (rest === '' || rest === '/') {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'method not allowed')
      if (rest === '' ) return send(res, 308, '', { location: `${basePath}/` })
      const nonce = randomBytes(16).toString('base64')
      return send(res, 200, renderPage(nonce, { embedded: url.searchParams.get('embed') === '1' }), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
        'referrer-policy': 'no-referrer',
      })
    }
    if (!rest.startsWith('/api/')) return send(res, 404, 'not found')
    const segments = rest.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent)
    const mutating = method !== 'GET'

    if (segments[0] === 'projects' && segments.length === 1 && !mutating) {
      return sendJson(res, 200, { projects: projectList(projects(), store.list({ limit: 10000 }).map(issue => issue.project)), defaults: defaults() })
    }
    if (segments[0] === 'issues' && segments.length === 1) {
      if (method === 'GET') {
        const project = url.searchParams.get('project') || undefined
        const statuses = (url.searchParams.get('status') ?? '').split(',').filter(Boolean)
        for (const status of statuses) {
          if (!STATUSES.includes(status)) throw new IssueError('invalid-input', `unknown status "${status}"`)
        }
        const issues = store.list({ project, status: statuses.length === 0 ? undefined : statuses, limit: 500 })
        return sendJson(res, 200, { issues, counts: store.counts() })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const project = typeof body.project === 'string' ? body.project : ''
        const known = projectList(projects(), []).some(info => info.path === project)
        if (!known && !isDirectory(project)) throw new IssueError('invalid-input', 'unknown project: pass a known project or an existing absolute directory')
        const issue = await store.create({
          project,
          title: body.title,
          description: body.description,
          priority: body.priority,
          labels: body.labels,
          autoMerge: typeof body.autoMerge === 'boolean' ? body.autoMerge : defaults().autoMerge === true,
        })
        return sendJson(res, 201, { issue })
      }
    }
    if (segments[0] === 'issues' && segments.length === 2) {
      const id = segments[1]
      if (method === 'GET') {
        const issue = store.get(id)
        if (issue === undefined) throw new IssueError('not-found', `Issue ${id} does not exist`)
        return sendJson(res, 200, { issue })
      }
      if (method === 'PATCH') {
        const body = await readJson(req)
        const { title, description, priority, labels, autoMerge, status, comment } = body
        return sendJson(res, 200, { issue: await updateIssue(deps, id, { title, description, priority, labels, autoMerge, status, comment }) })
      }
    }
    if (segments[0] === 'issues' && segments[2] === 'comments' && segments.length === 3 && method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 201, { issue: await store.addComment(segments[1], { author: 'user', text: body.text }) })
    }
    if (segments[0] === 'dispatch' && segments.length === 1 && method === 'POST') {
      await readJson(req)
      await dispatcher.tick()
      return sendJson(res, 200, { counts: store.counts() })
    }
    return send(res, 404, 'not found')
  }

  return async function handle(req, res) {
    const admitted = connection.admit(req)
    if (admitted && typeof admitted === 'object' && 'rejection' in admitted) {
      return send(res, admitted.rejection, admitted.rejection === 401 ? 'unauthorized' : 'forbidden', { 'content-type': 'text/plain; charset=utf-8' })
    }
    try {
      await route(req, res, new URL(req.url ?? '/', 'http://localhost'))
    } catch (error) {
      if (error instanceof IssueError) {
        return sendJson(res, STATUS_OF_CODE[error.code] ?? 400, { error: { code: error.code, message: error.message } })
      }
      logger.warn?.(`dsh-issues: request failed: ${String(error?.message ?? error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
      else res.end()
    }
  }
}
