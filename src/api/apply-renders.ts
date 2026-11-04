/**
 * A revision's renders apply on their own (docs/revision-renders.md "When they are ready"; Marc, November 2026): the
 * rendering agent's change, which commits its render runs to the run record, is merged once its checks pass, as trace's
 * own release record is, with nobody accepting it. Only a change that is renders and nothing else:
 *
 *   the job      one of trace's changes (traceJob: trace's branch, trace's author) made by the rendering agent
 *   the files    .trace/project.db and nothing else
 *   the record   every run the change adds is a render (render.*); no run of the default branch is changed or gone;
 *                every other table of the record is as the default branch has it
 *   GitHub       open, not a draft, targets the default branch, can merge, every check passed, and the specialist did not
 *                say it is unfinished
 *
 * A change that fails any of these waits for a person as any agent change does (change.accept). An applied change
 * records decision renders.ready per revision it rendered (revision, day, run, pictures), which is what Next and the
 * push read (src/core/journey.ts inboxItems, src/web/push-sender.ts).
 *
 * What calls it: applyEdits (src/api/apply-edits.ts), on every accepted delivery of a project and from changes.list.
 */
import type { DatabaseSync } from 'node:sqlite'
import { decide, loadJourney } from '../core/journey.js'
import type { JobRow } from '../core/job-index.js'
import { showcaseRecord } from '../ontology/renders.js'
import { type Context, PROJECT_DB_PATH, openProjectDb, tempDb, writeJourney } from './action-kit.js'
import { mergeMethod, projectRule } from './actions-changes.js'
import { listJobs } from './actions-jobs.js'
import { traceChanges, unfinishedWords, verdictOf } from './changes.js'
import type { GitHubApi, PullSummary } from './github.js'
import type { Applied } from './apply-edits.js'

/** The column a table's rows name their run by: runs' own id, else run_id in any table an area registered (artifacts,
 *  measurements, run_inputs, parts_list_lines, …); null for a table that is not a run's. */
function runKey(db: DatabaseSync, table: string): string | null {
  if (table === 'runs') return 'id'
  const cols = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as { name: string }[]
  return cols.some((c) => c.name === 'run_id') ? 'run_id' : null
}

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)

/** A table's rows as sorted JSON lines, leaving out rows of `skip` runs when it is a run table (bytes as their length and hash-free). */
function rowsOf(db: DatabaseSync, table: string, skip: ReadonlySet<string>): string[] {
  const key = runKey(db, table)
  const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all() as Record<string, unknown>[]
  return rows
    .filter((r) => !key || !skip.has(String(r[key])))
    .map((r) => JSON.stringify(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `bytes:${v.length}:${Buffer.from(v).toString('base64').slice(0, 64)}` : v])))
    .sort()
}

/**
 * What a change does to the run record, judged for applying on its own: the render runs it adds, or why it is not
 * renders only. `base` and `head` are the run record at the default branch and at the change's head.
 */
export function rendersOnly(base: DatabaseSync | null, head: DatabaseSync): { ok: true; runs: { id: string; kind: string; result: unknown }[] } | { ok: false; why: string } {
  const runIds = (db: DatabaseSync | null): Set<string> => new Set(db && tables(db).includes('runs') ? (db.prepare('SELECT id FROM runs').all() as { id: string }[]).map((r) => r.id) : [])
  const before = runIds(base)
  const after = runIds(head)
  for (const id of before) if (!after.has(id)) return { ok: false, why: `it removes run ${id}` }
  const added = [...after].filter((id) => !before.has(id))
  if (!added.length) return { ok: false, why: 'it adds no run' }
  const rows = head.prepare(`SELECT id, kind, status, result FROM runs WHERE id IN (${added.map(() => '?').join(',')})`).all(...added) as { id: string; kind: string; status: string | null; result: string | null }[]
  const other = rows.find((r) => !r.kind.startsWith('render.'))
  if (other) return { ok: false, why: `it adds a ${other.kind} run, which is not a render` }
  const skip = new Set(added)
  const headTables = tables(head)
  const baseTables = base ? tables(base) : []
  for (const t of new Set([...headTables, ...baseTables])) {
    const a = baseTables.includes(t) && base ? rowsOf(base, t, skip) : []
    const b = headTables.includes(t) ? rowsOf(head, t, skip) : []
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return { ok: false, why: `it changes the ${t} table besides adding renders` }
  }
  return { ok: true, runs: rows.map((r) => { let result: unknown = null; try { result = r.result ? JSON.parse(r.result) : null } catch { result = null } return { id: r.id, kind: r.kind, result } }) }
}

/** The rendering agent's job, or its delegated worker's specialist. */
const isRendering = (j: JobRow): boolean => j.agent === 'render'

/** The run record at `ref`, opened from a scratch copy that closing removes; null when the branch has none. */
async function dbAt(gh: GitHubApi, repo: string, ref: string, scratch: string): Promise<{ db: DatabaseSync; close(): void } | null> {
  const bytes = await gh.rawFile(repo, PROJECT_DB_PATH, ref)
  if (!bytes) return null
  const t = tempDb(scratch, bytes)
  const db = openProjectDb(t.db)
  return { db, close: () => { try { db.close() } finally { t.cleanup() } } }
}

/** Apply each open change of the rendering agent's that is renders only and whose checks passed. */
export async function applyRenders(ctx: Context, gh: GitHubApi, repo: string): Promise<Applied[]> {
  if (!gh.pullStatus || !gh.pullFiles || !gh.mergePull) return []
  const pulls = await gh.openPulls(repo)
  if (!pulls.length) return []
  const [rule, jobs] = await Promise.all([projectRule(ctx, repo), listJobs(ctx, repo).then((x) => x.rows)])
  const out: Applied[] = []
  for (const { pull, job } of traceChanges(pulls, jobs, rule)) {
    if (!isRendering(job)) continue
    try {
      out.push(await applyOne(ctx, gh, repo, pull, job, rule))
    } catch (err) {
      out.push({ branch: pull.head, number: pull.number, did: 'waiting', why: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) })
    }
  }
  return out
}

async function applyOne(ctx: Context, gh: GitHubApi, repo: string, pull: PullSummary, job: JobRow, rule: Awaited<ReturnType<typeof projectRule>>): Promise<Applied> {
  const at = { branch: pull.head, number: pull.number }
  const wait = (why: string): Applied => ({ ...at, did: 'waiting', why })
  if (pull.draft) return wait('It is a draft.')
  if (pull.base && pull.base !== rule.defaultBranch) return wait('It builds on another change: it applies once that one has.')
  const unfinished = unfinishedWords({ title: pull.title, summary: job.summary })
  if (unfinished) return wait(`The rendering agent said it is not finished (${unfinished}).`)
  const status = await gh.pullStatus!(repo, pull.number)
  if (!status) return wait('GitHub did not answer.')
  const verdict = verdictOf({ state: status.state, draft: status.draft, mergeable: status.mergeable, checks: status.checks, ...(status.checks_denied ? { checks_denied: true } : {}) })
  if (verdict !== 'ready') return wait(`It is ${verdict}.`)
  const files = await gh.pullFiles!(repo, pull.number)
  const stray = files.map((f) => f.path).filter((p) => p !== PROJECT_DB_PATH)
  if (stray.length || !files.length) return { ...at, did: 'left', why: `It changes more than the run record (${stray.slice(0, 3).join(', ') || 'nothing'}): a person accepts it.` }
  const scratch = ctx.deps.scratch
  const [base, head] = await Promise.all([dbAt(gh, repo, rule.defaultBranch, scratch), dbAt(gh, repo, status.sha, scratch)])
  if (!head) { base?.close(); return wait('Its run record could not be read.') }
  let judged: ReturnType<typeof rendersOnly>
  try { judged = rendersOnly(base?.db ?? null, head.db) } finally { base?.close(); head.close() }
  if (!judged.ok) return { ...at, did: 'left', why: `It is not renders only (${judged.why}): a person accepts it.` }
  const method = mergeMethod(await gh.mergeMethods?.(repo).catch(() => ['squash' as const]) ?? ['squash'])
  // GitHub merges only the commit judged here: a push since makes it refuse
  const { sha } = await gh.mergePull!(repo, pull.number, { method, sha: status.sha })
  await gh.removeLabel?.(repo, pull.number, rule.hold ?? 'no-automerge').catch(() => false)
  const sets = judged.runs.flatMap((r) => {
    const rec = r.kind === 'render.showcase' ? showcaseRecord(r.result) : null
    return rec ? [{ run: r.id, revision: rec.revision, date: rec.date, pictures: Object.keys(rec.shots).length }] : []
  })
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    const stage = r.journey.currentStage
    decide(db, {
      kind: 'change.applied', stage, ref: String(pull.number), by: 'trace',
      summary: `trace applied the rendering agent's renders (#${pull.number}) once its checks passed: it adds renders and nothing else.`,
      detail: { number: pull.number, sha, method, head: status.sha, kind: 'renders', checks: status.checks, runs: judged.runs.map((x) => x.id) },
    })
    for (const s of sets) {
      decide(db, {
        kind: 'renders.ready', stage, ref: s.run, by: 'trace',
        summary: `Revision ${s.revision}'s renders are ready: ${s.pictures} ${s.pictures === 1 ? 'picture' : 'pictures'}.`,
        detail: { ...s, number: pull.number },
      })
    }
    return { result: null }
  })
  return { ...at, did: 'applied', why: `Its checks passed and it is renders only: applied${sets.length ? ` (revision ${sets.map((s) => s.revision).join(', ')})` : ''}.` }
}
