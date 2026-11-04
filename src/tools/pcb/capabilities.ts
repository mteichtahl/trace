/**
 * What JLCPCB can make as a bare board (docs/ontology.md "Keeping fab capabilities current"): the figures a layout's
 * design rules come from, each with the page it was read from, in the same form as the mechanical table
 * (src/tools/mech/capabilities.ts) and kept current by the same daily check (src/tools/mech/capsync.ts, the
 * `capabilities` workflow): a figure the page now states with other numbers, in the same words, comes as a pull request
 * to ./capabilities.updates.ts; anything else is reported for a person, and the last reviewed figure stays in force.
 *
 * Read 4 November 2026 from PCB: https://jlcpcb.com/capabilities/pcb-capabilities. The figures are the standard
 * service's (FR-4, 1 oz outer copper unless named); the page lists dearer options beside some of them.
 */
import type { Figure, CapabilityUpdates } from '../mech/capabilities.js'
import { currentFigures, withUpdates } from '../mech/capabilities.js'
import { UPDATES } from './capabilities.updates.js'

export const PCB = 'https://jlcpcb.com/capabilities/pcb-capabilities'
export const BOARD_SOURCES = [PCB] as const
export const BOARD_CHECKED = '2026-11-04'

export interface BoardCapabilities {
  checked: string
  sources: readonly string[]
  fab: 'jlcpcb'
  layers: { min: number; max: number }
  /** the narrowest track and the smallest gap at 1 oz copper (mm) */
  track_mm: { two_layer: { width: number; spacing: number }; multilayer: { width: number; spacing: number } }
  via_mm: { drill: number; diameter: number }
  annular_ring_mm: { plated: number; unplated_pad: number }
  hole_to_hole_mm: { pad: number; via: number }
  /** the smallest hole with no copper (mm) */
  unplated_hole_min_mm: number
  board_min_mm: [number, number]
  soldermask_bridge_mm: number
  silkscreen_mm: { line: number; text_height: number }
  /** copper back from a routed board edge (mm) */
  edge_clearance_mm: number
  source: string
}

export const BASE_BOARD_CAPABILITIES: BoardCapabilities = {
  checked: BOARD_CHECKED,
  sources: BOARD_SOURCES,
  fab: 'jlcpcb',
  layers: { min: 1, max: 32 },
  track_mm: { two_layer: { width: 0.1, spacing: 0.1 }, multilayer: { width: 0.09, spacing: 0.09 } },
  via_mm: { drill: 0.15, diameter: 0.25 },
  annular_ring_mm: { plated: 0.2, unplated_pad: 0.45 },
  hole_to_hole_mm: { pad: 0.45, via: 0.2 },
  unplated_hole_min_mm: 0.5,
  board_min_mm: [3, 3],
  soldermask_bridge_mm: 0.1,
  silkscreen_mm: { line: 0.15, text_height: 1.0 },
  edge_clearance_mm: 0.2,
  source: PCB,
}

function need(nums: readonly number[], n: number): void {
  if (nums.length !== n) throw new Error(`expected ${n} numbers, found ${nums.length}`)
  if (nums.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error('a number is not positive')
}
const one = (id: string, label: string, text: string, put: (c: BoardCapabilities, n: number) => void): Figure<BoardCapabilities> => ({
  id, page: PCB, label, text, apply: (c, n) => { need(n, 1); put(c, n[0] as number) },
})

export const BOARD_FIGURES: readonly Figure<BoardCapabilities>[] = [
  { id: 'layers', page: PCB, label: 'Layer count', text: '1-32 Layers', apply: (c, n) => { need(n, 2); c.layers = { min: n[0] as number, max: n[1] as number } } },
  // the row gives 1- and 2-layer boards first, then multilayer boards
  {
    id: 'track_mm.two_layer', page: PCB, label: 'Min. track width and spacing', text: '0.10 / 0.10 mm', occurrence: 0,
    apply: (c, n) => { need(n, 2); c.track_mm.two_layer = { width: n[0] as number, spacing: n[1] as number } },
  },
  {
    id: 'track_mm.multilayer', page: PCB, label: 'Min. track width and spacing', text: '0.09 / 0.09 mm', occurrence: 0, nth: 1,
    apply: (c, n) => { need(n, 2); c.track_mm.multilayer = { width: n[0] as number, spacing: n[1] as number } },
  },
  { id: 'via_mm', page: PCB, label: 'Min. Via hole size/diameter', text: '0.15/0.25mm', apply: (c, n) => { need(n, 2); c.via_mm = { drill: n[0] as number, diameter: n[1] as number } } },
  one('annular_ring_mm.plated', 'PTH annular ring', '0.20mm', (c, n) => { c.annular_ring_mm.plated = n }),
  one('annular_ring_mm.unplated_pad', 'NPTH pad annular ring', '0.45mm', (c, n) => { c.annular_ring_mm.unplated_pad = n }),
  one('hole_to_hole_mm.pad', 'Pad Hole-to-Hole Spacing', '0.45mm', (c, n) => { c.hole_to_hole_mm.pad = n }),
  one('hole_to_hole_mm.via', 'Via Hole-to-Hole Spacing', '0.2mm', (c, n) => { c.hole_to_hole_mm.via = n }),
  one('unplated_hole_min_mm', 'Min. Non-plated holes', '0.50mm', (c, n) => { c.unplated_hole_min_mm = n }),
  { id: 'board_min_mm', page: PCB, label: 'Minimum Dimensions', text: '3 × 3 mm', apply: (c, n) => { need(n, 2); c.board_min_mm = [n[0] as number, n[1] as number] } },
  one('soldermask_bridge_mm', 'Soldermask bridge', '0.10mm', (c, n) => { c.soldermask_bridge_mm = n }),
  one('silkscreen_mm.line', 'Minimum Line Width', '0.15mm', (c, n) => { c.silkscreen_mm.line = n }),
  {
    id: 'silkscreen_mm.text_height', page: PCB, label: 'Minimum text height', text: '40 mil (1.0mm)',
    apply: (c, n) => { need(n, 2); c.silkscreen_mm.text_height = n[1] as number },
  },
  one('edge_clearance_mm', 'Copper clearance from routed board edges', '0.2 mm', (c, n) => { c.edge_clearance_mm = n }),
]

export const BOARD_CAPABILITIES: BoardCapabilities = withUpdates(BASE_BOARD_CAPABILITIES, UPDATES, BOARD_FIGURES)
export const CURRENT_BOARD_FIGURES: readonly Figure<BoardCapabilities>[] = currentFigures(BOARD_FIGURES, UPDATES)
export type { CapabilityUpdates }
