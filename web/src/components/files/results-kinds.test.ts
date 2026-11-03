/** Every result file trace's tools keep (src/tools/**, rec.artifact / run.artifact) maps to a viewer that shows it. */
import { describe, expect, it } from 'vitest'
import { aboutFile, codeLang, compareMode, groupOf, kindLabel, viewerKind } from './kinds'

describe('result files from the tools', () => {
  it.each([
    // SPICE (sim.spice, ams.*)
    ['runs/r1/tran.raw', 'spice'], ['runs/r1/ac.raw', 'spice'], ['runs/r1/dc.raw', 'spice'], ['runs/r1/op.raw', 'spice'],
    ['runs/r1/noise.raw', 'spice'], ['runs/r1/tran_2.raw', 'spice'],
    // Touchstone (emc.run, emc.si)
    ['runs/r1/model.s1p', 'touchstone'], ['runs/r1/model.s2p', 'touchstone'], ['runs/r1/board.s3p', 'touchstone'], ['runs/r1/board.S4P', 'touchstone'],
    ['runs/r1/bus.s12p', 'touchstone'], ['runs/r1/x.snp', 'touchstone'],
    // numeric tables (chart + table)
    ['runs/r1/CH1.csv', 'table'], ['runs/r1/waveform.csv', 'table'], ['runs/r1/readings.csv', 'table'], ['runs/r1/loop_gain.csv', 'table'],
    ['runs/r1/aol.csv', 'table'], ['runs/r1/transient.csv', 'table'], ['runs/r1/temperature.csv', 'table'], ['runs/r1/samples.csv', 'table'],
    ['runs/r1/corners.csv', 'table'], ['runs/r1/runs.csv', 'table'], ['runs/r1/points.csv', 'table'], ['runs/r1/model.csv', 'table'],
    ['runs/r1/line.csv', 'table'], ['runs/r1/compare.csv', 'table'], ['runs/r1/check.csv', 'table'], ['runs/r1/nets.tsv', 'table'],
    // waveforms
    ['runs/r1/dump.vcd', 'vcd'], ['runs/r1/capture.vcd', 'vcd'], ['runs/r1/model.vcd', 'vcd'],
    // single-file gzip
    ['runs/r1/netlist.json.gz', 'gzip'], ['runs/r1/netlist.edif.gz', 'gzip'], ['runs/r1/design.bit.gz', 'gzip'], ['runs/r1/design.asc.gz', 'gzip'],
    // archives stay archives
    ['runs/r1/vtk.tar.gz', 'archive'], ['runs/r1/postProcessing.tar.gz', 'archive'], ['runs/r1/logs.tar.gz', 'archive'],
    // text-like results
    ['runs/r1/model.xml', 'code'], ['runs/r1/results.xml', 'code'], ['runs/r1/board.vtu', 'code'], ['runs/r1/model.inp', 'code'],
    ['runs/r1/netlist.edif', 'code'], ['runs/r1/netlist.edn', 'code'], ['runs/r1/design.asc', 'code'], ['runs/r1/bus.asc', 'code'],
    ['runs/r1/bus.trc', 'code'], ['runs/r1/bus.candump', 'code'], ['runs/r1/plan.sexp', 'code'], ['runs/r1/timing.rpt', 'code'],
    ['runs/r1/design.config', 'code'], ['runs/r1/coverage.info', 'code'], ['runs/r1/coverage.dat', 'code'], ['runs/r1/board.dsn', 'code'],
    ['runs/r1/board.ses', 'code'], ['runs/r1/netlist.cir', 'code'], ['runs/r1/kicad-export.cir', 'code'], ['runs/r1/model.py', 'code'],
    ['runs/r1/stat.txt', 'code'], ['runs/r1/wavedrom.txt', 'code'], ['runs/r1/trace_cosim_top.v', 'code'],
    // logs
    ['runs/r1/ngspice.log', 'code'], ['runs/r1/nextpnr.log', 'code'], ['runs/r1/openems.log', 'code'], ['runs/r1/serial.log', 'code'],
    // binary CAN log: unknown, with a sentence
    ['runs/r1/bus.blf', 'unknown'],
    // check reports and findings
    ['runs/r1/erc-report.json', 'report'], ['runs/r1/drc-report.json', 'report'], ['runs/r1/findings.json', 'report'], ['runs/r1/pin-findings.json', 'report'],
    // other JSON stays code
    ['runs/r1/fab-check.json', 'code'], ['runs/r1/result.json', 'code'], ['runs/r1/report.json', 'code'], ['runs/r1/attempts.json', 'code'],
    ['runs/r1/plan.json', 'code'], ['runs/r1/annotations.json', 'code'], ['runs/r1/order.json', 'code'],
    // already handled
    ['runs/r1/transient.png', 'image'], ['runs/r1/map-top.png', 'image'], ['runs/r1/map-bottom.png', 'image'], ['runs/r1/colourbar.png', 'image'],
    ['runs/r1/compare.png', 'image'], ['runs/r1/diagram.svg', 'svg'], ['runs/r1/board.glb', 'model'], ['runs/r1/report.md', 'markdown'],
    ['runs/r1/order.md', 'markdown'], ['runs/r1/routed.kicad_pcb', 'board'], ['runs/r1/design.bit', 'firmware'], ['runs/r1/design.fs', 'firmware'],
    ['runs/r1/block.bin', 'firmware'], ['runs/r1/bom.csv', 'table'],
  ])('%s → %s', (path, kind) => expect(viewerKind(path)).toBe(kind))

  it('labels the new kinds', () => {
    expect(kindLabel('tran.raw')).toBe('Simulation')
    expect(kindLabel('board.s4p')).toBe('S-parameters')
    expect(kindLabel('netlist.json.gz')).toBe('Compressed')
    expect(kindLabel('erc-report.json')).toBe('Check report')
  })

  it('lists results under Evidence, and a compressed file with what is inside', () => {
    expect(groupOf('sim/tran.raw')).toBe('evidence')
    expect(groupOf('emc/board.s2p')).toBe('evidence')
    expect(groupOf('kicad/erc-report.json')).toBe('evidence')
    expect(groupOf('fpga/top.bit.gz')).toBe('firmware')
    expect(groupOf('runs/r1/netlist.json.gz')).toBe('evidence')
    expect(groupOf('docs/notes.txt.gz')).toBe('documents')
  })

  it('highlights EDIF and S-expressions as Lisp, XML plain', () => {
    expect(codeLang('netlist.edif')).toBe('lisp')
    expect(codeLang('plan.sexp')).toBe('lisp')
    expect(codeLang('model.xml')).toBeNull()
  })

  it('compares text results line by line', () => {
    expect(compareMode('spice')).toBe('text')
    expect(compareMode('touchstone')).toBe('text')
    expect(compareMode('gzip')).toBeNull()
  })

  it('says what a binary CAN log is', () => {
    expect(aboutFile('runs/r1/bus.blf')).toMatch(/binary CAN bus log/)
    expect(aboutFile('runs/r1/mystery.xyz')).toBeNull()
  })
})
