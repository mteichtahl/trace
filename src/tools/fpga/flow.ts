/**
 * The open FPGA flow: Yosys synthesis, nextpnr place and route, and the bitstream packers, for
 *
 *   ice40    synth_ice40   nextpnr-ice40      PCF constraints   icepack  (.asc → .bin)
 *   ecp5     synth_ecp5    nextpnr-ecp5       LPF               ecppack  (.config → .bit)
 *   gowin    synth_gowin   nextpnr-himbaechel (or the older nextpnr-gowin)  CST   gowin_pack (.json → .fs)
 *   xilinx   synth_xilinx  (no open place and route here: synthesis and utilisation only)
 *
 * Each step is one job through runJob (kinds yosys, nextpnr, fpga-pack; CPU jobs, local unless TRACE_GPU_REMOTE=always).
 * Place and route always runs with --timing-allow-fail and a JSON report, so a design that misses timing still gives
 * its numbers: whether timing closed is decided from the report (per clock: achieved Fmax against the target), not
 * from nextpnr's exit status. Seeds make a run repeatable: the same netlist, constraints, options and seed give the
 * same result.
 *
 * Floorplan regions (`regions`) are applied by a --pre-place Python script nextpnr runs: a rectangular region per
 * entry and every cell whose name matches one of its patterns (fnmatch globs) constrained into it. Per-clock targets
 * (`clocks`) are a --pre-pack script calling ctx.addClock; constraints in the PCF/LPF/CST still apply.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { haveProgram, hdlStage, includeArgs, needProgram, shellJob, sq, stage } from '../verify/job.js'

export const FAMILIES = ['ice40', 'ecp5', 'gowin', 'xilinx'] as const
export type Family = (typeof FAMILIES)[number]

export const gz = (b: Uint8Array | string): Uint8Array => new Uint8Array(gzipSync(typeof b === 'string' ? Buffer.from(b) : b, { level: 9 }))
export const gunzip = (b: Uint8Array): Uint8Array => new Uint8Array(gunzipSync(b))

// ------------------------------------------------------------------ synthesis

export interface SynthOptions {
  family: Family
  files: string[]
  top: string
  include_dirs?: string[] | undefined
  defines?: Record<string, string | number | boolean> | undefined
  parameters?: Record<string, string | number> | undefined
  options: string[]
  xilinx_family?: string | undefined
  timeout_s: number
}

export interface Utilisation {
  cells: number
  by_type: Record<string, number>
  /** the cell types grouped: lut, ff, carry, bram, dsp, io, pll, other */
  resources: Record<string, number>
}

export interface SynthRun {
  ok: boolean
  reason: string
  utilisation: Utilisation | null
  warnings: string[]
  log: string
  statText: string
  netlist: Uint8Array | null
  edif: Uint8Array | null
  seconds: number
  where: string
}

const RESOURCE: Record<Family, [string, RegExp][]> = {
  ice40: [['lut', /^SB_LUT4$/], ['ff', /^SB_DFF/], ['carry', /^SB_CARRY$/], ['bram', /^SB_RAM40/], ['spram', /^SB_SPRAM/], ['dsp', /^SB_MAC16$/], ['io', /^SB_IO/], ['pll', /^SB_PLL/], ['global', /^SB_GB/]],
  ecp5: [['lut', /^LUT4$/], ['ff', /^TRELLIS_FF$/], ['carry', /^CCU2/], ['lutram', /^TRELLIS_DPR16X4$/], ['mux', /^(PFUMX|L6MUX21)$/], ['bram', /^DP16KD$/], ['dsp', /^(MULT18X18D|ALU54B)$/], ['io', /^(TRELLIS_IO|IB|OB|BB)$/], ['pll', /^EHXPLLL$/]],
  gowin: [['lut', /^LUT[1-4]$/], ['ff', /^DFF/], ['carry', /^ALU$/], ['mux', /^MUX2/], ['bram', /^(SP|SPX9|DP|DPX9|SDP|SDPB|SDPX9B|DPB|DPX9B|pROM|pROMX9)$/], ['lutram', /^(RAM16S|RAM16SDP)/], ['dsp', /^(MULT|MULTALU|MULTADDALU|PADD|ALU54D)/], ['io', /^(IBUF|OBUF|IOBUF|TBUF|ELVDS|TLVDS)/], ['pll', /^(r?PLL|PLLVR)$/]],
  xilinx: [['lut', /^LUT[1-6]$/], ['ff', /^FD[CPRSE]E?$|^FD[A-Z]*$/], ['carry', /^CARRY[48]$/], ['mux', /^MUXF[78]$/], ['lutram', /^(RAM\d+[XM]|SRL|RAM64|RAM32|RAM128|RAM256)/], ['bram', /^RAMB(18|36)/], ['dsp', /^DSP48/], ['io', /^(IBUF|OBUF|IOBUF|IBUFDS|OBUFDS|OBUFT)/], ['pll', /^(PLLE2|MMCME2)/], ['global', /^BUFG/]],
}

export function utilisation(family: Family, statJson: string): Utilisation | null {
  let d: unknown
  try {
    d = JSON.parse(statJson)
  } catch {
    return null
  }
  const rec = d as { design?: { num_cells?: number; num_cells_by_type?: Record<string, number> }; modules?: Record<string, { num_cells?: number; num_cells_by_type?: Record<string, number> }> }
  const design = rec.design ?? Object.values(rec.modules ?? {})[0]
  if (!design) return null
  const by = design.num_cells_by_type ?? {}
  const resources: Record<string, number> = {}
  for (const [type, n] of Object.entries(by)) {
    const hit = RESOURCE[family].find(([, re]) => re.test(type))
    const k = hit ? hit[0] : 'other'
    resources[k] = (resources[k] ?? 0) + n
  }
  return { cells: design.num_cells ?? Object.values(by).reduce((s, n) => s + n, 0), by_type: by, resources }
}

const SYNTH: Record<Family, string> = { ice40: 'synth_ice40', ecp5: 'synth_ecp5', gowin: 'synth_gowin', xilinx: 'synth_xilinx' }

export async function synthesize(o: SynthOptions): Promise<SynthRun> {
  needProgram('yosys', 'apt install yosys, or the OSS CAD Suite')
  if (!/^[A-Za-z_][\w$]*$/.test(o.top)) throw new ToolError(`top ${JSON.stringify(o.top)} is not a module name`)
  for (const f of o.files) if (/\.(vhd|vhdl)$/i.test(f)) throw new ToolError(`${f}: VHDL needs the ghdl-yosys plugin, which fpga.synth does not load; give Verilog/SystemVerilog`)
  // sources and include dirs keep their relative layout, so `include "sub/x.vh" resolves
  const st = hdlStage({ files: o.files, include_dirs: o.include_dirs })
  const src = [...st.sources]
  const defs = Object.entries(o.defines ?? {}).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? `-D${k}` : `-D${k}=${v}`))
  const opt = (s: string): string => {
    if (!/^[-\w=.,:+/]+$/.test(s)) throw new ToolError(`synth option ${JSON.stringify(s)}: only flags and simple values`)
    return s
  }
  const params = Object.entries(o.parameters ?? {}).map(([k, v]) => {
    if (!/^\w+$/.test(k)) throw new ToolError(`parameter name ${k}`)
    return `chparam -set ${k} ${typeof v === 'number' ? v : JSON.stringify(String(v))} ${o.top}`
  })
  const synth = [SYNTH[o.family], '-top', o.top, ...(o.family === 'xilinx' ? ['-family', opt(o.xilinx_family ?? 'xc7')] : []), ...o.options.map(opt)].join(' ')
  const ys = [
    `read_verilog -sv ${[...defs, ...includeArgs(st)].join(' ')} ${src.map((n) => `{in:${n}}`).join(' ')}`,
    `hierarchy -check -top ${o.top}`,
    ...params,
    synth,
    'write_json {out:netlist.json}',
    ...(o.family === 'xilinx' ? ['write_edif -pvector bra {out:netlist.edif}'] : []),
    'tee -q -o {out:stat.json} stat -json',
    'tee -q -o {out:stat.txt} stat',
  ].join('; ')
  const r = await shellJob({
    kind: 'yosys', timeoutSeconds: o.timeout_s, inputs: st.inputs,
    script: `cd {dir}\nyosys -q -l {out:yosys.log} -p ${sq(ys)} > {out:stdout.log} 2>&1\necho "rc=$?" > {out:status.txt}`,
    outputs: ['yosys.log', 'stdout.log', 'status.txt', 'netlist.json', 'netlist.edif', 'stat.json', 'stat.txt'],
  })
  try {
    const log = r.text('yosys.log') || r.text('stdout.log')
    const rc = Number(/rc=(-?\d+)/.exec(r.text('status.txt'))?.[1] ?? r.job.exitCode)
    const warnings = [...new Set(log.split('\n').filter((l) => /^Warning:/.test(l)).map((l) => l.trim()))]
    const util = utilisation(o.family, r.text('stat.json'))
    const err = log.split('\n').find((l) => /^ERROR:/.test(l)) ?? r.text('stdout.log').split('\n').find((l) => /ERROR/.test(l))
    const ok = rc === 0 && r.has('netlist.json')
    return {
      ok, reason: ok ? `${util?.cells ?? '?'} cells` : `yosys failed${err ? `: ${err.replace(/^ERROR:\s*/, '').slice(0, 300)}` : ` (exit ${rc})`}`,
      utilisation: util, warnings, log, statText: r.text('stat.txt'), netlist: r.bytes('netlist.json'), edif: r.bytes('netlist.edif'),
      seconds: r.job.seconds, where: r.job.where,
    }
  } finally {
    r.cleanup()
  }
}

// ------------------------------------------------------------------ place and route

export const RegionSchema = z.object({
  name: z.string().regex(/^\w+$/),
  x0: z.number().int().min(0), y0: z.number().int().min(0), x1: z.number().int().min(0), y1: z.number().int().min(0),
  cells: z.array(z.string().min(1)).min(1).describe('cell name globs (fnmatch), e.g. ["u_filter.*"]'),
}).strict()
export type Region = z.output<typeof RegionSchema>

export interface PnrOptions {
  family: Exclude<Family, 'xilinx'>
  device: string
  package?: string | undefined
  /** gowin: the family (GW1N-9C, GW2A-18C, …) */
  gowin_family?: string | undefined
  netlist: string
  constraints?: string | undefined
  allow_unconstrained: boolean
  freq_mhz?: number | undefined
  clocks?: Record<string, number> | undefined
  seed: number
  placer?: string | undefined
  regions?: Region[] | undefined
  extra_args: string[]
  timeout_s: number
}

export interface ClockTiming {
  clock: string
  net: string
  achieved_mhz: number
  target_mhz: number | null
  slack_ns: number | null
  margin_pct: number | null
  status: 'met' | 'failed' | 'unconstrained'
}

export interface PathSummary {
  from: string
  to: string
  delay_ns: number
  logic_ns: number
  routing_ns: number
  setup_ns: number
  hops: number
  start: string | null
  end: string | null
  worst_nets: { net: string; delay_ns: number }[]
}

export interface Timing {
  closure: 'closed' | 'failing' | 'unconstrained'
  clocks: ClockTiming[]
  worst_slack_ns: number | null
  critical_paths: PathSummary[]
}

export interface PnrRun {
  ok: boolean
  reason: string
  timing: Timing | null
  utilisation: Record<string, { used: number; available: number; percent: number | null }>
  report: string
  log: string
  output: { name: string; bytes: Uint8Array } | null
  regions: Record<string, number>
  warnings: string[]
  program: string
  seconds: number
  where: string
}

/** The user's clock name from nextpnr's net name: clk$SB_IO_IN_$glb_clk → clk, $glbnet$clk$TRELLIS_IO_IN → clk. */
export function clockName(net: string): string {
  const s = net.replace(/^\$glbnet\$/, '').replace(/^\$?(?:posedge|negedge)\s+/, '')
  const i = s.indexOf('$')
  return i > 0 ? s.slice(0, i) : s
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000

export function timingFromReport(report: string, opts: { targets?: Record<string, number> } = {}): Timing | null {
  let d: unknown
  try {
    d = JSON.parse(report)
  } catch {
    return null
  }
  const rep = d as {
    fmax?: Record<string, { achieved: number; constraint?: number }>
    critical_paths?: { from: string; to: string; path: { type: string; delay: number; net?: string; from?: { cell: string }; to?: { cell: string } }[] }[]
  }
  const clocks: ClockTiming[] = Object.entries(rep.fmax ?? {}).map(([net, v]): ClockTiming => {
    const name = clockName(net)
    const target = opts.targets?.[name] ?? (v.constraint && v.constraint > 0 ? v.constraint : null)
    const slack = target ? 1000 / target - 1000 / v.achieved : null
    return {
      clock: name, net, achieved_mhz: r3(v.achieved), target_mhz: target === null ? null : r3(target),
      slack_ns: slack === null ? null : r3(slack), margin_pct: target ? r3((100 * (v.achieved - target)) / target) : null,
      status: target === null ? 'unconstrained' : v.achieved >= target ? 'met' : 'failed',
    }
  }).sort((a, b) => a.clock.localeCompare(b.clock))
  const constrained = clocks.filter((c) => c.status !== 'unconstrained')
  const paths: PathSummary[] = (rep.critical_paths ?? []).map((p) => {
    let logic = 0
    let routing = 0
    let setup = 0
    const nets: { net: string; delay_ns: number }[] = []
    for (const s of p.path) {
      if (s.type === 'routing') {
        routing += s.delay
        if (s.net) nets.push({ net: s.net, delay_ns: r3(s.delay) })
      } else if (s.type === 'setup') setup += s.delay
      else logic += s.delay
    }
    return {
      from: p.from.replace(/\S+$/, (n) => clockName(n)), to: p.to.replace(/\S+$/, (n) => clockName(n)),
      delay_ns: r3(logic + routing + setup), logic_ns: r3(logic), routing_ns: r3(routing), setup_ns: r3(setup), hops: p.path.length,
      start: p.path[0]?.from?.cell ?? null, end: p.path[p.path.length - 1]?.to?.cell ?? null,
      worst_nets: nets.sort((a, b) => b.delay_ns - a.delay_ns).slice(0, 5),
    }
  }).sort((a, b) => b.delay_ns - a.delay_ns)
  return {
    closure: !constrained.length ? 'unconstrained' : constrained.every((c) => c.status === 'met') ? 'closed' : 'failing',
    clocks,
    worst_slack_ns: constrained.length ? Math.min(...constrained.map((c) => c.slack_ns as number)) : null,
    critical_paths: paths,
  }
}

export function utilisationFromReport(report: string): PnrRun['utilisation'] {
  try {
    const u = (JSON.parse(report) as { utilization?: Record<string, { used: number; available: number }> }).utilization ?? {}
    return Object.fromEntries(Object.entries(u).filter(([, v]) => v.used > 0 || v.available > 0)
      .map(([k, v]) => [k, { used: v.used, available: v.available, percent: v.available ? Math.round((1000 * v.used) / v.available) / 10 : null }]))
  } catch {
    return {}
  }
}

export function regionScript(regions: readonly Region[]): string {
  const lines = ['# generated by trace fpga.pnr: floorplan regions', 'import fnmatch']
  for (const r of regions) {
    lines.push(`ctx.createRectangularRegion(${JSON.stringify(r.name)}, ${r.x0}, ${r.y0}, ${r.x1}, ${r.y1})`)
    lines.push(`_n = 0`)
    lines.push(`for _name, _cell in ctx.cells:`)
    lines.push(`    if any(fnmatch.fnmatchcase(_name, p) for p in ${JSON.stringify(r.cells)}):`)
    lines.push(`        ctx.constrainCellToRegion(_name, ${JSON.stringify(r.name)})`)
    lines.push(`        _n += 1`)
    lines.push(`print("TRACE_REGION ${r.name} %d" % _n)`)
  }
  return `${lines.join('\n')}\n`
}

export function clockScript(clocks: Readonly<Record<string, number>>): string {
  return `# generated by trace fpga.pnr: clock targets\n${Object.entries(clocks).map(([n, f]) => `ctx.addClock(${JSON.stringify(n)}, ${Number(f)})`).join('\n')}\n`
}

const ICE40_DEVICES = ['lp384', 'lp1k', 'lp4k', 'lp8k', 'hx1k', 'hx4k', 'hx8k', 'up3k', 'up5k', 'u1k', 'u2k', 'u4k']
const ECP5_DEVICES = ['12k', '25k', '45k', '85k', 'um-25k', 'um-45k', 'um-85k', 'um5g-25k', 'um5g-45k', 'um5g-85k']

export function pnrProgram(family: PnrOptions['family']): string {
  if (family === 'ice40') return 'nextpnr-ice40'
  if (family === 'ecp5') return 'nextpnr-ecp5'
  return haveProgram('nextpnr-himbaechel') || !haveProgram('nextpnr-gowin') ? 'nextpnr-himbaechel' : 'nextpnr-gowin'
}

export const PNR_OUTPUT: Record<PnrOptions['family'], string> = { ice40: 'design.asc', ecp5: 'design.config', gowin: 'pnr.json' }

export async function placeAndRoute(o: PnrOptions): Promise<PnrRun> {
  const prog = pnrProgram(o.family)
  needProgram(prog, `apt install ${prog}, or the OSS CAD Suite`)
  const st = stage([o.netlist])
  const netName = st.names[0] as string
  const args: string[] = []
  if (o.family === 'ice40') {
    if (!ICE40_DEVICES.includes(o.device)) throw new ToolError(`ice40 device ${o.device}: one of ${ICE40_DEVICES.join(', ')}`)
    args.push(`--${o.device}`, ...(o.package ? ['--package', o.package] : []), '--asc', '{out:design.asc}')
  } else if (o.family === 'ecp5') {
    if (!ECP5_DEVICES.includes(o.device)) throw new ToolError(`ecp5 device ${o.device}: one of ${ECP5_DEVICES.join(', ')}`)
    args.push(`--${o.device}`, ...(o.package ? ['--package', o.package] : []), '--textcfg', '{out:design.config}')
  } else {
    if (!o.gowin_family) throw new ToolError('gowin needs gowin_family (e.g. GW1N-9C) as well as device (e.g. GW1NR-LV9QN88PC6/I5)')
    if (prog === 'nextpnr-himbaechel') args.push('--device', o.device, '--vopt', `family=${o.gowin_family}`, '--write', '{out:pnr.json}')
    else args.push('--device', o.device, '--family', o.gowin_family, '--write', '{out:pnr.json}')
  }
  if (o.constraints) {
    const ext = extname(o.constraints).toLowerCase()
    const want = { ice40: '.pcf', ecp5: '.lpf', gowin: '.cst' }[o.family]
    if (ext !== want) throw new ToolError(`${o.family} constraints are a ${want} file (got ${o.constraints})`)
    stage([o.constraints], st)
    const c = st.names[st.names.length - 1] as string
    if (o.family === 'ice40') args.push('--pcf', `{in:${c}}`)
    else if (o.family === 'ecp5') args.push('--lpf', `{in:${c}}`)
    else if (prog === 'nextpnr-himbaechel') args.push('--vopt', `cst={in:${c}}`)
    else args.push('--cst', `{in:${c}}`)
  } else if (!o.allow_unconstrained) {
    throw new ToolError(`give constraints (the pin ${{ ice40: 'PCF', ecp5: 'LPF', gowin: 'CST' }[o.family]}), or allow_unconstrained to let the placer choose pins`)
  } else if (o.family === 'ice40') args.push('--pcf-allow-unconstrained')
  else if (o.family === 'ecp5') args.push('--lpf-allow-unconstrained')
  if (o.freq_mhz !== undefined) args.push('--freq', String(o.freq_mhz))
  if (o.placer) {
    if (!/^[\w-]+$/.test(o.placer)) throw new ToolError(`placer ${o.placer}`)
    args.push('--placer', o.placer)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'trace-pnr-'))
  try {
    if (o.regions?.length) {
      writeFileSync(join(tmp, 'trace_regions.py'), regionScript(o.regions))
      stage([join(tmp, 'trace_regions.py')], st)
      args.push('--pre-place', '{in:trace_regions.py}')
    }
    if (o.clocks && Object.keys(o.clocks).length) {
      writeFileSync(join(tmp, 'trace_clocks.py'), clockScript(o.clocks))
      stage([join(tmp, 'trace_clocks.py')], st)
      args.push('--pre-pack', '{in:trace_clocks.py}')
    }
    args.push('--json', `{in:${netName}}`, '--report', '{out:report.json}', '--seed', String(o.seed), '--timing-allow-fail', ...o.extra_args)
    const out = PNR_OUTPUT[o.family]
    const r = await shellJob({
      kind: 'nextpnr', timeoutSeconds: o.timeout_s, inputs: st.inputs,
      script: `cd {dir}\n${prog} ${args.map(sq).join(' ')} > {out:nextpnr.log} 2>&1\necho "rc=$?" > {out:status.txt}`,
      outputs: ['nextpnr.log', 'status.txt', 'report.json', out],
    })
    try {
      const log = r.text('nextpnr.log')
      const rc = Number(/rc=(-?\d+)/.exec(r.text('status.txt'))?.[1] ?? r.job.exitCode)
      const report = r.text('report.json')
      const timing = report ? timingFromReport(report, { targets: o.clocks }) : null
      const util = report ? utilisationFromReport(report) : {}
      const regions = Object.fromEntries([...log.matchAll(/TRACE_REGION (\w+) (\d+)/g)].map((m) => [m[1] as string, Number(m[2])]))
      const bytes = r.bytes(out)
      const ok = rc === 0 && bytes !== null
      const err = log.split('\n').find((l) => /^ERROR:/.test(l))
      const warnings = [...new Set(log.split('\n').filter((l) => /^Warning:/.test(l)).map((l) => l.trim()))]
      let reason: string
      if (!ok) reason = `${prog} failed${err ? `: ${err.replace(/^ERROR:\s*/, '').slice(0, 300)}` : ` (exit ${rc})`}`
      else if (!timing) reason = 'placed and routed (no timing report)'
      else reason = `timing ${timing.closure}: ${timing.clocks.map((c) => `${c.clock} ${c.achieved_mhz} MHz${c.target_mhz ? ` / ${c.target_mhz}` : ''}`).join(', ') || 'no clocks'}`
      return { ok, reason, timing, utilisation: util, report, log, output: bytes ? { name: out, bytes } : null, regions, warnings, program: prog, seconds: r.job.seconds, where: r.job.where }
    } finally {
      r.cleanup()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ bitstream

export interface PackRun { ok: boolean; reason: string; bitstream: Uint8Array | null; name: string; log: string; seconds: number; where: string }

export async function pack(o: { family: Exclude<Family, 'xilinx'>; input: string; gowin_family?: string | undefined; compress: boolean; extra_args: string[]; timeout_s: number }): Promise<PackRun> {
  const st = stage([o.input])
  const inName = st.names[0] as string
  let cmd: string
  let name: string
  if (o.family === 'ice40') {
    needProgram('icepack', 'apt install fpga-icestorm, or the OSS CAD Suite')
    name = 'design.bin'
    cmd = `icepack ${o.extra_args.map(sq).join(' ')} {in:${inName}} {out:${name}}`
  } else if (o.family === 'ecp5') {
    needProgram('ecppack', 'apt install fpga-trellis, or the OSS CAD Suite')
    name = 'design.bit'
    cmd = `ecppack ${o.compress ? '--compress ' : ''}${o.extra_args.map(sq).join(' ')} {in:${inName}} {out:${name}}`
  } else {
    needProgram('gowin_pack', 'pip install apycula (or apt install python3-apycula)')
    if (!o.gowin_family) throw new ToolError('gowin needs gowin_family (e.g. GW1N-9C)')
    name = 'design.fs'
    cmd = `gowin_pack -d ${sq(o.gowin_family)} ${o.compress ? '-c ' : ''}${o.extra_args.map(sq).join(' ')} -o {out:${name}} {in:${inName}}`
  }
  const r = await shellJob({ kind: 'fpga-pack', timeoutSeconds: o.timeout_s, inputs: st.inputs, script: `cd {dir}\n${cmd} > {out:pack.log} 2>&1\necho "rc=$?" > {out:status.txt}`, outputs: ['pack.log', 'status.txt', name] })
  try {
    const rc = Number(/rc=(-?\d+)/.exec(r.text('status.txt'))?.[1] ?? r.job.exitCode)
    const b = r.bytes(name)
    const log = r.text('pack.log')
    const ok = rc === 0 && b !== null && b.length > 0
    return { ok, reason: ok ? `${name}, ${b?.length} bytes` : `packing failed (exit ${rc}): ${log.trim().split('\n').filter((l) => !/SyntaxWarning|return f/.test(l)).slice(-1)[0] ?? ''}`, bitstream: b, name, log, seconds: r.job.seconds, where: r.job.where }
  } finally {
    r.cleanup()
  }
}
