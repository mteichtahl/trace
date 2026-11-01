/**
 * Large artifacts are kept gzipped in .trace/project.db (src/core/store.ts packArtifact), which lives in git under
 * GitHub's 100 MB file limit, and read back as they were written.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PACK_OVER, Work, artifactMime, packArtifact, packArtifacts, unpackArtifact } from '../../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-pack-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// a SPICE ASCII raw file's shape: a header and rows of numbers, which gzip shrinks several times
const raw = (points: number): string => `Title: astable\nNo. Variables: 3\nValues:\n${Array.from({ length: points }, (_, i) => ` ${i}\t${(i * 1e-4).toExponential(9)}\n\t${Math.sin(i / 50).toExponential(9)}\n\t${(i % 7 === 0 ? 4.99 : 0.01).toExponential(9)}`).join('\n')}\n`

describe('packed artifacts', () => {
  it('a large waveform is stored gzipped, read back byte for byte, and listed with its own mime', () => {
    const w = new Work(join(dir, 'a.db'))
    const text = raw(20000)
    expect(text.length).toBeGreaterThan(PACK_OVER)
    const id = w.start('sim.spice')
    w.artifact(id, 'tran.raw', text)
    w.artifact(id, 'small.log', 'ok')
    const stored = w.db.prepare("SELECT mime, length(bytes) AS n FROM artifacts WHERE name='tran.raw'").get() as { mime: string; n: number }
    expect(stored.mime).toBe('text/plain; trace-encoding=gzip')
    expect(stored.n).toBeLessThan(text.length / 3)
    expect(new TextDecoder().decode(w.getArtifact(id, 'tran.raw')!)).toBe(text)
    expect(new TextDecoder().decode(w.getArtifact(id, 'small.log')!)).toBe('ok')
    expect(w.run(id)?.artifacts.find((a) => a.name === 'tran.raw')?.mime).toBe('text/plain')
    w.close()
  })

  it('leaves small files, compressed formats and data gzip does not shrink as they are', () => {
    const big = new TextEncoder().encode(raw(20000))
    expect(packArtifact('text/plain', new TextEncoder().encode('short'))).toMatchObject({ mime: 'text/plain' })
    expect(packArtifact('image/png', big).mime).toBe('image/png')
    expect(packArtifact('application/pdf', big).mime).toBe('application/pdf')
    const noise = new Uint8Array(randomBytes(PACK_OVER + 1000))
    const kept = packArtifact('application/octet-stream', noise)
    expect(kept.mime).toBe('application/octet-stream')
    expect(kept.bytes).toBe(noise)
    expect(unpackArtifact('text/plain', big).bytes).toBe(big)
    expect(artifactMime('image/svg+xml; trace-encoding=gzip')).toBe('image/svg+xml')
    expect(artifactMime(null)).toBeNull()
  })

  it('tracectl db pack packs what an older database holds, and keeps every run', () => {
    const w = new Work(join(dir, 'b.db'))
    const id = w.start('sim.kicad_spice')
    const text = raw(20000)
    // written as an older trace did: unpacked
    w.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run(id, 'tran.raw', 'text/plain', new TextEncoder().encode(text))
    const r = packArtifacts(w.db)
    expect(r.packed).toBe(1)
    expect(r.after).toBeLessThan(r.before / 3)
    expect(packArtifacts(w.db).packed).toBe(0)
    expect(new TextDecoder().decode(w.getArtifact(id, 'tran.raw')!)).toBe(text)
    expect((w.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n).toBe(1)
    w.close()
  })
})
