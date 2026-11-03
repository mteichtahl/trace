/**
 * Touchstone S-parameter files (.s1p ... .s4p, .sNp; versions 1 and 2) into charts: |Sij| in dB and the phase in
 * degrees against frequency on a log axis. The option line `# <unit> <param> <format> R <z0>` is honoured (defaults:
 * GHz S MA R 50). Data are frequency then N*N pairs, wrapped over lines; two-port files list S11 S21 S12 S22, every
 * other size row by row (S11 S12 ... S1N, S21 ...). Version 2's [Two-Port Data Order] 12_21 is honoured.
 */
import type { ResultPlot } from './series'

export type TsFormat = 'MA' | 'DB' | 'RI'

export interface Touchstone {
  ports: number
  /** S, Y, Z, H or G */
  param: string
  format: TsFormat
  z0: number
  /** in Hz */
  freq: number[]
  /** [i][j] → per frequency: [re, im] (i, j from 0) */
  data: [number, number][][][]
}

const UNIT: Record<string, number> = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }

/** The port count from a name like board.s4p, or null. */
export function portsFromName(name: string): number | null {
  const m = /\.s(\d+)p$/i.exec(name)
  return m ? Number(m[1]) : null
}

export function parseTouchstone(text: string, name = ''): Touchstone {
  let unit = 1e9
  let param = 'S'
  let format: TsFormat = 'MA'
  let z0 = 50
  let ports = portsFromName(name)
  let order21 = true
  let sawOption = false
  const nums: number[] = []
  let firstLineCount: number | null = null
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/!.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (sawOption) continue
      sawOption = true
      const toks = line.slice(1).trim().split(/\s+/)
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k]!.toLowerCase()
        if (t in UNIT) unit = UNIT[t]!
        else if (['s', 'y', 'z', 'h', 'g'].includes(t)) param = t.toUpperCase()
        else if (t === 'ma' || t === 'db' || t === 'ri') format = t.toUpperCase() as TsFormat
        else if (t === 'r' && toks[k + 1] !== undefined) z0 = Number(toks[++k]) || 50
      }
      continue
    }
    if (line.startsWith('[')) {
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line)
      const key = (m?.[1] ?? '').toLowerCase().trim()
      const val = (m?.[2] ?? '').trim()
      if (key === 'number of ports') ports = Number(val) || ports
      else if (key === 'two-port data order') order21 = val !== '12_21'
      else if (key === 'reference') z0 = Number(val.split(/\s+/)[0]) || z0
      continue
    }
    const vals = line.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
    if (firstLineCount === null) firstLineCount = vals.length
    nums.push(...vals)
  }
  if (!ports) {
    // a single unwrapped line holds 1 + 2*N*N numbers
    const n = Math.round(Math.sqrt(((firstLineCount ?? 3) - 1) / 2))
    ports = n >= 1 ? n : 1
  }
  const per = 1 + 2 * ports * ports
  const count = Math.floor(nums.length / per)
  const freq: number[] = []
  const data: [number, number][][][] = Array.from({ length: ports }, () => Array.from({ length: ports }, () => []))
  for (let r = 0; r < count; r++) {
    const o = r * per
    freq.push(nums[o]! * unit)
    for (let k = 0; k < ports * ports; k++) {
      const a = nums[o + 1 + 2 * k]!
      const b = nums[o + 2 + 2 * k]!
      let i = Math.floor(k / ports)
      let j = k % ports
      if (ports === 2 && order21) [i, j] = [j, i]
      data[i]![j]!.push(toReIm(a, b, format))
    }
  }
  return { ports, param, format, z0, freq, data }
}

function toReIm(a: number, b: number, f: TsFormat): [number, number] {
  if (f === 'RI') return [a, b]
  const mag = f === 'DB' ? 10 ** (a / 20) : a
  const rad = (b * Math.PI) / 180
  return [mag * Math.cos(rad), mag * Math.sin(rad)]
}

/** Magnitude (dB) and phase (degrees) panels, one series per Sij. `pairs` limits which (default: all). */
export function touchstoneToPlots(t: Touchstone, title = 'S-parameters'): ResultPlot[] {
  const pairs: [number, number][] = []
  for (let i = 0; i < t.ports; i++) for (let j = 0; j < t.ports; j++) pairs.push([i, j])
  const xLog = t.freq.length > 1 && t.freq.every((f) => f > 0) && Math.max(...t.freq) / Math.min(...t.freq) > 10
  const name = (i: number, j: number) => `${t.param}${i + 1}${t.ports > 9 ? ',' : ''}${j + 1}`
  const x = { label: 'Frequency', unit: 'Hz' }
  const sub = `${t.ports}-port · ${t.z0} Ω`
  return [
    {
      title: `${title} · ${sub}`, panel: 'Magnitude', x, y: { label: `|${t.param}|`, unit: 'dB' }, xLog,
      series: pairs.map(([i, j]) => ({ name: name(i, j), points: t.freq.map((f, k): [number, number] => {
        const [re, im] = t.data[i]![j]![k]!
        const m = Math.hypot(re, im)
        return [f, m > 0 ? 20 * Math.log10(m) : -400]
      }) })),
    },
    {
      title: `${title} · ${sub}`, panel: 'Phase', x, y: { label: `∠${t.param}`, unit: '°' }, xLog,
      series: pairs.map(([i, j]) => ({ name: name(i, j), points: t.freq.map((f, k): [number, number] => {
        const [re, im] = t.data[i]![j]![k]!
        return [f, (Math.atan2(im, re) * 180) / Math.PI]
      }) })),
    },
  ]
}
