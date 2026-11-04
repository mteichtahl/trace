// The scheduled capability check (.github/workflows/capabilities.yml): re-read JLCPCB's, JLC3DP's and JLCCNC's pages,
// decide for every capability table what may change on its own (src/tools/mech/capsync.ts planSync, CAPABILITY_TABLES),
// write each table's updates file when something does, and leave the pull request's and the issue's words for the
// workflow.
//
//   node scripts/capabilities-sync.mjs [--out DIR] [--today YYYY-MM-DD] [--pages pages.json]
//
// Needs the build (npm ci builds dist/). Writes into DIR (default ./capsync-out): plan.json (one plan per table), kind
// (update, reverify or none), files (the updates files written, one per line), pr-title.txt and pr-body.md (when kind
// is not none), issue-title.txt and issue-body.md (when a figure needs a person). --pages reads saved pages ({url: {text, error}}) instead of fetching, for tests and dry runs. Exit 0 whenever
// it decided; anything else is a failure of the check itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const out = arg('--out') ?? join(root, 'capsync-out')
const today = arg('--today') ?? new Date().toISOString().slice(0, 10)
const pagesFile = arg('--pages')

const { fetchPages, planSync, renderUpdates, pullRequest, reviewIssue, combinedKind, CAPABILITY_TABLES } = await import(join(root, 'dist/tools/mech/capsync.js'))

const pages = pagesFile ? JSON.parse(readFileSync(pagesFile, 'utf8')) : await fetchPages()
// every table, each against its own updates file; one run, one pull request, one issue
const plans = CAPABILITY_TABLES.map((table) => planSync({ pages, updates: table.updates, today, table }))
const kind = combinedKind(plans)

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'plan.json'), JSON.stringify(plans, null, 1))
writeFileSync(join(out, 'kind'), kind)
const files = []
if (kind !== 'none') {
  // a reverify moves only the tables that are due; an update writes every table that has one (and moves the dates
  // of the others that are due and clean)
  for (const [i, table] of CAPABILITY_TABLES.entries()) {
    const p = plans[i]
    if (p.kind === 'none') continue
    writeFileSync(join(root, table.updatesFile), renderUpdates(p.next, table))
    files.push(table.updatesFile)
  }
  const pr = pullRequest(plans)
  writeFileSync(join(out, 'pr-title.txt'), pr.title)
  writeFileSync(join(out, 'pr-body.md'), pr.body)
}
writeFileSync(join(out, 'files'), files.join('\n'))
const issue = reviewIssue(plans)
if (issue) {
  writeFileSync(join(out, 'issue-title.txt'), issue.title)
  writeFileSync(join(out, 'issue-body.md'), issue.body)
}
for (const [i, table] of CAPABILITY_TABLES.entries()) {
  const plan = plans[i]
  console.log(`capabilities ${today} ${table.id}: ${plan.kind}; ${plan.same} same, ${plan.updated.length} updated, ${plan.review.length} for a person; `
    + `checked ${plan.checked_before} -> ${plan.next.checked ?? plan.checked_before}`)
}
console.log(`capabilities ${today}: ${kind}; pages ${Object.entries(pages).map(([u, p]) => `${u} ${p.text !== null ? 'read' : `not read (${p.error})`}`).join(', ')}`)
