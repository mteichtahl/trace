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
 *                                  wrote "pending" in every section the stage was about (test-esp32 #58, #98, #120)
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
import { sourcesOfDatabases, sourcesOfPaths } from '../docs/stale.js'
import { designWorkLeft, loadJourney, mergeAgentFacts, type CriterionRow, type JourneyRecord } from '../core/journey.js'
import { type Context, agentFacts, journeyStore, label, PROJECT_DB_PATH } from './action-kit.js'

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

/** Start Scribe on the project, unless one of its jobs is already queued or running (`queue`: start it anyway, behind). */
export async function startScribe(ctx: Context, repo: string, request: string, o: { queue?: boolean } = {}): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string }> {
  try {
    const jobs = await ctx.deps.jobs()
    const busy = o.queue ? undefined : (await jobs.jobStatus()).find((j) => j.repository === repo && j.agent === 'docs' && (j.state === 'queued' || j.state === 'running'))
    if (busy) return { skipped: `Scribe is already working on this project (job ${busy.id}); it compares with the documents' last commit, so it sees this too.` }
    const r = await jobs.startJob({ kind: 'task', repository: repo, request, agent: 'docs', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
    return r.accepted ? { jobId: r.jobId, started: 'The Documentation agent brings the project\'s documents up to date.' } : { jobError: r.reason ?? 'trace did not accept the job.' }
  } catch (e) {
    return { jobError: e instanceof Error ? e.message : String(e) }
  }
}

/** The project's record with the agents' facts merged in (their checks meet trace's criteria), or null before a journey. */
export async function recordNow(ctx: Context, repo: string): Promise<JourneyRecord | null> {
  const [rec, facts] = await Promise.all([journeyStore(ctx, repo).read((db) => loadJourney(db)), agentFacts(ctx, repo).catch(() => null)])
  return rec.result && facts ? mergeAgentFacts(rec.result, facts) : rec.result
}

/** Why the documents wait, in words: the design work of the stage still to land. */
export const waitWords = (r: JourneyRecord, left: readonly CriterionRow[]): string =>
  `${STAGE_NAMES[r.journey.currentStage]}'s documents are written once its design work lands; still to come: ${left.map((c) => c.text.replace(/\.$/, '').toLowerCase()).join('; ')}.`

/**
 * Start Scribe on the current stage's documents, unless that stage still has design work to land (designWorkLeft):
 * then nothing starts and `waiting` says what it waits for; the push or the person's act that lands the last of it
 * starts Scribe then (docsAfterDesign). `rec`: the record with the agents' facts, when the caller has it.
 */
export async function startStageScribe(ctx: Context, repo: string, why: string, o: { rec?: JourneyRecord | null; records?: readonly SourceKind[]; also?: readonly SourceKind[] } = {}): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string; waiting?: string }> {
  const r = o.rec ?? await recordNow(ctx, repo)
  if (!r) return { skipped: 'The project has no journey yet.' }
  const left = designWorkLeft(r)
  if (left.length) return { waiting: waitWords(r, left) }
  return startScribe(ctx, repo, docsRequest(why, { stage: r.journey.currentStage, ...(o.records ? { records: o.records } : {}), ...(o.also ? { also: o.also } : {}) }))
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
  return { ...out, ...(await startStageScribe(ctx, repo, why, { records: out.records })) }
}
