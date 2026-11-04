/**
 * Large run outputs kept outside the run record (src/core/artifact-store.ts): a large output goes to the project's
 * artifacts folder under its SHA-256 and the row names it (empty bytes, marked mime, its size); a small one, or one with
 * no bucket, stays in the record; lineage hashes are written either way; readers get the bytes back from wherever they
 * are; a run's artifact list shows the stored size.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ArtifactStore, STORE_OVER, artifactKey, artifactStoreFromEnv, keepOutput, readOutput, storedRef } from '../../src/core/artifact-store.js'
import { backendFor } from '../../src/core/central.js'
import { Work, artifactMime } from '../../src/core/store.js'

function work(): Work {
  const dir = mkdtempSync(join(tmpdir(), 'trace-artifact-store-'))
  mkdirSync(join(dir, '.git'))
  return new Work(join(dir, 'project.db'))
}
const bucket = (): ArtifactStore => ({ backend: backendFor(mkdtempSync(join(tmpdir(), 'trace-artifact-bucket-'))), repository: 'Acme/Soil' })
const big = (n = STORE_OVER + 10): Uint8Array => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31) % 251; return b }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('keeping large outputs in the bucket', () => {
  it('stores a large output under its hash in the project\'s folder, and the row names it', async () => {
    const w = work()
    const store = bucket()
    const id = w.start('render.showcase')
    const data = big()
    expect(await keepOutput(w, id, 'x_rev-B_2026-11-05_exploded.png', data, 'image/png', store)).toBe('stored')
    const row = w.db.prepare('SELECT mime, length(bytes) AS n FROM artifacts WHERE run_id=?').get(id) as { mime: string; n: number }
    expect(row.n).toBe(0)
    expect(storedRef(row.mime)).toEqual({ sha256: sha(data), size: data.length, mime: 'image/png' })
    expect(artifactMime(row.mime)).toBe('image/png')
    expect(artifactKey('Acme/Soil', sha(data))).toBe(`acme/soil/artifacts/${sha(data)}`)
    expect((await store.backend.get(artifactKey('Acme/Soil', sha(data))))?.body).toEqual(data)
    // lineage as for any output
    expect(w.db.prepare('SELECT count(*) AS n FROM artifact_hashes WHERE run_id=?').get(id)).toEqual({ n: 1 })
    // the run's list shows its real size; getArtifact says it is not in the record; readOutput fetches it
    expect(w.run(id)?.artifacts[0]).toMatchObject({ name: 'x_rev-B_2026-11-05_exploded.png', size: data.length })
    expect(w.getArtifact(id, 'x_rev-B_2026-11-05_exploded.png')).toBeNull()
    expect(await readOutput(w, id, 'x_rev-B_2026-11-05_exploded.png', store)).toEqual(data)
    expect(await readOutput(w, id, 'x_rev-B_2026-11-05_exploded.png', null)).toBeNull()
  })

  it('keeps a small output, or any output with no bucket, in the run record as before', async () => {
    const w = work()
    const id = w.start('render.board')
    expect(await keepOutput(w, id, 'top.png', big(1000), 'image/png', bucket())).toBe('kept')
    expect(await keepOutput(w, id, 'iso.png', big(), 'image/png', null)).toBe('kept')
    expect(w.getArtifact(id, 'iso.png')?.length).toBe(STORE_OVER + 10)
    expect(await readOutput(w, id, 'top.png', null)).toEqual(big(1000))
  })

  it('writes the same bytes once: a second run with the same picture reuses the object', async () => {
    const w = work()
    const store = bucket()
    const data = big()
    for (const k of ['a', 'b']) await keepOutput(w, w.start(`render.${k}`), 'p.png', data, 'image/png', store)
    expect(await store.backend.list('acme/soil/artifacts/')).toHaveLength(1)
  })

  it('stores only in a job on an installation whose home is the bucket', () => {
    expect(artifactStoreFromEnv({ TRACE_PROJECT: 'acme/soil', TRACE_PROJECT_HOME: 's3://b/projects/acme/soil' })).toBeNull()
    expect(artifactStoreFromEnv({ TRACE_JOB_ID: 'j1', TRACE_PROJECT: 'acme/soil', TRACE_HOME: '/tmp/home' })).toBeNull()
    expect(artifactStoreFromEnv({ TRACE_JOB_ID: 'j1', TRACE_PROJECT: 'acme/soil', TRACE_PROJECT_HOME: 's3://b/projects/acme/soil' })).toMatchObject({ repository: 'acme/soil' })
  })

  it('reads only well-formed markers', () => {
    expect(storedRef('image/png')).toBeNull()
    expect(storedRef('image/png; trace-stored=nothex:12')).toBeNull()
    expect(storedRef(`video/mp4; trace-stored=${'a'.repeat(64)}:99`)).toEqual({ sha256: 'a'.repeat(64), size: 99, mime: 'video/mp4' })
  })
})
