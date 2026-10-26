import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { allTools } from '../../../src/tools/index.js'
import { iverilog, parseMessages, rootModules, vvp } from '../../../src/tools/sim/logic.js'
import { exportSpice, kicadCli, transform } from '../../../src/tools/sim/kicad_spice.js'
import { ngspice } from '../../../src/tools/sim/spice.js'

const ctx = { hardware: false, via: 'test' } as const

describe('vvp output', () => {
  it('reads root modules from scope lines', () => {
    const v = [
      'S_0x1 .scope package, "$unit" "$unit" 2 1;',
      'S_0x2 .scope module, "other" "other" 3 3;',
      'S_0x3 .scope module, "tb" "tb" 3 2;',
      'S_0x4 .scope module, "u" "sub" 3 2, 3 1 0, S_0x3;',
    ].join('\n')
    expect(rootModules(v)).toEqual(['other', 'tb'])
  })

  it('reads $error/$warning/$fatal messages with their time and scope', () => {
    const m = parseMessages('hello 5\nERROR: t.v:1: bad thing\n       Time: 0  Scope: t\nWARNING: t.v:1: w\n         Time: 0  Scope: t\nFATAL: t.v:1: boom\n       Time: 5  Scope: t\n')
    expect(m).toEqual([
      { severity: 'error', text: 'bad thing', where: 't.v:1', time: '0', scope: 't' },
      { severity: 'warning', text: 'w', where: 't.v:1', time: '0', scope: 't' },
      { severity: 'fatal', text: 'boom', where: 't.v:1', time: '5', scope: 't' },
    ])
  })
})

const COUNTER = `module counter #(parameter W = 4) (input clk, input rst, output reg [W-1:0] q);
  always @(posedge clk) q <= rst ? '0 : q + 1'b1;
endmodule
`
const TB = (bad: boolean) => `\`timescale 1ns/1ps
module tb;
  reg clk = 0, rst = 1;
  wire [3:0] q;
  counter #(.W(4)) dut (.clk(clk), .rst(rst), .q(q));
  always #5 clk = ~clk;
  initial begin
    @(posedge clk); #1 rst = 0;
    repeat (20) @(posedge clk);
    #1 $display("q=%0d", q);
    if (q !== 4'd${bad ? '7' : '4'}) $fatal(1, "count wrong: %0d", q);
    $display("PASS");
    $finish;
  end
endmodule
`

describe.skipIf(!iverilog() || !vvp())('Icarus Verilog', () => {
  const reg = allTools()
  const dir = mkdtempSync(join(tmpdir(), 'trace-logic-'))
  writeFileSync(join(dir, 'counter.v'), COUNTER)

  it('compiles and runs a counter testbench, passes, and stores an injected VCD', async () => {
    writeFileSync(join(dir, 'tb.sv'), TB(false))
    const r = (await reg.call('sim.logic', { files: [join(dir, 'counter.v'), join(dir, 'tb.sv')], pass: '^PASS$' }, ctx)) as { run_id: string; passed: boolean; top: string; output: string[]; vcd: { artifact: string } | null }
    expect(r.passed).toBe(true)
    expect(r.top).toBe('tb')
    expect(r.output).toContain('q=4') // 20 clocks wraps a 4-bit counter: 20 mod 16
    expect(r.vcd?.artifact).toBe('trace_dump.vcd')
    // the stored VCD feeds the wave tools by run id
    const w = (await reg.call('sim.wave_read', { run_id: r.run_id, signals: ['tb.clk'] }, ctx)) as { signals: { pulses?: { rising: number } }[] }
    expect(w.signals[0]?.pulses?.rising).toBeGreaterThanOrEqual(21)
    const t = (await reg.call('sim.wave_timing', { run_id: r.run_id, checks: [{ kind: 'pulse', signal: 'tb.clk', min_high: 4.9e-9, min_period: 9.9e-9 }] }, ctx)) as { pass: boolean; checks: { period_mean: number }[] }
    expect(t.pass).toBe(true)
    expect(t.checks[0]?.period_mean).toBeCloseTo(10e-9, 15)
  })

  it('a $fatal fails the run with its message', async () => {
    const r = (await reg.call('sim.logic', { sources: [{ name: 'counter.v', text: COUNTER }, { name: 'tb.sv', text: TB(true) }] }, ctx)) as { passed: boolean; reason: string; messages: { severity: string }[] }
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/\$fatal: count wrong: 4/)
    expect(r.messages[0]?.severity).toBe('fatal')
  })

  it('a syntax error fails at compile', async () => {
    const r = (await reg.call('sim.logic', { sources: [{ name: 'x.v', text: 'module x; wire a = ; endmodule\n' }] }, ctx)) as { passed: boolean; reason: string }
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/compile failed/)
  })

  it('a testbench without $finish is stopped at the time limit', async () => {
    const r = (await reg.call('sim.logic', { sources: [{ name: 'f.v', text: 'module f; reg c = 0; always #1 c = ~c; endmodule\n' }], timeout_s: 1 }, ctx)) as { passed: boolean; reason: string }
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/time limit/)
  })
})

// ------------------------------------------------------------------------------------------- KiCad

describe('KiCad netlist overrides', () => {
  const exported = '.title KiCad schematic\nR1 /in /out 1k\nR2 /out GND 2k\nU1 __U1\n.end\n'

  it('replaces, removes, adds, and refuses unmodelled parts unless told to drop them', () => {
    expect(() => transform(exported, {})).toThrow(/without a simulation model: U1/)
    const t = transform(exported, { replace: { R2: 'R2 /out GND 1k' }, add: ['V1 /in GND DC 3'], dropUnmodelled: true })
    expect(t.netlist).toMatch(/^KiCad schematic\nR1 \/in \/out 1k\nR2 \/out GND 1k\n\* no simulation model: U1 __U1\nV1 \/in GND DC 3$/)
    expect(t.replaced).toEqual(['R2'])
    expect(t.unmodelled).toEqual(['U1'])
    expect(() => transform(exported, { replace: { R9: null }, dropUnmodelled: true })).toThrow(/not in the schematic: R9/)
  })
})

function schematic(): string {
  const lib = readFileSync('/usr/share/kicad/symbols/Device.kicad_sym', 'utf8')
  const start = lib.indexOf('\n\t(symbol "R"') + 1
  let depth = 0
  let end = start
  for (; end < lib.length; end++) {
    if (lib[end] === '(') depth++
    else if (lib[end] === ')' && --depth === 0) break
  }
  const sym = lib.slice(start, end + 1).replace('(symbol "R"', '(symbol "Device:R"')
  const root = '7c1d6a7e-0000-4000-8000-000000000001'
  let n = 2
  const id = (): string => `7c1d6a7e-0000-4000-8000-${String(n++).padStart(12, '0')}`
  const r = (ref: string, val: string, y: number): string => `\t(symbol (lib_id "Device:R") (at 100 ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "${id()}")
\t\t(property "Reference" "${ref}" (at 102 ${y} 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "${val}" (at 104 ${y} 0) (effects (font (size 1.27 1.27))))
\t\t(property "Footprint" "" (at 100 ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(pin "1" (uuid "${id()}")) (pin "2" (uuid "${id()}"))
\t\t(instances (project "t" (path "/${root}" (reference "${ref}") (unit 1))))
\t)\n`
  const label = (name: string, y: number): string => `\t(label "${name}" (at 100 ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id()}"))\n`
  return `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "${root}") (paper "A4")
\t(lib_symbols\n${sym}\n\t)
${label('in', 96.19)}${label('out', 103.81)}${label('GND', 111.43)}${r('R1', '1k', 100)}${r('R2', '2k', 107.62)}\t(sheet_instances (path "/" (page "1")))
)\n`
}

const HAS_KICAD = kicadCli() !== null
let kicadLib = false
try {
  readFileSync('/usr/share/kicad/symbols/Device.kicad_sym')
  kicadLib = true
} catch {
  kicadLib = false
}

describe.skipIf(!HAS_KICAD || !kicadLib || !ngspice())('kicad-cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-kicad-'))
  const sch = join(dir, 'divider.kicad_sch')
  // in beforeAll: a skipped describe still runs its body while collecting
  beforeAll(() => writeFileSync(sch, schematic()))

  it('exports a schematic to SPICE', async () => {
    const e = await exportSpice({ schematic: sch })
    expect(e.netlist).toMatch(/R1 \/in \/out 1k/)
    expect(e.components).toBe(2)
  })

  it('sim.kicad_spice: adds a source and simulates the divider', async () => {
    const r = (await allTools().call('sim.kicad_spice', {
      schematic: sch, analyses: ['.op'], add: ['V1 /in GND DC 3'],
      measurements: [{ name: 'vout', kind: 'final', vector: 'v(/out)' }],
    }, ctx)) as { measurements: { value: number }[]; netlist: { components: number } }
    expect(r.measurements[0]?.value).toBeCloseTo(2, 9)
  })
})
