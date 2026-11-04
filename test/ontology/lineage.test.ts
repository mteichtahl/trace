/**
 * Lineage and freshness (docs/ontology-plan.md P4.1, P4.2): what a run was made from is recorded with it, outputs are
 * hashed over a normalised form, and freshness is worked out on read. The exit check's two cases: a schematic change
 * that leaves the netlist the same leaves what was made from the netlist current, with the reason; one that changes the
 * netlist makes it stale, naming the change.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Work } from '../../src/core/store.js'
import { normalise, normalisedHash } from '../../src/core/normalise.js'
import { fileInputs } from '../../src/tools/kicad/record.js'
import { filesRead, freshness, latestFreshness, staleRuns } from '../../src/ontology/lineage.js'

let root: string
let work: Work
const read = (p: string): Uint8Array | null => (existsSync(join(root, p)) ? readFileSync(join(root, p)) : null)
const put = (p: string, s: string): void => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s) }
const sch = (part: string, labelAt: number, date = '2026-11-01'): string => `(kicad_sch (version 20250114) (generator "eeschema") (date "${date}")\n  (symbol (lib_id "Device:${part}"))\n  (label "VIN" (at ${labelAt} 20 0))\n)\n`
const net = (part: string, date: string): string => `(export (version "E") (design (date "${date}") (tool "Eeschema 10.0.1"))\n  (components (comp (ref "U1") (value "${part}")))\n)\n`

/** A netlist run of the schematic as it is now, writing `netlist.net`. */
function netlistRun(part: string, date: string, at: number): string {
  const id = work.start('kicad.netlist', { subject: 'hw/board' })
  work.db.prepare('UPDATE runs SET started=? WHERE id=?').run(at, id)
  work.inputs(id, [{ kind: 'file', ref: 'hw/board.kicad_sch', sha256: normalisedHash('hw/board.kicad_sch', read('hw/board.kicad_sch')!) }])
  work.artifact(id, 'netlist.net', net(part, date))
  work.finish(id, 'pass', 'netlist')
  return id
}
/** A run made from a netlist run's output (a layout check, say). */
function fromNetlist(netRun: string, at: number): string {
  const id = work.start('layout.check', { subject: 'hw/board' })
  work.db.prepare('UPDATE runs SET started=? WHERE id=?').run(at, id)
  const h = (work.db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=? AND name=?').get(netRun, 'netlist.net') as { sha256: string }).sha256
  work.inputs(id, [{ kind: 'artifact', ref: netRun, name: 'netlist.net', sha256: h }])
  work.finish(id, 'pass', 'checked')
  return id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-lineage-'))
  mkdirSync(join(root, '.git'))
  work = new Work(join(root, 'project.db'))
  put('hw/board.kicad_sch', sch('LM1117', 10))
})

describe('normalised hashes', () => {
  it('leave out when and by which version a KiCad file or report was made, nothing else', () => {
    expect(normalisedHash('a.net', new TextEncoder().encode(net('LM1117', '2026-01-01')))).toBe(normalisedHash('a.net', new TextEncoder().encode(net('LM1117', '2026-11-04'))))
    expect(normalisedHash('a.net', new TextEncoder().encode(net('LM1117', 'x')))).not.toBe(normalisedHash('a.net', new TextEncoder().encode(net('TPS7A02', 'x'))))
    expect(new TextDecoder().decode(normalise('drc.rpt', new TextEncoder().encode('** Created on 2026-11-04 10:00\r\nerrors: 0  \r\n')))).toBe('\nerrors: 0\n')
    const bin = new Uint8Array([0, 1, 2, 255])
    expect(normalise('x.bin', bin)).toBe(bin)
  })

  it('are kept for every output a run writes', () => {
    const id = work.start('kicad.drc')
    work.artifact(id, 'drc.rpt', '** Created on today\nok\n')
    expect(work.db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=?').get(id)).toEqual({ sha256: normalisedHash('drc.rpt', new TextEncoder().encode('** Created on another day\nok\n')) })
  })
})

describe('the files a run reads', () => {
  it('are its arguments that name repository files, and for a KiCad project its sheets, board and rules', () => {
    put('hw/board.kicad_pro', '{}')
    put('hw/board.kicad_pcb', '(kicad_pcb)')
    put('hw/board.kicad_dru', '(version 1)')
    put('hw/notes.txt', 'x')
    const ins = fileInputs({ project: join(root, 'hw/board.kicad_pro'), other: 'nope/missing.txt', n: 3 }, root)
    expect(ins.map((i) => i.ref)).toEqual(['hw/board.kicad_dru', 'hw/board.kicad_pcb', 'hw/board.kicad_pro', 'hw/board.kicad_sch'])
    expect(ins.every((i) => i.kind === 'file' && /^[0-9a-f]{64}$/.test(i.sha256 ?? ''))).toBe(true)
    expect(fileInputs({ path: '/etc/hostname' }, root)).toEqual([])
  })
})

describe('freshness, worked out on read', () => {
  it('is current while nothing a run was made from changed, and unknown for a run with no inputs recorded', () => {
    const n = netlistRun('LM1117', 'd1', 1)
    const l = fromNetlist(n, 2)
    expect(freshness(work.db, l, read)).toMatchObject({ state: 'current', reasons: [], kept: [] })
    const old = work.start('kicad.erc')
    expect(freshness(work.db, old, read).state).toBe('unknown')
  })

  it('a schematic change makes the netlist stale, and what was made from it, naming the change', () => {
    const n = netlistRun('LM1117', 'd1', 1)
    const l = fromNetlist(n, 2)
    put('hw/board.kicad_sch', sch('LM1117', 15))
    expect(freshness(work.db, n, read)).toMatchObject({ state: 'stale', reasons: ['hw/board.kicad_sch changed since kicad.netlist ran'] })
    expect(freshness(work.db, l, read)).toMatchObject({ state: 'stale', reasons: ['netlist.net from kicad.netlist is out of date: hw/board.kicad_sch changed since kicad.netlist ran'] })
  })

  it('a moved label regenerates the same netlist: what was made from it stays current, and says why', () => {
    const n = netlistRun('LM1117', 'd1', 1)
    const l = fromNetlist(n, 2)
    put('hw/board.kicad_sch', sch('LM1117', 15))
    netlistRun('LM1117', 'd2', 3)
    const f = freshness(work.db, l, read)
    expect(f.state).toBe('current')
    expect(f.kept).toEqual([expect.stringMatching(/^hw\/board\.kicad_sch changed since kicad\.netlist ran, but kicad\.netlist made the same netlist\.net again/)])
  })

  it('a swapped part makes a different netlist: what was made from the old one is stale', () => {
    const n = netlistRun('LM1117', 'd1', 1)
    const l = fromNetlist(n, 2)
    put('hw/board.kicad_sch', sch('TPS7A02', 10))
    netlistRun('TPS7A02', 'd2', 3)
    expect(freshness(work.db, l, read)).toMatchObject({ state: 'stale', reasons: [expect.stringMatching(/^kicad\.netlist made netlist\.net again \(run \w+\) and it differs$/)] })
  })

  it('lists the newest run of each tool and subject with its freshness', () => {
    netlistRun('LM1117', 'd1', 1)
    const n2 = netlistRun('LM1117', 'd2', 2)
    const l = fromNetlist(n2, 3)
    put('hw/board.kicad_sch', sch('TPS7A02', 10))
    expect(latestFreshness(work.db, read).map((f) => [f.run, f.state])).toEqual([[l, 'stale'], [n2, 'stale']])
  })

  it('names every file freshness reads, through the runs an output came from, and says which runs no longer stand', () => {
    const n = netlistRun('LM1117', 'd1', 1)
    const l = fromNetlist(n, 2)
    expect(filesRead(work.db, [l])).toEqual(['hw/board.kicad_sch'])
    const files = new Map([['hw/board.kicad_sch', read('hw/board.kicad_sch')]])
    expect(staleRuns(work.db, [l, n], files)).toEqual(new Map())
    files.set('hw/board.kicad_sch', new TextEncoder().encode(sch('TPS7A02', 10)))
    expect([...staleRuns(work.db, [l, n], files).keys()].sort()).toEqual([l, n].sort())
  })
})
