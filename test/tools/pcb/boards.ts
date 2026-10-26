/** Synthetic KiCad boards for the router tests: just enough of the format for trace's reader, pcbnew and kicad-cli. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PadSpec { num: string; x: number; y: number; w?: number; h?: number; net?: string; kind?: 'smd' | 'thru_hole'; layer?: string }
export interface FpSpec { ref: string; x: number; y: number; rot?: number; pads: PadSpec[]; side?: 'F' | 'B' }
export interface BoardSpec {
  copper: 2 | 4 | 6
  width: number
  height: number
  footprints: FpSpec[]
  zones?: { net: string; layer: string }[]
  /** KiCad 10 style (nets named in place) instead of KiCad 9's numbered net table */
  kicad10?: boolean
  extra?: string
}

let uid = 0
const u = (): string => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`

export function copperNames(n: number): string[] {
  return ['F.Cu', ...Array.from({ length: n - 2 }, (_, i) => `In${i + 1}.Cu`), 'B.Cu']
}

export function boardText(s: BoardSpec): string {
  const cu = copperNames(s.copper)
  const ids = cu.map((_, i) => (i === 0 ? 0 : i === cu.length - 1 ? 2 : 2 + 2 * i))
  const nets = [...new Set(s.footprints.flatMap((f) => f.pads.map((p) => p.net).filter((n): n is string => !!n)))].sort()
  const code = new Map(nets.map((n, i) => [n, i + 1]))
  const netTok = (n: string | undefined): string => (!n ? '' : s.kicad10 ? ` (net "${n}")` : ` (net ${code.get(n)} "${n}")`)
  const stack = cu.flatMap((name, i) => [
    `\t\t\t(layer "${name}" (type "copper") (thickness 0.035))`,
    ...(i < cu.length - 1 ? [`\t\t\t(layer "dielectric ${i + 1}" (type "${i === Math.floor(cu.length / 2) - 1 ? 'core' : 'prepreg'}") (thickness 0.2) (material "FR4") (epsilon_r 4.4) (loss_tangent 0.02))`] : []),
  ])
  const fps = s.footprints.map((f) => {
    const side = f.side ?? 'F'
    const pads = f.pads.map((p) => {
      const kind = p.kind ?? 'smd'
      const layers = kind === 'thru_hole' ? '"*.Cu" "*.Mask"' : `"${p.layer ?? `${side}.Cu`}" "${side}.Mask" "${side}.Paste"`
      return `\t\t(pad "${p.num}" ${kind} rect (at ${p.x} ${p.y}${f.rot ? ` ${f.rot}` : ''}) (size ${p.w ?? 0.5} ${p.h ?? 0.5})${kind === 'thru_hole' ? ' (drill 0.6)' : ''} (layers ${layers})${netTok(p.net)} (uuid "${u()}"))`
    }).join('\n')
    return `\t(footprint "test:${f.ref}" (layer "${side}.Cu") (uuid "${u()}") (at ${f.x} ${f.y}${f.rot ? ` ${f.rot}` : ''})\n`
      + `\t\t(property "Reference" "${f.ref}" (at 0 0) (layer "${side}.SilkS") (uuid "${u()}") (effects (font (size 1 1) (thickness 0.15))))\n`
      + `\t\t(property "Value" "${f.ref}" (at 0 0) (layer "${side}.Fab") (uuid "${u()}") (effects (font (size 1 1) (thickness 0.15))))\n`
      + `\t\t(attr smd)\n${pads}\n\t)`
  }).join('\n')
  const zones = (s.zones ?? []).map((z) => `\t(zone${s.kicad10 ? ` (net "${z.net}")` : ` (net ${code.get(z.net)})`} (net_name "${z.net}") (layer "${z.layer}") (uuid "${u()}") (hatch edge 0.5)\n`
    + `\t\t(connect_pads (clearance 0.2)) (min_thickness 0.2) (filled_areas_thickness no)\n\t\t(fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n`
    + `\t\t(polygon (pts (xy 1 1) (xy ${s.width - 1} 1) (xy ${s.width - 1} ${s.height - 1}) (xy 1 ${s.height - 1})))\n\t)`).join('\n')
  return `(kicad_pcb
\t(version ${s.kicad10 ? 20260206 : 20241229})
\t(generator "pcbnew")
\t(generator_version "${s.kicad10 ? '10.0' : '9.0'}")
\t(general (thickness 1.6) (legacy_teardrops no))
\t(paper "A4")
\t(layers
${cu.map((n, i) => `\t\t(${ids[i]} "${n}" signal)`).join('\n')}
\t\t(9 "F.Adhes" user "F.Adhesive")
\t\t(11 "B.Adhes" user "B.Adhesive")
\t\t(13 "F.Paste" user)
\t\t(15 "B.Paste" user)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen")
\t\t(1 "F.Mask" user)
\t\t(3 "B.Mask" user)
\t\t(25 "Edge.Cuts" user)
\t\t(31 "F.CrtYd" user "F.Courtyard")
\t\t(29 "B.CrtYd" user "B.Courtyard")
\t\t(35 "F.Fab" user)
\t\t(33 "B.Fab" user)
\t)
\t(setup
\t\t(stackup
\t\t\t(layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
${stack.join('\n')}
\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
\t\t\t(copper_finish "None")
\t\t\t(dielectric_constraints no)
\t\t)
\t\t(pad_to_mask_clearance 0)
\t)
${s.kicad10 ? '' : `\t(net 0 "")\n${nets.map((n) => `\t(net ${code.get(n)} "${n}")`).join('\n')}\n`}${fps}
${zones}
${s.extra ?? ''}
\t(gr_rect (start 0 0) (end ${s.width} ${s.height}) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${u()}"))
)
`
}

/** A .kicad_pro with a Default net class. */
export function projectText(r: { track: number; clearance: number; via: number; drill: number } = { track: 0.2, clearance: 0.2, via: 0.6, drill: 0.3 }): string {
  return JSON.stringify({
    board: { design_settings: { rules: { min_clearance: 0.1, min_track_width: 0.1, min_via_diameter: 0.3, min_through_hole_diameter: 0.15 } } },
    meta: { filename: 'board.kicad_pro', version: 3 },
    net_settings: { classes: [{ name: 'Default', clearance: r.clearance, track_width: r.track, via_diameter: r.via, via_drill: r.drill, microvia_diameter: 0.3, microvia_drill: 0.1, wire_width: 6, bus_width: 12, line_style: 0, schematic_color: 'rgba(0, 0, 0, 0.000)', pcb_color: 'rgba(0, 0, 0, 0.000)', priority: 2147483647, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2 }], meta: { version: 4 } },
  }, null, 2)
}

/** Write a board (and its project) into a fresh folder as name.kicad_pcb / name.kicad_pro. */
export function writeBoard(s: BoardSpec, name = 'board', rules?: Parameters<typeof projectText>[0]): string {
  const d = mkdtempSync(join(tmpdir(), 'pcb-fixture-'))
  writeFileSync(join(d, `${name}.kicad_pcb`), boardText(s))
  writeFileSync(join(d, `${name}.kicad_pro`), projectText(rules))
  return join(d, `${name}.kicad_pcb`)
}

/** An n×n area array at `pitch`, centred on the footprint, nets `${prefix}<row>_<col>`. */
export function bga(ref: string, x: number, y: number, n: number, pitch: number, prefix = 'B'): FpSpec {
  const pads: PadSpec[] = []
  const off = ((n - 1) * pitch) / 2
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) pads.push({ num: `${String.fromCharCode(65 + r)}${c + 1}`, x: Math.round((c * pitch - off) * 1e4) / 1e4, y: Math.round((r * pitch - off) * 1e4) / 1e4, w: pitch * 0.45, h: pitch * 0.45, net: `${prefix}${r}_${c}` })
  }
  return { ref, x, y, pads }
}

/** An n×n area array with every ball also on a connector beside it, so each net has two pads to join. */
export function bgaWithFanout(n: number, pitch: number, prefix = 'B'): FpSpec[] {
  const u = bga('U1', 20, 20, n, pitch, prefix)
  return [u, header('J1', 2, 2, u.pads.map((p) => p.net as string), Math.min(0.35, 36 / (n * n)), { w: 0.2 })]
}

/** A single-row connector with pins on `nets`, at `pitch`. */
export function header(ref: string, x: number, y: number, nets: readonly string[], pitch = 1.27, opts: { w?: number; kind?: 'smd' | 'thru_hole' } = {}): FpSpec {
  return { ref, x, y, pads: nets.map((net, i) => ({ num: String(i + 1), x: 0, y: Math.round(i * pitch * 1e4) / 1e4, w: opts.w ?? 0.6, h: opts.w ?? 0.6, net, kind: opts.kind ?? 'smd' })) }
}
