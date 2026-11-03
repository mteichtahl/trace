import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardHoles, checkFab, drillHits, type FabSettings } from '../../../src/tools/kicad/export.js'

const EXPLICIT: FabSettings = { gerber_source: 'explicit', protel_ext: true, subtract_soldermask: true, separate_drill: true }

const drl = (fn: string, hits: string[]): string =>
  ['M48', `; #@! TF.FileFunction,${fn}`, 'METRIC', 'T1C0.300', '%', 'G90', 'G05', 'T1', ...hits, 'M30'].join('\n')

/** A gerbers folder as kicad-cli writes it (names as KiCad 7–10 give them). */
function pkg(o: { protel?: boolean; job?: string[] | null; drills: Record<string, string> }): string {
  const d = mkdtempSync(join(tmpdir(), 'fabchk-'))
  const ext = o.protel === false ? { F: 'gbr', B: 'gbr', E: 'gbr' } : { F: 'gtl', B: 'gbl', E: 'gm1' }
  const names = [`b-F_Cu.${ext.F}`, `b-B_Cu.${ext.B}`, `b-Edge_Cuts.${ext.E}`]
  for (const n of names) writeFileSync(join(d, n), 'G04*\nM02*\n')
  if (o.job !== null) writeFileSync(join(d, 'b-job.gbrjob'), JSON.stringify({ FilesAttributes: (o.job ?? names).map((Path) => ({ Path })) }))
  for (const [n, t] of Object.entries(o.drills)) writeFileSync(join(d, n), t)
  return d
}

describe('drillHits', () => {
  it('counts drill hits and slots, not tool selects or headers', () => {
    expect(drillHits(drl('Plated,1,2,PTH', ['X18.0Y-15.0', 'X25.0Y-10.0', 'X27.54Y-10.0']))).toBe(3)
    expect(drillHits('T1\nG00X1.0Y-1.0\nM15\nG01X2.0Y-1.0\nM16\nG05\nX3.0Y-3.0G85X4.0Y-3.0\n')).toBe(2)
  })
})

describe('boardHoles', () => {
  it('counts vias and through-hole pads as plated, NPTH pads as unplated, SMD pads not at all', () => {
    const b = {
      vias: { GND: [[18, 15, 0.6, 0.3, 'F.Cu', 'B.Cu']] },
      pads: { GND: [{ kind: 'thru_hole', drill: [1, 1] }, { kind: 'thru_hole', drill: [1, 1] }, { kind: 'smd' }] },
      unnetted: [{ kind: 'np_thru_hole', drill: [3.2, 3.2] }],
    }
    expect(boardHoles(b)).toEqual({ plated: 3, unplated: 1 })
  })
})

describe('checkFab', () => {
  const board = { plated: 3, unplated: 1 }
  const pth = drl('Plated,1,2,PTH', ['X18.0Y-15.0', 'X25.0Y-10.0', 'X27.54Y-10.0'])
  const npth = drl('NonPlated,1,2,NPTH', ['X10.0Y-10.0'])

  it('passes a package that is what was asked for', () => {
    const c = checkFab(pkg({ drills: { 'b-PTH.drl': pth, 'b-NPTH.drl': npth } }), 'b', EXPLICIT, board)
    expect(c.problems).toEqual([])
    expect(c.holes.files).toEqual({ plated: 3, unplated: 1 })
  })

  it('fails .gbr names when Protel extensions were asked for', () => {
    const c = checkFab(pkg({ protel: false, drills: { 'b-PTH.drl': pth, 'b-NPTH.drl': npth } }), 'b', EXPLICIT, board)
    expect(c.problems.join(' ')).toMatch(/Protel extensions were asked for/)
  })

  it('fails a missing job file, or one naming files that are not there', () => {
    expect(checkFab(pkg({ job: null, drills: { 'b-PTH.drl': pth, 'b-NPTH.drl': npth } }), 'b', EXPLICIT, board).problems.join(' ')).toMatch(/no Gerber job file/)
    expect(checkFab(pkg({ job: ['b-F_Cu.gbr'], drills: { 'b-PTH.drl': pth, 'b-NPTH.drl': npth } }), 'b', EXPLICIT, board).problems.join(' '))
      .toMatch(/names files that are not in the package: b-F_Cu.gbr/)
  })

  it('fails a merged drill file, or an unplated hole in the plated file, when separate files were asked for', () => {
    const merged = drl('MixedPlating,1,2', ['X18.0Y-15.0', 'X25.0Y-10.0', 'X27.54Y-10.0', 'X10.0Y-10.0'])
    expect(checkFab(pkg({ drills: { 'b.drl': merged } }), 'b', EXPLICIT, board).problems.join(' ')).toMatch(/no b-PTH.drl.*merged b.drl|merged b.drl/)
    const allPlated = drl('Plated,1,2,PTH', ['X18.0Y-15.0', 'X25.0Y-10.0', 'X27.54Y-10.0', 'X10.0Y-10.0'])
    const c = checkFab(pkg({ drills: { 'b-PTH.drl': allPlated, 'b-NPTH.drl': drl('NonPlated,1,2,NPTH', []) } }), 'b', EXPLICIT, board)
    expect(c.problems).toEqual(['the board drills 3 plated holes, the drill files hold 4', 'the board drills 1 unplated holes, the NPTH file holds 0'])
  })

  it('accepts a missing NPTH file only when the board has no unplated holes', () => {
    expect(checkFab(pkg({ drills: { 'b-PTH.drl': pth } }), 'b', EXPLICIT, { plated: 3, unplated: 0 }).problems).toEqual([])
    expect(checkFab(pkg({ drills: { 'b-PTH.drl': pth } }), 'b', EXPLICIT, board).problems.join(' ')).toMatch(/no b-NPTH.drl/)
  })

  it('with a merged file asked for, counts every hole and warns about unplated ones', () => {
    const merged = drl('MixedPlating,1,2', ['X18.0Y-15.0', 'X25.0Y-10.0', 'X27.54Y-10.0', 'X10.0Y-10.0'])
    const c = checkFab(pkg({ drills: { 'b.drl': merged } }), 'b', { ...EXPLICIT, separate_drill: false }, board)
    expect(c.problems).toEqual([])
    expect(c.notes.join(' ')).toMatch(/1 unplated holes share the merged drill file/)
  })

  it("does not check Gerber names when the board's own settings were used", () => {
    const c = checkFab(pkg({ protel: false, drills: { 'b-PTH.drl': pth, 'b-NPTH.drl': npth } }), 'b', { ...EXPLICIT, gerber_source: 'board' }, board)
    expect(c.problems).toEqual([])
    expect(c.notes.join(' ')).toMatch(/settings saved in the board file/)
  })
})
