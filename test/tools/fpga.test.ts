/**
 * The fpga area: the report readers on captured nextpnr/yosys output, and — where the programs are installed — the
 * examples/fpga-blinky design through synth → pnr → timing → bitstream for iCE40, ECP5 and Gowin, closure over seeds,
 * floorplan regions, and a target the design cannot meet.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clockName, clockScript, regionScript, timingFromReport, utilisation, utilisationFromReport } from '../../src/tools/fpga/flow.js'
import { attemptScore } from '../../src/tools/fpga/tools.js'
import { which } from '../../src/tools/sim/proc.js'
import { allTools } from '../../src/tools/index.js'

const EX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'fpga-blinky')
const f = (n: string): string => join(EX, n)
const has = (cmd: string, args: string[] = ['--version']): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
const on = (cmd: string): boolean => which(cmd) !== null
const hasYosys = has('yosys', ['-V'])
const hasIce40 = hasYosys && on('nextpnr-ice40') && on('icepack')
const hasEcp5 = hasYosys && on('nextpnr-ecp5') && on('ecppack')
const hasGowin = hasYosys && (on('nextpnr-himbaechel') || on('nextpnr-gowin')) && on('gowin_pack')

type Dict = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict

// a nextpnr-ice40 0.6 --report, cut down from a real run of blinky.v
const REPORT = JSON.stringify({
  fmax: { 'clk$SB_IO_IN_$glb_clk': { achieved: 79.75753784179688, constraint: 12 } },
  utilization: { ICESTORM_LC: { available: 5280, used: 28 }, ICESTORM_RAM: { available: 30, used: 0 }, SB_IO: { available: 96, used: 4 }, SB_GB: { available: 8, used: 2 }, ICESTORM_DSP: { available: 8, used: 0 } },
  critical_paths: [{
    from: 'posedge clk$SB_IO_IN_$glb_clk', to: 'posedge clk$SB_IO_IN_$glb_clk',
    path: [
      { delay: 1.39, from: { cell: '$nextpnr_ICESTORM_LC_0', loc: [4, 28], port: 'CLK' }, to: { cell: 'count_LC', loc: [3, 28], port: 'O' }, type: 'clk-to-q' },
      { delay: 1.75, net: 'count[0]', from: { cell: 'count_LC', port: 'O' }, to: { cell: 'carry_LC', port: 'I1' }, type: 'routing' },
      { delay: 0.68, from: { cell: 'carry_LC', port: 'I1' }, to: { cell: 'carry_LC', port: 'COUT' }, type: 'logic' },
      { delay: 3.5, net: 'count[23]', from: { cell: 'carry_LC', port: 'COUT' }, to: { cell: 'last_LC', port: 'I3' }, type: 'routing' },
      { delay: 0.47, from: { cell: 'last_LC', port: 'I3' }, to: { cell: 'last_LC', port: 'D' }, type: 'setup' },
    ],
  }],
})

describe('fpga report readers', () => {
  it('names clocks as the design does', () => {
    expect(clockName('clk$SB_IO_IN_$glb_clk')).toBe('clk')
    expect(clockName('$glbnet$clk$TRELLIS_IO_IN')).toBe('clk')
    expect(clockName('sys_clk')).toBe('sys_clk')
  })

  it('reads timing: per-clock closure, slack, path breakdown', () => {
    const t = timingFromReport(REPORT)
    expect(t?.closure).toBe('closed')
    expect(t?.clocks).toEqual([{ clock: 'clk', net: 'clk$SB_IO_IN_$glb_clk', achieved_mhz: 79.758, target_mhz: 12, slack_ns: 70.795, margin_pct: 564.646, status: 'met' }])
    expect(t?.critical_paths[0]).toMatchObject({ from: 'posedge clk', to: 'posedge clk', logic_ns: 2.07, routing_ns: 5.25, setup_ns: 0.47, delay_ns: 7.79, hops: 5, start: '$nextpnr_ICESTORM_LC_0', end: 'last_LC' })
    expect(t?.critical_paths[0]?.worst_nets[0]).toEqual({ net: 'count[23]', delay_ns: 3.5 })
    const fail = timingFromReport(REPORT, { targets: { clk: 100 } })
    expect(fail?.closure).toBe('failing')
    expect(fail?.clocks[0]?.status).toBe('failed')
    expect(fail?.worst_slack_ns).toBeCloseTo(10 - 1000 / 79.75753784179688, 3)
    const none = timingFromReport(JSON.stringify({ fmax: { clk: { achieved: 50, constraint: 0 } } }))
    expect(none?.closure).toBe('unconstrained')
    expect(timingFromReport('not json')).toBeNull()
  })

  it('reads utilisation from the report and from yosys stat -json', () => {
    expect(utilisationFromReport(REPORT).ICESTORM_LC).toEqual({ used: 28, available: 5280, percent: 0.5 })
    const stat = JSON.stringify({ modules: {}, design: { num_cells: 71, num_cells_by_type: { SB_CARRY: 22, SB_DFFSR: 24, SB_LUT4: 25 } } })
    expect(utilisation('ice40', stat)).toEqual({ cells: 71, by_type: { SB_CARRY: 22, SB_DFFSR: 24, SB_LUT4: 25 }, resources: { carry: 22, ff: 24, lut: 25 } })
    expect(utilisation('ecp5', JSON.stringify({ design: { num_cells: 3, num_cells_by_type: { LUT4: 1, TRELLIS_FF: 1, DP16KD: 1 } } }))?.resources).toEqual({ lut: 1, ff: 1, bram: 1 })
  })

  it('writes the nextpnr Python for regions and clocks', () => {
    const s = regionScript([{ name: 'pwm', x0: 1, y0: 1, x1: 6, y1: 6, cells: ['u_pwm*'] }])
    expect(s).toContain('ctx.createRectangularRegion("pwm", 1, 1, 6, 6)')
    expect(s).toContain('fnmatch.fnmatchcase(_name, p) for p in ["u_pwm*"]')
    expect(clockScript({ clk: 48 })).toContain('ctx.addClock("clk", 48)')
  })

  it('ranks closure attempts', () => {
    const closed = attemptScore({ routed: true, closure: 'closed', worst_slack_ns: 0.2, clocks: [] })
    const closedMore = attemptScore({ routed: true, closure: 'closed', worst_slack_ns: 1.5, clocks: [] })
    const failing = attemptScore({ routed: true, closure: 'failing', worst_slack_ns: -0.1, clocks: [] })
    const unrouted = attemptScore({ routed: false, closure: null, worst_slack_ns: null, clocks: [] })
    const lex = (a: number[], b: number[]): number => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (b[i] as number) - (a[i] as number)
      return 0
    }
    const sorted = [failing, closed, unrouted, closedMore].sort(lex)
    expect(sorted).toEqual([closedMore, closed, failing, unrouted])
  })
})

describe.skipIf(!hasIce40)('ice40 flow (yosys, nextpnr-ice40, icepack installed)', () => {
  it('synth → pnr → timing → bitstream on the iCEBreaker pins', async () => {
    const s = await call('fpga.synth', { family: 'ice40', files: [f('blinky.v')], top: 'blinky' })
    expect(s.passed).toBe(true)
    const u = s.utilisation as { resources: Record<string, number> }
    expect(u.resources.lut).toBeGreaterThan(10)
    expect(u.resources.ff).toBeGreaterThanOrEqual(24 + 8 + 1)
    const p = await call('fpga.pnr', { family: 'ice40', device: 'up5k', package: 'sg48', synth_run: s.run_id, constraints: f('icebreaker.pcf'), seed: 3 })
    expect(p.passed).toBe(true)
    const t = p.timing as { closure: string; clocks: { clock: string; target_mhz: number; status: string }[] }
    expect(t.closure).toBe('closed')
    expect(t.clocks).toEqual([expect.objectContaining({ clock: 'clk', target_mhz: 12, status: 'met' })]) // from set_frequency in the PCF
    expect((p.utilisation as Record<string, { used: number }>).SB_IO?.used).toBe(4)
    const tt = await call('fpga.timing', { run_id: p.run_id, targets: { clk: 400 } })
    expect(tt.closure).toBe('failing')
    const dir = mkdtempSync(join(tmpdir(), 'fpga-bit-'))
    try {
      const b = await call('fpga.bitstream', { family: 'ice40', run_id: p.run_id, out: join(dir, 'blinky.bin') })
      expect(b.passed).toBe(true)
      expect(statSync(join(dir, 'blinky.bin')).size).toBe(104090) // an UP5K image is always this size
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('the same seed gives the same result; closure keeps the best of several', async () => {
    const s = await call('fpga.synth', { family: 'ice40', files: [f('blinky.v')], top: 'blinky' })
    const args = { family: 'ice40', device: 'up5k', package: 'sg48', synth_run: s.run_id, constraints: f('icebreaker.pcf') }
    const a = await call('fpga.pnr', { ...args, seed: 7 })
    const b = await call('fpga.pnr', { ...args, seed: 7 })
    expect((a.timing as { clocks: unknown[] }).clocks).toEqual((b.timing as { clocks: unknown[] }).clocks)
    const c = await call('fpga.closure', { ...args, seeds: [1, 2, 3], placers: ['heap', 'sa'], concurrency: 3 })
    expect((c.attempts as unknown[]).length).toBe(6)
    const best = c.best as { worst_slack_ns: number }
    expect(Math.max(...(c.attempts as { worst_slack_ns: number }[]).map((x) => x.worst_slack_ns))).toBe(best.worst_slack_ns)
    const again = await call('fpga.closure', { ...args, seeds: [1, 2, 3], placers: ['heap', 'sa'], concurrency: 1 })
    expect(again.best).toMatchObject({ seed: (c.best as { seed: number }).seed, placer: (c.best as { placer: string }).placer })
    const stop = await call('fpga.closure', { ...args, seeds: [1, 2, 3, 4], stop_when_closed: true, concurrency: 2 })
    expect((stop.attempts as unknown[]).length).toBe(1)
    const bit = await call('fpga.bitstream', { family: 'ice40', run_id: c.run_id })
    expect(bit.passed).toBe(true)
  }, 600_000)

  it('misses a target it cannot reach, and constrains cells to a region', async () => {
    const s = await call('fpga.synth', { family: 'ice40', files: [f('blinky.v')], top: 'blinky' })
    const slow = await call('fpga.pnr', { family: 'ice40', device: 'up5k', package: 'sg48', synth_run: s.run_id, constraints: f('icebreaker.pcf'), clocks: { clk: 500 } })
    expect(slow.passed).toBe(false)
    expect(slow.routed).toBe(true) // it routes; timing fails
    expect((slow.timing as { closure: string }).closure).toBe('failing')
    const r = await call('fpga.pnr', { family: 'ice40', device: 'up5k', package: 'sg48', synth_run: s.run_id, constraints: f('icebreaker.pcf'),
      regions: [{ name: 'pwm', x0: 1, y0: 1, x1: 8, y1: 8, cells: ['u_pwm*', '*pwm*'] }] })
    expect(r.routed).toBe(true)
    expect((r.regions_constrained as Record<string, number>).pwm).toBeGreaterThan(0)
  }, 300_000)

  it('refuses missing constraints and a wrong constraint file', async () => {
    const s = await call('fpga.synth', { family: 'ice40', files: [f('blinky.v')], top: 'blinky' })
    await expect(call('fpga.pnr', { family: 'ice40', device: 'up5k', synth_run: s.run_id })).rejects.toThrow(/give constraints/)
    await expect(call('fpga.pnr', { family: 'ice40', device: 'up5k', synth_run: s.run_id, constraints: f('ulx3s.lpf') })).rejects.toThrow(/\.pcf/)
    const bad = await call('fpga.synth', { family: 'ice40', files: [f('blinky.v')], top: 'nosuch' })
    expect(bad.passed).toBe(false)
    expect(String(bad.reason)).toMatch(/nosuch/)
  }, 300_000)
})

describe.skipIf(!hasEcp5)('ecp5 flow (nextpnr-ecp5, ecppack installed)', () => {
  it('synth → pnr → bitstream on the ULX3S pins, with the LPF clock target', async () => {
    const s = await call('fpga.synth', { family: 'ecp5', files: [f('blinky.v')], top: 'blinky' })
    expect(s.passed).toBe(true)
    const p = await call('fpga.pnr', { family: 'ecp5', device: '25k', package: 'CABGA381', synth_run: s.run_id, constraints: f('ulx3s.lpf') })
    expect(p.passed).toBe(true)
    expect((p.timing as { clocks: { target_mhz: number }[] }).clocks[0]?.target_mhz).toBe(25)
    const b = await call('fpga.bitstream', { family: 'ecp5', run_id: p.run_id, compress: true })
    expect(b.passed).toBe(true)
    expect(b.bytes as number).toBeGreaterThan(10_000)
  }, 300_000)
})

describe.skipIf(!hasGowin)('gowin flow (nextpnr for Gowin, gowin_pack installed)', () => {
  it('synth → pnr → bitstream on the Tang Nano 9K pins', async () => {
    const s = await call('fpga.synth', { family: 'gowin', files: [f('blinky.v')], top: 'blinky' })
    expect(s.passed).toBe(true)
    const p = await call('fpga.pnr', { family: 'gowin', device: 'GW1NR-LV9QN88PC6/I5', gowin_family: 'GW1N-9C', synth_run: s.run_id, constraints: f('tangnano9k.cst'), clocks: { clk: 27 } })
    expect(p.routed).toBe(true)
    const b = await call('fpga.bitstream', { family: 'gowin', run_id: p.run_id, gowin_family: 'GW1N-9C' })
    expect(b.passed).toBe(true)
  }, 300_000)
})

describe.skipIf(!hasYosys)('xilinx synthesis (yosys installed)', () => {
  it('maps to 7-series primitives and writes EDIF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpga-x-'))
    try {
      const s = await call('fpga.synth', { family: 'xilinx', files: [f('blinky.v')], top: 'blinky', out_dir: dir })
      expect(s.passed).toBe(true)
      const r = (s.utilisation as { resources: Record<string, number> }).resources
      expect(r.lut).toBeGreaterThan(0)
      expect(r.ff).toBeGreaterThan(0)
      expect(existsSync(join(dir, 'netlist.edif'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe.skipIf(!hasYosys)('synthesis with an include in a sub-folder (yosys installed)', () => {
  it('finds `include "sub/w.vh" and an include dir, and keeps two files of the same name', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fpga-inc-'))
    try {
      for (const sub of ['rtl/sub', 'rtl/alt', 'inc']) mkdirSync(join(d, sub), { recursive: true })
      writeFileSync(join(d, 'rtl', 'sub', 'w.vh'), '`define W 4\n')
      writeFileSync(join(d, 'inc', 'reset.vh'), '`define RST_VAL 0\n')
      writeFileSync(join(d, 'rtl', 'core.v'), '`include "sub/w.vh"\n`include "reset.vh"\nmodule core(input clk, output reg [`W-1:0] q); initial q = `RST_VAL; always @(posedge clk) q <= q + 1; endmodule\n')
      writeFileSync(join(d, 'rtl', 'alt', 'core.v'), 'module top(input clk, output [3:0] q); core c(.clk(clk), .q(q)); endmodule\n')
      const s = await call('fpga.synth', { family: 'ice40', files: [join(d, 'rtl', 'core.v'), join(d, 'rtl', 'alt', 'core.v')], include_dirs: [join(d, 'inc')], top: 'top' })
      expect(s.reason).toMatch(/cells/)
      expect(s.passed).toBe(true)
      expect((s.utilisation as { resources: Record<string, number> }).resources.ff).toBe(4)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }, 300_000)
})
