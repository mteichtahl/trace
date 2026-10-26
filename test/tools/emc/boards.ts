/** Small KiCad 10 boards for the EMC tests: copper layers with given dielectric thickness, tracks, vias, pads and
 * zones with filled polygons (so the plane shapes are exact). */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface EmcBoard {
  layers: 2 | 4
  /** dielectric thickness between copper layers (mm) */
  h: number
  er?: number
  width: number
  height: number
  segments?: { net: string; layer: string; x1: number; y1: number; x2: number; y2: number; w: number }[]
  vias?: { net: string; x: number; y: number; size?: number; drill?: number }[]
  zones?: { net: string; layer: string; poly: [number, number][] }[]
  footprints?: { ref: string; x: number; y: number; side?: 'F' | 'B'; pads: { num: string; x: number; y: number; w: number; h: number; net: string; tht?: boolean }[] }[]
}

let uid = 0
const u = (): string => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`

export function emcBoardText(b: EmcBoard): string {
  const cu = b.layers === 2 ? ['F.Cu', 'B.Cu'] : ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
  const ids = b.layers === 2 ? [0, 2] : [0, 4, 6, 2]
  const er = b.er ?? 4.4
  const stack = cu.flatMap((name, i) => [
    `(layer "${name}" (type "copper") (thickness 0.035))`,
    ...(i < cu.length - 1 ? [`(layer "dielectric ${i + 1}" (type "core") (thickness ${b.h}) (material "FR4") (epsilon_r ${er}) (loss_tangent 0.02))`] : []),
  ])
  const segs = (b.segments ?? []).map((s) => `(segment (start ${s.x1} ${s.y1}) (end ${s.x2} ${s.y2}) (width ${s.w}) (layer "${s.layer}") (net "${s.net}") (uuid "${u()}"))`)
  const vias = (b.vias ?? []).map((v) => `(via (at ${v.x} ${v.y}) (size ${v.size ?? 0.6}) (drill ${v.drill ?? 0.3}) (layers "F.Cu" "B.Cu") (net "${v.net}") (uuid "${u()}"))`)
  const zones = (b.zones ?? []).map((z) => {
    const pts = z.poly.map(([x, y]) => `(xy ${x} ${y})`).join(' ')
    return `(zone (net "${z.net}") (layer "${z.layer}") (uuid "${u()}") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.2)
      (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
      (polygon (pts ${pts}))
      (filled_polygon (layer "${z.layer}") (pts ${pts})))`
  })
  const fps = (b.footprints ?? []).map((f) => {
    const side = f.side ?? 'F'
    const pads = f.pads.map((p) => p.tht
      ? `(pad "${p.num}" thru_hole circle (at ${p.x} ${p.y}) (size ${p.w} ${p.h}) (drill 0.8) (layers "*.Cu" "*.Mask") (net "${p.net}") (uuid "${u()}"))`
      : `(pad "${p.num}" smd rect (at ${p.x} ${p.y}) (size ${p.w} ${p.h}) (layers "${side}.Cu" "${side}.Mask" "${side}.Paste") (net "${p.net}") (uuid "${u()}"))`).join('\n')
    return `(footprint "test:${f.ref}" (layer "${side}.Cu") (uuid "${u()}") (at ${f.x} ${f.y})
      (property "Reference" "${f.ref}" (at 0 0) (layer "${side}.SilkS") (uuid "${u()}") (effects (font (size 1 1) (thickness 0.15))))
      (property "Value" "${f.ref}" (at 0 0) (layer "${side}.Fab") (uuid "${u()}") (effects (font (size 1 1) (thickness 0.15))))
      (attr smd)
      ${pads})`
  })
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness ${b.h * (cu.length - 1)}) (legacy_teardrops no))
  (paper "A4")
  (layers ${cu.map((n, i) => `(${ids[i]} "${n}" signal)`).join(' ')} (25 "Edge.Cuts" user) (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user) (35 "F.Fab" user) (33 "B.Fab" user))
  (setup (stackup ${stack.join(' ')} (copper_finish "None") (dielectric_constraints no)) (pad_to_mask_clearance 0))
  ${fps.join('\n')}
  ${segs.join('\n')}
  ${vias.join('\n')}
  ${zones.join('\n')}
  (gr_rect (start 0 0) (end ${b.width} ${b.height}) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${u()}"))
)
`
}

export function writeEmcBoard(b: EmcBoard): string {
  const d = mkdtempSync(join(tmpdir(), 'emc-fixture-'))
  const p = join(d, 'board.kicad_pcb')
  writeFileSync(p, emcBoardText(b))
  return p
}
