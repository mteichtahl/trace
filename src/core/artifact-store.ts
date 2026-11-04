/**
 * Large run outputs kept outside the run record (docs/artifact-store.md). `.trace/project.db` lives in git, so a
 * revision's renders (about 5 MB a picture at release quality) would grow every project's repository by tens of
 * megabytes a revision. A tool that makes large outputs stores them with Work.storeArtifact instead: the bytes go to the
 * project's own folder in the installation's bucket, content-addressed, and the run record keeps a row naming them.
 *
 *   s3://<bucket>/projects/<owner>/<repo>/artifacts/<sha256>      the bytes, written once (If-None-Match), never changed
 *   artifacts row (run_id, name, mime, bytes)                     mime carries `; trace-stored=<sha256>:<size>`, bytes is empty
 *
 * The run's artifact_hashes row is written as for any artifact, so lineage and freshness are unchanged. Where there is
 * no bucket (a person's own checkout, tests) the output is kept in the run record as before. The API reads a stored
 * output back for the app (src/api/actions.ts `artifact`, actions-files.ts `files.url`); the worker may write the
 * project's `artifacts/` folder (it may write anything under its project's prefix) and the API may read it
 * (src/infra/api-grants.ts).
 */
import { type Backend, Conflict } from './central.js'
import { ARTIFACTS_FOLDER, PROJECTS_PREFIX, projectSlug } from './project.js'
import { projectsBackend, projectsFromEnv } from './agent-facts.js'

/** Outputs above this go to the bucket when one is there; smaller ones stay in the run record. */
export const STORE_OVER = 512 * 1024

import { storedRef } from './store.js'
export { storedMime, storedRef, withoutStored } from './store.js'

/** A stored output's key under the bucket's `projects` prefix. */
export const artifactKey = (repository: string, sha256: string): string => `${projectSlug(repository)}/${ARTIFACTS_FOLDER}/${sha256}`

/** Where this process stores large outputs: its project's folder in the bucket, or null (kept in the run record). */
export interface ArtifactStore { backend: Backend; repository: string }

export function artifactStoreFromEnv(env: Record<string, string | undefined> = process.env): ArtifactStore | null {
  // only in a job on an installation: a person's checkout keeps its outputs in its own record
  if (!env.TRACE_JOB_ID && !env.TRACE_STORE_ARTIFACTS) return null
  const at = projectsFromEnv(env)
  if (!at || !at.projects.startsWith('s3://')) return null
  return { backend: projectsBackend(at.projects), repository: at.repository }
}

/** Write a stored output once: an object already there under the same hash is the same bytes. */
export async function putStored(store: ArtifactStore, sha256: string, bytes: Uint8Array, contentType: string): Promise<void> {
  try {
    await store.backend.put(artifactKey(store.repository, sha256), bytes, { ifNoneMatch: true, contentType })
  } catch (e) {
    if (!(e instanceof Conflict)) throw e
  }
}

/** A stored output's bytes, from the bucket's `projects` prefix (the API's store at PROJECTS_PREFIX). */
export async function getStored(projects: Backend, repository: string, sha256: string): Promise<Uint8Array | null> {
  const got = await projects.get(artifactKey(repository, sha256))
  return got?.body ?? null
}

export { PROJECTS_PREFIX }

/**
 * Keep a tool's output in its run: in the bucket when this is a job on an installation and the output is large
 * (Work.storeArtifact), else in the run record. What render.*, docs.publish and other tools with large outputs call.
 */
export function keepOutput(work: import('./store.js').Work, id: string, name: string, data: Uint8Array, mime: string, store: ArtifactStore | null = artifactStoreFromEnv()): Promise<'stored' | 'kept'> {
  return work.storeArtifact(id, name, data, mime, store ? (sha, bytes, m) => putStored(store, sha, bytes, m) : null, STORE_OVER)
}

/**
 * A run output's bytes wherever it is kept: the run record's row, or the bucket for a stored one (when this process can
 * reach it: a job on an installation). Null when the run has no such output, or it is stored and the bucket cannot be
 * reached from here (a person's own checkout).
 */
export async function readOutput(work: import('./store.js').Work, id: string, name: string, store: ArtifactStore | null = artifactStoreFromEnv()): Promise<Uint8Array | null> {
  const row = work.db.prepare('SELECT mime FROM artifacts WHERE run_id=? AND name=?').get(id, name) as { mime: string | null } | undefined
  if (!row) return null
  const ref = storedRef(row.mime)
  if (!ref) return work.getArtifact(id, name)
  return store ? getStored(store.backend, store.repository, ref.sha256) : null
}
