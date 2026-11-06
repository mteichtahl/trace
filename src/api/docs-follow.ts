/**
 * When Scribe starts on its own (docs/scribe.md "Event driven"): the documents are brought up to date after anything
 * that can change them, without a person asking.
 *
 *   a push to the default branch   (hook.docs, called by the hooks function on that push, src/web/hooks.ts): when
 *                                  the commit changed a record a document is written from (its files, and its project
 *                                  database compared with its parent's table by table, src/docs/stale.ts). A commit
 *                                  that changed only the documents, or only runs Scribe makes for them, starts nothing,
 *                                  so Scribe's own change never starts Scribe again
 *   a stage's design work landed   (docsAfterDesign): the stage's documents are written from its design, so they
 *                                  start once its criteria (but the documents' own) are met or waived: a push that
 *                                  meets the last of them (hook.docs), or the person's act that does (a guided
 *                                  review submitted, a question answered, a criterion signed off). A stage opening
 *                                  starts nothing while it has design work to do (gate.sign): started then, Scribe
 *                                  wrote "pending" in every section the stage was about (test-esp32 #58, #98, #120).
 *                                  The design as accepted: a check on a change not accepted yet does not count
 *                                  (acceptedNow), a change carrying the stage's work still open holds them
 *                                  (stageChangesOpen), and the push that accepts the last of it starts them whatever
 *                                  it changed itself (docsOwed)
 *   a revision cut                 (gate.sign's release, journey.snapshot): the documents brought up to date and
 *                                  printed as the revision's release copies (docsReleaseRequest, src/docs/printed.ts)
 *   the nightly drift check        (hook.drift, the hooks function's schedule at DRIFT_HOUR_UTC): anything that
 *                                  changed a record since the documents were last written and started no Scribe (a
 *                                  missed delivery, a push while Scribe was busy, a stage with a document missing)
 *
 * One Scribe job at a time per project: while one is queued or running, another is not started (the running one
 * compares with the commit the documents were last written at, so it sees every change since). A revision's release
 * copies are the exception: they are queued behind it, since only that job prints them.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StageId } from '../core/journey-catalog.js'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import { DOC_KINDS, DOCS, docsFor, type DocKind, type SourceKind } from '../docs/catalog.js'
import { parseDoc } from '../docs/markers.js'
import { dueSections, sourcesOfDatabases, sourcesOfPaths } from '../docs/stale.js'
import { designWorkLeft, loadJourney, mergeAgentFacts, withStaleEvidence, type CriterionRow, type JourneyRecord } from '../core/journey.js'
import { type Context, agentFacts, journeyStore, label, PROJECT_DB_PATH } from './action-kit.js'
import { jobRows, tracePulls } from './actions-changes.js'
import { creditedAgent, criteriaNamed, jobRequest } from './changes.js'
import { evidenceStaleness } from './evidence-freshness.js'

/** What Scribe is asked. `why`: what happened, in a person's words. Pure. */
export function docsRequest(why: string, o: { stage?: StageId | null; records?: readonly SourceKind[]; also?: readonly SourceKind[] } = {}): string {
  return [
    `${why} Bring the project's documents up to date.`,
    o.stage ? `The project is at ${STAGE_NAMES[o.stage]} (stage ${o.stage}): start any document it needs that is missing (docs_init), and write every section due by it.` : 'Read the stage with journey_status first.',
    o.records?.length ? `The records that changed: ${o.records.join(', ')}.` : '',
    o.also?.length ? `Records that changed outside the repository: ${o.also.join(', ')}; pass them to docs_stale as also.` : '',
    'Find the sections to write with docs_stale, leaving base unset so it compares with the commit the documents were last written at. Write only those sections and the pending ones now due; check, print and deliver as your instructions say. If nothing needs writing, say so and stop without a change.',
  ].filter(Boolean).join('\n')
}

/**
 * What Scribe is asked when a revision is cut: the documents brought up to date at the release stage, then printed
 * at release quality as the revision's release copies (docs_publish with release), with the revision in the table.
 */
export function docsReleaseRequest(revision: string, day: string, o: { stage?: StageId | null } = {}): string {
  return [
    docsRequest(`Revision ${revision} was cut on ${day}.`, { ...o, also: ['journey'] }),
    `Then print the revision's release copies: make any figure still at draft quality again at release quality (docs_figures quality=release), check every document (docs_check), and print them all with docs_publish release=${revision}, its revision table ending with revision ${revision}, ${day}, at the commit you print, "Released". A document the revision already has a copy of is kept as it was.`,
  ].join('\n')
}

/** The records a commit changed, from its files and (when it changed it) the project database against its parent's. */
export async function recordsOfCommit(ctx: Context, repo: string, sha: string): Promise<{ records: SourceKind[]; paths: string[] }> {
  const gh = await ctx.deps.github()
  if (!gh.request) return { records: [], paths: [] }
  const c = await gh.request('GET', `/repos/${repo}/commits/${sha}`) as { parents?: { sha: string }[]; files?: { filename: string }[] }
  const paths = (c.files ?? []).map((f) => f.filename)
  const parent = c.parents?.[0]?.sha
  return { records: await recordsOf(ctx, repo, paths, parent ?? null, sha), paths }
}

/** The records changed between two commits (GitHub's comparison: its files, and the project database at each end). */
export async function recordsBetween(ctx: Context, repo: string, base: string, head: string): Promise<{ records: SourceKind[]; paths: string[] }> {
  const gh = await ctx.deps.github()
  if (!gh.request || base === head) return { records: [], paths: [] }
  const c = await gh.request('GET', `/repos/${repo}/compare/${base}...${head}`) as { files?: { filename: string }[] }
  const paths = (c.files ?? []).map((f) => f.filename)
  return { records: await recordsOf(ctx, repo, paths, base, head), paths }
}

/** The records `paths` changed, the project database compared between `before` and `after` when it is one of them. */
async function recordsOf(ctx: Context, repo: string, paths: readonly string[], before: string | null, after: string): Promise<SourceKind[]> {
  const gh = await ctx.deps.github()
  const records = sourcesOfPaths(paths.filter((p) => !p.startsWith('docs/design/')))
  if (before && paths.includes(PROJECT_DB_PATH)) {
    const dir = mkdtempSync(join(ctx.deps.scratch, 'docs-follow-'))
    const open = async (ref: string): Promise<DatabaseSync | null> => {
      const bytes = await gh.rawFile(repo, PROJECT_DB_PATH, ref)
      if (!bytes) return null
      const f = join(dir, `${ref}.db`)
      writeFileSync(f, bytes)
      return new DatabaseSync(f, { readOnly: true })
    }
    const b = await open(before)
    const a = await open(after)
    try { sourcesOfDatabases(b, a).forEach((r) => records.add(r)) } finally { b?.close(); a?.close(); rmSync(dir, { recursive: true, force: true }) }
  }
  return [...records].sort()
}

/**
 * The documents at `ref`, from GitHub: which of the ones the stage needs are missing, and the oldest commit any says
 * it was written at (its front matter), which the nightly check compares the branch with.
 */
export async function documentsAt(ctx: Context, repo: string, ref: string, stage: StageId): Promise<{ missing: DocKind[]; written: { kind: DocKind; commit: string | null }[] }> {
  const gh = await ctx.deps.github()
  const due = new Set(docsFor(stage, true).map((d) => d.kind))
  const written: { kind: DocKind; commit: string | null }[] = []
  const missing: DocKind[] = []
  for (const k of DOC_KINDS) {
    const bytes = await gh.rawFile(repo, DOCS[k].file, ref)
    if (!bytes) { if (due.has(k) && k !== 'protocol') missing.push(k); continue }
    const c = parseDoc(Buffer.from(bytes).toString('utf8')).front?.commit
    written.push({ kind: k, commit: c && /^[0-9a-f]{4,40}$/.test(c) ? c : null })
  }
  return { missing, written }
}

/**
 * Scribe's change still waiting for review, when there is one (the newest): a second Scribe job on its own branch would
 * edit the same documents, and once one is accepted the other is in a text conflict nothing merges by itself (log
 * #110). None when the changes cannot be read: Scribe then starts on its own branch as before.
 */
export async function openScribeChange(ctx: Context, repo: string): Promise<{ number: number; title: string; branch: string; defaultBranch: string } | null> {
  const { changes, rule } = await tracePulls(ctx, repo)
  const docs = changes.filter(({ job }) => creditedAgent(job) === 'docs' || job.agent === 'docs').at(-1)
  return docs && rule.defaultBranch ? { number: docs.pull.number, title: docs.pull.title, branch: docs.pull.head, defaultBranch: rule.defaultBranch } : null
}

/** What Scribe is asked when it carries on on its open change: bring that branch up to date first, then the request. */
export function onOpenChangeRequest(request: string, c: { number: number; title: string; branch: string; defaultBranch: string }): string {
  return [
    `Your change #${c.number} ("${c.title}") still waits for a person's review and edits the same documents, so this work goes on its branch, ${c.branch}, and lands with it: two changes to one document would conflict once either is accepted.`,
    `First bring the branch up to date: git fetch origin ${c.defaultBranch}, then git merge origin/${c.defaultBranch} (never a rebase or a force-push). The project database merges by itself; if a document's text conflicts, keep what each side added and write the section again from the records, then commit the merge.`,
    'Then:',
    request,
    `Push to ${c.branch}, so its change carries both.`,
  ].join('\n')
}

/**
 * Start Scribe on the project, unless one of its jobs is already queued or running (`queue`: start it anyway, behind).
 * When Scribe's last change still waits for review, it carries on on that change's branch rather than open a second
 * change on the same documents (log #110).
 */
export async function startScribe(ctx: Context, repo: string, request: string, o: { queue?: boolean } = {}): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string; change?: number }> {
  try {
    const jobs = await ctx.deps.jobs()
    const busy = o.queue ? undefined : (await jobs.jobStatus()).find((j) => j.repository === repo && j.agent === 'docs' && (j.state === 'queued' || j.state === 'running'))
    if (busy) return { skipped: `Scribe is already working on this project (job ${busy.id}); it compares with the documents' last commit, so it sees this too.` }
    // a revision's release copies (queue) are printed on their own change, from the default branch as accepted
    const open = o.queue ? null : await openScribeChange(ctx, repo).catch(() => null)
    const r = await jobs.startJob({
      kind: 'task', repository: repo, request: open ? onOpenChangeRequest(request, open) : request, agent: 'docs', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub,
      ...(open ? { branch: open.branch } : {}),
    })
    if (!r.accepted) return { jobError: r.reason ?? 'trace did not accept the job.' }
    return open
      ? { jobId: r.jobId, change: open.number, started: `The Documentation agent brings the documents up to date on its change #${open.number}, which still waits for review, so the two never conflict.` }
      : { jobId: r.jobId, started: 'The Documentation agent brings the project\'s documents up to date.' }
  } catch (e) {
    return { jobError: e instanceof Error ? e.message : String(e) }
  }
}

/** The project's record with the agents' facts merged in (their checks meet trace's criteria), or null before a journey. */
export async function recordNow(ctx: Context, repo: string): Promise<JourneyRecord | null> {
  const [rec, facts] = await Promise.all([journeyStore(ctx, repo).read((db) => loadJourney(db)), agentFacts(ctx, repo).catch(() => null)])
  return rec.result && facts ? mergeAgentFacts(rec.result, facts) : rec.result
}

/**
 * The record as the accepted design stands (src/api/evidence-freshness.ts): a criterion an agent checked on a change
 * that is not accepted yet, or on evidence gone out of date, reads as not met. The documents are written from the
 * default branch, so they wait for what it holds: started on an agent's check of its own branch, Scribe wrote
 * "pending" and "no requirement is verified yet" over the record it was about (test-esp32 #58, #98). Unreadable: as it is.
 */
export async function acceptedNow(ctx: Context, repo: string, r: JourneyRecord): Promise<JourneyRecord> {
  const stale = await evidenceStaleness(ctx, repo, r).catch(() => undefined)
  return stale ? withStaleEvidence(r, stale) : r
}

/** The criteria of the current stage's design work (its unsigned gates', but the documents' own): what the documents wait for. */
const stageWork = (r: JourneyRecord): Set<string> => {
  const left = designWorkLeft({ ...r, criteria: r.criteria.map((c) => ({ ...c, status: 'not_met' as const })), waivers: [] })
  return new Set(left.map((c) => c.id))
}

/**
 * trace's open changes that carry the current stage's design work (their job named one of its criteria), other than
 * Scribe's own: the documents are written once they are accepted, from the design as it then stands. None when they
 * cannot be listed (the documents are not held back on a guess).
 */
export async function stageChangesOpen(ctx: Context, repo: string, r: JourneyRecord): Promise<{ number: number; title: string }[]> {
  const work = stageWork(r)
  if (!work.size) return []
  try {
    const { changes } = await tracePulls(ctx, repo)
    return changes
      .filter(({ job }) => creditedAgent(job) !== 'docs' && job.agent !== 'docs' && criteriaNamed(jobRequest(job), job.title).some((c) => work.has(c)))
      .map(({ pull }) => ({ number: pull.number, title: pull.title }))
  } catch {
    return []
  }
}

/** Why the documents wait for open changes, in words. Pure. */
export const openWords = (r: JourneyRecord, open: readonly { number: number; title: string }[]): string =>
  `${STAGE_NAMES[r.journey.currentStage]}'s documents are written once its design is accepted; still open: ${open.slice(0, 3).map((c) => `change #${c.number} ("${c.title}")`).join(', ')}${open.length > 3 ? ` and ${open.length - 3} more` : ''}.`

const secs = (t: number | null | undefined): number | null => (typeof t === 'number' ? (t > 1e12 ? t / 1000 : t) : null)

/**
 * When the current stage's design work last landed: the newest check, sign-off or waiver of its criteria (the record
 * with the agents' facts). Null when none of it has a time. Pure.
 */
export function designDoneAt(r: JourneyRecord): number | null {
  const work = stageWork(r)
  const times = [
    ...r.criteria.filter((c) => work.has(c.id) && c.status === 'met').map((c) => secs(c.checkedAt)),
    ...r.waivers.filter((w) => w.closedAt === null && w.targetKind === 'criterion' && work.has(w.target)).map((w) => secs(w.at)),
  ].filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

/**
 * Whether the stage's documents are owed: its design work is all in the accepted design, no change of it is still
 * open, and no Documentation job has started since the last of it landed. The documents waited for that work (an
 * open change, a check on a branch), so the push that accepts the last of it starts them, whatever records that push
 * itself changed: a thermal record accepted at Architect feeds no section due there, yet it was what they waited for.
 */
export async function docsOwed(ctx: Context, repo: string, r: JourneyRecord): Promise<boolean> {
  if (r.journey.currentStage === 'define') return false
  const seen = await acceptedNow(ctx, repo, r)
  if (designWorkLeft(seen).length) return false
  const done = designDoneAt(seen)
  if (done === null) return false
  const rows = await jobRows(ctx, repo).catch(() => null)
  if (!rows) return false
  const last = Math.max(0, ...rows.filter((j) => creditedAgent(j) === 'docs' || j.agent === 'docs').map((j) => secs(j.startedAt) ?? secs(j.queuedAt) ?? 0))
  if (last >= done) return false
  return !(await stageChangesOpen(ctx, repo, r)).length
}

/** Why the documents wait, in words: the design work of the stage still to land. */
export const waitWords = (r: JourneyRecord, left: readonly CriterionRow[]): string =>
  `${STAGE_NAMES[r.journey.currentStage]}'s documents are written once its design work lands; still to come: ${left.map((c) => `${c.text.replace(/\.$/, '').toLowerCase()}${c.staleBecause ? ' (checked, but not in the accepted design yet)' : ''}`).join('; ')}.`

/**
 * Why a change starts no Documentation job: the records it changed feed no section due at the current stage, in
 * words, or null when they feed one (or the caller named no records: a stage opening, a missing document). Pure.
 */
export function notDueWords(stage: StageId, records: readonly SourceKind[] | undefined): string | null {
  if (!records?.length || dueSections(new Set(records), stage).length) return null
  return `The records that changed (${records.join(', ')}) feed no section due at ${STAGE_NAMES[stage]}, so the documents are not written again for them now: the stage that needs those sections writes them, from everything that changed since.`
}

/**
 * Start Scribe on the current stage's documents, unless that stage still has design work to land (designWorkLeft):
 * then nothing starts and `waiting` says what it waits for; the push or the person's act that lands the last of it
 * starts Scribe then (docsAfterDesign). `records`: what the push changed; when none of it feeds a section due at the
 * stage, nothing starts (notDueWords) unless `anyway` (a document is missing). `rec`: the record with the agents' facts, when the caller has it.
 */
export async function startStageScribe(ctx: Context, repo: string, why: string, o: { rec?: JourneyRecord | null; records?: readonly SourceKind[]; also?: readonly SourceKind[]; anyway?: boolean } = {}): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string; waiting?: string }> {
  const r = o.rec ?? await recordNow(ctx, repo)
  if (!r) return { skipped: 'The project has no journey yet.' }
  // a change that feeds only later stages' sections is written when they are due, once, not on every push before
  // (each Documentation job reads the documents and the records afresh: test-esp32 run 2 ran 17 of them before Sign-off)
  // unless the documents waited for what this push landed (docsOwed): then they are written now, the stage's
  // decisions with them
  let also = o.also
  const notDue = o.also?.length || o.anyway ? null : notDueWords(r.journey.currentStage, o.records)
  if (notDue) {
    if (!(await docsOwed(ctx, repo, r))) return { skipped: notDue }
    also = ['journey']
  }
  // the design as accepted: a check on a change still open is not yet the design the documents describe
  const left = designWorkLeft(await acceptedNow(ctx, repo, r))
  if (left.length) return { waiting: waitWords(r, left) }
  const open = await stageChangesOpen(ctx, repo, r)
  if (open.length) return { waiting: openWords(r, open) }
  return startScribe(ctx, repo, docsRequest(why, { stage: r.journey.currentStage, ...(o.records ? { records: o.records } : {}), ...(also ? { also } : {}) }))
}

/**
 * After a person's act that can meet a criterion (a guided review submitted, a question answered, a criterion signed
 * off): when it landed the last of the stage's design work (`before`: what was left before it, from the same record),
 * Scribe writes the stage's documents now. No push follows these acts, so hook.docs would not see them.
 */
export async function docsAfterDesign(ctx: Context, repo: string, before: readonly CriterionRow[] | null): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string; waiting?: string }> {
  if (!before?.length) return {}
  const r = await recordNow(ctx, repo)
  if (!r || r.journey.currentStage === 'define' || designWorkLeft(r).length) return {}
  return startStageScribe(ctx, repo, `${STAGE_NAMES[r.journey.currentStage]}'s design work is done.`, { rec: r, also: ['journey'] })
}

/**
 * The nightly drift check of one project (hook.drift): whether anything changed a record since the documents were
 * last written (each document's front-matter commit compared with the default branch), or a document the stage needs
 * is missing; if so, Scribe is started. Before Architect there is nothing to check.
 */
export async function driftOf(ctx: Context, repo: string, stage: StageId): Promise<{ head: string; records: SourceKind[]; missing: DocKind[]; since: string[]; started?: string; skipped?: string; jobId?: string; jobError?: string; waiting?: string }> {
  const gh = await ctx.deps.github()
  const { sha } = await gh.defaultBranch(repo)
  const docs = await documentsAt(ctx, repo, sha, stage)
  const since = [...new Set(docs.written.map((d) => d.commit).filter((c): c is string => Boolean(c)))]
  const records = new Set<SourceKind>()
  for (const base of since) {
    try { (await recordsBetween(ctx, repo, base, sha)).records.forEach((r) => records.add(r)) } catch { /* a commit GitHub no longer has: the documents are written again below */ }
  }
  // a document written without a commit it can be compared from is written again too
  const unknown = docs.written.some((d) => !d.commit)
  const out = { head: sha, records: [...records].sort(), missing: docs.missing, since }
  if (!out.records.length && !out.missing.length && !unknown) return out
  const why = [
    'The nightly check found the documents behind the default branch',
    out.missing.length ? ` (missing: ${out.missing.map((k) => DOCS[k].title.toLowerCase()).join(', ')})` : '',
    '.',
  ].join('')
  // the stage's design work still to land: the documents wait for it, as they do on a push
  // a document missing, or one with no commit to compare from, is written whatever the records feed
  return { ...out, ...(await startStageScribe(ctx, repo, why, { records: out.records, anyway: out.missing.length > 0 || unknown })) }
}
