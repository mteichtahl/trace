/**
 * The synthetic hot board: a SOT-223 regulator U1 dissipating 1 W in the middle of a 50 x 50 mm, 2-layer, 1.5 mm
 * board. `bare` has only its pads and short tracks, so the heat cannot spread and the check fails; `poured` adds a
 * copper pour on the tab's net on both layers (the top pour stops short of the pin row) and a 4 x 4 array of
 * 0.3 mm thermal vias under the tab, and the check passes. Written with the EMC tests' KiCad board writer.
 */
import { writeEmcBoard, type EmcBoard } from '../emc/boards.js'

const pads = [
  { num: '4', x: 0, y: -3.15, w: 3.6, h: 2.2, net: 'TAB' },
  { num: '1', x: -2.3, y: 3.15, w: 1.0, h: 2.0, net: 'VIN' },
  { num: '2', x: 0, y: 3.15, w: 1.0, h: 2.0, net: 'TAB' },
  { num: '3', x: 2.3, y: 3.15, w: 1.0, h: 2.0, net: 'GND' },
]

export function hotBoard(kind: 'bare' | 'poured'): string {
  const b: EmcBoard = {
    layers: 2, h: 1.5, width: 50, height: 50,
    footprints: [{ ref: 'U1', x: 25, y: 25, pads }],
    segments: [
      { net: 'VIN', layer: 'F.Cu', x1: 22.7, y1: 28.15, x2: 22.7, y2: 40, w: 0.5 },
      { net: 'GND', layer: 'F.Cu', x1: 27.3, y1: 28.15, x2: 27.3, y2: 40, w: 0.5 },
      { net: 'TAB', layer: 'F.Cu', x1: 25, y1: 21.85, x2: 25, y2: 10, w: 0.5 },
    ],
  }
  if (kind === 'poured') {
    b.zones = [
      { net: 'TAB', layer: 'F.Cu', poly: [[5, 5], [45, 5], [45, 26.6], [5, 26.6]] },
      { net: 'TAB', layer: 'B.Cu', poly: [[3, 3], [47, 3], [47, 47], [3, 47]] },
    ]
    b.vias = []
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) b.vias.push({ net: 'TAB', x: 23.65 + i * 0.9, y: 20.95 + j * 0.85, size: 0.6, drill: 0.3 })
  }
  return writeEmcBoard(b)
}

export const U1_LIMITS = {
  ref: 'U1', mpn: 'SYNTHETIC-LDO', package: 'SOT-223', tj_max_c: 125, theta_ja: 104, psi_jb: 10,
  citations: {
    tj_max_c: { source: 'synthetic fixture (figures of the order of a SOT-223 LDO), not a real part' },
    theta_ja: { source: 'synthetic fixture (figures of the order of a SOT-223 LDO), not a real part' },
    psi_jb: { source: 'synthetic fixture (figures of the order of a SOT-223 LDO), not a real part' },
  },
}
