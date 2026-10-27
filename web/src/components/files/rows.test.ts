import { describe, expect, it } from 'vitest'
import { newestFirst, toRows } from './rows'

describe('Files screen rows', () => {
  const rows = toRows([
    { path: 'docs/old.pdf', kind: 'documents', size: 10, at: '2026-10-01T00:00:00Z' },
    { path: 'fab/board-jlcpcb.zip', kind: 'fabrication', size: 10, release: 'Rev A release 1', at: '2026-10-20T00:00:00Z' },
    { path: 'hardware/board.kicad_pcb', kind: 'design', size: 10, at: '2026-10-26T00:00:00Z', versions: [{ commit: '7f3e21abcdef' }], findings: [
      { id: 'a', severity: 'fix', text: '', x_mm: 0, y_mm: 0 },
      { id: 'b', severity: 'waived', text: '', x_mm: 0, y_mm: 0 },
    ] },
    { path: 'no-date.txt', kind: '', size: 1 },
  ])

  it('lists newest first, undated last', () => {
    expect(rows.map((r) => r.path)).toEqual(['hardware/board.kicad_pcb', 'fab/board-jlcpcb.zip', 'docs/old.pdf', 'no-date.txt'])
    expect(newestFirst([{ at: '', path: 'b' }, { at: '', path: 'a' }]).map((r) => r.path)).toEqual(['a', 'b'])
  })

  it('groups by kind and marks a release’s files frozen', () => {
    const zip = rows.find((r) => r.path === 'fab/board-jlcpcb.zip')!
    expect(zip).toMatchObject({ group: 'Fabrication', release: 'Rev A release 1', frozen: true, kind: 'Fabrication' })
    const pcb = rows.find((r) => r.path === 'hardware/board.kicad_pcb')!
    expect(pcb).toMatchObject({ group: 'Design', frozen: false, commit: '7f3e21a', findings: 1, name: 'board.kicad_pcb', folder: 'hardware' })
    expect(rows.find((r) => r.path === 'no-date.txt')!.group).toBe('Documents')
  })
})
