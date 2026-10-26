/**
 * Timing diagrams: signal lanes (one-bit waves, buses as hexagons with their values), decoded-protocol rows (START,
 * ADDR 0x50 W, ACK, DATA ...), measurement arrows between two events with a label (measured value against its
 * limit, green when it passes, red when it fails, grey with no verdict), time cursors and a time axis. Written as SVG
 * by hand (no dependency), as WaveDrom JSON (sampled on a fixed tick, so approximate), and as PNG when a rasteriser
 * is on the machine (resvg or rsvg-convert on PATH, or the sharp module); otherwise the PNG is skipped and the
 * result says so.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Annotation, AnnotationKind } from './waveform.js'

const run = promisify(execFile)

export interface Lane { name: string; width: number; changes: readonly (readonly [number, string])[] }
export interface Arrow { t0: number; t1: number; from?: string | undefined; to?: string | undefined; label: string; pass: boolean | null }
export interface Cursor { t: number; label: string }
export interface Panel { title: string; lanes: Lane[]; decode: Annotation[]; arrows: Arrow[]; cursors: Cursor[]; from: number; to: number }

const C = {
  bg: '#ffffff', text: '#1f2328', muted: '#57606a', grid: '#d0d7de', wave: '#0b5cad', x: '#cf222e', z: '#8250df',
  pass: '#1a7f37', fail: '#cf222e', none: '#6e7781', cursor: '#9a6700',
}
const FILL: Readonly<Record<AnnotationKind, string>> = {
  start: '#dafbe1', restart: '#dafbe1', stop: '#dafbe1', addr: '#ddf4ff', data: '#f6f8fa', ack: '#dafbe1', nack: '#ffebe9',
  frame: 'none', field: '#fff8c5', idle: '#f6f8fa', error: '#ffebe9', info: '#fff8c5',
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Seconds in engineering units: 1.25e-7 → "125 ns". */
export function eng(t: number, unit = 's'): string {
  if (!Number.isFinite(t)) return String(t)
  if (t === 0) return `0 ${unit}`
  const a = Math.abs(t)
  const steps: [number, string][] = [[1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']]
  const big: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']]
  for (const [m, p] of big) if (a >= m) return `${Number((t / m).toPrecision(4))} ${p}${unit}`
  for (const [m, p] of steps) if (a >= m * 0.9995) return `${Number((t / m).toPrecision(4))} ${p}${unit}`
  return `${t.toExponential(3)} ${unit}`
}

function niceStep(span: number, target = 10): number {
  const raw = span / target
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p
  return 10 * p
}

const fmtValue = (v: string, width: number): string => {
  if (/^[01]+$/.test(v) && width > 1) return `0x${BigInt(`0b${v}`).toString(16)}`
  return v
}

/** One panel as an SVG group, with its height. */
function panelSvg(p: Panel, width: number, y0: number): { svg: string; height: number } {
  const left = 120
  const right = 16
  const plotW = width - left - right
  const span = Math.max(p.to - p.from, 1e-15)
  const X = (t: number): number => left + ((Math.min(Math.max(t, p.from), p.to) - p.from) / span) * plotW
  const out: string[] = []
  let y = y0
  out.push(`<text x="8" y="${y + 16}" font-size="14" font-weight="600" fill="${C.text}">${esc(p.title)}</text>`)
  y += 26
  // axis
  const step = niceStep(span)
  const first = Math.ceil(p.from / step) * step
  const axisY = y + 14
  out.push(`<line x1="${left}" y1="${axisY}" x2="${left + plotW}" y2="${axisY}" stroke="${C.grid}"/>`)
  const ticks: number[] = []
  for (let t = first; t <= p.to + step * 1e-9; t += step) ticks.push(t)
  for (const t of ticks) out.push(`<line x1="${X(t).toFixed(1)}" y1="${axisY - 4}" x2="${X(t).toFixed(1)}" y2="${axisY}" stroke="${C.muted}"/><text x="${X(t).toFixed(1)}" y="${axisY - 6}" font-size="10" text-anchor="middle" fill="${C.muted}">${esc(eng(t))}</text>`)
  y = axisY + 6
  const gridTop = y
  const laneY = new Map<string, number>()
  const laneH = 34
  for (const lane of p.lanes) {
    const top = y + 4
    const hi = top + 4
    const lo = top + 24
    const mid = (hi + lo) / 2
    laneY.set(lane.name, mid)
    out.push(`<text x="${left - 8}" y="${mid + 4}" font-size="12" text-anchor="end" fill="${C.text}" font-family="monospace">${esc(lane.name)}</text>`)
    const segs: [number, number, string][] = []
    const ch = lane.changes
    for (let k = 0; k < ch.length; k++) {
      const [t, v] = ch[k] as [number, string]
      const t1 = (ch[k + 1] as [number, string] | undefined)?.[0] ?? Infinity
      if (t1 <= p.from || t >= p.to) continue
      segs.push([Math.max(t, p.from), Math.min(t1, p.to), v])
    }
    if (lane.width === 1) {
      let path = ''
      let prevY: number | null = null
      for (const [a, b, v] of segs) {
        const xa = X(a)
        const xb = X(b)
        if (v === 'x') {
          out.push(`<rect x="${xa.toFixed(1)}" y="${hi}" width="${Math.max(0.5, xb - xa).toFixed(1)}" height="${lo - hi}" fill="${C.x}" fill-opacity="0.18" stroke="${C.x}" stroke-width="0.8"/>`)
          prevY = null
          continue
        }
        if (v === 'z') {
          out.push(`<line x1="${xa.toFixed(1)}" y1="${mid}" x2="${xb.toFixed(1)}" y2="${mid}" stroke="${C.z}" stroke-dasharray="4 3"/>`)
          prevY = null
          continue
        }
        const yy = v === '1' ? hi : lo
        path += prevY === null ? `M${xa.toFixed(1)},${yy}` : `L${xa.toFixed(1)},${prevY}L${xa.toFixed(1)},${yy}`
        path += `L${xb.toFixed(1)},${yy}`
        prevY = yy
      }
      if (path) out.push(`<path d="${path}" fill="none" stroke="${C.wave}" stroke-width="1.5"/>`)
    } else {
      for (const [a, b, v] of segs) {
        const xa = X(a)
        const xb = X(b)
        const s = Math.min(4, (xb - xa) / 2)
        const fill = v.includes('x') ? C.x : v.includes('z') ? C.z : C.wave
        out.push(`<path d="M${xa.toFixed(1)},${mid}L${(xa + s).toFixed(1)},${hi}L${(xb - s).toFixed(1)},${hi}L${xb.toFixed(1)},${mid}L${(xb - s).toFixed(1)},${lo}L${(xa + s).toFixed(1)},${lo}Z" fill="${fill}" fill-opacity="0.08" stroke="${fill}" stroke-width="1.2"/>`)
        const label = fmtValue(v, lane.width)
        if (xb - xa > label.length * 6.5 + 6) out.push(`<text x="${((xa + xb) / 2).toFixed(1)}" y="${mid + 4}" font-size="10" text-anchor="middle" fill="${C.text}" font-family="monospace">${esc(label)}</text>`)
      }
    }
    y += laneH
  }
  // decoded rows, one per lane name of the annotations
  const rows = [...new Set(p.decode.map((d) => d.lane))]
  for (const r of rows) {
    const top = y + 4
    out.push(`<text x="${left - 8}" y="${top + 14}" font-size="11" text-anchor="end" fill="${C.muted}">${esc(r)}</text>`)
    for (const d of p.decode.filter((x) => x.lane === r && x.t1 >= p.from && x.t0 <= p.to)) {
      const xa = X(d.t0)
      const xb = Math.max(X(d.t1), xa + 2)
      const fill = FILL[d.kind]
      const stroke = d.kind === 'nack' || d.kind === 'error' ? C.fail : d.kind === 'frame' ? C.muted : C.grid
      out.push(`<rect x="${xa.toFixed(1)}" y="${top}" width="${(xb - xa).toFixed(1)}" height="18" rx="3" fill="${fill}" stroke="${stroke}"${d.kind === 'frame' ? ' stroke-dasharray="3 2"' : ''}/>`)
      if (xb - xa > d.label.length * 5.6 + 4) out.push(`<text x="${((xa + xb) / 2).toFixed(1)}" y="${top + 13}" font-size="10" text-anchor="middle" fill="${C.text}">${esc(d.label)}</text>`)
    }
    y += 26
  }
  const gridBottom = y
  // arrows: packed into rows below the lanes, each with guides up to the signals it is measured between
  const visible = p.arrows.filter((a) => a.t1 >= p.from && a.t0 <= p.to)
  const rowsEnd: number[] = []
  for (const a of visible) {
    const xa = X(a.t0)
    const xb = X(a.t1)
    const need = Math.max(xb, xa + a.label.length * 6 + 10)
    let r = rowsEnd.findIndex((e) => e < xa - 4)
    if (r < 0) { r = rowsEnd.length; rowsEnd.push(0) }
    rowsEnd[r] = need
    const ay = gridBottom + 14 + r * 24
    const col = a.pass === true ? C.pass : a.pass === false ? C.fail : C.none
    const g0 = laneY.get(a.from ?? '') ?? gridTop
    const g1 = laneY.get(a.to ?? '') ?? gridTop
    out.push(`<line x1="${xa.toFixed(1)}" y1="${g0}" x2="${xa.toFixed(1)}" y2="${ay}" stroke="${col}" stroke-width="0.8" stroke-dasharray="2 2"/>`)
    out.push(`<line x1="${xb.toFixed(1)}" y1="${g1}" x2="${xb.toFixed(1)}" y2="${ay}" stroke="${col}" stroke-width="0.8" stroke-dasharray="2 2"/>`)
    out.push(`<line x1="${xa.toFixed(1)}" y1="${ay}" x2="${xb.toFixed(1)}" y2="${ay}" stroke="${col}" stroke-width="1.4" marker-start="url(#arr-${a.pass === true ? 'p' : a.pass === false ? 'f' : 'n'})" marker-end="url(#arr-${a.pass === true ? 'p' : a.pass === false ? 'f' : 'n'})"/>`)
    out.push(`<text x="${(Math.max(xb, xa) + 4).toFixed(1)}" y="${ay + 4}" font-size="10" fill="${col}">${esc(a.label)}</text>`)
  }
  y = gridBottom + (rowsEnd.length ? 14 + rowsEnd.length * 24 : 0)
  for (const c of p.cursors.filter((x) => x.t >= p.from && x.t <= p.to)) {
    out.push(`<line x1="${X(c.t).toFixed(1)}" y1="${gridTop}" x2="${X(c.t).toFixed(1)}" y2="${y}" stroke="${C.cursor}" stroke-dasharray="5 3"/><text x="${(X(c.t) + 3).toFixed(1)}" y="${gridTop + 10}" font-size="10" fill="${C.cursor}">${esc(c.label)}</text>`)
  }
  return { svg: out.join('\n'), height: y - y0 + 10 }
}

/** Panels stacked in one SVG (one for a diagram; measured over spec for a comparison). */
export function renderSvg(panels: readonly Panel[], width = 1200): string {
  const parts: string[] = []
  let y = 8
  for (const p of panels) {
    const r = panelSvg(p, width, y)
    parts.push(r.svg)
    y += r.height + 12
  }
  const marker = (id: string, col: string): string => `<marker id="arr-${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${col}"/></marker>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(y)}" viewBox="0 0 ${width} ${Math.ceil(y)}" font-family="Helvetica, Arial, sans-serif">`,
    `<defs>${marker('p', C.pass)}${marker('f', C.fail)}${marker('n', C.none)}</defs>`,
    `<rect width="100%" height="100%" fill="${C.bg}"/>`,
    ...parts,
    '</svg>',
  ].join('\n')
}

/** WaveDrom JSON: each lane sampled at the middle of every tick; arrows as nodes and edges. */
export function wavedrom(p: Panel, maxTicks = 96): { json: Record<string, unknown>; tick: number } {
  const span = Math.max(p.to - p.from, 1e-15)
  // a tick no longer than the shortest stretch of time between changes, within maxTicks
  let shortest = span
  for (const l of p.lanes) {
    let last: number | null = null
    for (const [t] of l.changes) {
      if (t < p.from || t > p.to) continue
      if (last !== null && t - last > 0) shortest = Math.min(shortest, t - last)
      last = t
    }
  }
  const n = Math.max(4, Math.min(maxTicks, Math.ceil(span / Math.max(shortest, span / maxTicks))))
  const tick = span / n
  const at = (l: Lane, t: number): string => {
    let v = 'x'
    for (const [ti, vi] of l.changes) { if (ti > t) break; v = vi }
    return v
  }
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const nodes = new Map<string, string[]>(p.lanes.map((l) => [l.name, Array.from({ length: n }, () => '.')]))
  const edges: string[] = []
  let li = 0
  for (const a of p.arrows) {
    if (li + 2 > letters.length) break
    const i0 = Math.min(n - 1, Math.max(0, Math.round((a.t0 - p.from) / tick)))
    const i1 = Math.min(n - 1, Math.max(0, Math.round((a.t1 - p.from) / tick)))
    const l0 = nodes.get(a.from ?? '') ?? nodes.get(p.lanes[0]?.name ?? '')
    const l1 = nodes.get(a.to ?? '') ?? l0
    if (!l0 || !l1 || l0[i0] !== '.' || l1[i1] !== '.') continue
    const x = letters[li++] as string
    const y = letters[li++] as string
    l0[i0] = x
    l1[i1] = y
    edges.push(`${x}<->${y} ${a.label}`)
  }
  const signal = p.lanes.map((l) => {
    let wave = ''
    const data: string[] = []
    let prev: string | null = null
    for (let i = 0; i < n; i++) {
      const v = at(l, p.from + (i + 0.5) * tick)
      if (v === prev) { wave += '.'; continue }
      prev = v
      if (l.width > 1) {
        if (/^[01]+$/.test(v)) { wave += '='; data.push(fmtValue(v, l.width)) } else wave += v.includes('z') ? 'z' : 'x'
      } else wave += v === '1' || v === '0' || v === 'z' ? v : 'x'
    }
    const node = (nodes.get(l.name) ?? []).join('')
    return { name: l.name, wave, ...(data.length ? { data } : {}), ...(/[^.]/.test(node) ? { node } : {}) }
  })
  return { json: { signal, ...(edges.length ? { edge: edges } : {}), head: { text: p.title }, foot: { text: `${eng(p.from)} to ${eng(p.to)}, one tick = ${eng(tick)}` } }, tick }
}

/** SVG → PNG with what the machine has: resvg, rsvg-convert, or the sharp module. null and the reason when none. */
export async function rasterise(svg: string): Promise<{ png: Uint8Array | null; via: string | null; note?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-svg-'))
  try {
    const src = join(dir, 'in.svg')
    const dst = join(dir, 'out.png')
    writeFileSync(src, svg)
    for (const [cmd, args] of [['resvg', [src, dst]], ['rsvg-convert', ['-o', dst, src]]] as const) {
      try {
        await run(cmd, [...args], { timeout: 60_000 })
        return { png: new Uint8Array(readFileSync(dst)), via: cmd }
      } catch {
        /* not installed, or failed: try the next */
      }
    }
    try {
      const name = 'sharp'
      const mod = (await import(name)) as { default: (b: Buffer) => { png: () => { toBuffer: () => Promise<Buffer> } } }
      const buf = await mod.default(Buffer.from(svg)).png().toBuffer()
      return { png: new Uint8Array(buf), via: 'sharp' }
    } catch {
      return { png: null, via: null, note: 'no SVG rasteriser on this machine (resvg, rsvg-convert or the sharp module): PNG skipped, the SVG is stored' }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
