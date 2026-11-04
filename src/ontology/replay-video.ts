/**
 * The replay as a film (docs/ontology-plan.md P8.5): the record's events (replay.ts journeyEvents) drawn one frame
 * each, headless, as SVG, which ffmpeg (built with librsvg, as trace's images are) rasterises and encodes. No browser:
 * the frames are drawn here, the same way on any machine.
 *
 *   storyboard(events, nodes, o)   the frames: a title, one per event (the graph as it stands after it, the event's
 *                                  node ringed, its caption and source), the record as it ends; each with how long it
 *                                  is shown, so the film lasts `seconds`
 *   concatList(frames)             ffmpeg's concat list for them
 *
 * Every node keeps one place for the whole film (a force layout of the graph as it ends, seeded by the node ids), so
 * nothing jumps as the graph grows.
 */
import { STAGE_NAMES, type StageId } from '../core/journey-catalog.js'
import type { JourneyEvent, ReplayStatus } from './replay.js'

export interface FilmNode { id: string; label: string }
export interface FilmOptions {
  /** the project, for the title */
  title: string
  seconds: number
  width: number
  height: number
}
export interface Frame { name: string; svg: string; seconds: number }

const C = { bg: '#ffffff', panel: '#f4f5f7', fg: '#111827', muted: '#6b7280', line: '#c3c7cf', primary: '#2563eb', verified: '#16a34a', failing: '#dc2626', waived: '#d97706' }
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const kindOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf(':')))

/** A string's hash in [0, 1): the layout's seed, so the same record always lays out the same way. */
function unit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 100_000) / 100_000
}

/** The graph's nodes and links as the record ends: every node an event names, each event's node linked to its links. */
export function finalGraph(events: readonly JourneyEvent[]): { nodes: string[]; links: [string, string][] } {
  const nodes = new Set<string>()
  const links = new Map<string, [string, string]>()
  for (const e of events) {
    if (!e.node) continue
    nodes.add(e.node)
    for (const l of e.links ?? []) {
      if (l === e.node) continue
      nodes.add(l)
      const k = [e.node, l].sort().join('|')
      if (!links.has(k)) links.set(k, [e.node, l])
    }
  }
  return { nodes: [...nodes], links: [...links.values()] }
}

/** A force layout (Fruchterman–Reingold) in the unit square, seeded by the node ids. */
export function layout(nodes: readonly string[], links: readonly [string, string][]): Map<string, { x: number; y: number }> {
  const n = nodes.length
  const p = nodes.map((id) => ({ x: 0.2 + 0.6 * unit(id), y: 0.2 + 0.6 * unit(`${id}#y`) }))
  if (n <= 1) return new Map(nodes.map((id) => [id, { x: 0.5, y: 0.5 }]))
  const index = new Map(nodes.map((id, i) => [id, i]))
  const k = Math.sqrt(1 / n) * 0.9
  let temp = 0.12
  for (let it = 0; it < 300; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[i]!.x - p[j]!.x || 1e-4
        const dy = p[i]!.y - p[j]!.y || 1e-4
        const dist = Math.max(1e-3, Math.hypot(dx, dy))
        const f = (k * k) / dist
        d[i]!.x += (dx / dist) * f; d[i]!.y += (dy / dist) * f
        d[j]!.x -= (dx / dist) * f; d[j]!.y -= (dy / dist) * f
      }
    }
    for (const [a, b] of links) {
      const i = index.get(a)!, j = index.get(b)!
      const dx = p[i]!.x - p[j]!.x, dy = p[i]!.y - p[j]!.y
      const dist = Math.max(1e-3, Math.hypot(dx, dy))
      const f = (dist * dist) / k
      d[i]!.x -= (dx / dist) * f; d[i]!.y -= (dy / dist) * f
      d[j]!.x += (dx / dist) * f; d[j]!.y += (dy / dist) * f
    }
    for (let i = 0; i < n; i++) {
      // a pull to the middle keeps parts that do not link from drifting off
      d[i]!.x += (0.5 - p[i]!.x) * k * 2
      d[i]!.y += (0.5 - p[i]!.y) * k * 2
      const m = Math.max(1e-6, Math.hypot(d[i]!.x, d[i]!.y))
      p[i]!.x += (d[i]!.x / m) * Math.min(m, temp)
      p[i]!.y += (d[i]!.y / m) * Math.min(m, temp)
    }
    temp *= 0.985
  }
  // into the unit square
  const xs = p.map((q) => q.x), ys = p.map((q) => q.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return new Map(nodes.map((id, i) => [id, { x: (p[i]!.x - x0) / Math.max(1e-6, x1 - x0), y: (p[i]!.y - y0) / Math.max(1e-6, y1 - y0) }]))
}

/** A node's outline: its kind's shape, centred on (x, y). */
function shape(kind: string, x: number, y: number, r: number, attrs: string): string {
  const poly = (pts: [number, number][]) => `<polygon points="${pts.map(([a, b]) => `${(x + a * r).toFixed(1)},${(y + b * r).toFixed(1)}`).join(' ')}" ${attrs}/>`
  switch (kind) {
    case 'gate': return poly([[-0.41, -1], [0.41, -1], [1, -0.41], [1, 0.41], [0.41, 1], [-0.41, 1], [-1, 0.41], [-1, -0.41]])
    case 'criterion': case 'run': case 'test': return poly([[0, -1], [1, 0], [0, 1], [-1, 0]])
    case 'decision': case 'waiver': return poly([[0, -1], [0.95, 0.8], [-0.95, 0.8]])
    case 'block': case 'intent': case 'case': return `<rect x="${(x - r * 1.2).toFixed(1)}" y="${(y - r * 0.8).toFixed(1)}" width="${(r * 2.4).toFixed(1)}" height="${(r * 1.6).toFixed(1)}" rx="${(r * 0.3).toFixed(1)}" ${attrs}/>`
    case 'part': return poly([[-0.5, -0.87], [0.5, -0.87], [1, 0], [0.5, 0.87], [-0.5, 0.87], [-1, 0]])
    default: return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" ${attrs}/>`
  }
}

const stroke = (s: ReplayStatus | undefined): string => (s === 'verified' ? C.verified : s === 'failing' ? C.failing : s === 'waived' || s === 'inactive' ? C.waived : C.muted)

/** The frames of the film. */
export function storyboard(events: readonly JourneyEvent[], labels: ReadonlyMap<string, string>, o: FilmOptions): Frame[] {
  const { width: W, height: H } = o
  const g = finalGraph(events)
  const at = layout(g.nodes, g.links)
  const top = 92, bottom = 120, side = 70
  const px = (id: string) => {
    const q = at.get(id) ?? { x: 0.5, y: 0.5 }
    return { x: side + q.x * (W - 2 * side), y: top + 20 + q.y * (H - top - bottom - 40) }
  }
  const r = Math.max(7, Math.min(18, Math.round(Math.min(W, H) / Math.max(30, g.nodes.length * 0.9))))
  const font = 'Inter, DejaVu Sans, sans-serif'
  const stages = [...new Set(events.map((e) => e.stage).filter((s): s is StageId => !!s))]
  const t0 = events[0]?.t ?? 0, t1 = events.at(-1)?.t ?? 0
  const when = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

  const frame = (upTo: number, title: string | null): string => {
    const shown = new Map<string, ReplayStatus | undefined>()
    const lines = new Set<string>()
    for (const e of events.slice(0, upTo)) {
      if (!e.node) continue
      shown.set(e.node, e.status ?? shown.get(e.node))
      for (const l of e.links ?? []) {
        if (l === e.node) continue
        if (!shown.has(l)) shown.set(l, undefined)
        lines.add([e.node, l].sort().join('|'))
      }
    }
    const cur = upTo > 0 ? events[upTo - 1] : undefined
    const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="${C.bg}"/>`]
    // the header: the project, the stage chips, the time and a progress bar
    out.push(`<text x="32" y="44" font-family="${font}" font-size="22" font-weight="600" fill="${C.fg}">${esc(cut(o.title, 60))}</text>`)
    let cx = 32
    for (const s of stages) {
      const name = STAGE_NAMES[s] ?? s
      const w = name.length * 7.4 + 22
      const on = cur?.stage === s
      out.push(`<rect x="${cx}" y="58" width="${w.toFixed(0)}" height="22" rx="11" fill="${on ? C.primary : C.bg}" stroke="${on ? C.primary : C.line}"/>`)
      out.push(`<text x="${(cx + w / 2).toFixed(0)}" y="73" text-anchor="middle" font-family="${font}" font-size="12" fill="${on ? '#ffffff' : C.fg}">${esc(name)}</text>`)
      cx += w + 8
    }
    if (cur) out.push(`<text x="${W - 32}" y="44" text-anchor="end" font-family="${font}" font-size="14" fill="${C.muted}">${esc(when(cur.t))}</text>`)
    const done = t1 > t0 && cur ? (cur.t - t0) / (t1 - t0) : upTo >= events.length ? 1 : 0
    out.push(`<rect x="0" y="${H - 6}" width="${W}" height="6" fill="${C.panel}"/><rect x="0" y="${H - 6}" width="${(W * done).toFixed(1)}" height="6" fill="${C.primary}"/>`)
    // the graph
    for (const k of lines) {
      const [a, b] = k.split('|') as [string, string]
      const p = px(a), q = px(b)
      const hot = cur?.node && (a === cur.node || b === cur.node)
      out.push(`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${hot ? C.primary : C.line}" stroke-width="${hot ? 2 : 1.2}"/>`)
    }
    for (const [id, st] of shown) {
      const p = px(id)
      const kind = kindOf(id)
      const isCur = cur?.node === id
      if (isCur) out.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r * 1.9).toFixed(1)}" fill="${C.primary}" fill-opacity="0.12"/>`)
      out.push(shape(kind, p.x, p.y, kind === 'person' ? r * 0.8 : r, `fill="${C.bg}" stroke="${isCur ? C.primary : stroke(st)}" stroke-width="${isCur ? 3 : 2}"${st === 'waived' ? ' stroke-dasharray="4 3"' : ''}`))
      out.push(`<text x="${p.x.toFixed(1)}" y="${(p.y + r + 14).toFixed(1)}" text-anchor="middle" font-family="${font}" font-size="11" fill="${C.fg}"${isCur ? ' font-weight="600"' : ''}>${esc(cut(labels.get(id) ?? id.slice(id.indexOf(':') + 1), 26))}</text>`)
    }
    // the caption: who did what, from which record
    out.push(`<rect x="24" y="${H - bottom + 14}" width="${W - 48}" height="${bottom - 36}" rx="10" fill="${C.panel}"/>`)
    if (title) {
      out.push(`<text x="44" y="${H - bottom + 52}" font-family="${font}" font-size="20" font-weight="600" fill="${C.fg}">${esc(cut(title, 90))}</text>`)
      out.push(`<text x="44" y="${H - bottom + 76}" font-family="${font}" font-size="13" fill="${C.muted}">${esc(events.length ? `${when(t0)} – ${when(t1)} · ${events.length} records` : 'Nothing recorded yet')}</text>`)
    } else if (cur) {
      out.push(`<text x="44" y="${H - bottom + 50}" font-family="${font}" font-size="18" fill="${C.fg}">${esc(cut(cur.caption, Math.floor((W - 90) / 9.5)))}</text>`)
      out.push(`<text x="44" y="${H - bottom + 74}" font-family="${font}" font-size="12" fill="${C.muted}">${esc([cur.who ? `by ${cur.who}` : null, `from ${cur.source}`, cur.class].filter(Boolean).join(' · '))}</text>`)
    }
    out.push('</svg>')
    return out.join('\n')
  }

  const ends = Math.min(3, o.seconds * 0.1)
  const each = Math.max(1 / 30, (o.seconds - 2 * ends) / Math.max(1, events.length))
  const frames: Frame[] = [{ name: 'f_00000.svg', svg: frame(0, `Replay · ${o.title}`), seconds: ends }]
  events.forEach((_e, i) => frames.push({ name: `f_${String(i + 1).padStart(5, '0')}.svg`, svg: frame(i + 1, null), seconds: each }))
  frames.push({ name: `f_${String(events.length + 1).padStart(5, '0')}.svg`, svg: frame(events.length, `${o.title}: the record as it stands`), seconds: ends })
  return frames
}

/** ffmpeg's concat list for the frames (the last named twice, as the concat demuxer wants, so its time counts). */
export function concatList(frames: readonly Frame[]): string {
  const lines = frames.flatMap((f) => [`file '${f.name}'`, `duration ${f.seconds.toFixed(4)}`])
  if (frames.length) lines.push(`file '${frames.at(-1)!.name}'`)
  return `${lines.join('\n')}\n`
}

/** ffmpeg's arguments: the frames in `list` at `fps`, an H.264 MP4 to `out`. */
export const filmArgs = (list: string, fps: number, out: string): string[] => [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
  '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', out,
]
