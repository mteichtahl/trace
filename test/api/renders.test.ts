/**
 * renders.list's reading (src/api/actions-renders.ts): each revision's renders from the run record, the newest passing
 * run of a revision winning, pictures in the app's order with their sizes, nothing for failed runs or a run whose
 * pictures are gone; and the revision a rendering job's request names.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rendersRequest } from '../../src/api/actions-journey.js'
import { readRenders, revisionOfRequest } from '../../src/api/actions-renders.js'
import { Work } from '../../src/core/store.js'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const palette = { source: 'logo', logo: { path: 'docs/design/logo.png', sha256: 'ab'.repeat(32) }, base: '#1d3557', accent: '#e63946', neutral: '#a8b0ba', background: ['#4075bf', '#14253d'] }

function record(): Work {
  const dir = mkdtempSync(join(tmpdir(), 'trace-renders-api-'))
  mkdirSync(join(dir, '.git'))
  return new Work(join(dir, 'project.db'))
}

function showcase(w: Work, revision: string, date: string, shots: Record<string, string>, o: { status?: 'pass' | 'fail'; keep?: string[] } = {}): string {
  const id = w.start('render.showcase', { subject: 'hardware/x.kicad_pcb', gitSha: 'a41e9d0' })
  for (const name of o.keep ?? Object.keys(shots)) w.artifact(id, name, PNG, 'image/png')
  w.finish(id, o.status ?? 'pass', 'rendered', {
    revision, date, palette, shots, case: { look: 'nylon' },
    artifacts: Object.keys(shots).map((name) => ({ name, bytes: 8, width: 2560, height: 1600 })),
  })
  return id
}

describe('renders.list reading', () => {
  it('lists each revision newest first, its pictures assembly first, with sizes and colours', () => {
    const w = record()
    showcase(w, 'A', '2026-10-21', { 'x_rev-A_2026-10-21_board.png': 'board' })
    const b = showcase(w, 'B', '2026-11-05', {
      'x_rev-B_2026-11-05_board-top.png': 'board-top', 'x_rev-B_2026-11-05_exploded.png': 'exploded', 'x_rev-B_2026-11-05_case.png': 'case',
    })
    const r = readRenders(w.db)
    expect(r.map((x) => x.revision)).toEqual(['B', 'A'])
    expect(r[0]).toMatchObject({ revision: 'B', date: '2026-11-05', run: b, commit: 'a41e9d0', case: 'nylon', palette: { source: 'logo', base: '#1d3557', logo: 'docs/design/logo.png' } })
    expect(r[0]?.pictures.map((p) => [p.shot, p.label])).toEqual([['exploded', 'Exploded'], ['case', 'Case'], ['board-top', 'Top']])
    expect(r[0]?.pictures[0]).toMatchObject({ width: 2560, height: 1600, bytes: 8 })
  })

  it('takes the newest passing run of a revision, and leaves out failed runs and missing pictures', () => {
    const w = record()
    showcase(w, 'B', '2026-11-05', { 'old.png': 'board' })
    const newer = showcase(w, 'B', '2026-11-05', { 'new.png': 'board', 'gone.png': 'case' }, { keep: ['new.png'] })
    showcase(w, 'C', '2026-11-06', { 'c.png': 'board' }, { status: 'fail' })
    const r = readRenders(w.db)
    expect(r).toHaveLength(1)
    expect(r[0]?.run).toBe(newer)
    expect(r[0]?.pictures.map((p) => p.name)).toEqual(['new.png'])
  })

  it('orders AA after Z', () => {
    const w = record()
    for (const rev of ['Z', 'AA', 'Y']) showcase(w, rev, '2026-11-05', { [`${rev}.png`]: 'board' })
    expect(readRenders(w.db).map((x) => x.revision)).toEqual(['AA', 'Z', 'Y'])
  })

  it('reads the revision and day from a rendering job\'s request, and nothing from any other', () => {
    expect(revisionOfRequest(rendersRequest('C', '2026-11-06'))).toEqual({ revision: 'C', date: '2026-11-06' })
    expect(revisionOfRequest('Draw the schematic')).toBeNull()
    expect(revisionOfRequest(null)).toBeNull()
  })
})
