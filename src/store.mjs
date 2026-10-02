/**
 * Issue records and their state machine.
 *
 * The store is deliberately free of harness imports: it receives a table with
 * `entries()` and `put()` (the shape of a storage-domain table), serializes
 * every mutation, persists before it publishes, and hands out detached copies.
 */
import path from 'node:path'

export const STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'needs_review', 'done', 'cancelled'])
export const PRIORITIES = Object.freeze(['low', 'normal', 'high'])
export const AUTHORS = Object.freeze(['user', 'agent', 'system'])

const PRIORITY_RANK = { low: 0, normal: 1, high: 2 }
const MAX_COMMENTS = 500
const MAX_TEXT = 10_000

/** Allowed status moves; anything else is rejected. */
const TRANSITIONS = {
  open: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['open', 'blocked', 'needs_review', 'done', 'cancelled'],
  blocked: ['open', 'in_progress', 'cancelled'],
  needs_review: ['open', 'in_progress', 'done', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
}

/** Failure with a stable machine-readable code. */
export class IssueError extends Error {
  /**
   * @param {string} code stable classification, e.g. `not-found`
   * @param {string} message human-readable explanation
   */
  constructor(code, message) {
    super(message)
    this.name = 'IssueError'
    this.code = code
  }
}

/**
 * Canonical comparison key for a project path.
 * @param {string} value absolute or relative path
 * @returns {string}
 */
export function projectKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Normalize an issue reference such as `12`, `#12`, `iss-12` to `ISS-12`.
 * @param {unknown} value
 * @returns {string}
 */
export function parseIssueId(value) {
  const match = /^(?:iss-|#)?(\d+)$/i.exec(String(value ?? '').trim())
  if (match === null) throw new IssueError('invalid-id', `"${String(value)}" is not an issue id (expected ISS-<number>)`)
  return `ISS-${Number(match[1])}`
}

function text(value, field, { min = 0, max }) {
  if (typeof value !== 'string') throw new IssueError('invalid-input', `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length < min) throw new IssueError('invalid-input', `${field} must not be empty`)
  if (trimmed.length > max) throw new IssueError('invalid-input', `${field} must be at most ${max} characters`)
  return trimmed
}

function priorityOf(value) {
  if (!PRIORITIES.includes(value)) {
    throw new IssueError('invalid-input', `priority must be one of ${PRIORITIES.join(', ')}`)
  }
  return value
}

function labelsOf(value) {
  if (value === undefined) return []
  const list = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(list)) throw new IssueError('invalid-input', 'labels must be a list or a comma-separated string')
  const labels = [...new Set(list.map(label => String(label).trim()).filter(label => label !== ''))]
  if (labels.length > 20) throw new IssueError('invalid-input', 'at most 20 labels are allowed')
  for (const label of labels) {
    if (label.length > 40) throw new IssueError('invalid-input', 'a label must be at most 40 characters')
  }
  return labels
}

function projectOf(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IssueError('invalid-input', 'project must be a non-empty absolute path')
  }
  if (!path.isAbsolute(value.trim())) {
    throw new IssueError('invalid-input', `project must be an absolute path, got "${value}"`)
  }
  return path.resolve(value.trim())
}

function reasonOf(reason) {
  if (reason === null || typeof reason !== 'object'
    || typeof reason.code !== 'string' || reason.code.trim() === ''
    || typeof reason.message !== 'string' || reason.message.trim() === '') {
    throw new IssueError('invalid-input', 'a blocked issue needs a reason with a code and a message')
  }
  return { code: reason.code.trim(), message: reason.message.trim().slice(0, 1000) }
}

export class IssueStore {
  #table
  #now
  #issues = new Map()
  #chain = Promise.resolve()
  #listeners = new Set()
  #next = 1

  /**
   * @param {{ table: { entries(): Iterable<[string, object]>, put(key: string, value: object): Promise<void> }, now?: () => Date }} options
   */
  constructor({ table, now = () => new Date() }) {
    this.#table = table
    this.#now = now
    for (const [id, issue] of table.entries()) {
      this.#issues.set(id, issue)
      this.#next = Math.max(this.#next, issue.number + 1)
    }
  }

  /**
   * Subscribe to committed changes; failures in a listener never affect the store.
   * @param {(event: { type: string, issue: object, previous?: object }) => unknown} listener
   * @returns {() => void}
   */
  onChange(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined)
      } catch {
        // contained on purpose
      }
    }
  }

  #serialize(work) {
    const run = this.#chain.then(work)
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  #iso() {
    return this.#now().toISOString()
  }

  #require(id) {
    const key = parseIssueId(id)
    const issue = this.#issues.get(key)
    if (issue === undefined) throw new IssueError('not-found', `Issue ${key} does not exist`)
    return issue
  }

  async #write(next, type, previous) {
    next.updatedAt = this.#iso()
    await this.#table.put(next.id, structuredClone(next))
    this.#issues.set(next.id, next)
    this.#emit({
      type,
      issue: structuredClone(next),
      ...previous === undefined ? {} : { previous: structuredClone(previous) },
    })
    return structuredClone(next)
  }

  #withComment(issue, author, body) {
    issue.comments = [...issue.comments, { at: this.#iso(), author, text: body }].slice(-MAX_COMMENTS)
  }

  /** @returns {object | undefined} a detached copy */
  get(id) {
    const issue = this.#issues.get(parseIssueId(id))
    return issue === undefined ? undefined : structuredClone(issue)
  }

  /**
   * @param {{ project?: string, status?: string | string[], label?: string, limit?: number, order?: 'newest' | 'queue' }} [filter]
   * @returns {object[]}
   */
  list({ project, status, label, limit = 200, order = 'newest' } = {}) {
    const wanted = status === undefined ? undefined : new Set([status].flat())
    const key = project === undefined ? undefined : projectKey(project)
    const rows = [...this.#issues.values()].filter(issue =>
      (wanted === undefined || wanted.has(issue.status))
      && (key === undefined || projectKey(issue.project) === key)
      && (label === undefined || issue.labels.includes(label)))
    rows.sort(order === 'queue'
      ? (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.number - b.number
      : (a, b) => b.number - a.number)
    return rows.slice(0, limit).map(issue => structuredClone(issue))
  }

  /** Open issues in dispatch order: priority first, then oldest first. */
  queue() {
    return this.list({ status: 'open', order: 'queue', limit: Number.MAX_SAFE_INTEGER })
  }

  /** @returns {object | undefined} the issue worked by a session */
  bySession(sessionId) {
    for (const issue of this.#issues.values()) {
      if (issue.sessionId === sessionId) return structuredClone(issue)
    }
    return undefined
  }

  /** @returns {Record<string, number>} issue counts per status */
  counts() {
    const counts = Object.fromEntries(STATUSES.map(status => [status, 0]))
    for (const issue of this.#issues.values()) counts[issue.status] += 1
    return counts
  }

  /** @returns {Promise<object>} the created issue */
  create(input) {
    return this.#serialize(async () => {
      const number = this.#next
      const now = this.#iso()
      const issue = {
        id: `ISS-${number}`,
        number,
        project: projectOf(input.project),
        title: text(input.title, 'title', { min: 1, max: 200 }),
        description: text(input.description ?? '', 'description', { max: 20_000 }),
        status: 'open',
        priority: priorityOf(input.priority ?? 'normal'),
        labels: labelsOf(input.labels),
        attempts: 0,
        failedStarts: 0,
        comments: [],
        createdAt: now,
        updatedAt: now,
      }
      const stored = await this.#write(issue, 'created')
      this.#next = number + 1
      return stored
    })
  }

  /** Edit title, description, priority or labels. */
  update(id, patch) {
    return this.#serialize(async () => {
      const previous = this.#require(id)
      const next = structuredClone(previous)
      let changed = false
      if (patch.title !== undefined) { next.title = text(patch.title, 'title', { min: 1, max: 200 }); changed = true }
      if (patch.description !== undefined) {
        next.description = text(patch.description, 'description', { max: 20_000 })
        changed = true
      }
      if (patch.priority !== undefined) { next.priority = priorityOf(patch.priority); changed = true }
      if (patch.labels !== undefined) { next.labels = labelsOf(patch.labels); changed = true }
      if (!changed) throw new IssueError('invalid-input', 'nothing to update')
      if (previous.status === 'in_progress') {
        this.#withComment(next, 'system', 'Issue was edited while a session is working on it; the running agent was not notified.')
      }
      return this.#write(next, 'updated', previous)
    })
  }

  /** Append a comment. */
  addComment(id, { author, text: body }) {
    return this.#serialize(async () => {
      if (!AUTHORS.includes(author)) throw new IssueError('invalid-input', `author must be one of ${AUTHORS.join(', ')}`)
      const previous = this.#require(id)
      const next = structuredClone(previous)
      this.#withComment(next, author, text(body, 'comment', { min: 1, max: MAX_TEXT }))
      return this.#write(next, 'commented', previous)
    })
  }

  /**
   * Move an issue to another status.
   * @param {string} id
   * @param {string} to target status
   * @param {{ reason?: { code: string, message: string }, comment?: string, from?: string, author?: string }} [options]
   *   `from` makes the move conditional on the current status.
   */
  transition(id, to, { reason, comment, from, author = 'system' } = {}) {
    return this.#serialize(async () => {
      const previous = this.#require(id)
      if (!STATUSES.includes(to)) throw new IssueError('invalid-input', `unknown status "${to}"`)
      if (from !== undefined && previous.status !== from) {
        throw new IssueError('conflict', `${previous.id} is ${previous.status}, expected ${from}`)
      }
      if (previous.status === to) return structuredClone(previous)
      if (!TRANSITIONS[previous.status].includes(to)) {
        throw new IssueError('invalid-transition', `${previous.id} cannot move from ${previous.status} to ${to}`)
      }
      const next = structuredClone(previous)
      next.status = to
      delete next.blockedReason
      if (to === 'blocked') next.blockedReason = reasonOf(reason)
      if (to === 'open') {
        delete next.sessionId
        delete next.goalId
      }
      this.#withComment(next, 'system', `Status: ${previous.status} → ${to}${to === 'blocked' ? ` (${next.blockedReason.message})` : ''}`)
      if (comment !== undefined && comment.trim() !== '') this.#withComment(next, author, text(comment, 'comment', { min: 1, max: MAX_TEXT }))
      return this.#write(next, 'transition', previous)
    })
  }

  /**
   * Compare-and-set claim for the dispatcher: `open` → `in_progress`.
   * @returns {Promise<object | undefined>} the claimed issue, or undefined when it is no longer open
   */
  claim(id) {
    return this.#serialize(async () => {
      const previous = this.#require(id)
      if (previous.status !== 'open') return undefined
      const next = structuredClone(previous)
      next.status = 'in_progress'
      next.attempts += 1
      delete next.blockedReason
      return this.#write(next, 'transition', previous)
    })
  }

  /** Record the session, goal, branch and worktree that work on an issue. */
  attach(id, { sessionId, goalId, branch, worktreePath }) {
    return this.#serialize(async () => {
      const previous = this.#require(id)
      const next = structuredClone(previous)
      if (sessionId !== undefined) {
        next.sessionId = sessionId
        next.failedStarts = 0
      }
      if (goalId !== undefined) next.goalId = goalId
      if (branch !== undefined) next.branch = branch
      if (worktreePath !== undefined) next.worktreePath = worktreePath
      return this.#write(next, 'updated', previous)
    })
  }

  /**
   * Give a claimed issue back after a failed start.
   * @param {string} id
   * @param {{ to?: 'open' | 'blocked', reason?: { code: string, message: string }, comment: string, failed?: boolean }} options
   *   `failed` counts the release as a failed start; consecutive failures are what the dispatcher limits.
   */
  release(id, { to = 'open', reason, comment, failed = false }) {
    return this.#serialize(async () => {
      const previous = this.#require(id)
      if (previous.status !== 'in_progress') return structuredClone(previous)
      const next = structuredClone(previous)
      next.status = to
      next.failedStarts = (previous.failedStarts ?? 0) + (failed ? 1 : 0)
      delete next.blockedReason
      delete next.sessionId
      delete next.goalId
      if (to === 'blocked') next.blockedReason = reasonOf(reason)
      this.#withComment(next, 'system', comment)
      return this.#write(next, 'transition', previous)
    })
  }
}
