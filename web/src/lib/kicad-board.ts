/**
 * A KiCad board (.kicad_pcb, KiCad 6 and later) read into what the 3D board view draws: the outline and its cut-outs,
 * the thickness, the solder mask colour from the stackup, each footprint with its pads and silkscreen, the tracks, arcs,
 * vias, filled zones and board text. Everything stays in KiCad's own millimetres (x right, y down); the viewer turns
 * them into a scene. Pure and synchronous: the board's text in, a plain object out, so it is tested without a browser.
 *
 * What KiCad stores and how it is read here:
 *   footprint   (at x y rot) — rot in degrees, counter-clockwise as seen from the top. A pad's (at x y a) is in the
 *               footprint's frame (already mirrored for a footprint on the back); its angle `a` is the pad's own
 *               absolute angle on the board
 *   outline     Edge.Cuts lines, arcs, circles, rectangles and polygons, on the board or inside footprints, chained into
 *               closed loops; the loop enclosing the most area is the board, the others are cut-outs
 *   zones       their filled_polygon, as KiCad last filled them (a zone never filled has none and is not drawn)
 */

export type Xy = [number, number]
export type Side = 'F' | 'B'

export interface Pad {
  num: string
  /** smd, thru_hole, np_thru_hole, connect */
  type: string
  /** rect, roundrect, circle, oval, trapezoid, custom */
  shape: string
  /** the pad's centre on the board */
  at: Xy
  /** its own angle on the board, degrees */
  angle: number
  size: [number, number]
  /** round drill diameter, or the slot's [w, h] */
  drill: number | [number, number] | null
  /** which outer sides it has copper on */
  sides: Side[]
  roundness: number
  net: string | null
}

export interface Graphic {
  kind: 'line' | 'arc' | 'circle' | 'rect' | 'poly'
  layer: string
  pts: Xy[]
  width: number
  fill: boolean
}

export interface Text {
  text: string
  at: Xy
  angle: number
  size: number
  layer: string
  mirror: boolean
}

export interface Footprint {
  ref: string
  value: string
  /** the library footprint name without its library ("R_0603_1608Metric") */
  name: string
  lib: string
  at: Xy
  angle: number
  side: Side
  pads: Pad[]
  /** silkscreen, courtyard and fabrication drawings, on the board */
  graphics: Graphic[]
  texts: Text[]
  /** the 3D model KiCad names for it, if any */
  model: string | null
  /** through-hole, smd, board_only… (KiCad's attr) */
  attr: string[]
}

export interface Track { a: Xy; b: Xy; mid?: Xy; width: number; layer: string }
export interface Via { at: Xy; size: number; drill: number }
export interface Zone { layer: string; polys: Xy[][] }

export interface Board {
  thickness: number
  /** the board's outer edge, a closed loop */
  outline: Xy[]
  /** cut-outs inside it */
  cutouts: Xy[][]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** the solder mask colour the stackup names (KiCad's names: "Green", "Black"… or "#RRGGBBAA"), if any */
  maskColor: string | null
  silkColor: string | null
  /** the copper finish the stackup names ("ENIG", "HAL lead-free", "None"…), if any */
  copperFinish: string | null
  copperLayers: number
  footprints: Footprint[]
  tracks: Track[]
  vias: Via[]
  zones: Zone[]
  graphics: Graphic[]
  texts: Text[]
  /** said when something could not be read (an open outline, say), in words */
  notes: string[]
}

// ------------------------------------------------------------------ s-expressions

type Node = string | Node[]

/** Parse KiCad's s-expression text. Strings keep their contents (escapes undone); atoms stay strings. */
export function parseSexpr(text: string): Node {
  let i = 0
  const n = text.length
  const stack: Node[][] = []
  let root: Node | null = null
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 40) { // (
      const list: Node[] = []
      if (stack.length) stack[stack.length - 1]!.push(list)
      else root = list
      stack.push(list)
      i++
    } else if (c === 41) { // )
      stack.pop()
      i++
      if (!stack.length && root) break
    } else if (c === 34) { // "
      let j = i + 1
      let s = ''
      while (j < n) {
        const d = text[j]!
        if (d === '\\' && j + 1 < n) { const e = text[j + 1]!; s += e === 'n' ? '\n' : e; j += 2; continue }
        if (d === '"') break
        s += d
        j++
      }
      stack[stack.length - 1]?.push(s)
      i = j + 1
    } else if (c <= 32) {
      i++
    } else {
      let j = i
      while (j < n) { const d = text.charCodeAt(j); if (d <= 32 || d === 40 || d === 41) break; j++ }
      stack[stack.length - 1]?.push(text.slice(i, j))
      i = j
    }
  }
  if (!root) throw new Error('This is not a KiCad file: no opening bracket.')
  return root
}

const isList = (x: Node | undefined): x is Node[] => Array.isArray(x)
const head = (x: Node): string => (isList(x) && typeof x[0] === 'string' ? x[0] : '')
const kids = (x: Node[], name: string): Node[][] => x.filter((k): k is Node[] => isList(k) && k[0] === name)
const kid = (x: Node[], name: string): Node[] | undefined => kids(x, name)[0]
const num = (x: Node | undefined, d = 0): number => { const v = typeof x === 'string' ? Number(x) : NaN; return Number.isFinite(v) ? v : d }
const str = (x: Node | undefined): string => (typeof x === 'string' ? x : '')
const xy = (x: Node[] | undefined): Xy => [num(x?.[1]), num(x?.[2])]
const hasFlag = (x: Node[], flag: string): boolean => x.some((k) => k === flag || (isList(k) && k[0] === flag && k[1] !== 'no'))

// ------------------------------------------------------------------ geometry helpers

const rad = (deg: number): number => (deg * Math.PI) / 180

/** A point in a footprint's frame to the board: KiCad turns counter-clockwise as seen from the top, with y down. */
export function toBoard(at: Xy, angle: number, p: Xy): Xy {
  const a = rad(angle)
  const c = Math.cos(a), s = Math.sin(a)
  return [at[0] + p[0] * c + p[1] * s, at[1] - p[0] * s + p[1] * c]
}

/** Points along the arc through start, mid and end (KiCad 6+ arcs), end included. */
export function arcPoints(start: Xy, mid: Xy, end: Xy, step = 10): Xy[] {
  const [ax, ay] = start, [bx, by] = mid, [cx, cy] = end
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return [start, end]
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const a0 = Math.atan2(ay - uy, ax - ux)
  let a1 = Math.atan2(by - uy, bx - ux)
  let a2 = Math.atan2(cy - uy, cx - ux)
  // go from a0 to a2 the way that passes a1
  const norm = (a: number): number => { while (a < a0) a += Math.PI * 2; while (a >= a0 + Math.PI * 2) a -= Math.PI * 2; return a }
  a1 = norm(a1); a2 = norm(a2)
  const sweep = a1 <= a2 ? a2 - a0 : a2 - a0 - Math.PI * 2
  const n = Math.max(4, Math.ceil((Math.abs(sweep) * 180) / Math.PI / step))
  const out: Xy[] = []
  for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; out.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]) }
  return out
}

function circlePoints(c: Xy, r: number, n = 48): Xy[] {
  const out: Xy[] = []
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]) }
  return out
}

export function area(loop: readonly Xy[]): number {
  let s = 0
  for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i]!, [x2, y2] = loop[(i + 1) % loop.length]!; s += x1 * y2 - x2 * y1 }
  return s / 2
}

/** A graphic item (gr_* or fp_*) read in board coordinates; `place` maps a footprint's frame onto the board. */
function graphic(n: Node[], place: (p: Xy) => Xy): Graphic | null {
  const kind = head(n).replace(/^(gr|fp)_/, '')
  const layer = str(kid(n, 'layer')?.[1])
  const width = num(kid(kid(n, 'stroke') ?? [], 'width')?.[1], num(kid(n, 'width')?.[1], 0.1))
  const fillNode = kid(n, 'fill')
  const fill = fillNode ? ['yes', 'solid'].includes(str(fillNode[1])) : false
  if (kind === 'line') return { kind, layer, width, fill, pts: [place(xy(kid(n, 'start'))), place(xy(kid(n, 'end')))] }
  if (kind === 'arc') return { kind, layer, width, fill, pts: arcPoints(place(xy(kid(n, 'start'))), place(xy(kid(n, 'mid'))), place(xy(kid(n, 'end')))) }
  if (kind === 'circle') {
    const c = xy(kid(n, 'center')), e = xy(kid(n, 'end'))
    return { kind, layer, width, fill, pts: circlePoints(place(c), Math.hypot(e[0] - c[0], e[1] - c[1])) }
  }
  if (kind === 'rect') {
    const [x1, y1] = xy(kid(n, 'start')), [x2, y2] = xy(kid(n, 'end'))
    return { kind, layer, width, fill, pts: [place([x1, y1]), place([x2, y1]), place([x2, y2]), place([x1, y2])] }
  }
  if (kind === 'poly') {
    const pts = kids(kid(n, 'pts') ?? [], 'xy').map((p) => place(xy(p)))
    return pts.length >= 2 ? { kind, layer, width, fill, pts } : null
  }
  return null
}

function text(n: Node[], place: (p: Xy) => Xy, angle0: number, value?: string): Text | null {
  if (hasFlag(n, 'hide')) return null
  const effects = kid(n, 'effects') ?? []
  if (hasFlag(effects, 'hide')) return null
  const at = kid(n, 'at')
  const font = kid(effects, 'font') ?? []
  const justify = kid(effects, 'justify') ?? []
  const t = value ?? str(head(n) === 'gr_text' ? n[1] : n[2])
  if (!t) return null
  return {
    text: t, at: place([num(at?.[1]), num(at?.[2])]), angle: at && at.length > 3 ? num(at[3]) : angle0,
    size: num(kid(font, 'size')?.[1], 1), layer: str(kid(n, 'layer')?.[1]), mirror: justify.includes('mirror'),
  }
}

// ------------------------------------------------------------------ the board

/** Read a .kicad_pcb's text. Throws when it is not a KiCad board at all. */
export function readBoard(source: string): Board {
  const root = parseSexpr(source)
  if (!isList(root) || root[0] !== 'kicad_pcb') throw new Error('This is not a KiCad board (.kicad_pcb).')
  const notes: string[] = []
  const thickness = num(kid(kid(root, 'general') ?? [], 'thickness')?.[1], 1.6)
  const stack = kid(kid(root, 'setup') ?? [], 'stackup')
  const colourOf = (layer: string): string | null => {
    const l = (stack ? kids(stack, 'layer') : []).find((x) => x[1] === layer)
    const c = l ? str(kid(l, 'color')?.[1]) : ''
    return c || null
  }
  const layers = kid(root, 'layers') ?? []
  const copperLayers = layers.filter((l) => isList(l) && /\.Cu$/.test(str(l[1]))).length || 2

  const edges: Graphic[] = []
  const graphics: Graphic[] = []
  const texts: Text[] = []
  const footprints: Footprint[] = []
  const tracks: Track[] = []
  const vias: Via[] = []
  const zones: Zone[] = []
  const same = (p: Xy): Xy => p

  for (const n of root) {
    if (!isList(n)) continue
    const h = head(n)
    if (h.startsWith('gr_') && h !== 'gr_text' && h !== 'gr_text_box') {
      const g = graphic(n, same)
      if (!g) continue
      if (g.layer === 'Edge.Cuts') edges.push(g)
      else graphics.push(g)
    } else if (h === 'gr_text') {
      const t = text(n, same, 0)
      if (t) texts.push(t)
    } else if (h === 'segment') {
      tracks.push({ a: xy(kid(n, 'start')), b: xy(kid(n, 'end')), width: num(kid(n, 'width')?.[1], 0.2), layer: str(kid(n, 'layer')?.[1]) })
    } else if (h === 'arc') {
      tracks.push({ a: xy(kid(n, 'start')), mid: xy(kid(n, 'mid')), b: xy(kid(n, 'end')), width: num(kid(n, 'width')?.[1], 0.2), layer: str(kid(n, 'layer')?.[1]) })
    } else if (h === 'via') {
      vias.push({ at: xy(kid(n, 'at')), size: num(kid(n, 'size')?.[1], 0.6), drill: num(kid(n, 'drill')?.[1], 0.3) })
    } else if (h === 'zone') {
      for (const f of kids(n, 'filled_polygon')) {
        const layer = str(kid(f, 'layer')?.[1])
        const pts = kids(kid(f, 'pts') ?? [], 'xy').map((p) => xy(p))
        if (pts.length < 3) continue
        const z = zones.find((x) => x.layer === layer)
        if (z) z.polys.push(pts)
        else zones.push({ layer, polys: [pts] })
      }
    } else if (h === 'footprint' || h === 'module') {
      footprints.push(footprint(n, edges))
    }
  }

  // the outline: chain the edge pieces into loops
  const loops = chain(edges)
  let outline: Xy[] = []
  let cutouts: Xy[][] = []
  if (loops.closed.length) {
    const sorted = [...loops.closed].sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
    outline = sorted[0]!
    cutouts = sorted.slice(1)
  }
  if (loops.open) notes.push(`The board outline has ${loops.open} gap${loops.open === 1 ? '' : 's'}; the 3D board follows its overall size instead.`)
  if (!outline.length) {
    // no closed outline: the box around everything on the board
    const pts = [...footprints.flatMap((f) => f.pads.map((p) => p.at)), ...tracks.flatMap((t) => [t.a, t.b]), ...edges.flatMap((e) => e.pts)]
    if (!edges.length) notes.push('The board has no outline on Edge.Cuts yet; the 3D board is the box around its parts.')
    const b = boundsOf(pts.length ? pts : [[0, 0], [50, 30]])
    const m = edges.length ? 0 : 2
    outline = [[b.minX - m, b.minY - m], [b.maxX + m, b.minY - m], [b.maxX + m, b.maxY + m], [b.minX - m, b.maxY + m]]
  }
  return {
    thickness, outline, cutouts, bounds: boundsOf(outline),
    maskColor: colourOf('F.Mask'), silkColor: colourOf('F.SilkS'), copperFinish: str(kid(stack ?? [], 'copper_finish')?.[1]) || null, copperLayers,
    footprints, tracks, vias, zones, graphics, texts, notes,
  }
}

export function boundsOf(pts: readonly Xy[]): Board['bounds'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y }
  return { minX, minY, maxX, maxY }
}

function footprint(n: Node[], edges: Graphic[]): Footprint {
  const lib = str(n[1])
  const atN = kid(n, 'at')
  const at: Xy = [num(atN?.[1]), num(atN?.[2])]
  const angle = num(atN?.[3])
  const layer = str(kid(n, 'layer')?.[1])
  const side: Side = layer.startsWith('B.') ? 'B' : 'F'
  const place = (p: Xy): Xy => toBoard(at, angle, p)
  const prop = (name: string): string => {
    const p = kids(n, 'property').find((x) => x[1] === name)
    if (p) return str(p[2])
    const t = kids(n, 'fp_text').find((x) => x[1] === name.toLowerCase())
    return t ? str(t[2]) : ''
  }
  const ref = prop('Reference')
  const value = prop('Value')
  const pads: Pad[] = kids(n, 'pad').map((p) => {
    const pa = kid(p, 'at')
    const local: Xy = [num(pa?.[1]), num(pa?.[2])]
    const sz = kid(p, 'size')
    const dr = kid(p, 'drill')
    let drill: Pad['drill'] = null
    if (dr) {
      const oval = dr[1] === 'oval'
      const vals = dr.slice(oval ? 2 : 1).filter((x): x is string => typeof x === 'string').map(Number).filter(Number.isFinite)
      drill = oval && vals.length >= 2 ? [vals[0]!, vals[1]!] : vals[0] ?? null
    }
    const layers = (kid(p, 'layers') ?? []).slice(1).map(str)
    const sides: Side[] = []
    if (layers.some((l) => l === 'F.Cu' || l === '*.Cu')) sides.push('F')
    if (layers.some((l) => l === 'B.Cu' || l === '*.Cu')) sides.push('B')
    const net = kid(p, 'net')
    return {
      num: str(p[1]), type: str(p[2]), shape: str(p[3]), at: place(local), angle: pa && pa.length > 3 ? num(pa[3]) : angle,
      size: [num(sz?.[1], 1), num(sz?.[2], num(sz?.[1], 1))], drill, sides,
      roundness: num(kid(p, 'roundrect_rratio')?.[1], 0.25), net: net ? str(net[2] ?? net[1]) || null : null,
    }
  })
  const graphics: Graphic[] = []
  for (const g of n) {
    if (!isList(g) || !head(g).startsWith('fp_') || head(g) === 'fp_text' || head(g) === 'fp_text_box') continue
    const gr = graphic(g, place)
    if (!gr) continue
    if (gr.layer === 'Edge.Cuts') edges.push(gr)
    else graphics.push(gr)
  }
  const texts: Text[] = []
  for (const t of [...kids(n, 'property'), ...kids(n, 'fp_text')]) {
    const layer = str(kid(t, 'layer')?.[1])
    if (!/SilkS/.test(layer)) continue
    const raw = str(t[2])
    const tx = text(t, place, angle, raw.replace('${REFERENCE}', ref).replace('${VALUE}', value))
    if (tx) texts.push(tx)
  }
  const model = kid(n, 'model')
  const attr = (kid(n, 'attr') ?? []).slice(1).map(str)
  return { ref, value, name: lib.replace(/^[^:]*:/, ''), lib, at, angle, side, pads, graphics, texts, model: model ? str(model[1]) : null, attr }
}

/** Chain edge pieces end to end into closed loops (ends within 0.01 mm meet). Circles, rectangles and polygons are loops already. */
function chain(edges: readonly Graphic[]): { closed: Xy[][]; open: number } {
  const closed: Xy[][] = []
  const pieces: Xy[][] = []
  for (const e of edges) {
    if (e.kind === 'circle' || e.kind === 'rect' || e.kind === 'poly') closed.push(e.pts)
    else pieces.push([...e.pts])
  }
  const near = (a: Xy, b: Xy): boolean => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01
  let open = 0
  while (pieces.length) {
    const loop = pieces.pop()!
    let grew = true
    while (grew && !near(loop[0]!, loop[loop.length - 1]!)) {
      grew = false
      const end = loop[loop.length - 1]!
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!
        if (near(p[0]!, end)) { loop.push(...p.slice(1)); pieces.splice(i, 1); grew = true; break }
        if (near(p[p.length - 1]!, end)) { loop.push(...[...p].reverse().slice(1)); pieces.splice(i, 1); grew = true; break }
      }
    }
    if (loop.length > 2 && near(loop[0]!, loop[loop.length - 1]!)) closed.push(loop.slice(0, -1))
    else open++
  }
  return { closed, open }
}

// ------------------------------------------------------------------ colours

/** KiCad's named solder mask colours (the stackup's names) as the colour a finished board shows. */
export const MASK_COLOURS: Record<string, string> = {
  green: '#0b4d24', 'light green': '#2f8a3a', 'saturated green': '#0a6a2a', red: '#8a1414', 'light red': '#c23a2c', 'red/orange': '#b8401a',
  blue: '#0b3a7a', 'light blue': '#3a6fb0', 'dark blue': '#0a2350', purple: '#3c1662', 'light purple': '#6a3a9a', 'dark purple': '#2a0f45',
  black: '#121314', white: '#e9ebe8', yellow: '#c9a40c',
}

/** The mask colour a stackup names (a KiCad name or #RRGGBB[AA]) as #rrggbb, or null when it names none we know. */
export function maskHex(name: string | null): string | null {
  if (!name) return null
  const m = /^#([0-9a-f]{6})/i.exec(name)
  if (m) return `#${m[1]!.toLowerCase()}`
  return MASK_COLOURS[name.trim().toLowerCase()] ?? null
}

export type Finish = 'enig' | 'hasl' | 'osp'

/** The pad plating a stackup's copper_finish names, as the three looks a board can have; null when it names none. */
export function finishOf(name: string | null): Finish | null {
  if (!name) return null
  const n = name.toLowerCase()
  if (/enig|enepig|gold/.test(n)) return 'enig'
  if (/hal|hasl|tin|immersion tin|silver/.test(n)) return 'hasl'
  if (/osp|bare/.test(n)) return 'osp' // KiCad writes "None" when no finish is chosen: that is not bare copper
  return null
}
