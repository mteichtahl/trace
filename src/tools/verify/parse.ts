/**
 * Readers for what the verification programs write: Verilator's messages and coverage.dat, cocotb's results.xml, and
 * the logs of yosys-smtbmc and SymbiYosys. Pure functions, so they are tested on captured output.
 */
import { childrenNamed, descendants, parseXml, type XmlElement } from '../kicad/xml.js'

// ------------------------------------------------------------------ verilator messages

export interface VMessage {
  severity: 'error' | 'warning' | 'info'
  code: string | null
  file: string | null
  line: number | null
  col: number | null
  text: string
}

/** `%Warning-WIDTHEXPAND: file.v:32:28: Operator ...` and `%Error: file.v:3:1: ...` lines (continuations dropped). */
export function verilatorMessages(log: string): VMessage[] {
  const out: VMessage[] = []
  for (const line of log.split('\n')) {
    const m = /^%(Error|Warning|Info)(?:-([A-Z0-9_]+))?:\s*(?:(\S+?):(\d+)(?::(\d+))?:\s*)?(.*)$/.exec(line)
    if (!m) continue
    const text = (m[6] ?? '').trim()
    if (m[1] === 'Error' && /^Exiting due to/.test(text)) continue
    out.push({
      severity: (m[1] as string).toLowerCase() as VMessage['severity'], code: m[2] ?? null, file: m[3] ?? null,
      line: m[4] ? Number(m[4]) : null, col: m[5] ? Number(m[5]) : null, text,
    })
  }
  return out
}

// ------------------------------------------------------------------ verilator coverage.dat

export type CovKind = 'line' | 'toggle' | 'branch' | 'expr' | 'user' | 'other'

export interface CovPoint {
  kind: CovKind
  file: string
  line: number
  column: number
  /** the point's comment: the signal for toggle, the cover name for user points, "if"/"else"/"block" for lines */
  comment: string
  hier: string
  count: number
}

/**
 * coverage.dat (SystemC::Coverage-3): one `C '<key>\x02<value>\x01…' <count>` line per point, with keys f (file),
 * l (line), n (column), page (v_line/<module>, v_toggle/…, v_branch/…, v_user/…), o (comment), h (hierarchy).
 */
export function parseCoverageDat(text: string): CovPoint[] {
  const out: CovPoint[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('C ')) continue
    const m = /^C '(.*)' (\d+)\s*$/.exec(line)
    if (!m) continue
    const kv = new Map<string, string>()
    for (const part of (m[1] as string).split('\x01')) {
      if (!part) continue
      const i = part.indexOf('\x02')
      if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1))
    }
    const page = kv.get('page') ?? ''
    const pk = /^v_([a-z]+)/.exec(page)?.[1] ?? ''
    const kind: CovKind = pk === 'line' ? 'line' : pk === 'toggle' ? 'toggle' : pk === 'branch' ? 'branch' : pk === 'expr' ? 'expr' : pk === 'user' ? 'user' : 'other'
    out.push({
      kind, file: kv.get('f') ?? '', line: Number(kv.get('l') ?? 0), column: Number(kv.get('n') ?? 0),
      comment: kv.get('o') ?? '', hier: kv.get('h') ?? '', count: Number(m[2]),
    })
  }
  return out
}

const pointKey = (p: CovPoint): string => `${p.kind}|${p.file}|${p.line}|${p.column}|${p.comment}|${p.hier}`

/** Several runs' points as one set: the same point (kind, file, line, column, comment, hierarchy) adds its counts. */
export function mergeCoverage(sets: readonly CovPoint[][]): CovPoint[] {
  const m = new Map<string, CovPoint>()
  for (const set of sets) {
    for (const p of set) {
      const k = pointKey(p)
      const cur = m.get(k)
      if (cur) cur.count += p.count
      else m.set(k, { ...p })
    }
  }
  return [...m.values()]
}

export interface CovSummary {
  kind: CovKind
  covered: number
  total: number
  percent: number | null
}

/** Covered/total per kind, and per file, ignoring files matched by `exclude` (testbenches, say). */
export function summarizeCoverage(points: readonly CovPoint[], opts: { exclude?: RegExp; minHits?: number } = {}): {
  by_kind: CovSummary[]
  by_file: { file: string; by_kind: CovSummary[] }[]
  uncovered: { kind: CovKind; file: string; line: number; comment: string; hier: string }[]
} {
  const min = opts.minHits ?? 1
  const keep = points.filter((p) => !opts.exclude || !opts.exclude.test(p.file))
  const sum = (ps: readonly CovPoint[]): CovSummary[] => {
    const by = new Map<CovKind, { c: number; t: number }>()
    for (const p of ps) {
      const e = by.get(p.kind) ?? by.set(p.kind, { c: 0, t: 0 }).get(p.kind) as { c: number; t: number }
      e.t++
      if (p.count >= min) e.c++
    }
    return [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, e]) => ({ kind, covered: e.c, total: e.t, percent: e.t ? Math.round((1000 * e.c) / e.t) / 10 : null }))
  }
  const files = [...new Set(keep.map((p) => p.file))].sort()
  return {
    by_kind: sum(keep),
    by_file: files.map((file) => ({ file, by_kind: sum(keep.filter((p) => p.file === file)) })),
    uncovered: keep.filter((p) => p.count < min).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((p) => ({ kind: p.kind, file: p.file, line: p.line, comment: p.comment, hier: p.hier })),
  }
}

// ------------------------------------------------------------------ cocotb results.xml

export interface CocotbCase {
  name: string
  classname: string
  status: 'pass' | 'fail' | 'skip' | 'error'
  message: string | null
  sim_time_ns: number | null
  seconds: number | null
}

/** JUnit-style results.xml as cocotb writes it: <testsuites><testsuite><testcase> with <failure>/<error>/<skipped>. */
export function parseCocotbResults(xml: string): CocotbCase[] {
  const root: XmlElement = parseXml(xml)
  const out: CocotbCase[] = []
  for (const tc of root.name === 'testcase' ? [root] : descendants(root, 'testcase')) {
    const failure = childrenNamed(tc, 'failure')[0]
    const error = childrenNamed(tc, 'error')[0]
    const skipped = childrenNamed(tc, 'skipped')[0]
    const props = new Map(descendants(tc, 'property').map((p) => [p.attrs.name ?? '', p.attrs.value ?? '']))
    const unit = props.get('sim_time_unit') ?? 'ns'
    const scale = ({ fs: 1e-6, ps: 1e-3, ns: 1, us: 1e3, ms: 1e6, s: 1e9 } as Record<string, number>)[unit] ?? 1
    const dur = props.get('sim_time_duration')
    const status: CocotbCase['status'] = failure ? 'fail' : error ? 'error' : skipped ? 'skip' : 'pass'
    const msgEl = failure ?? error ?? skipped
    out.push({
      name: tc.attrs.name ?? '?', classname: tc.attrs.classname ?? '', status,
      message: msgEl ? (msgEl.attrs.message ?? msgEl.text.trim().split('\n').slice(-3).join(' ')).slice(0, 500) || null : null,
      sim_time_ns: dur !== undefined && dur !== '' && Number.isFinite(Number(dur)) ? Number(dur) * scale : null,
      seconds: tc.attrs.time !== undefined ? Number(tc.attrs.time) : null,
    })
  }
  return out
}

// ------------------------------------------------------------------ formal: yosys-smtbmc and sby

export interface FormalFinding {
  kind: 'assert_failed' | 'cover_reached' | 'cover_unreached' | 'assume_failed' | 'induction_failed'
  name: string | null
  location: string | null
  step: number | null
}

export interface FormalLog {
  /** PASS (proved / no failure to the depth / every cover reached), FAIL, UNKNOWN, ERROR or TIMEOUT */
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR' | 'TIMEOUT' | null
  findings: FormalFinding[]
  /** trace files the log says were written (relative to where the program ran) */
  traces: string[]
  steps: number | null
}

/** file.sv:25.51-26.45 (a source location) rather than a property's label. */
const isLoc = (s: string): boolean => /:\d+(\.\d+)?(-\d+(\.\d+)?)?$/.test(s)

/** yosys-smtbmc's output: "Status: PASSED|FAILED", "Assert failed in <mod>: <loc> (<name>)", "Reached cover statement
 * at <loc> (<name>) in step N.", "Unreached cover statement at …", "Writing trace to VCD file: <f>". */
export function parseSmtbmc(log: string): FormalLog {
  const findings: FormalFinding[] = []
  const traces: string[] = []
  let status: FormalLog['status'] = null
  let steps: number | null = null
  let induction = false
  for (const raw of log.split('\n')) {
    const line = raw.replace(/^.*?##\s+\d+:\d+:\d+\s+/, '').trim()
    let m: RegExpExecArray | null
    if ((m = /^Status: (PASSED|FAILED|passed|failed)/.exec(line))) status = /pass/i.test(m[1] as string) ? 'PASS' : 'FAIL'
    else if (/^Temporal induction failed/.test(line)) induction = true
    else if ((m = /^Assert failed in (\S+?):\s*(\S+)(?:\s+\((.+)\))?\.?$/.exec(line))) {
      // a labelled assertion prints its label where the location goes
      const loc = m[2] as string
      findings.push({ kind: induction ? 'induction_failed' : 'assert_failed', name: m[3] ?? (isLoc(loc) ? m[1] ?? null : loc), location: isLoc(loc) ? loc : null, step: null })
    } else if ((m = /^Assumptions are unsatisfiable!?/.exec(line))) findings.push({ kind: 'assume_failed', name: null, location: null, step: null })
    else if ((m = /^Reached cover statement (?:in \S+ )?at (\S+?)(?:\s+\((.+?)\))? in step (\d+)/.exec(line))) {
      const loc = m[1] as string
      findings.push({ kind: 'cover_reached', name: m[2] ?? (isLoc(loc) ? null : loc), location: isLoc(loc) ? loc : null, step: Number(m[3]) })
    } else if ((m = /^Unreached cover statement (?:in \S+ )?at (\S+?)(?:\s+\((.+?)\))?\.?$/.exec(line))) {
      const loc = m[1] as string
      findings.push({ kind: 'cover_unreached', name: m[2] ?? (isLoc(loc) ? null : loc), location: isLoc(loc) ? loc : null, step: null })
    } else if ((m = /^Writing trace to (?:VCD|Yosys witness) file: (\S+)/.exec(line))) traces.push(m[1] as string)
    else if ((m = /^Checking (?:assertions|assumptions|cover reachability) in step (\d+)/.exec(line)) || (m = /^Trying induction in step (\d+)/.exec(line))) {
      steps = Math.max(steps ?? 0, Number(m[1]))
    }
  }
  // a failed assertion seen in the step after "BMC failed" carries its step from the trace; smtbmc prints no step there
  return { status, findings, traces, steps }
}

/** SymbiYosys's log (logfile.txt or its stdout): "DONE (PASS, rc=0)", the engine lines (smtbmc's own messages, as
 * above, prefixed by "engine_N: "), and the summary lines (counterexample trace, failed assertion … in step N,
 * reached cover statement … in step N). */
export function parseSby(log: string): FormalLog {
  const engine = parseSmtbmc(log.split('\n').map((l) => l.replace(/^SBY\s+[\d:]+\s+\[[^\]]*\]\s+engine_\d+(?:\.\w+)?:\s*/, '')).join('\n'))
  let status: FormalLog['status'] = null
  const findings: FormalFinding[] = []
  const traces: string[] = []
  for (const line of log.split('\n')) {
    let m: RegExpExecArray | null
    if ((m = /DONE \((PASS|FAIL|UNKNOWN|ERROR|TIMEOUT)\b/.exec(line))) status = m[1] as FormalLog['status']
    else if ((m = /summary:\s+(?:counterexample|cover|failing|witness)?\s*trace(?:\s+\w+)?:\s+(\S+)/.exec(line))) traces.push(m[1] as string)
    else if ((m = /summary:\s+failed assertion (\S+) at (\S+)(?: in step (\d+))?/.exec(line))) findings.push({ kind: 'assert_failed', name: m[1] ?? null, location: m[2] ?? null, step: m[3] ? Number(m[3]) : null })
    else if ((m = /summary:\s+reached cover statement (\S+) at (\S+)(?: in step (\d+))?/.exec(line))) findings.push({ kind: 'cover_reached', name: m[1] ?? null, location: m[2] ?? null, step: m[3] ? Number(m[3]) : null })
    else if ((m = /summary:\s+unreached cover statement (\S+) at (\S+)/.exec(line))) findings.push({ kind: 'cover_unreached', name: m[1] ?? null, location: m[2] ?? null, step: null })
  }
  return {
    status: status ?? engine.status,
    findings: findings.length ? findings : engine.findings,
    traces: [...new Set([...traces, ...engine.traces])],
    steps: engine.steps,
  }
}
