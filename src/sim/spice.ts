/**
 * ngspice, driven in batch mode, and its ASCII raw output read back into vectors.
 *
 * A caller gives a netlist (the circuit, without .control or .end) and one or more analyses (".op", ".dc …", ".ac …",
 * ".tran …", ".noise …"); analysis lines already in the netlist are used when none are given. The netlist is wrapped
 * in a .control block that runs each analysis in turn and writes its vectors as an ASCII raw file, one file per
 * analysis, so every result knows which analysis made it. AC data is complex: each vector becomes its magnitude, with
 * `<name>#db`, `<name>#phase` (degrees), `<name>#re` and `<name>#im` beside it. A .noise analysis yields two results:
 * `noise` (the spectral densities against frequency) and `noise_total` (the integrated noise).
 *
 * As in every SPICE deck, the netlist's first line is its title (a netlist starting with a directive or a blank line
 * is given one).
 *
 * The model libraries the project lists (config `electronics.models`, files or folders relative to the repository)
 * are included automatically. ngspice runs in a scratch directory that is removed afterwards; the caller stores what
 * matters (the netlist, the log, the raw files) in the project database. A failed run is reported with the first
 * error line of the log, never as empty results: ngspice sometimes still writes a raw file after an error, so the
 * exit status and the log decide, not the file's existence.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { load } from '../core/config.js'
import { scratchDir } from '../core/store.js'
import { run, which } from './proc.js'

export class SpiceError extends Error {
  override name = 'SpiceError'
  constructor(message: string, readonly log: string = '', readonly netlist: string = '') {
    super(message)
  }
}

export type AnalysisKind = 'op' | 'dc' | 'ac' | 'tran' | 'noise' | 'noise_total'

export interface Plot {
  /** op, dc, ac, tran, noise (spectral density) or noise_total; a repeated analysis gets a suffix (tran_2). */
  readonly analysis: string
  readonly kind: AnalysisKind
  readonly plotname: string
  readonly complex: boolean
  /** The scale (x axis) name, null for an operating point. */
  readonly scale: string | null
  readonly points: number
  /** Vectors by lower-case name, the scale included. */
  readonly vectors: Map<string, number[]>
  /** The original variable names in file order (the derived #db/#phase vectors are not listed). */
  readonly names: readonly string[]
}

export interface SpiceRun {
  readonly plots: Plot[]
  readonly netlist: string
  readonly log: string
  /** The raw files as ngspice wrote them, by analysis. */
  readonly raw: Map<string, string>
  readonly warnings: string[]
  readonly ms: number
}

export interface SimulateOptions {
  readonly netlist: string
  /** ".tran 1u 1m" or "tran 1u 1m"; empty = the analysis lines in the netlist. */
  readonly analyses?: readonly string[]
  /** Vectors to keep (ngspice names); empty = everything. Ignored for .noise, which writes its own plots. */
  readonly save?: readonly string[]
  /** .param overrides, appended after the netlist (in ngspice the last definition wins). */
  readonly params?: Readonly<Record<string, number | string>>
  /** Extra model files or folders, besides the config's. */
  readonly models?: readonly string[]
  /** Skip the config's electronics.models. */
  readonly noConfigModels?: boolean
  /** The directory relative .include/.lib paths in the netlist are resolved against (default: the cwd). */
  readonly baseDir?: string
  readonly options?: string
  readonly timeoutMs?: number
}

export function ngspice(): string | null {
  return which('ngspice', 'NGSPICE')
}

export async function ngspiceVersion(): Promise<string | null> {
  const exe = ngspice()
  if (!exe) return null
  try {
    const r = await run(exe, ['-v'], { timeoutMs: 30_000 })
    const m = /ngspice-(\d+(?:\.\d+)?)/.exec(r.stdout + r.stderr)
    return m ? (m[1] ?? null) : null
  } catch {
    return null
  }
}

const ANALYSIS = /^\s*\.(op|dc|ac|tran|noise|pz|tf|sens|disto|sp)\b(.*)$/i
const SUPPORTED = new Set(['op', 'dc', 'ac', 'tran', 'noise'])

/** The netlist without .end, and the analysis lines it carried (taken out, to run under our .control). */
export function splitNetlist(netlist: string): { body: string; analyses: string[] } {
  const lines = netlist.replace(/\r\n?/g, '\n').split('\n')
  const body: string[] = []
  const analyses: string[] = []
  let inControl = false
  for (const ln of lines) {
    const t = ln.trim().toLowerCase()
    if (t.startsWith('.control')) {
      inControl = true
      continue
    }
    if (inControl) {
      if (t.startsWith('.endc')) inControl = false
      continue
    }
    if (t === '.end' || t.startsWith('.end ')) continue
    const m = ANALYSIS.exec(ln)
    if (m) {
      analyses.push(`.${(m[1] ?? '').toLowerCase()}${m[2] ?? ''}`.trim())
      continue
    }
    body.push(ln)
  }
  if (lines.some((l) => l.trim().toLowerCase().startsWith('.control'))) {
    throw new SpiceError('the netlist has its own .control block: give the circuit only, with analyses as lines or in `analyses`')
  }
  return { body: body.join('\n'), analyses }
}

function analysisCommand(a: string): { kind: 'op' | 'dc' | 'ac' | 'tran' | 'noise'; cmd: string } {
  const t = a.trim().replace(/^\./, '')
  const kind = (t.split(/\s+/)[0] ?? '').toLowerCase()
  if (!SUPPORTED.has(kind)) throw new SpiceError(`unsupported analysis ${JSON.stringify(a)} (op, dc, ac, tran, noise)`)
  return { kind: kind as 'op' | 'dc' | 'ac' | 'tran' | 'noise', cmd: t }
}

const MODEL_EXT = new Set(['.lib', '.mod', '.model', '.models', '.sub', '.subckt', '.inc', '.spi', '.spice', '.cmp'])

/** Model files to .include: the config's electronics.models (relative to the repository) and any extra ones. */
export function modelFiles(extra: readonly string[] = [], useConfig = true): { files: string[]; warnings: string[] } {
  const warnings: string[] = []
  const entries: string[] = []
  if (useConfig) {
    const cfg = load()
    const root = cfg.root ?? process.cwd()
    for (const m of cfg.electronics.models) entries.push(isAbsolute(m) ? m : join(root, m))
  }
  for (const m of extra) entries.push(resolve(m))
  const files: string[] = []
  for (const e of entries) {
    if (!existsSync(e)) {
      warnings.push(`model path ${e} does not exist`)
      continue
    }
    const st = statSync(e)
    const cands = st.isDirectory()
      ? readdirSync(e).sort().filter((f) => MODEL_EXT.has(f.slice(f.lastIndexOf('.')).toLowerCase())).map((f) => join(e, f))
      : [e]
    for (const f of cands) {
      const text = readFileSync(f, 'utf8')
      if (/^\s*\.endl\b/im.test(text)) {
        warnings.push(`${f} has .lib sections; include it from the netlist with ".lib ${f} <section>"`)
        continue
      }
      files.push(f)
    }
  }
  return { files, warnings }
}

/** Relative .include/.lib paths made absolute against `baseDir`, since ngspice runs in a scratch directory. */
function absoluteIncludes(body: string, baseDir: string): string {
  return body.replace(/^(\s*\.(?:include|inc|lib)\s+)("?)([^\s"]+)\2(.*)$/gim, (all, head: string, q: string, p: string, rest: string) => {
    if (isAbsolute(p)) return all
    return `${head}${q}${resolve(baseDir, p)}${q}${rest}`
  })
}

const FATAL = /^.*(?:simulation interrupted due to error|run simulation\(s\) aborted|timestep too small|unknown subckt|could not find a valid modelname|too few parameters|unable to find definition|singular matrix|no such vector|cannot open|could not find include file|unknown model).*$/im

export function firstError(log: string): string {
  const fatal = FATAL.exec(log)
  if (fatal) return fatal[0].trim().slice(0, 300)
  for (const line of log.split('\n')) if (/\berror\b|singular|too small|abort|fatal/i.test(line)) return line.trim().slice(0, 300)
  const lines = log.trim().split('\n')
  return (lines[lines.length - 1] ?? '(empty log)').slice(0, 300)
}

/** The full netlist ngspice runs, and the analyses in the order their raw files are written. */
export function buildDeck(o: SimulateOptions): { deck: string; runs: { analysis: string; kind: AnalysisKind; file: string }[]; warnings: string[] } {
  const split = splitNetlist(o.netlist)
  const given = o.analyses?.length ? [...o.analyses] : split.analyses
  if (!given.length) throw new SpiceError('no analysis: give one (.op, .dc, .ac, .tran, .noise) in `analyses` or in the netlist')
  const { files, warnings } = modelFiles(o.models ?? [], !o.noConfigModels)
  let body = absoluteIncludes(split.body.trimEnd(), o.baseDir ?? process.cwd())
  for (const f of files) if (!body.includes(f)) body += `\n.include ${f}`
  for (const [k, v] of Object.entries(o.params ?? {})) {
    if (!new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(split.body)) {
      throw new SpiceError(`parameter ${k} does not appear in the netlist`)
    }
    body += `\n.param ${k}=${v}`
  }
  if (o.options) body += `\n.options ${o.options}`
  const save = (o.save ?? []).join(' ')
  const ctl = ['.control', 'set filetype=ascii', 'set noaskquit']
  const runs: { analysis: string; kind: AnalysisKind; file: string }[] = []
  const seen = new Map<string, number>()
  const label = (k: string): string => {
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n === 1 ? k : `${k}_${n}`
  }
  given.forEach((a, i) => {
    const { kind, cmd } = analysisCommand(a)
    ctl.push(cmd)
    if (kind === 'noise') {
      const tot = label('noise_total')
      const spec = label('noise')
      ctl.push(`write r${i}t.raw all`, 'setplot previous', `write r${i}.raw all`)
      runs.push({ analysis: spec, kind: 'noise', file: `r${i}.raw` }, { analysis: tot, kind: 'noise_total', file: `r${i}t.raw` })
    } else {
      ctl.push(`write r${i}.raw ${save || 'all'}`)
      runs.push({ analysis: label(kind), kind, file: `r${i}.raw` })
    }
  })
  ctl.push('quit', '.endc')
  // SPICE reads the first line as the title; a netlist starting with a directive or a blank line gets one
  const head = body.split('\n')[0]?.trim() ?? ''
  const title = head && !head.startsWith('.') ? '' : 'trace simulation\n'
  return { deck: `${title}${body}\n${ctl.join('\n')}\n.end\n`, runs, warnings }
}

/** Run ngspice on a netlist; throws SpiceError (with the log) when it fails. */
export async function simulate(o: SimulateOptions): Promise<SpiceRun> {
  const exe = ngspice()
  if (!exe) throw new SpiceError('ngspice not found (install it: apt install ngspice / brew install ngspice; or set NGSPICE)')
  const { deck, runs, warnings } = buildDeck(o)
  const dir = scratchDir('trace-spice-')
  try {
    writeFileSync(join(dir, 'netlist.cir'), deck)
    const timeoutMs = o.timeoutMs ?? 300_000
    const p = await run(exe, ['-b', 'netlist.cir'], { cwd: dir, timeoutMs })
    const log = p.stdout + p.stderr
    if (p.timedOut) throw new SpiceError(`ngspice ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, log, deck)
    const fatal = FATAL.exec(log)
    if (fatal || p.code !== 0) throw new SpiceError(`ngspice failed: ${firstError(log)}`, log, deck)
    const plots: Plot[] = []
    const raw = new Map<string, string>()
    for (const r of runs) {
      const f = join(dir, r.file)
      if (!existsSync(f)) throw new SpiceError(`ngspice wrote no results for ${r.analysis}: ${firstError(log)}`, log, deck)
      const text = readFileSync(f, 'utf8')
      raw.set(r.analysis, text)
      const parsed = parseRaw(text)
      const pl = parsed[0]
      if (!pl) throw new SpiceError(`ngspice's ${r.analysis} results are empty: ${firstError(log)}`, log, deck)
      plots.push({ ...pl, analysis: r.analysis, kind: r.kind })
    }
    for (const line of log.split('\n')) if (/^\s*warning\b/i.test(line) && warnings.length < 20) warnings.push(line.trim().slice(0, 200))
    return { plots, netlist: deck, log, raw, warnings, ms: p.ms }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------------------------------- raw files

type ParsedPlot = Omit<Plot, 'analysis' | 'kind'> & { analysis: string; kind: AnalysisKind }

function kindOf(plotname: string): AnalysisKind {
  const p = plotname.toLowerCase()
  if (p.startsWith('operating')) return 'op'
  if (p.startsWith('dc')) return 'dc'
  if (p.startsWith('ac')) return 'ac'
  if (p.startsWith('transient')) return 'tran'
  if (p.startsWith('integrated noise')) return 'noise_total'
  if (p.includes('noise')) return 'noise'
  return 'op'
}

/**
 * An ngspice ASCII raw file (one or more plots) → plots. Each point's first value sits on the line with the point's
 * index; the others follow, one per line. Complex values are "re,im".
 */
export function parseRaw(text: string): ParsedPlot[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ParsedPlot[] = []
  let i = 0
  while (i < lines.length) {
    let plotname = ''
    let complex = false
    let npoints: number | null = null
    const names: string[] = []
    let binary = false
    // header
    for (; i < lines.length; i++) {
      const ln = lines[i] as string
      if (ln.startsWith('Plotname:')) plotname = ln.slice(9).trim()
      else if (ln.startsWith('Flags:')) complex = /complex/i.test(ln)
      else if (ln.startsWith('No. Points:')) npoints = Number(ln.slice(11).trim())
      else if (ln.startsWith('Variables:')) {
        i++
        while (i < lines.length && !/^(Values|Binary):/.test(lines[i] as string)) {
          const parts = (lines[i] as string).trim().split(/\s+/)
          if (parts.length >= 2) names.push((parts[1] as string).toLowerCase())
          i++
        }
        binary = (lines[i] ?? '').startsWith('Binary:')
        i++
        break
      }
    }
    if (!names.length) break
    if (binary) throw new SpiceError('the raw file is binary (expected ASCII: set filetype=ascii)')
    const nv = names.length
    const re: number[][] = names.map(() => [])
    const im: number[][] = names.map(() => [])
    let k = 0
    for (; i < lines.length; i++) {
      const s = (lines[i] as string).trim()
      if (!s) continue
      if (s.startsWith('Title:')) break
      const parts = s.split(/\s+/)
      const tok = (k % nv === 0 && parts.length >= 2 ? parts[1] : parts[parts.length - 1]) as string
      const col = k % nv
      if (complex) {
        const [a, b] = tok.split(',')
        re[col]?.push(Number(a))
        im[col]?.push(Number(b ?? 0))
      } else re[col]?.push(Number(tok))
      k++
      if (npoints !== null && k >= npoints * nv) {
        i++
        break
      }
    }
    const kind = kindOf(plotname)
    const vectors = new Map<string, number[]>()
    names.forEach((n, c) => {
      const r = re[c] as number[]
      if (!complex) {
        vectors.set(n, r)
        return
      }
      const m = im[c] as number[]
      if (c === 0) {
        vectors.set(n, r)
        return
      }
      const mag = r.map((v, j) => Math.hypot(v, m[j] ?? 0))
      vectors.set(n, mag)
      vectors.set(`${n}#db`, mag.map((v) => (v > 0 ? 20 * Math.log10(v) : -400)))
      vectors.set(`${n}#phase`, r.map((v, j) => (Math.atan2(m[j] ?? 0, v) * 180) / Math.PI))
      vectors.set(`${n}#re`, r)
      vectors.set(`${n}#im`, m)
    })
    const scale = kind === 'op' ? null : (names[0] ?? null)
    out.push({ analysis: kind, kind, plotname, complex, scale, points: (re[0] ?? []).length, vectors, names })
    while (i < lines.length && !(lines[i] as string).startsWith('Title:') && !(lines[i] as string).startsWith('Plotname:')) i++
  }
  return out
}

/** A vector of a plot by name: case-insensitive, and a bare node ("out") finds "v(out)". */
export function vectorOf(plot: Plot, name: string): number[] | undefined {
  const n = name.toLowerCase().trim()
  return plot.vectors.get(n) ?? plot.vectors.get(`v(${n})`) ?? (n.includes('#') ? plot.vectors.get(`v(${n.split('#')[0]})#${n.split('#')[1]}`) : undefined)
}

/** The operating point as {node voltages, branch currents}, from an op plot. */
export function opTable(plot: Plot, limit = 200): { voltages: Record<string, number>; currents: Record<string, number>; truncated: boolean } {
  const voltages: Record<string, number> = {}
  const currents: Record<string, number> = {}
  let n = 0
  for (const name of plot.names) {
    if (n >= limit) return { voltages, currents, truncated: true }
    const v = plot.vectors.get(name)?.[0]
    if (v === undefined) continue
    if (name.startsWith('i(') || name.endsWith('#branch') || name.startsWith('@')) currents[name] = v
    else voltages[name] = v
    n++
  }
  return { voltages, currents, truncated: false }
}
