/**
 * The printed copies of a project's documents (docs/scribe.md "Publishing"): kept in the central bucket beside the
 * project's other records, never in the repository's run record, which grows with every print otherwise. They are
 * under the agents' own prefix (projects/<slug>/journey-agent, src/infra/project.ts), whose writes the worker's role
 * allows only as conditional puts and never deletes, so a released copy cannot be replaced or removed from Bash.
 *
 *   <projects>/<slug>/journey-agent/documents/printed/<sha256>.pdf       every copy docs.publish prints, named by
 *                                                                       its content: written once (If-None-Match)
 *   <projects>/<slug>/journey-agent/documents/releases/<revision>.json  the copies printed for a revision when it
 *                                                                       was cut: one entry per document, each
 *                                                                       written once; a later print of the same
 *                                                                       document for the same revision is kept out
 *
 * The release manifests are what the journey record's revisions show their documents from (documents.get joins them
 * with the journey.snapshot decisions). The nightly drift check runs at DRIFT_HOUR_UTC (nextDriftCheck).
 */
import { type Backend, Conflict, sha256Hex } from '../core/central.js'
import { AGENT_FACTS_FOLDER } from '../core/agent-facts.js'
import { projectSlug } from '../core/project.js'
import { DOC_KINDS, type DocKind } from './catalog.js'

export const PRINTED_FOLDER = `${AGENT_FACTS_FOLDER}/documents`
const REVISION = /^[A-Z]{1,3}$/
const SHA = /^[0-9a-f]{64}$/

export const printedKey = (repository: string, sha256: string): string => `${projectSlug(repository)}/${PRINTED_FOLDER}/printed/${sha256}.pdf`
export const releaseKey = (repository: string, revision: string): string => `${projectSlug(repository)}/${PRINTED_FOLDER}/releases/${revision}.json`

/** One printed document, as a release manifest and docs.publish's run record it. */
export interface Printed {
  kind: DocKind
  sha256: string
  bytes: number
  /** the commit the document was printed at */
  commit: string | null
  /** the docs.publish run that printed it */
  run: string
  /** epoch ms */
  at: number
}

export interface ReleaseManifest { revision: string; documents: Printed[] }

/** Keep one printed copy (idempotent: the same bytes are the same key). Returns its key and hash. */
export async function storePrinted(store: Backend, repository: string, pdf: Uint8Array): Promise<{ key: string; sha256: string }> {
  const sha256 = sha256Hex(pdf)
  const key = printedKey(repository, sha256)
  try {
    await store.put(key, pdf, { ifNoneMatch: true, contentType: 'application/pdf' })
  } catch (e) {
    // already there: the same content under the same name
    if (!(e instanceof Conflict)) throw e
  }
  return { key, sha256 }
}

/** A printed copy's bytes, or null. */
export async function readPrinted(store: Backend, repository: string, sha256: string): Promise<Uint8Array | null> {
  if (!SHA.test(sha256)) return null
  return (await store.get(printedKey(repository, sha256)))?.body ?? null
}

const parseManifest = (body: Uint8Array, revision: string): ReleaseManifest => {
  try {
    const m = JSON.parse(Buffer.from(body).toString('utf8')) as Partial<ReleaseManifest>
    const documents = (Array.isArray(m.documents) ? m.documents : []).filter((d): d is Printed =>
      Boolean(d) && (DOC_KINDS as readonly string[]).includes(d.kind) && SHA.test(String(d.sha256)) && typeof d.run === 'string')
    return { revision, documents }
  } catch {
    return { revision, documents: [] }
  }
}

/**
 * Add printed documents to a revision's release copies. A document the revision already has a copy of is kept as it
 * was (a released copy is never replaced): those are returned as `kept`. Conditional writes, re-run on a lost race.
 */
export async function recordRelease(store: Backend, repository: string, revision: string, docs: readonly Printed[]): Promise<{ added: DocKind[]; kept: DocKind[] }> {
  if (!REVISION.test(revision)) throw new Error(`"${revision}" is not a revision (A, B, … AA)`)
  const key = releaseKey(repository, revision)
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await store.get(key)
    const m = got ? parseManifest(got.body, revision) : { revision, documents: [] }
    const have = new Set(m.documents.map((d) => d.kind))
    const added = docs.filter((d) => !have.has(d.kind))
    const kept = docs.filter((d) => have.has(d.kind)).map((d) => d.kind)
    if (!added.length) return { added: [], kept }
    const next: ReleaseManifest = { revision, documents: [...m.documents, ...added].sort((a, b) => DOC_KINDS.indexOf(a.kind) - DOC_KINDS.indexOf(b.kind)) }
    try {
      await store.put(key, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), { contentType: 'application/json', ...(got ? { ifMatch: got.etag } : { ifNoneMatch: true }) })
      return { added: added.map((d) => d.kind), kept }
    } catch (e) {
      if (!(e instanceof Conflict)) throw e
    }
  }
  throw new Error(`the release copies of revision ${revision} kept changing while they were written: try again`)
}

/** Every revision's release copies, oldest revision first (A, B, … Z, AA). */
export async function releasesOf(store: Backend, repository: string): Promise<ReleaseManifest[]> {
  const prefix = `${projectSlug(repository)}/${PRINTED_FOLDER}/releases/`
  const keys = (await store.list(prefix)).filter((k) => k.endsWith('.json'))
  const out: ReleaseManifest[] = []
  for (const k of keys) {
    const revision = k.slice(k.lastIndexOf('/') + 1, -'.json'.length)
    if (!REVISION.test(revision)) continue
    const got = await store.get(k)
    if (got) out.push(parseManifest(got.body, revision))
  }
  return out.sort((a, b) => a.revision.length - b.revision.length || a.revision.localeCompare(b.revision))
}

export { DRIFT_EVENT, DRIFT_HOUR_UTC, nextDriftCheck } from './drift.js'
