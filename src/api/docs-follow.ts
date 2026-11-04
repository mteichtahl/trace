/**
 * When Scribe starts on its own (docs/scribe.md "Event driven"): the documents are brought up to date after anything
 * that can change them, without a person asking.
 *
 *   a push to the default branch   (hook.docs, called by the hooks function on that push, src/web/hooks.ts): when
 *                                  the commit changed a record a document is written from (its files, and its project
 *                                  database compared with its parent's table by table, src/docs/stale.ts). A commit
 *                                  that changed only the documents, or only runs Scribe makes for them, starts nothing,
 *                                  so Scribe's own change never starts Scribe again
 *   a gate signed                  (gate.sign): the stage that opens may need new documents or new sections
 *
 * One Scribe job at a time per project: while one is queued or running, another is not started (the running one
 * compares with the commit the documents were last written at, so it sees every change since).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StageId } from '../core/journey-catalog.js'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import type { SourceKind } from '../docs/catalog.js'
import { sourcesOfDatabases, sourcesOfPaths } from '../docs/stale.js'
import { type Context, label, PROJECT_DB_PATH } from './action-kit.js'

/** What Scribe is asked. `why`: what happened, in a person's words. Pure. */
export function docsRequest(why: string, o: { stage?: StageId | null; records?: readonly SourceKind[] } = {}): string {
  return [
    `${why} Bring the project's documents up to date.`,
    o.stage ? `The project is at ${STAGE_NAMES[o.stage]} (stage ${o.stage}): start any document it needs that is missing (docs_init), and write every section due by it.` : 'Read the stage with journey_status first.',
    o.records?.length ? `The records that changed: ${o.records.join(', ')}.` : '',
    'Find the sections to write with docs_stale, leaving base unset so it compares with the commit the documents were last written at. Write only those sections and the pending ones now due; check, print and deliver as your instructions say. If nothing needs writing, say so and stop without a change.',
  ].filter(Boolean).join('\n')
}

/** The records a commit changed, from its files and (when it changed it) the project database against its parent's. */
export async function recordsOfCommit(ctx: Context, repo: string, sha: string): Promise<{ records: SourceKind[]; paths: string[] }> {
  const gh = await ctx.deps.github()
  if (!gh.request) return { records: [], paths: [] }
  const c = await gh.request('GET', `/repos/${repo}/commits/${sha}`) as { parents?: { sha: string }[]; files?: { filename: string }[] }
  const paths = (c.files ?? []).map((f) => f.filename)
  const records = sourcesOfPaths(paths.filter((p) => !p.startsWith('docs/design/')))
  const parent = c.parents?.[0]?.sha
  if (parent && paths.includes(PROJECT_DB_PATH)) {
    const dir = mkdtempSync(join(ctx.deps.scratch, 'docs-follow-'))
    const open = async (ref: string): Promise<DatabaseSync | null> => {
      const bytes = await gh.rawFile(repo, PROJECT_DB_PATH, ref)
      if (!bytes) return null
      const f = join(dir, `${ref}.db`)
      writeFileSync(f, bytes)
      return new DatabaseSync(f, { readOnly: true })
    }
    const before = await open(parent)
    const after = await open(sha)
    try { sourcesOfDatabases(before, after).forEach((r) => records.add(r)) } finally { before?.close(); after?.close(); rmSync(dir, { recursive: true, force: true }) }
  }
  return { records: [...records].sort(), paths }
}

/** Start Scribe on the project, unless one of its jobs is already queued or running. */
export async function startScribe(ctx: Context, repo: string, request: string): Promise<{ jobId?: string; started?: string; skipped?: string; jobError?: string }> {
  try {
    const jobs = await ctx.deps.jobs()
    const busy = (await jobs.jobStatus()).find((j) => j.repository === repo && j.agent === 'docs' && (j.state === 'queued' || j.state === 'running'))
    if (busy) return { skipped: `Scribe is already working on this project (job ${busy.id}); it compares with the documents' last commit, so it sees this too.` }
    const r = await jobs.startJob({ kind: 'task', repository: repo, request, agent: 'docs', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
    return r.accepted ? { jobId: r.jobId, started: 'The Documentation agent brings the project\'s documents up to date.' } : { jobError: r.reason ?? 'trace did not accept the job.' }
  } catch (e) {
    return { jobError: e instanceof Error ? e.message : String(e) }
  }
}
