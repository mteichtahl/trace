/**
 * A project's documents as the app shows them (docs/scribe.md "Publishing"; the Docs tab):
 *
 *   documents.get   read   { repo } → each document on the default branch (written or not, its revision and the
 *                          commit and day it was last written at, from its front matter), each revision's release
 *                          copies with the record of the revision they were printed for (the journey.snapshot
 *                          decision: its commit and branch), and when the nightly drift check next runs
 *   documents.pdf   read   { repo, sha256 } → one printed copy's bytes (base64) from the central bucket, when at most
 *                          MAX_ARTIFACT
 *
 * Printed copies are in the central bucket, never the repository (src/docs/printed.ts); nothing here writes.
 */
import { z } from 'zod'
import { RepoSlug } from '../core/access.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { loadJourney } from '../core/journey.js'
import { DOC_KINDS, DOCS } from '../docs/catalog.js'
import { parseDoc } from '../docs/markers.js'
import { nextDriftCheck, readPrinted, releasesOf } from '../docs/printed.js'
import { ActionError, def, journeyStore, MAX_ARTIFACT, storeAt } from './action-kit.js'

export const DOCUMENT_ACTIONS = {
  'documents.get': def('read', z.object({ repo: RepoSlug }), async ({ repo }, ctx) => {
    const gh = await ctx.deps.github()
    const { branch, sha } = await gh.defaultBranch(repo)
    const documents = await Promise.all(DOC_KINDS.map(async (k) => {
      const bytes = await gh.rawFile(repo, DOCS[k].file, sha)
      const front = bytes ? parseDoc(Buffer.from(bytes).toString('utf8')).front : null
      return {
        kind: k, title: DOCS[k].title, file: DOCS[k].file, exists: Boolean(bytes),
        revision: front?.revision ?? null, commit: front?.commit ?? null, updated: front?.updated ?? null,
      }
    }))
    const [manifests, rec] = await Promise.all([
      releasesOf(storeAt(ctx, PROJECTS_PREFIX), repo),
      journeyStore(ctx, repo).read((db) => loadJourney(db)).then((x) => x.result).catch(() => null),
    ])
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
    }))
    return { repo, branch, commit: sha, documents, releases, next_check: nextDriftCheck(new Date()).toISOString() }
  }),

  'documents.pdf': def('read', z.object({ repo: RepoSlug, sha256: z.string().regex(/^[0-9a-f]{64}$/) }), async ({ repo, sha256 }, ctx) => {
    const bytes = await readPrinted(storeAt(ctx, PROJECTS_PREFIX), repo, sha256)
    if (!bytes) throw new ActionError('There is no printed copy with that hash for this project.')
    if (bytes.length > MAX_ARTIFACT) throw new ActionError(`That printed copy is ${(bytes.length / 1048576).toFixed(1)} MB, more than the app opens (${MAX_ARTIFACT / 1048576} MB).`)
    return { repo, sha256, bytes: bytes.length, mime: 'application/pdf', base64: Buffer.from(bytes).toString('base64') }
  }),
}
