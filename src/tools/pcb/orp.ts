/**
 * OrthoRoute's board file (.ORP: gzip-compressed JSON, format 1.0) written from a .kicad_pcb without KiCad, so the
 * GPU router runs headless (`python main.py headless board.ORP`) with no KiCad GUI or IPC server.
 *
 * The layout follows OrthoRoute 1.0.0's own reader (orthoroute/infrastructure/serialization/orp_exporter.py,
 * `import_board_from_orp` and `convert_orp_to_board_data`), which is what headless mode runs — its docs page shows an
 * older shape. Coordinates are the board's own (mm, KiCad's Y-down frame); OrthoRoute's solution comes back in the
 * same frame. Only the nets asked for are listed as nets to route; every pad is listed (with its own net), so the
 * router's escape planner sees the pads it must avoid. Existing tracks and keepouts are not part of the format
 * (OrthoRoute's documented limitation): its result is vetted against them on the way back in (./ors.ts).
 */
import { gzipSync } from 'node:zlib'
import type { Board } from '../kicad/pcb.js'

export interface OrpRules {
  track_width: number
  clearance: number
  via_diameter: number
  via_drill: number
}

export interface OrpOptions {
  nets: readonly string[]
  rules: OrpRules
  boardName: string
  /** OrthoRoute's lattice pitch (mm); its default is 0.4 */
  gridPitch?: number
}

/** Through-hole drill when the pad has no (drill …) the reader could read: a conservative fraction of its smaller side. */
const drillFor = (w: number, h: number): number => Math.round(Math.min(w, h) * 0.6 * 1000) / 1000

export function buildOrp(board: Board, opts: OrpOptions): Record<string, unknown> {
  const layers = board.layers.map((l) => l.name)
  const want = new Set(opts.nets)
  const pads: Record<string, unknown>[] = []
  const xs: number[] = []
  const ys: number[] = []
  for (const [net, list] of Object.entries(board.pads)) {
    for (const p of list) {
      const thru = p.kind === 'thru_hole' || p.kind === 'np_thru_hole'
      xs.push(p.x)
      ys.push(p.y)
      pads.push({
        id: `${p.ref}@${p.num}`, component_id: p.ref, component_ref: p.ref, net_id: net, net_name: net,
        position: { x: p.x, y: p.y }, size: { width: p.w, height: p.h },
        // the pad's own (drill …); an oval hole as its smaller side (what fits the slot)
        drill_size: thru ? (p.drill ? Math.min(p.drill[0], p.drill[1]) : drillFor(p.w, p.h)) : null,
        layer: thru ? layers[0] : (p.layers[0] ?? layers[0]), shape: 'rect', angle: 0,
      })
    }
  }
  const o = board.outline
  const margin = 2
  const bounds = o
    ? { x_min: o.min_x_mm, y_min: o.min_y_mm, x_max: o.max_x_mm, y_max: o.max_y_mm, width: o.width_mm, height: o.height_mm }
    : (() => {
        const [x0, x1, y0, y1] = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin]
        return { x_min: x0, y_min: y0, x_max: x1, y_max: y1, width: x1 - x0, height: y1 - y0 }
      })()
  const nets = [...want].filter((n) => board.pads[n]).sort().map((n) => {
    const ps = board.pads[n] ?? []
    return {
      id: n, name: n, netclass: 'Default', pad_count: ps.length, is_routable: ps.length >= 2,
      terminals: ps.map((p) => ({ pad_id: `${p.ref}@${p.num}`, position: { x: p.x, y: p.y }, layer: p.layers[0] ?? layers[0] })),
      bounds: { x_min: Math.min(...ps.map((p) => p.x)), y_min: Math.min(...ps.map((p) => p.y)), x_max: Math.max(...ps.map((p) => p.x)), y_max: Math.max(...ps.map((p) => p.y)) },
    }
  })
  return {
    format_version: '1.0',
    metadata: { filename: `${opts.boardName}.ORP`, board_name: opts.boardName, board_id: opts.boardName, export_timestamp: new Date().toISOString(), orthoroute_version: '1.0.0', exporter: 'trace' },
    board: { bounds, layer_count: layers.length, thickness: board.thickness_mm ?? 1.6 },
    pads,
    nets,
    layers: layers.map((name, i) => ({ name, type: 'signal', stackup_position: i, thickness: 0.035, material: 'copper', is_routing_layer: true })),
    drc_rules: { default: { ...opts.rules, netclass: 'Default' }, netclasses: {}, min_values: { track_width: opts.rules.track_width, clearance: opts.rules.clearance, via_diameter: opts.rules.via_diameter, via_drill: opts.rules.via_drill } },
    grid_parameters: { grid_pitch: opts.gridPitch ?? 0.4, expansion_margin: 3.0, coordinate_system: 'PCB coordinates in millimeters, origin at board bounds minimum', board_bounds_used: { x_min: bounds.x_min, y_min: bounds.y_min, x_max: bounds.x_max, y_max: bounds.y_max } },
  }
}

export const encodeOrp = (orp: Record<string, unknown>): Buffer => gzipSync(Buffer.from(JSON.stringify(orp), 'utf8'))
