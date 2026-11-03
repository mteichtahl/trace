/**
 * Findings files as a list. kicad-cli's JSON ERC and DRC reports (erc-report.json, drc-report.json; drc-report also from the autorouter) as
 * findings: severity error blocks, warning must be fixed or waived, an excluded one is waived. ERC lists violations
 * per sheet; DRC lists violations, unconnected items and schematic parity. Positions are in the report's
 * coordinate_units (mm, in, mils), kept in millimetres. Also the tools' own findings files: design.pins_check's
 * pin-findings.json (id, severity blocks/fix, text) and emc.precheck's findings.json (rule, severity error/warn/info,
 * message, net, layer).
 */
import type { PictureFinding } from '@/lib/types-s1'

interface Item { description?: string; pos?: { x?: number; y?: number } }
interface Violation { type?: string; severity?: string; description?: string; items?: Item[]; excluded?: boolean }

export interface KicadReport {
  check: 'erc' | 'drc' | 'findings'
  version: string | null
  findings: PictureFinding[]
  counts: { blocks: number; fix: number; waived: number }
}

const factor = (u: unknown) => (u === 'in' ? 25.4 : u === 'mils' ? 0.0254 : 1)

/** The report, or null when the JSON is not a kicad-cli ERC or DRC report. */
export function readKicadReport(text: string): KicadReport | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (Array.isArray(j)) return readFindingsArray(j)
  if (!j || typeof j !== 'object') return null
  const erc = Array.isArray(j.sheets)
  const drc = Array.isArray(j.violations) || Array.isArray(j.unconnected_items)
  if (!erc && !drc) return null
  const f = factor(j.coordinate_units)
  const list: { v: Violation; where: string; sheet?: string }[] = erc
    ? (j.sheets as { path?: string; violations?: Violation[] }[]).flatMap((s) => (s.violations ?? []).map((v) => ({ v, where: `sheet ${s.path ?? '/'}`, sheet: s.path ?? '/' })))
    : [
        ...((j.violations as Violation[] | undefined) ?? []).map((v) => ({ v, where: '' })),
        ...((j.unconnected_items as Violation[] | undefined) ?? []).map((v) => ({ v, where: 'unconnected' })),
        ...((j.schematic_parity as Violation[] | undefined) ?? []).map((v) => ({ v, where: 'schematic parity' })),
      ]
  if (list.some(({ v }) => !v || typeof v !== 'object')) return null
  const rank = { blocks: 0, fix: 1, waived: 2 }
  const findings: PictureFinding[] = list.map(({ v, where, sheet }, i) => {
    const severity: PictureFinding['severity'] = v.excluded || v.severity === 'exclusion' ? 'waived' : v.severity === 'error' ? 'blocks' : 'fix'
    const items = (v.items ?? []).map((it) => it.description).filter(Boolean)
    const pos = v.items?.find((it) => it.pos)?.pos
    const text = [v.description || v.type || 'Violation', ...items.slice(0, 3)].join(' · ')
    return {
      id: `k${i}`, severity, text,
      where: [v.type, where].filter(Boolean).join(', '),
      ...(pos && typeof pos.x === 'number' && typeof pos.y === 'number' ? { x_mm: Math.round(pos.x * f * 1e3) / 1e3, y_mm: Math.round(pos.y * f * 1e3) / 1e3 } : {}),
      ...(sheet ? { sheet } : {}),
    }
  }).sort((a, b) => rank[a.severity] - rank[b.severity])
  const counts = { blocks: 0, fix: 0, waived: 0 }
  for (const x of findings) counts[x.severity]++
  return { check: erc ? 'erc' : 'drc', version: typeof j.kicad_version === 'string' ? j.kicad_version : null, findings, counts }
}

type Loose = Record<string, unknown>

/** A JSON array of findings (pin-findings.json, emc findings.json), or null when it is not one. */
function readFindingsArray(a: unknown[]): KicadReport | null {
  if (!a.every((x) => x && typeof x === 'object' && typeof (x as Loose).severity === 'string' && (typeof (x as Loose).text === 'string' || typeof (x as Loose).message === 'string'))) return null
  const sev = (s: string): PictureFinding['severity'] => (s === 'blocks' || s === 'error' ? 'blocks' : s === 'waived' || s === 'exclusion' ? 'waived' : 'fix')
  const rank = { blocks: 0, fix: 1, waived: 2 }
  const findings = (a as Loose[]).map((x, i): PictureFinding => {
    const at = x.at as { x_mm?: number; y_mm?: number } | null | undefined
    // an advisory (emc's info) has no severity of its own in the list: it reads as fix-or-waive and says so
    const where = [x.severity === 'info' ? 'advisory' : null, x.rule ?? x.kind, x.net && `net ${String(x.net)}`, x.layer, x.target].filter(Boolean).map(String).join(', ')
    return {
      id: typeof x.id === 'string' ? x.id : `f${i}`,
      severity: sev(String(x.severity)),
      text: String(x.text ?? x.message),
      ...(where ? { where } : {}),
      ...(at && typeof at.x_mm === 'number' && typeof at.y_mm === 'number' ? { x_mm: at.x_mm, y_mm: at.y_mm } : {}),
    }
  }).sort((p, q) => rank[p.severity] - rank[q.severity])
  const counts = { blocks: 0, fix: 0, waived: 0 }
  for (const x of findings) counts[x.severity]++
  return { check: 'findings', version: null, findings, counts }
}
