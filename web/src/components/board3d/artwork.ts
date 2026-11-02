/**
 * The board's two faces drawn into canvases, which the 3D view lays on its top and bottom surfaces:
 *
 *   colour   what you see: the solder mask, copper under it (a little lighter, as on a real board), tented vias, the
 *            silkscreen, and exposed copper in the plating's colour
 *   height   a grey height map for the light to catch: copper and silkscreen stand slightly above the mask
 *   metal    white where copper is bare (pads), black elsewhere: the plated layer shows only there
 *
 * Both faces are drawn in KiCad's own millimetres (column = x − minX, row = y − minY). The bottom face is mirrored by
 * the geometry, so its words are drawn mirrored here and read correctly once the board is turned over.
 */
import type { Board, Graphic, Pad, Side, Text, Xy } from '@/lib/kicad-board'
import { arcPoints } from '@/lib/kicad-board'

export interface Look {
  mask: string
  silk: string
  /** the plating's colour, for exposed copper in the colour map */
  metal: string
}

/** Pixels per millimetre for a board of this size: sharp on small boards, within a 2560 px texture on large ones. */
export function scaleFor(b: Board): number {
  const w = b.bounds.maxX - b.bounds.minX, h = b.bounds.maxY - b.bounds.minY
  return Math.max(6, Math.min(48, 2560 / Math.max(w, h, 1)))
}

const copperOf = (side: Side): string => (side === 'F' ? 'F.Cu' : 'B.Cu')
const silkOf = (side: Side): string => (side === 'F' ? 'F.SilkS' : 'B.SilkS')

/** Lighten (k > 0) or darken (k < 0) a #rrggbb colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)))
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`
}

/** The mask over copper: lighter on dark masks, a touch darker and warmer on white. */
const maskOverCopper = (mask: string): string => {
  const n = parseInt(mask.slice(1), 16)
  const lum = ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255
  return lum > 0.7 ? shade(mask, -0.06) : shade(mask, 0.14)
}

function canvas(b: Board, s: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round((b.bounds.maxX - b.bounds.minX) * s))
  c.height = Math.max(2, Math.round((b.bounds.maxY - b.bounds.minY) * s))
  const g = c.getContext('2d')!
  g.scale(s, s)
  g.translate(-b.bounds.minX, -b.bounds.minY)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  return [c, g]
}

function path(g: CanvasRenderingContext2D, pts: readonly Xy[], close: boolean): void {
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  if (close) g.closePath()
}

/** A pad's copper outline, grown by `grow` mm on every side (a mask opening is a little larger than its pad). */
export function padPath(g: CanvasRenderingContext2D, p: Pad, grow = 0): void {
  const [w, h] = [p.size[0] + grow * 2, p.size[1] + grow * 2]
  g.save()
  g.translate(p.at[0], p.at[1])
  g.rotate((-p.angle * Math.PI) / 180)
  g.beginPath()
  if (p.shape === 'circle') g.arc(0, 0, w / 2, 0, Math.PI * 2)
  else {
    const r = p.shape === 'oval' ? Math.min(w, h) / 2 : p.shape === 'roundrect' ? Math.min(w, h) * p.roundness : 0
    g.roundRect(-w / 2, -h / 2, w, h, r)
  }
  g.restore()
}

function holePath(g: CanvasRenderingContext2D, p: Pad): void {
  if (!p.drill) return
  g.save()
  g.translate(p.at[0], p.at[1])
  g.rotate((-p.angle * Math.PI) / 180)
  g.beginPath()
  if (typeof p.drill === 'number') g.arc(0, 0, p.drill / 2, 0, Math.PI * 2)
  else { const [w, h] = p.drill; g.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2) }
  g.restore()
}

function strokeGraphic(g: CanvasRenderingContext2D, x: Graphic): void {
  const closed = x.kind !== 'line' && x.kind !== 'arc'
  path(g, x.pts, closed)
  if (x.fill && closed) g.fill()
  g.lineWidth = Math.max(0.08, x.width)
  g.stroke()
}

function drawText(g: CanvasRenderingContext2D, t: Text, mirrored: boolean): void {
  g.save()
  g.translate(t.at[0], t.at[1])
  if (mirrored) g.scale(-1, 1)
  g.rotate(((mirrored ? t.angle : -t.angle) * Math.PI) / 180)
  // KiCad's size is the letters' height; a font's em is about 1.4 times its capitals
  g.font = `600 ${t.size * 1.35}px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(t.text, 0, 0)
  g.restore()
}

/** The copper on one side: tracks, arcs and filled zones, in the current fill/stroke style. */
function copper(g: CanvasRenderingContext2D, b: Board, side: Side): void {
  const layer = copperOf(side)
  for (const z of b.zones) if (z.layer === layer) for (const poly of z.polys) { path(g, poly, true); g.fill() }
  for (const t of b.tracks) {
    if (t.layer !== layer) continue
    g.lineWidth = t.width
    path(g, t.mid ? arcPoints(t.a, t.mid, t.b) : [t.a, t.b], false)
    g.stroke()
  }
}

const padsOn = (b: Board, side: Side): Pad[] => b.footprints.flatMap((f) => f.pads.filter((p) => p.type !== 'np_thru_hole' && p.sides.includes(side)))

/** One face's colour map. */
export function colourArt(b: Board, side: Side, look: Look, s = scaleFor(b)): HTMLCanvasElement {
  const [c, g] = canvas(b, s)
  g.fillStyle = look.mask
  g.fillRect(b.bounds.minX, b.bounds.minY, b.bounds.maxX - b.bounds.minX, b.bounds.maxY - b.bounds.minY)
  g.fillStyle = g.strokeStyle = maskOverCopper(look.mask)
  copper(g, b, side)
  for (const v of b.vias) { g.beginPath(); g.arc(v.at[0], v.at[1], v.size / 2, 0, Math.PI * 2); g.fill() }
  g.fillStyle = '#050505'
  for (const v of b.vias) { g.beginPath(); g.arc(v.at[0], v.at[1], v.drill / 2, 0, Math.PI * 2); g.fill() }
  // the openings around pads: a dark rim where the mask stops, then the plated pad
  const pads = padsOn(b, side)
  g.fillStyle = shade(look.mask, -0.35)
  for (const p of pads) { padPath(g, p, 0.05); g.fill() }
  g.fillStyle = look.metal
  for (const p of pads) { padPath(g, p); g.fill() }
  // silkscreen
  g.fillStyle = g.strokeStyle = look.silk
  const silk = silkOf(side)
  for (const x of b.graphics) if (x.layer === silk) strokeGraphic(g, x)
  for (const t of b.texts) if (t.layer === silk) drawText(g, t, side === 'B')
  for (const f of b.footprints) {
    for (const x of f.graphics) if (x.layer === silk) strokeGraphic(g, x)
    for (const t of f.texts) if (t.layer === silk) drawText(g, t, side === 'B')
  }
  // silkscreen never prints on bare copper: clear it off the pads again
  g.fillStyle = look.metal
  for (const p of pads) { padPath(g, p); g.fill() }
  g.fillStyle = '#060606'
  for (const f of b.footprints) for (const p of f.pads) if (p.drill) { holePath(g, p); g.fill() }
  return c
}

/** One face's height map: mask low, copper and silkscreen a little higher, bare pads highest. */
export function heightArt(b: Board, side: Side, s = scaleFor(b)): HTMLCanvasElement {
  const [c, g] = canvas(b, s)
  g.fillStyle = '#3a3a3a'
  g.fillRect(b.bounds.minX, b.bounds.minY, b.bounds.maxX - b.bounds.minX, b.bounds.maxY - b.bounds.minY)
  g.fillStyle = g.strokeStyle = '#8a8a8a'
  copper(g, b, side)
  for (const v of b.vias) { g.beginPath(); g.arc(v.at[0], v.at[1], v.size / 2, 0, Math.PI * 2); g.fill() }
  g.fillStyle = g.strokeStyle = '#a8a8a8'
  const silk = silkOf(side)
  for (const x of b.graphics) if (x.layer === silk) strokeGraphic(g, x)
  for (const t of b.texts) if (t.layer === silk) drawText(g, t, side === 'B')
  for (const f of b.footprints) {
    for (const x of f.graphics) if (x.layer === silk) strokeGraphic(g, x)
    for (const t of f.texts) if (t.layer === silk) drawText(g, t, side === 'B')
  }
  g.fillStyle = '#c8c8c8'
  for (const p of padsOn(b, side)) { padPath(g, p); g.fill() }
  return c
}

/** Where copper is bare on one face: white on black, holes black again. */
export function metalArt(b: Board, side: Side, s = scaleFor(b)): HTMLCanvasElement {
  const [c, g] = canvas(b, s)
  g.fillStyle = '#000'
  g.fillRect(b.bounds.minX, b.bounds.minY, b.bounds.maxX - b.bounds.minX, b.bounds.maxY - b.bounds.minY)
  g.fillStyle = '#fff'
  for (const p of padsOn(b, side)) { padPath(g, p); g.fill() }
  g.fillStyle = '#000'
  for (const f of b.footprints) for (const p of f.pads) if (p.drill) { holePath(g, p); g.fill() }
  return c
}
