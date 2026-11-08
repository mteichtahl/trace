/**
 * ERC and DRC, run by KiCad itself.
 *
 * The electrical rules check (schematic) and design rules check (board) are KiCad's: re-implementing them would only
 * give different answers. These functions run `kicad-cli sch erc` / `kicad-cli pcb drc` with `--format json
 * --severity-all` (DRC optionally with `--schematic-parity`), read the report from a scratch directory, and reduce it
 * to what an agent needs: counts by severity, counts by violation type, and each violation with the items it names
 * (reference or uuid, description, position). The report is validated with zod, so a format change fails loudly
 * instead of reading as "no violations". Without kicad-cli these throw ToolError; nothing is ever made up.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { runCli } from './project.js'

const Pos = z.object({ x: z.number(), y: z.number() }).loose()
const Item = z.object({ description: z.string().default(''), pos: Pos.optional(), uuid: z.string().optional() }).loose()
const Violation = z.object({
  type: z.string(),
  severity: z.string(),
  description: z.string().default(''),
  items: z.array(Item).default([]),
  excluded: z.boolean().optional(),
}).loose()
const ErcReport = z.object({
  kicad_version: z.string().optional(),
  coordinate_units: z.string().optional(),
  sheets: z.array(z.object({ path: z.string().default('/'), violations: z.array(Violation).default([]) }).loose()).default([]),
}).loose()
const DrcReport = z.object({
  kicad_version: z.string().optional(),
  coordinate_units: z.string().optional(),
  violations: z.array(Violation).default([]),
  unconnected_items: z.array(Violation).default([]),
  schematic_parity: z.array(Violation).default([]),
}).loose()

export interface CheckItem {
  ref: string | null
  uuid: string | null
  description: string
  pos: { x_mm: number; y_mm: number } | null
}

export interface CheckViolation {
  type: string
  severity: 'error' | 'warning' | 'exclusion' | string
  description: string
  /** ERC: the sheet; DRC: 'violations' | 'unconnected' | 'parity' */
  where: string
  items: CheckItem[]
}

export interface CheckReport {
  check: 'erc' | 'drc'
  kicad_version: string | null
  errors: number
  warnings: number
  excluded: number
  by_type: Record<string, number>
  violations: CheckViolation[]
  unconnected?: number
  parity?: number
}

/** "Symbol C101 [C]" → C101; "Footprint R4" → R4; "Pad 2 [GND] of U1 on F.Cu" → U1; else null. */
export function refFromDescription(d: string): string | null {
  const m = /^(?:Symbol|Footprint)\s+([^\s[\]]+)/.exec(d) ?? /\bof\s+([A-Za-z#]+[0-9]+[A-Za-z0-9_]*)\b/.exec(d)
  return m?.[1] ?? null
}

const factor = (units: string | undefined): number => (units === 'in' ? 25.4 : units === 'mils' ? 0.0254 : 1)

/**
 * DRC types that are always errors, whatever the board's own severity settings say (design.silkscreen in the prompt
 * catalog): silkscreen is never interrupted by solder mask, so KiCad's "Silkscreen clipped by solder mask" blocks the board.
 */
export const ALWAYS_ERRORS: ReadonlySet<string> = new Set(['silk_over_copper'])

function convert(v: z.output<typeof Violation>, where: string, units: string | undefined): CheckViolation {
  const f = factor(units)
  // an always-error type stays an error even when the board file excludes it: it is fixed, never waived
  const severity = ALWAYS_ERRORS.has(v.type) ? 'error' : v.excluded ? 'exclusion' : v.severity
  return {
    type: v.type, severity, description: v.description, where,
    items: v.items.map((it) => ({
      ref: refFromDescription(it.description), uuid: it.uuid ?? null, description: it.description,
      pos: it.pos ? { x_mm: Math.round(it.pos.x * f * 1e4) / 1e4, y_mm: Math.round(it.pos.y * f * 1e4) / 1e4 } : null,
    })),
  }
}

function summarise(check: 'erc' | 'drc', version: string | null, vs: CheckViolation[]): CheckReport {
  const by: Record<string, number> = {}
  for (const v of vs) by[v.type] = (by[v.type] ?? 0) + 1
  const rank = (s: string): number => (s === 'error' ? 0 : s === 'warning' ? 1 : 2)
  return {
    check, kicad_version: version,
    errors: vs.filter((v) => v.severity === 'error').length,
    warnings: vs.filter((v) => v.severity === 'warning').length,
    excluded: vs.filter((v) => v.severity === 'exclusion').length,
    by_type: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1])),
    violations: [...vs].sort((a, b) => rank(a.severity) - rank(b.severity)),
  }
}

export function parseErc(text: string): CheckReport {
  const r = ErcReport.safeParse(JSON.parse(text))
  if (!r.success) throw new ToolError(`kicad-cli wrote an ERC report this reader does not understand: ${r.error.issues[0]?.message ?? ''}`)
  const vs = r.data.sheets.flatMap((s) => s.violations.map((v) => convert(v, s.path, r.data.coordinate_units)))
  return summarise('erc', r.data.kicad_version ?? null, vs)
}

export function parseDrc(text: string): CheckReport {
  const r = DrcReport.safeParse(JSON.parse(text))
  if (!r.success) throw new ToolError(`kicad-cli wrote a DRC report this reader does not understand: ${r.error.issues[0]?.message ?? ''}`)
  const u = r.data.coordinate_units
  const vs = [
    ...r.data.violations.map((v) => convert(v, 'violations', u)),
    ...r.data.unconnected_items.map((v) => convert(v, 'unconnected', u)),
    ...r.data.schematic_parity.map((v) => convert(v, 'parity', u)),
  ]
  return { ...summarise('drc', r.data.kicad_version ?? null, vs), unconnected: r.data.unconnected_items.length, parity: r.data.schematic_parity.length }
}

async function runReport(args: string[], timeoutMs: number): Promise<string> {
  const tmp = scratchDir('trace-check-')
  try {
    const out = join(tmp, 'report.json')
    // kicad-cli exits 0 with violations (we never pass --exit-code-violations); other codes are failures
    await runCli([...args.slice(0, -1), '--format', 'json', '--severity-all', '--units', 'mm', '-o', out, args[args.length - 1] as string], { timeoutMs })
    if (!existsSync(out)) throw new ToolError('kicad-cli did not write a report')
    return readFileSync(out, 'utf8')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** ERC on a schematic: [the compact report, kicad-cli's raw JSON (to store)]. */
export async function erc(schPath: string, timeoutMs = 600_000): Promise<[CheckReport, string]> {
  const raw = await runReport(['sch', 'erc', schPath], timeoutMs)
  return [parseErc(raw), raw]
}

/** DRC on a board, optionally checking it against its schematic. */
export async function drc(pcbPath: string, opts: { parity?: boolean; refillZones?: boolean; timeoutMs?: number } = {}): Promise<[CheckReport, string]> {
  const args = ['pcb', 'drc']
  if (opts.parity) args.push('--schematic-parity')
  if (opts.refillZones) args.push('--refill-zones')
  const raw = await runReport([...args, pcbPath], opts.timeoutMs ?? 1_200_000)
  return [withSilenced(parseDrc(raw), silencedRules(pcbPath)), raw]
}

/**
 * The always-error rules (ALWAYS_ERRORS) the board's project file sets to "ignore": KiCad does not even look for
 * those, so the check is turned off rather than passed. Read from the .kicad_pro next to the board.
 */
export function silencedRules(pcbPath: string): string[] {
  const pro = pcbPath.replace(/\.kicad_pcb$/, '.kicad_pro')
  try {
    if (pro === pcbPath || !existsSync(pro)) return []
    const sev = (JSON.parse(readFileSync(pro, 'utf8')) as { board?: { design_settings?: { rule_severities?: Record<string, unknown> } } })
      .board?.design_settings?.rule_severities ?? {}
    return [...ALWAYS_ERRORS].filter((t) => sev[t] === 'ignore')
  } catch {
    return []
  }
}

/** A report with one error for each always-error rule the project turned off. */
export function withSilenced(r: CheckReport, silenced: readonly string[]): CheckReport {
  if (!silenced.length) return r
  const added: CheckViolation[] = silenced.map((type) => ({
    type, severity: 'error', where: 'violations', items: [],
    description: `The project file sets ${type} to "ignore", so KiCad did not check it. trace always checks it: set it back to error in Board Setup.`,
  }))
  return { ...summarise('drc', r.kicad_version, [...r.violations, ...added]), unconnected: r.unconnected, parity: r.parity }
}

/**
 * The libraries a check says the project's configuration does not include ("The current configuration does not
 * include the symbol library 'power'"): KiCad's own libraries the project's library tables leave out, not a fault of
 * the design. test-esp32-run2: 67 such warnings on a fresh schematic, and the next step asked a person to waive 50 of
 * them, where adding the libraries to sym-lib-table / fp-lib-table clears them all (run 2 of test-esp32 did so). Pure.
 */
export function missingLibraries(r: Pick<CheckReport, 'violations'>): { symbol: string[]; footprint: string[]; findings: number } {
  const symbol = new Set<string>()
  const footprint = new Set<string>()
  let findings = 0
  for (const v of r.violations) {
    const m = /does not include the (symbol|footprint) library '([^']+)'/i.exec(v.description)
    if (!m) continue
    findings++
    ;(m[1]!.toLowerCase() === 'symbol' ? symbol : footprint).add(m[2]!)
  }
  return { symbol: [...symbol].sort(), footprint: [...footprint].sort(), findings }
}

/** What to do about them, for the agent: add the libraries, then check again. Null when there are none. */
export function libraryTablesHint(r: Pick<CheckReport, 'violations' | 'kicad_version'>): Record<string, unknown> | null {
  const m = missingLibraries(r)
  if (!m.findings) return null
  // KiCad names its library folders by major version: KICAD9_SYMBOL_DIR, KICAD10_SYMBOL_DIR
  const major = /^(\d+)\./.exec(r.kicad_version ?? '')?.[1] ?? '9'
  return {
    findings: m.findings, missing_symbol_libraries: m.symbol, missing_footprint_libraries: m.footprint,
    next: `${m.findings} of these findings say the project's library tables leave out KiCad libraries it uses. They are fixed, not waived: add each to the project's sym-lib-table (uri "\${KICAD${major}_SYMBOL_DIR}/<name>.kicad_sym") and fp-lib-table (uri "\${KICAD${major}_FOOTPRINT_DIR}/<name>.pretty"), type KiCad, next to the project's own entries, commit, and run the check again. Never ask a person to waive them.`,
  }
}
