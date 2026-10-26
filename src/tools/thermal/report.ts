/**
 * The Markdown report a thermal run stores as `report.md` (as Antmicro's `tpre report` documents a case's settings):
 * the settings, boundary conditions with the converged film coefficients, materials with their sources, the mesh,
 * the results, the margins and the caveats. Every figure in it names its source.
 */
import { type Coefficient, type Environment, type FilmIteration, type Surface, SURFACES } from './convection.js'
import { AIR_SOURCE, COPPER, EMISSIVITY, FR4 } from './materials.js'
import type { JunctionResult } from './junction.js'

const f = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))

export interface ReportInput {
  title: string
  run_id: string
  solver: string
  board?: string
  envelope?: string
  environment: Environment
  ambient_c: number
  sink_c: number
  coefficients: Record<Surface, Coefficient>
  film_iterations: FilmIteration[]
  film_converged: boolean
  mesh: Record<string, string | number>
  materials?: Record<string, string>
  balance?: { input_w: number; out_w: number; error: number }
  parts?: { ref: string; power_w: number; board_c: number }[]
  hotspot?: { x_mm: number; y_mm: number; layer: string; t_c: number }
  junctions?: JunctionResult[]
  transient?: { name: string; t90_s: number | null; t_steady_s: number | null; max_c: number }[]
  validation?: { case: string; model: number; reference: number; error_pct: number; tolerance_pct: number }[]
  assumptions?: string[]
  caveats: string[]
}

export function report(r: ReportInput): string {
  const e = r.environment
  const L: string[] = [`# ${r.title}`, '', `Run \`${r.run_id}\`, solver **${r.solver}**${r.board ? `, board \`${r.board}\`` : ''}${r.envelope ? `, envelope \`${r.envelope}\`` : ''}.`, '']
  L.push('## Settings', '', '| Setting | Value | Source |', '| --- | --- | --- |')
  L.push(`| environment | ${e.kind}${e.kind === 'forced' ? `, ${e.airflow_m_s} m/s` : ''} | envelope |`)
  L.push(`| ambient | ${f(r.ambient_c, 1)} °C | envelope corner |`)
  if (r.sink_c !== r.ambient_c) L.push(`| internal air | ${f(r.sink_c, 1)} °C | sealed-enclosure wall network (convection.sealedInternal) |`)
  L.push(`| orientation | ${e.orientation} | envelope |`, `| altitude | ${e.altitude_m} m | envelope (air properties: ${AIR_SOURCE}) |`)
  L.push(`| radiation | ${e.radiation ? `on, emissivity top ${e.emissivity.top}, bottom ${e.emissivity.bottom}, edge ${e.emissivity.edge}` : 'off'} | ${EMISSIVITY.solder_mask.source} |`)
  if (e.h_multiplier !== 1) L.push(`| h multiplier | ${e.h_multiplier.toPrecision(4)} | thermal_corrections (calibration) |`)
  L.push('', '## Boundary conditions', '', '| Surface | h (W/m² K) | Correlation | Ra / Re | L (m) | Film (°C) |', '| --- | --- | --- | --- | --- | --- |')
  for (const s of SURFACES) {
    const c = r.coefficients[s]
    L.push(`| ${s} | ${f(c.h, 3)} | ${c.correlation}${c.out_of_range ? ' (outside its stated range)' : ''} | ${c.ra !== undefined ? c.ra.toExponential(3) : c.re !== undefined ? `Re ${c.re.toExponential(3)}` : '—'} | ${f(c.char_length_m, 4)} | ${f(c.film_c, 1)} |`)
  }
  L.push('', `Film-temperature iteration: ${r.film_iterations.length} iteration(s), ${r.film_converged ? 'converged' : '**not converged**'} (assumed vs solved surface rise).`, '')
  L.push('', '## Materials', '', '| Material | Figure | Source |', '| --- | --- | --- |')
  L.push(`| copper | k ${COPPER.k.value} W/m K | ${COPPER.k.source} |`, `| laminate | k_z ${FR4.k_through.value}, k_xy ${FR4.k_inplane.value} W/m K (unless overridden) | ${FR4.k_through.source} (verified: null) |`)
  for (const [k, v] of Object.entries(r.materials ?? {})) L.push(`| ${k} | ${v} | run arguments |`)
  L.push('', '## Mesh', '', ...Object.entries(r.mesh).map(([k, v]) => `- ${k}: ${v}`), '')
  if (r.balance) L.push('## Energy balance', '', `Heat in ${f(r.balance.input_w, 4)} W, out ${f(r.balance.out_w, 4)} W, error ${(r.balance.error * 100).toExponential(2)} %.`, '')
  if (r.hotspot) L.push('## Results', '', `Hot spot ${f(r.hotspot.t_c, 2)} °C on ${r.hotspot.layer} at (${f(r.hotspot.x_mm, 2)}, ${f(r.hotspot.y_mm, 2)}) mm.`, '')
  if (r.parts?.length) {
    L.push('| Part | Power (W) | Board under it (°C) |', '| --- | --- | --- |')
    for (const p of r.parts) L.push(`| ${p.ref} | ${f(p.power_w, 4)} | ${f(p.board_c, 2)} |`)
    L.push('')
  }
  if (r.junctions?.length) {
    L.push('## Margins', '', '| Part | Ambient (°C) | Tj (°C) | Method | Tj max | Derated | Margin | Derated margin | Status |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const j of r.junctions) L.push(`| ${j.ref} | ${f(j.ambient_c, 1)} | ${f(j.tj_c, 1)} | ${j.method ?? '—'} | ${f(j.tj_max_c, 0)} | ${f(j.derated_limit_c, 0)} | ${f(j.margin_c, 1)} | ${f(j.derated_margin_c, 1)} | ${j.status} |`)
    L.push('', 'Each metric\'s source is in the part limits\' citations (thermal.envelope); each caveat is in the tool result.', '')
  }
  if (r.transient?.length) {
    L.push('## Transient', '', '| Series | t90 (s) | t steady (s) | max (°C) |', '| --- | --- | --- | --- |')
    for (const t of r.transient) L.push(`| ${t.name} | ${f(t.t90_s, 1)} | ${f(t.t_steady_s, 1)} | ${f(t.max_c, 2)} |`)
    L.push('')
  }
  if (r.validation?.length) {
    L.push('## Validation', '', '| Case | Model | Reference | Error | Tolerance |', '| --- | --- | --- | --- | --- |')
    for (const v of r.validation) L.push(`| ${v.case} | ${f(v.model, 4)} | ${f(v.reference, 4)} | ${f(v.error_pct, 2)} % | ${v.tolerance_pct} % |`)
    L.push('')
  }
  if (r.assumptions?.length) L.push('## Assumptions', '', ...r.assumptions.map((a) => `- ${a}`), '')
  L.push('## Caveats', '', ...r.caveats.map((c) => `- ${c}`), '')
  return L.join('\n')
}

export const BOARD_CAVEATS = [
  'No CFD: airflow enters only through the film coefficients (textbook correlations at the film temperature); air temperature is uniform.',
  'Component bodies are not modelled: all of a part\'s heat enters the board through its pads (pessimistic for parts that shed heat from their top).',
  'Pads are perfectly attached; solder voids, thermal interface materials and solder mask under parts are ignored.',
  'Radiation exchanges with surroundings at the sink temperature with a view factor of 1.',
  'Laminate properties are typical figures (verified: null) unless overridden; check the laminate datasheet.',
]
