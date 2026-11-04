/**
 * A project's documents as the app shows them (docs/scribe.md "Publishing"; the Docs tab):
 *
 *   documents.get   read   { repo } → each document on the default branch: written or not, due or not, how current
 *                          (DocState: the records changed since the commit it was written at, by GitHub's
 *                          comparison, and the sections due by the stage still pending), its revision, commit and day
 *                          (front matter), and its newest print (whether it is of that commit); each revision's
 *                          release copies, newest first, with the record of the revision they were printed for (the
 *                          journey.snapshot decision: its commit and branch); the Documentation agent's job when one
 *                          is working; and when the nightly drift check next runs
 *   documents.pdf   read   { repo, sha256 } → one printed copy's bytes (base64) from the central bucket, when at most
 *                          MAX_ARTIFACT
 *
 * Printed copies are in the central bucket, never the repository (src/docs/printed.ts); nothing here writes.
 */
import { z } from 'zod'
import { RepoSlug } from '../core/access.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { loadJourney } from '../core/journey.js'
import { DOC_KINDS, DOCS, reached, type SourceKind } from '../docs/catalog.js'
import { parseDoc } from '../docs/markers.js'
import { latestOf, nextDriftCheck, readPrinted, releasesOf } from '../docs/printed.js'
import { ActionError, type Context, def, journeyStore, MAX_ARTIFACT, storeAt } from './action-kit.js'
import { recordsBetween } from './docs-follow.js'

/**
 * How current a document is: written and nothing it is written from changed since (current); a record it is written
 * from changed since, or a section due by the stage is still pending (behind); not written though the stage needs it
 * (missing); not needed yet (later); written, but its commit could not be compared (unknown).
 */
export type DocState = 'current' | 'behind' | 'missing' | 'later' | 'unknown'

/** The Documentation agent's job on the project now, if one is queued or running. */
async function scribeAt(ctx: Context, repo: string): Promise<{ job: string; state: string; since: string | null } | null> {
  try {
    const j = (await (await ctx.deps.jobs()).jobStatus()).find((x) => x.repository === repo && x.agent === 'docs' && (x.state === 'queued' || x.state === 'running'))
    if (!j) return null
    const t = (j.startedAt ?? j.queuedAt) as number | string | null | undefined
    const since = typeof t === 'number' ? new Date(t * (t < 1e12 ? 1000 : 1)).toISOString() : typeof t === 'string' ? t : null
    return { job: j.id, state: j.state, since }
  } catch {
    return null
  }
}

export const DOCUMENT_ACTIONS = {
  'documents.get': def('read', z.object({ repo: RepoSlug }), async ({ repo }, ctx) => {
    const gh = await ctx.deps.github()
    const { branch, sha } = await gh.defaultBranch(repo)
    const store = storeAt(ctx, PROJECTS_PREFIX)
    const [manifests, latest, rec, writing] = await Promise.all([
      releasesOf(store, repo),
      latestOf(store, repo),
      journeyStore(ctx, repo).read((db) => loadJourney(db)).then((x) => x.result).catch(() => null),
      scribeAt(ctx, repo),
    ])
    const stage = rec?.journey.currentStage ?? null
    // the records changed since each commit a document was written at, asked once per commit
    const since = new Map<string, Promise<SourceKind[] | null>>()
    const behindOf = (commit: string): Promise<SourceKind[] | null> => {
      if (!since.has(commit)) since.set(commit, recordsBetween(ctx, repo, commit, sha).then((r) => r.records, () => null))
      return since.get(commit)!
    }
    const documents = await Promise.all(DOC_KINDS.map(async (k) => {
      const def = DOCS[k]
      const bytes = await gh.rawFile(repo, def.file, sha)
      const parsed = bytes ? parseDoc(Buffer.from(bytes).toString('utf8')) : null
      const front = parsed?.front ?? null
      const commit = front?.commit && /^[0-9a-f]{4,40}$/.test(front.commit) ? front.commit : null
      // due: the stage reached the document's own; the protocol specification only once it exists (an interface)
      const due = Boolean(stage && stage !== 'define' && reached(stage, def.from) && (def.when === 'always' || parsed))
      const sections = def.sections.map((sd) => {
        const got = parsed?.sections.find((x) => x.id === sd.id)
        return { id: sd.id, title: sd.title, due: sd.due, written: Boolean(got && !got.pending), overdue: Boolean(stage && reached(stage, sd.due) && (!got || got.pending)) }
      })
      const behind = parsed && commit ? await behindOf(commit) : null
      const p = latest[k] ?? null
      const state: DocState = !parsed ? (due ? 'missing' : 'later')
        : (behind?.length || sections.some((x) => x.overdue) ? 'behind' : behind === null && commit ? 'unknown' : 'current')
      return {
        kind: k, title: def.title, file: def.file, exists: Boolean(parsed), due, from: def.from, state,
        revision: front?.revision ?? null, commit, updated: front?.updated ?? null,
        behind: behind ?? [], sections,
        printed: p ? { ...p, current: Boolean(commit && p.commit && (p.commit.startsWith(commit) || commit.startsWith(p.commit))) } : null,
      }
    }))
    // each revision's record copy (journey.snapshot), newest last: the release copies sit with it
    const cuts = new Map<string, { at: number; commit: string | null; branch: string | null }>()
    for (const d of [...(rec?.decisions ?? [])].reverse()) {
      if (d.kind !== 'journey.snapshot') continue
      const det = (d.detail ?? {}) as { revision?: string; commit?: string; branch?: string }
      if (det.revision) cuts.set(det.revision, { at: d.at, commit: det.commit ?? d.ref, branch: det.branch ?? null })
    }
    const releases = manifests.map((m) => ({
      revision: m.revision, cut: cuts.get(m.revision) ?? null,
      documents: m.documents.map((d) => ({ ...d, title: DOCS[d.kind].title })),
    })).reverse()
    return { repo, branch, commit: sha, stage, documents, releases, writing, next_check: nextDriftCheck(new Date()).toISOString() }
  }),

  'documents.pdf': def('read', z.object({ repo: RepoSlug, sha256: z.string().regex(/^[0-9a-f]{64}$/) }), async ({ repo, sha256 }, ctx) => {
    const bytes = await readPrinted(storeAt(ctx, PROJECTS_PREFIX), repo, sha256)
    if (!bytes) throw new ActionError('There is no printed copy with that hash for this project.')
    if (bytes.length > MAX_ARTIFACT) throw new ActionError(`That printed copy is ${(bytes.length / 1048576).toFixed(1)} MB, more than the app opens (${MAX_ARTIFACT / 1048576} MB).`)
    return { repo, sha256, bytes: bytes.length, mime: 'application/pdf', base64: Buffer.from(bytes).toString('base64') }
  }),
}
