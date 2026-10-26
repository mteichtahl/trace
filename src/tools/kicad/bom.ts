/**
 * Bills of materials from the schematic, and the JLCPCB assembly pair (BOM + CPL).
 *
 * A BOM line is one buyable part: placements are grouped by value, footprint and part number (MPN, manufacturer and
 * LCSC fields, under whatever names the design uses, see schematic.ts). Multi-unit symbols count once per reference.
 * Parts marked DNP, excluded from the BOM, or not on the board are kept out of the quantities and listed separately,
 * so nothing disappears silently. References within a line are in natural order (R2 before R10).
 *
 * JLCPCB's assembly service takes a BOM with columns Comment, Designator, Footprint, "LCSC Part #" and a placement
 * (CPL) file with Designator, Mid X, Mid Y, Layer, Rotation. The CPL comes from `kicad-cli pcb export pos --format csv
 * --units mm` (KiCad's own placement maths) with the columns renamed; DNP parts are left out of both.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { runCli } from './project.js'
import { isVirtual, lcscOf, manufacturerOf, mpnOf, naturalCompare, type Schematic, type Symbol } from './schematic.js'

export interface BomLine {
  quantity: number
  refs: string[]
  value: string
  footprint: string
  mpn: string | null
  manufacturer: string | null
  lcsc: string | null
  description: string | null
}

export interface Bom {
  lines: BomLine[]
  /** parts kept out of the quantities, with the reason */
  excluded: { ref: string; value: string; reason: 'dnp' | 'not_in_bom' | 'not_on_board' }[]
  total_parts: number
  unique_lines: number
  /** lines with no MPN or LCSC code (cannot be ordered as written) */
  missing_part_number: number
}

/** The footprint name without its library ("Resistor_SMD:R_0402_1005Metric" → "R_0402_1005Metric"). */
export const footprintName = (fp: string): string => fp.replace(/^[^:]*:/, '')

export function buildBom(sch: Schematic): Bom {
  const byRef = new Map<string, Symbol>()
  for (const s of sch.symbols) {
    if (isVirtual(s)) continue
    const prev = byRef.get(s.ref)
    if (!prev || s.unit < prev.unit) byRef.set(s.ref, s)
  }
  const excluded: Bom['excluded'] = []
  const groups = new Map<string, BomLine>()
  for (const s of [...byRef.values()].sort((a, b) => naturalCompare(a.ref, b.ref))) {
    const reason = s.dnp ? 'dnp' : !s.in_bom ? 'not_in_bom' : !s.on_board ? 'not_on_board' : null
    if (reason) {
      excluded.push({ ref: s.ref, value: s.value, reason })
      continue
    }
    const mpn = mpnOf(s)
    const mfr = manufacturerOf(s)
    const lcsc = lcscOf(s)
    const k = JSON.stringify([s.value, s.footprint, mpn ?? '', mfr ?? '', lcsc ?? ''])
    const line = groups.get(k)
    if (line) {
      line.quantity++
      line.refs.push(s.ref)
    } else {
      const desc = s.fields.Description?.trim()
      groups.set(k, { quantity: 1, refs: [s.ref], value: s.value, footprint: s.footprint, mpn, manufacturer: mfr, lcsc, description: desc || null })
    }
  }
  const lines = [...groups.values()].sort((a, b) => naturalCompare(a.refs[0] as string, b.refs[0] as string))
  return {
    lines, excluded,
    total_parts: lines.reduce((s, l) => s + l.quantity, 0),
    unique_lines: lines.length,
    missing_part_number: lines.filter((l) => !l.mpn && !l.lcsc).length,
  }
}

export function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function bomCsv(b: Bom): string {
  return toCsv(['Quantity', 'References', 'Value', 'Footprint', 'MPN', 'Manufacturer', 'LCSC', 'Description'],
    b.lines.map((l) => [l.quantity, l.refs.join(' '), l.value, l.footprint, l.mpn, l.manufacturer, l.lcsc, l.description]))
}

export function jlcBomCsv(b: Bom): string {
  return toCsv(['Comment', 'Designator', 'Footprint', 'LCSC Part #'],
    b.lines.map((l) => [l.value, l.refs.join(','), footprintName(l.footprint), l.lcsc]))
}

/** A small CSV reader (quoted fields, doubled quotes, CRLF), enough for kicad-cli's position file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '')
}

export interface Placement { ref: string; value: string; package: string; x_mm: number; y_mm: number; rotation_deg: number; side: 'top' | 'bottom' }

/** kicad-cli's position CSV (Ref,Val,Package,PosX,PosY,Rot,Side) → placements. */
export function parsePos(text: string): Placement[] {
  const rows = parseCsv(text)
  const hdr = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const col = (n: string): number => {
    const i = hdr.indexOf(n)
    if (i < 0) throw new ToolError(`kicad-cli's position file has no ${n} column (columns: ${hdr.join(', ')})`)
    return i
  }
  const [ir, iv, ip, ix, iy, irot, is] = ['ref', 'val', 'package', 'posx', 'posy', 'rot', 'side'].map(col) as number[]
  return rows.slice(1).map((r) => {
    const n = (i: number | undefined): number => {
      const v = Number(r[i as number])
      if (!Number.isFinite(v)) throw new ToolError(`unreadable number in the position file row ${r.join(',')}`)
      return v
    }
    return { ref: r[ir as number] ?? '', value: r[iv as number] ?? '', package: r[ip as number] ?? '', x_mm: n(ix), y_mm: n(iy),
      rotation_deg: n(irot), side: (r[is as number] ?? '').toLowerCase().startsWith('b') ? 'bottom' : 'top' }
  })
}

export function jlcCplCsv(ps: readonly Placement[]): string {
  const f = (x: number): string => `${Math.round(x * 1e4) / 1e4}mm`
  return toCsv(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'],
    [...ps].sort((a, b) => naturalCompare(a.ref, b.ref)).map((p) => [p.ref, f(p.x_mm), f(p.y_mm), p.side === 'bottom' ? 'Bottom' : 'Top', String(Math.round(p.rotation_deg * 1000) / 1000)]))
}

/** Placements from the board via kicad-cli (DNP footprints excluded). */
export async function placements(pcbPath: string, opts: { excludeDnp?: boolean; smdOnly?: boolean } = {}): Promise<Placement[]> {
  const tmp = scratchDir('trace-pos-')
  try {
    const out = join(tmp, 'pos.csv')
    const args = ['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both']
    if (opts.excludeDnp !== false) args.push('--exclude-dnp')
    if (opts.smdOnly) args.push('--smd-only')
    await runCli([...args, '-o', out, pcbPath], { timeoutMs: 300_000 })
    if (!existsSync(out)) throw new ToolError('kicad-cli did not write a position file')
    return parsePos(readFileSync(out, 'utf8'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
