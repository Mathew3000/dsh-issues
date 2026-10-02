/** Shared issue actions used by the tools and the HTTP API. */
import { IssueError } from './store.mjs'

/** Status targets a person (or a model acting for one) may request; the rest is managed by the tracker. */
export const REQUESTABLE_STATUSES = Object.freeze(['open', 'done', 'cancelled'])

/**
 * Apply edits, a status change and a comment to one issue.
 * @param {{ store: import('./store.mjs').IssueStore, dispatcher: import('./dispatcher.mjs').Dispatcher }} deps
 * @param {string} id
 * @param {{ title?: string, description?: string, priority?: string, labels?: string | string[], autoMerge?: boolean, status?: string, comment?: string }} change
 */
export async function updateIssue({ store, dispatcher }, id, change) {
  let issue = store.get(id)
  if (issue === undefined) throw new IssueError('not-found', `Issue ${id} does not exist`)
  const { status, comment, ...edits } = change
  if (status !== undefined && !REQUESTABLE_STATUSES.includes(status)) {
    throw new IssueError('invalid-input', `status must be one of ${REQUESTABLE_STATUSES.join(', ')}`)
  }
  // Turning auto-merge on again after a failed or skipped merge starts a new attempt.
  if (edits.autoMerge === true && issue.status === 'done' && ['conflict', 'failed', 'skipped'].includes(issue.merge?.status)) {
    issue = await store.setMerge(id, undefined, { comment: 'Merge retried on request.' })
  }
  if (Object.values(edits).some(value => value !== undefined)) issue = await store.update(id, edits)
  if (status !== undefined) {
    issue = status === 'cancelled'
      ? await dispatcher.cancel(id)
      : await store.transition(id, status, { author: 'user' })
  }
  if (comment !== undefined && comment !== '') issue = await store.addComment(id, { author: 'user', text: comment })
  return issue
}
