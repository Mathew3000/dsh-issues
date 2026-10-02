/**
 * Access to the harness packages this plugin builds on.
 *
 * An out-of-tree plugin is not inside the harness's dependency tree, so a plain
 * `import '@deepseek-ai/…'` cannot resolve. Instead the packages are resolved
 * from places the harness itself is installed: this plugin's own location,
 * the running CLI, and the working directory, directly or through the base
 * bundle that depends on all of them. The same files are used the harness
 * already loaded, so classes and registries keep their identity.
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const BRIDGES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

function anchors() {
  const found = [import.meta.url]
  // Escape hatch: a directory inside the harness installation (for example the CLI package).
  if (process.env.DSH_ISSUES_HARNESS_DIR) found.push(pathToFileURL(`${process.env.DSH_ISSUES_HARNESS_DIR}/`).href + 'noop.js')
  try {
    if (process.argv[1]) found.push(pathToFileURL(realpathSync(process.argv[1])).href)
  } catch { /* the entry point may be virtual */ }
  found.push(pathToFileURL(`${process.cwd()}/`).href + 'noop.js')
  return found
}

function candidates() {
  const result = []
  for (const anchor of anchors()) {
    const base = createRequire(anchor)
    result.push(base)
    for (const bridge of BRIDGES) {
      try {
        result.push(createRequire(base.resolve(`${bridge}/package.json`)))
      } catch { /* not reachable from this anchor */ }
    }
  }
  return result
}

/**
 * Import a harness package, optionally resolving it from another package's directory.
 * @param {string} specifier
 * @param {string} [from] package to resolve `specifier` from (for example zod from the storage domain package)
 */
export async function load(specifier, from) {
  const tried = []
  for (const base of candidates()) {
    try {
      const root = from === undefined ? base : createRequire(base.resolve(`${from}/package.json`))
      const file = root.resolve(specifier)
      const mod = await import(pathToFileURL(file).href)
      return mod
    } catch (error) {
      tried.push(String(error?.code ?? error?.message ?? error))
    }
  }
  throw new Error(`dsh-issues: cannot find ${specifier} from the running harness (${[...new Set(tried)].join(', ')})`)
}

/** CommonJS packages appear as `default`. */
export function defaultExport(mod) {
  const value = mod.default ?? mod
  return value?.__esModule && value.default !== undefined ? value.default : value
}

export const cordis = await load('@deepseek-ai/cordis')
export const schemastery = defaultExport(await load('@deepseek-ai/schemastery'))
export const tools = await load('@deepseek-ai/dsh-tools')
export const storageDomain = await load('@deepseek-ai/dsh-storage-domain')
export const llm = await load('@deepseek-ai/dsh-llm')
const zodModule = await load('zod', '@deepseek-ai/dsh-storage-domain')
export const zod = zodModule.z ?? zodModule
