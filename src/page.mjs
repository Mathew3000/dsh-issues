/** Single-page UI served by the HTTP plugin. Sources live in ./web and are inlined with the CSP nonce. */
import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8')
const STYLE = read('style.css')
const SCRIPT = `'use strict';\n${read('markdown.cjs')}\n${read('app.cjs')}`

/**
 * @param {string} nonce per-response CSP nonce
 * @returns {string} HTML document
 */
export function renderPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issues</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="msg" class="err" role="alert" hidden></div>
<header class="topbar">
  <h1>Issues</h1>
  <select id="f-project" aria-label="Project"><option value="">All projects</option></select>
  <span class="spacer"></span>
  <button id="run-queue" type="button" title="Start waiting issues now, within the concurrency limits">Run queue</button>
  <button id="new-issue" class="primary" type="button" title="Press N">New issue</button>
</header>
<div id="chips" class="chips" aria-label="Filter by status"></div>
<main>
  <nav id="list" aria-label="Issues"></nav>
  <section id="detail" aria-live="polite"></section>
</main>
<dialog id="editor" aria-label="Issue editor"></dialog>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
}
