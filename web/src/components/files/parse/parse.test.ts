import { gzipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseDelimited } from '../csv'
import { csvToPlots, columnUnit, monotonic } from './csv-series'
import { align, downsample, pickRows, windowRows } from './downsample'
import { gunzip, innerName, isGzip } from './gzip'
import { readKicadReport } from './kicad-report'
import { fmtValue } from './series'
import { looksLikeRaw, opRows, parseSpiceRaw, rawKind, rawToPlots, unitOf } from './spice-raw'
import { parseTouchstone, portsFromName, touchstoneToPlots } from './touchstone'

// what ngspice writes with `set filetype=ascii` (and what src/tools/sim/spice.ts parseRaw reads)
const TRAN = `Title: rc step
Date: Mon Nov  2 10:00:00  2026
Plotname: Transient Analysis
Flags: real
No. Variables: 3
No. Points: 4
Variables:
	0	time	time
	1	v(out)	voltage
	2	i(v1)	current
Values:
 0	0.000000000000000e+00
	0.000000000000000e+00
	-1.000000000000000e-03
 1	1.000000000000000e-06
	6.321205588285577e-01
	-3.678794411714423e-04
 2	2.000000000000000e-06
	8.646647167633873e-01
	-1.353352832366127e-04
 3	3.000000000000000e-06
	9.502129316321360e-01
	-4.978706836786394e-05
`

const AC = `Title: rc lowpass
Date: Mon Nov  2 10:00:00  2026
Plotname: AC Analysis
Flags: complex
No. Variables: 2
No. Points: 3
Variables:
	0	frequency	frequency grid=3
	1	v(out)	voltage
Values:
 0	1.000000000000000e+01,0.000000000000000e+00
	1.000000000000000e+00,0.000000000000000e+00
 1	1.000000000000000e+03,0.000000000000000e+00
	5.000000000000000e-01,-5.000000000000000e-01
 2	1.000000000000000e+05,0.000000000000000e+00
	0.000000000000000e+00,-1.000000000000000e-01
`

const OP = `Title: divider
Date: Mon Nov  2 10:00:00  2026
Plotname: Operating Point
Flags: real
No. Variables: 2
No. Points: 1
Variables:
	0	v(mid)	voltage
	1	i(v1)	current
Values:
 0	1.650000000000000e+00
	-1.650000000000000e-04
`

const DC = `Title: diode iv
Plotname: DC transfer characteristic
Flags: real
No. Variables: 2
No. Points: 3
Variables:
	0	v-sweep	voltage
	1	i(vd)	current
Values:
 0	0.0
	0.0
 1	0.5
	-1e-6
 2	1.0
	-2e-3
`

describe('ngspice rawfiles', () => {
  it('reads a transient plot and draws voltage and current panels against time', () => {
    const [p] = parseSpiceRaw(TRAN)
    expect(p!.kind).toBe('tran')
    expect(p!.points).toBe(4)
    expect(p!.vars.map((v) => v.name)).toEqual(['time', 'v(out)', 'i(v1)'])
    const panels = rawToPlots(p!)
    expect(panels.map((x) => x.panel)).toEqual(['Voltage', 'Current'])
    expect(panels[0]!.x).toEqual({ label: 'Time', unit: 's' })
    expect(panels[0]!.y.unit).toBe('V')
    expect(panels[0]!.series[0]!.points[1]).toEqual([1e-6, 0.6321205588285577])
    expect(panels[1]!.series[0]!.name).toBe('i(v1)')
    expect(panels[0]!.xLog).toBe(false)
  })

  it('draws AC as magnitude in dB and phase in degrees on a log frequency axis', () => {
    const [p] = parseSpiceRaw(AC)
    expect(p!.kind).toBe('ac')
    expect(p!.complex).toBe(true)
    const [mag, ph] = rawToPlots(p!)
    expect(mag!.panel).toBe('Magnitude')
    expect(mag!.y.unit).toBe('dB')
    expect(mag!.xLog).toBe(true)
    expect(mag!.x.unit).toBe('Hz')
    expect(mag!.series[0]!.points[0]).toEqual([10, 0])
    expect(mag!.series[0]!.points[1]![1]).toBeCloseTo(20 * Math.log10(Math.SQRT1_2), 6)
    expect(mag!.series[0]!.points[2]![1]).toBeCloseTo(-20, 6)
    expect(ph!.y.unit).toBe('°')
    expect(ph!.series[0]!.points[1]![1]).toBeCloseTo(-45, 6)
    expect(ph!.series[0]!.points[2]![1]).toBeCloseTo(-90, 6)
  })

  it('draws a DC sweep against the swept variable', () => {
    const [p] = parseSpiceRaw(DC)
    expect(p!.kind).toBe('dc')
    const [panel] = rawToPlots(p!)
    expect(panel!.x).toEqual({ label: 'Swept voltage', unit: 'V' })
    expect(panel!.y.unit).toBe('A')
    expect(panel!.series[0]!.points[2]).toEqual([1, -2e-3])
  })

  it('shows an operating point as a table of values, not a chart', () => {
    const [p] = parseSpiceRaw(OP)
    expect(p!.kind).toBe('op')
    expect(rawToPlots(p!)).toEqual([])
    expect(opRows(p!)).toEqual([
      { name: 'v(mid)', value: 1.65, unit: 'V' },
      { name: 'i(v1)', value: -1.65e-4, unit: 'A' },
    ])
  })

  it('reads several plots in one file, CRLF line ends, and refuses a binary file', () => {
    const both = `${TRAN}${OP}`.replace(/\n/g, '\r\n')
    const plots = parseSpiceRaw(both)
    expect(plots.map((p) => p.kind)).toEqual(['tran', 'op'])
    expect(() => parseSpiceRaw('Title: x\nPlotname: Transient Analysis\nVariables:\n\t0\ttime\ttime\nBinary:\n')).toThrow(/binary/)
    expect(parseSpiceRaw('not a rawfile')).toEqual([])
  })

  it('names analyses and units', () => {
    expect(rawKind('Noise Spectral Density Curves')).toBe('noise')
    expect(rawKind('Integrated Noise')).toBe('noise_total')
    expect(unitOf({ name: 'v(x)', type: 'notype' })).toBe('V')
    expect(unitOf({ name: 'l1#branch', type: 'notype' })).toBe('A')
    expect(looksLikeRaw(TRAN)).toBe(true)
    expect(looksLikeRaw('a,b\n1,2')).toBe(false)
  })
})

const S2P_MA = `! a 2-port filter
# MHz S MA R 50
1    0.5 -30   0.9 -10   0.9 -10   0.4 20
10   0.1 -90   0.5 -60   0.5 -60   0.2 45
100  0.01 180  0.1 -170  0.1 -170  0.05 90
`

describe('Touchstone', () => {
  it('honours the option line and the 2-port order S11 S21 S12 S22', () => {
    const t = parseTouchstone(S2P_MA, 'filter.s2p')
    expect(t.ports).toBe(2)
    expect(t.format).toBe('MA')
    expect(t.z0).toBe(50)
    expect(t.freq).toEqual([1e6, 1e7, 1e8])
    // S21 is the second pair on the line
    const [re, im] = t.data[1]![0]![0]!
    expect(Math.hypot(re, im)).toBeCloseTo(0.9, 9)
    expect((Math.atan2(im, re) * 180) / Math.PI).toBeCloseTo(-10, 9)
    const [mag, ph] = touchstoneToPlots(t)
    expect(mag!.series.map((s) => s.name)).toEqual(['S11', 'S12', 'S21', 'S22'])
    expect(mag!.xLog).toBe(true)
    expect(mag!.y.unit).toBe('dB')
    const s21 = mag!.series.find((s) => s.name === 'S21')!
    expect(s21.points[0]![1]).toBeCloseTo(20 * Math.log10(0.9), 6)
    expect(ph!.series.find((s) => s.name === 'S11')!.points[1]![1]).toBeCloseTo(-90, 6)
  })

  it('reads DB and RI formats, Hz and GHz, defaults, comments and wrapped 4-port rows', () => {
    const db = parseTouchstone('# Hz S DB R 75\n1e9 -3 45\n2e9 -6 90\n', 'x.s1p')
    expect(db.z0).toBe(75)
    expect(db.freq).toEqual([1e9, 2e9])
    const [r, i] = db.data[0]![0]![0]!
    expect(20 * Math.log10(Math.hypot(r, i))).toBeCloseTo(-3, 9)
    const ri = parseTouchstone('# GHz S RI\n1 0.6 0.8 ! one point\n', 'x.s1p')
    expect(ri.freq).toEqual([1e9])
    expect(ri.data[0]![0]![0]).toEqual([0.6, 0.8])
    // no option line: GHz S MA R 50
    expect(parseTouchstone('1 1 0\n', 'x.s1p').freq).toEqual([1e9])
    // a 4-port point: frequency and 16 pairs over 4 lines, row by row (S11 S12 S13 S14 ...)
    const pairs = Array.from({ length: 16 }, (_, k) => `${(k + 1) / 100} 0`)
    const rows = [0, 1, 2, 3].map((r2) => pairs.slice(r2 * 4, r2 * 4 + 4).join(' '))
    const t4 = parseTouchstone(`# GHz S MA R 50\n1 ${rows[0]}\n${rows[1]}\n${rows[2]}\n${rows[3]}\n`, 'b.s4p')
    expect(t4.ports).toBe(4)
    expect(t4.data[0]![1]![0]![0]).toBeCloseTo(0.02, 9)
    expect(t4.data[1]![0]![0]![0]).toBeCloseTo(0.05, 9)
    expect(portsFromName('a.S3P')).toBe(3)
  })

  it('reads a version 2 file with its keywords', () => {
    const t = parseTouchstone('[Version] 2.0\n# GHz S MA R 50\n[Number of Ports] 2\n[Two-Port Data Order] 12_21\n[Number of Frequencies] 1\n[Network Data]\n1 0.1 0 0.2 0 0.3 0 0.4 0\n[End]\n', 'v2.ts')
    expect(t.ports).toBe(2)
    // 12_21: the second pair is S12
    expect(t.data[0]![1]![0]![0]).toBeCloseTo(0.2, 9)
    expect(t.data[1]![0]![0]![0]).toBeCloseTo(0.3, 9)
  })
})

describe('numeric tables as charts', () => {
  it('draws a scope capture against time with units from the header', () => {
    const t = parseDelimited('t_s,CH1_v,CH2_v\n0,0,3.3\n1e-6,1.5,3.3\n2e-6,3.3,0\n')
    const plots = csvToPlots(t)!
    expect(plots).toHaveLength(1)
    expect(plots[0]!.x).toEqual({ label: 'Time', unit: 's' })
    expect(plots[0]!.y.unit).toBe('V')
    expect(plots[0]!.series.map((s) => s.name)).toEqual(['CH1', 'CH2'])
    expect(plots[0]!.xLog).toBe(false)
  })

  it('draws loop_gain.csv as magnitude and phase panels on a log axis', () => {
    const rows = [1, 10, 100, 1000, 10000].map((f, i) => `${f},${60 - 20 * i},${-90 - 20 * i}`)
    const plots = csvToPlots(parseDelimited(`f,mag_db,phase_deg\n${rows.join('\n')}\n`))!
    expect(plots.map((p) => p.panel)).toEqual(['Magnitude', 'Phase'])
    expect(plots[0]!.xLog).toBe(true)
    expect(plots[0]!.x).toEqual({ label: 'Frequency', unit: 'Hz' })
    expect(plots[1]!.y.unit).toBe('°')
  })

  it('keeps a linear axis for two decades or less, scales units, and skips meter overloads', () => {
    const p = csvToPlots(parseDelimited('Freq (kHz),Gain (dB)\n1,0\n10,-3\n100,-20\n'))!
    expect(p[0]!.xLog).toBe(false)
    expect(p[0]!.series[0]!.points[1]).toEqual([1e4, -3])
    const meter = csvToPlots(parseDelimited('i,dcv_V\n0,1.2\n1,OL\n2,1.3\n3,1.25\n'))!
    expect(meter[0]!.series[0]!.points).toHaveLength(3)
  })

  it('does not chart tables whose first column is text or goes back and forth', () => {
    expect(csvToPlots(parseDelimited('Ref,Value\nR1,10k\nR2,4k7\n'))).toBeNull()
    expect(csvToPlots(parseDelimited('corner,vout\n1,3.3\n0,3.2\n2,3.4\n'))).toBeNull()
    expect(csvToPlots(parseDelimited('t,label\n0,a\n1,b\n'))).toBeNull()
  })

  it('reads units from headers', () => {
    expect(columnUnit('t_s')).toEqual({ label: 't', unit: 's', factor: 1 })
    expect(columnUnit('I [mA]')).toEqual({ label: 'I', unit: 'A', factor: 1e-3 })
    expect(columnUnit('phase_deg')).toEqual({ label: 'phase', unit: '°', factor: 1 })
    expect(columnUnit('freq')).toEqual({ label: 'freq', unit: 'Hz', factor: 1 })
    expect(columnUnit('run')).toEqual({ label: 'run', unit: '', factor: 1 })
    expect(monotonic([3, 2, 1])).toBe(true)
    expect(monotonic([1, 1, 1])).toBe(false)
  })
})

describe('thinning for drawing', () => {
  it('keeps at most the budget and the extremes of every bucket', () => {
    const pts: [number, number][] = Array.from({ length: 100_000 }, (_, i) => [i, Math.sin(i / 50)])
    pts[54_321] = [54_321, 99]
    pts[77_777] = [77_777, -99]
    const out = downsample(pts, 4000)
    expect(out.length).toBeLessThanOrEqual(4000)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]![0]).toBe(99_999)
    expect(out.some((p) => p[1] === 99)).toBe(true)
    expect(out.some((p) => p[1] === -99)).toBe(true)
    expect(out.every((p, i) => i === 0 || p[0] > out[i - 1]![0])).toBe(true)
    expect(downsample([[0, 1], [1, 2]], 4000)).toEqual([[0, 1], [1, 2]])
  })

  it('picks shared rows across series within a window', () => {
    const ys = [Array.from({ length: 50_000 }, (_, i) => (i === 123 ? 10 : 0)), Array.from({ length: 50_000 }, (_, i) => (i === 40_000 ? -10 : 1))]
    const rows = pickRows(ys, 4000)
    expect(rows.length).toBeLessThanOrEqual(4002)
    expect(rows).toContain(123)
    expect(rows).toContain(40_000)
    expect(pickRows(ys, 4000, 10, 20)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(windowRows([0, 1, 2, 3, 4, 5], 2, 3)).toEqual([1, 5])
  })

  it('aligns series on one x', () => {
    expect(align([{ points: [[0, 1], [1, 2]] }, { points: [[0, 3], [1, 4]] }])).toEqual({ xs: [0, 1], ys: [[1, 2], [3, 4]] })
    expect(align([{ points: [[0, 1], [2, 2]] }, { points: [[1, 3]] }])).toEqual({ xs: [0, 1, 2], ys: [[1, null, 2], [null, 3, null]] })
  })

  it('formats dB and degrees plainly and the rest with engineering prefixes', () => {
    expect(fmtValue(-3.0103, 'dB')).toBe('-3.01 dB')
    expect(fmtValue(-45, '°')).toBe('-45 °')
    expect(fmtValue(1e-6, 's')).toBe('1 µs')
    expect(fmtValue(2.5e9, 'Hz')).toBe('2.5 GHz')
  })
})

describe('single-file gzip', () => {
  it('names the inner file and unpacks it', async () => {
    expect(innerName('netlist.json.gz')).toBe('netlist.json')
    expect(innerName('runs/r1/design.bit.gz')).toBe('runs/r1/design.bit')
    expect(innerName('release.tar.gz')).toBeNull()
    expect(innerName('a.json')).toBeNull()
    const gz = gzipSync(strToU8('{"modules":{}}'))
    expect(isGzip(gz)).toBe(true)
    expect(new TextDecoder().decode(await gunzip(gz))).toBe('{"modules":{}}')
    await expect(gunzip(strToU8('plain'))).rejects.toThrow(/not gzip/)
  })
})

describe('check reports as findings', () => {
  it('reads a kicad-cli ERC report', () => {
    const r = readKicadReport(JSON.stringify({
      kicad_version: '9.0.1', coordinate_units: 'mm',
      sheets: [{ path: '/', violations: [
        { type: 'pin_not_connected', severity: 'error', description: 'Pin not connected', items: [{ description: 'Symbol U1 Pin 3 [NC]', pos: { x: 120, y: 80 } }] },
        { type: 'lib_symbol_mismatch', severity: 'warning', description: 'Symbol does not match library', items: [] },
        { type: 'power_pin_not_driven', severity: 'error', description: 'Power pin not driven', excluded: true, items: [] },
      ] }],
    }))!
    expect(r.check).toBe('erc')
    expect(r.version).toBe('9.0.1')
    expect(r.counts).toEqual({ blocks: 1, fix: 1, waived: 1 })
    expect(r.findings[0]).toMatchObject({ severity: 'blocks', x_mm: 120, y_mm: 80, sheet: '/' })
    expect(r.findings[0]!.text).toContain('Symbol U1 Pin 3')
  })

  it('reads a DRC report in inches with unconnected items', () => {
    const r = readKicadReport(JSON.stringify({
      coordinate_units: 'in',
      violations: [{ type: 'clearance', severity: 'error', description: 'Clearance violation', items: [{ description: 'Track', pos: { x: 1, y: 2 } }] }],
      unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] }],
      schematic_parity: [],
    }))!
    expect(r.check).toBe('drc')
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatchObject({ x_mm: 25.4, y_mm: 50.8 })
    expect(r.findings[1]!.where).toContain('unconnected')
  })

  it('reads the tools findings arrays and leaves other JSON alone', () => {
    const pins = readKicadReport(JSON.stringify([{ id: 'pin:U1.3:no_net', target: 'pin:U1.3', kind: 'no_net', severity: 'blocks', text: 'U1 pin 3 is used but names no net.' }]))!
    expect(pins.check).toBe('findings')
    expect(pins.findings[0]).toMatchObject({ id: 'pin:U1.3:no_net', severity: 'blocks' })
    const emc = readKicadReport(JSON.stringify([{ rule: 'return_path', severity: 'warn', net: 'CLK', layer: 'F.Cu', at: { x_mm: 1, y_mm: 2 }, message: 'CLK crosses a split', evidence: {} }]))!
    expect(emc.findings[0]).toMatchObject({ severity: 'fix', text: 'CLK crosses a split', x_mm: 1 })
    expect(emc.findings[0]!.where).toContain('net CLK')
    expect(readKicadReport('{"settings":{},"ok":true}')).toBeNull()
    expect(readKicadReport('[1,2]')).toBeNull()
    expect(readKicadReport('not json')).toBeNull()
  })
})
