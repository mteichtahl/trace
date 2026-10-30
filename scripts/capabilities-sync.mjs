// The scheduled capability check (.github/workflows/capabilities.yml): re-read JLC3DP's and JLCCNC's pages, decide
// what may change on its own (src/tools/mech/capsync.ts planSync), write src/tools/mech/capabilities.updates.ts when
// something does, and leave the pull request's and the issue's words for the workflow.
//
//   node scripts/capabilities-sync.mjs [--out DIR] [--today YYYY-MM-DD] [--pages pages.json]
//
// Needs the build (npm ci builds dist/). Writes into DIR (default ./capsync-out): plan.json, kind (update, reverify or
// none), pr-title.txt and pr-body.md (when kind is not none), issue-title.txt and issue-body.md (when a figure needs a
// person). --pages reads saved pages ({url: {text, error}}) instead of fetching, for tests and dry runs. Exit 0 whenever
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

const { fetchPages, planSync, renderUpdates, pullRequest, reviewIssue } = await import(join(root, 'dist/tools/mech/capsync.js'))
const { UPDATES } = await import(join(root, 'dist/tools/mech/capabilities.updates.js'))

const pages = pagesFile ? JSON.parse(readFileSync(pagesFile, 'utf8')) : await fetchPages()
const plan = planSync({ pages, updates: UPDATES, today })

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 1))
writeFileSync(join(out, 'kind'), plan.kind)
if (plan.kind !== 'none') {
  writeFileSync(join(root, 'src/tools/mech/capabilities.updates.ts'), renderUpdates(plan.next))
  const pr = pullRequest(plan)
  writeFileSync(join(out, 'pr-title.txt'), pr.title)
  writeFileSync(join(out, 'pr-body.md'), pr.body)
}
const issue = reviewIssue(plan)
if (issue) {
  writeFileSync(join(out, 'issue-title.txt'), issue.title)
  writeFileSync(join(out, 'issue-body.md'), issue.body)
}
console.log(`capabilities ${today}: ${plan.kind}; ${plan.same} same, ${plan.updated.length} updated, ${plan.review.length} for a person; `
  + `checked ${plan.checked_before} -> ${plan.next.checked ?? plan.checked_before}; pages ${plan.pages.map((p) => `${p.url} ${p.read ? 'read' : `not read (${p.error})`}`).join(', ')}`)
