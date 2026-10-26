/**
 * Which router a board needs. OrthoRoute (a GPU Manhattan-lattice router) is good at the dense, regular part of a
 * board — BGA escapes, wide buses, backplane connector fans — and Freerouting (push-and-shove, CPU) at everything
 * else. `planRoute` finds the board's "complex core" and decides, as a pure function of the board, the settings and
 * whether a GPU backend is reachable:
 *
 *   - area arrays: a footprint with at least `bga_min_pads` pads on a grid of pitch at most `bga_max_pitch_mm`, at
 *     least 4×4 and filled to `bga_min_fill` (a QFP's ring of pads is not an array)
 *   - buses: at least `bus_min_nets` nets sharing a name stem (D0…D31, A[0]…, TX0_P/TX0_N) between the same footprints
 *   - backplane fans: at least `backplane_min_nets` nets running from one connector to another (`connector_prefixes`)
 *   - the core's nets are the nets on those pads and in those groups, without nets that have a copper pour (power and
 *     ground handled by zones) and nets with fewer than two pads; `include_nets` / `exclude_nets` override this
 *
 *   engine auto:  no core → Freerouting only; a core and a GPU → both (OrthoRoute on the core, then Freerouting on the
 *                 rest); a core but no GPU → Freerouting only, with a note; a board with fewer copper layers than
 *                 `orthoroute_min_layers` → Freerouting only (OrthoRoute's lattice routes between inner layers).
 *   engine orthoroute | both: as asked (OrthoRoute on the CPU when there is no GPU); an empty core then means every
 *                 routable net. engine freerouting: Freerouting only.
 */
import type { Board, Footprint } from '../kicad/pcb.js'

export interface AutorouteSettings {
  bga_max_pitch_mm: number
  bga_min_pads: number
  bga_min_fill: number
  bus_min_nets: number
  backplane_min_nets: number
  connector_prefixes: string[]
  include_nets: string[]
  exclude_nets: string[]
  orthoroute_min_layers: number
}

export const DEFAULT_AUTOROUTE: AutorouteSettings = {
  bga_max_pitch_mm: 0.8, bga_min_pads: 64, bga_min_fill: 0.35, bus_min_nets: 8, backplane_min_nets: 32,
  connector_prefixes: ['J', 'P', 'CN', 'X'], include_nets: [], exclude_nets: [], orthoroute_min_layers: 4,
}

export type Engine = 'auto' | 'orthoroute' | 'freerouting' | 'both'

export interface RoutePlan {
  engine: Engine
  /** the stages to run, in order */
  stages: ('orthoroute' | 'freerouting')[]
  /** OrthoRoute without a GPU (only when asked for explicitly) */
  orthoroute_cpu_only: boolean
  gpu: { available: boolean; how: string }
  copper_layers: number
  core: {
    arrays: { ref: string; pads: number; pitch_mm: number; grid: string; fill: number }[]
    buses: { stem: string; nets: number; footprints: string[] }[]
    backplanes: { footprints: string[]; nets: number }[]
    /** the nets stage 1 routes */
    nets: string[]
    /** nets left out because a pour carries them */
    poured: string[]
  }
  notes: string[]
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** The smallest spacing between distinct sorted values (after rounding to 1 µm), or Infinity. */
function minStep(vals: number[]): number {
  const u = [...new Set(vals.map((v) => Math.round(v * 1000)))].sort((a, b) => a - b)
  let m = Infinity
  for (let i = 1; i < u.length; i++) m = Math.min(m, ((u[i] as number) - (u[i - 1] as number)) / 1000)
  return m
}

/** An area array's grid in the footprint's own frame, or null. */
export function areaArray(fp: Footprint, s: AutorouteSettings): { pitch: number; cols: number; rows: number; fill: number } | null {
  const pads = fp.pads.filter((p) => p.type === 'smd' || p.type === 'thru_hole')
  if (pads.length < s.bga_min_pads) return null
  const a = (-fp.rotation_deg * Math.PI) / 180
  const local = pads.map((p) => {
    const dx = p.x_mm - fp.x_mm
    const dy = p.y_mm - fp.y_mm
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)] as const
  })
  const px = minStep(local.map((q) => q[0]))
  const py = minStep(local.map((q) => q[1]))
  const pitch = Math.min(px, py)
  if (!Number.isFinite(pitch) || pitch <= 0 || pitch > s.bga_max_pitch_mm + 1e-6) return null
  const span = (vals: number[], step: number): number => Math.round((Math.max(...vals) - Math.min(...vals)) / step) + 1
  const cols = span(local.map((q) => q[0]), px)
  const rows = span(local.map((q) => q[1]), py)
  if (cols < 4 || rows < 4) return null
  const fill = pads.length / (cols * rows)
  return fill >= s.bga_min_fill ? { pitch, cols, rows, fill } : null
}

/** A net name's bus stem: the last path part with its index and pair suffix removed ("/mem/D12" → "D", "A[3]" → "A[]",
 * "TX0_P" → "TX_"), or null when it has no index. */
export function busStem(name: string): string | null {
  const leaf = name.split('/').pop() ?? name
  // a differential pair's suffix, when it follows an index: TX0_P, D3+, LANE2N
  const pair = /^(.*\d)(_?[PN]|[+-])$/.exec(leaf)
  const base = pair ? (pair[1] as string) : leaf
  const m = /^(.*?)(\d+)(\D*)$/.exec(base)
  if (!m || (!m[1] && !m[3])) return null
  return `${m[1]}#${m[3]}${pair ? '±' : ''}`
}

export function planRoute(board: Board, opts: { engine?: Engine; gpu: { available: boolean; how: string }; settings?: Partial<AutorouteSettings> }): RoutePlan {
  const s: AutorouteSettings = { ...DEFAULT_AUTOROUTE, ...opts.settings }
  const engine = opts.engine ?? 'auto'
  const notes: string[] = []
  const layers = board.layers.length
  const poured = new Set(board.zones.filter((z) => z.copper && !z.keepout && z.net).map((z) => z.net as string))
  const netFps = new Map<string, Set<string>>()
  for (const [net, pads] of Object.entries(board.pads)) netFps.set(net, new Set(pads.map((p) => p.ref)))
  const routable = (n: string): boolean => (board.pads[n]?.length ?? 0) >= 2

  const core = new Set<string>()
  const arrays: RoutePlan['core']['arrays'] = []
  for (const fp of board.footprints) {
    const g = areaArray(fp, s)
    if (!g) continue
    arrays.push({ ref: fp.ref, pads: fp.pads.length, pitch_mm: r3(g.pitch), grid: `${g.cols}x${g.rows}`, fill: r3(g.fill) })
    for (const p of fp.pads) if (p.net) core.add(p.net)
  }

  const groups = new Map<string, string[]>()
  for (const [net, fps] of netFps) {
    const stem = busStem(net)
    if (!stem || fps.size < 2) continue
    const k = `${net.split('/').slice(0, -1).join('/')}/${stem}|${[...fps].sort().join(',')}`
    ;(groups.get(k) ?? groups.set(k, []).get(k) as string[]).push(net)
  }
  const buses: RoutePlan['core']['buses'] = []
  for (const [k, nets] of groups) {
    if (nets.length < s.bus_min_nets) continue
    const [stem, fps] = k.split('|') as [string, string]
    buses.push({ stem: stem.replace(/^\//, ''), nets: nets.length, footprints: fps.split(',') })
    for (const n of nets) core.add(n)
  }

  const isConnector = (ref: string): boolean => s.connector_prefixes.some((p) => new RegExp(`^${p.replace(/[^A-Za-z]/g, '')}\\d`).test(ref))
  const pairs = new Map<string, string[]>()
  for (const [net, fps] of netFps) {
    if (fps.size !== 2 || ![...fps].every(isConnector)) continue
    const k = [...fps].sort().join(',')
    ;(pairs.get(k) ?? pairs.set(k, []).get(k) as string[]).push(net)
  }
  const backplanes: RoutePlan['core']['backplanes'] = []
  for (const [k, nets] of pairs) {
    if (nets.length < s.backplane_min_nets) continue
    backplanes.push({ footprints: k.split(','), nets: nets.length })
    for (const n of nets) core.add(n)
  }

  const pouredHit = [...core].filter((n) => poured.has(n)).sort()
  for (const n of pouredHit) core.delete(n)
  for (const n of [...core]) if (!routable(n)) core.delete(n)
  for (const n of s.include_nets) if (board.pads[n]) core.add(n); else notes.push(`include_nets: ${n} is not a net on this board`)
  for (const n of s.exclude_nets) core.delete(n)
  let nets = [...core].sort()

  let stages: RoutePlan['stages']
  let cpuOnly = false
  if (engine === 'freerouting') stages = ['freerouting']
  else if (engine === 'orthoroute' || engine === 'both') {
    stages = engine === 'both' ? ['orthoroute', 'freerouting'] : ['orthoroute']
    if (!nets.length) {
      nets = Object.keys(board.pads).filter((n) => routable(n) && !poured.has(n) && !s.exclude_nets.includes(n)).sort()
      notes.push('no complex core found: OrthoRoute gets every routable net without a pour')
    }
    if (!opts.gpu.available) {
      cpuOnly = true
      notes.push(`no GPU backend (${opts.gpu.how}): OrthoRoute runs on the CPU (--cpu-only), which is much slower`)
    }
    if (layers < s.orthoroute_min_layers) notes.push(`the board has ${layers} copper layers; OrthoRoute's lattice is built for ${s.orthoroute_min_layers} or more`)
  } else if (!nets.length) {
    stages = ['freerouting']
    notes.push('no complex core (area arrays, dense buses, backplane fans): Freerouting alone')
  } else if (layers < s.orthoroute_min_layers) {
    stages = ['freerouting']
    notes.push(`a complex core of ${nets.length} nets, but only ${layers} copper layers: OrthoRoute's lattice needs ${s.orthoroute_min_layers}+, so Freerouting alone`)
  } else if (!opts.gpu.available) {
    stages = ['freerouting']
    notes.push(`a complex core of ${nets.length} nets, but OrthoRoute was skipped: no GPU backend (${opts.gpu.how}). Ask for engine orthoroute or both to run it on the CPU.`)
  } else {
    stages = ['orthoroute', 'freerouting']
    notes.push(`a complex core of ${nets.length} nets: OrthoRoute on the GPU first, then Freerouting on the rest`)
  }
  if (pouredHit.length) notes.push(`left to their pours: ${pouredHit.slice(0, 10).join(', ')}${pouredHit.length > 10 ? ', …' : ''}`)
  return {
    engine, stages, orthoroute_cpu_only: stages.includes('orthoroute') && cpuOnly, gpu: opts.gpu, copper_layers: layers,
    core: { arrays, buses, backplanes, nets: stages.includes('orthoroute') ? nets : [...core].sort(), poured: pouredHit },
    notes,
  }
}
