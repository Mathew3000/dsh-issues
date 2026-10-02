/** Optional web UI for the issue tracker. Loads only where the web server is available. */
import { createHandler } from './http.mjs'

export const name = 'dsh-issues-http'
export const inject = ['issues', 'webServer', 'connection']

const BASE = '/dsh-issues'

export function apply(ctx) {
  const handler = createHandler({
    store: ctx.issues.store,
    dispatcher: ctx.issues.dispatcher,
    projects: () => ctx.issues.listProjectInfo(),
    defaults: () => ctx.issues.defaults(),
    connection: ctx.connection,
    basePath: BASE,
    logger: ctx.logger,
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE, handler }))
  ctx.logger.info(`dsh-issues: web UI at ${BASE}/ (open the Harness UI once first so your browser holds the session cookie)`)
}
