/**
 * PCB implementation checks for the Implementation agent, read from the board file (no kicad-cli needed): placement
 * rules, length matching, and a floorplan summary by functional block. They report; none of them moves anything.
 * Tool names are pcb.*; the area lives in src/tools/layout so it stays apart from the router area (src/pcb).
 *
 *   pcb.placement_check  courtyard overlaps, parts outside / too near the edge, keep-out areas, decoupling distance,
 *                        connectors away from the edge
 *   pcb.length_match     diff pair skew and length-group matching against given or .kicad_dru tolerances
 *   pcb.floorplan        footprints grouped by sheet (or ref prefix, or given blocks): boxes, density, overlaps,
 *                        inter-block nets
 */
import { relative } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { netNames } from '../../kicad/pcb.js'
import { needPcb, resolveProject, type Project } from '../../kicad/project.js'
import { cap, recorded } from '../../kicad/record.js'
import { readLayout } from './board.js'
import { druRules, floorplan, GROUND, lengthMatch, netClasses, placementCheck, POWER } from './checks.js'
import { existsSync, readFileSync } from 'node:fs'

const project = z.string().optional().describe('path to a .kicad_pro, .kicad_sch or .kicad_pcb (or a folder with one project); omit for the configured/only project')
const subject = (p: Project): string => {
  const f = p.pcb ?? p.pro ?? p.name
  const r = relative(process.cwd(), f)
  return r && !r.startsWith('..') ? r : f
}
const re = (s: string, what: string): RegExp => {
  try {
    return new RegExp(s, 'i')
  } catch {
    throw new ToolError(`${what}: ${JSON.stringify(s)} is not a valid regex`)
  }
}

export const placementCheckTool = defineTool({
  name: 'pcb.placement_check',
  description: 'Placement rules on a KiCad board, from the file: courtyard overlaps (same side; courtyards as the convex hull of F/B.CrtYd), parts outside the Edge.Cuts outline or nearer the edge than edge_clearance_mm, parts in keep-out areas that forbid footprints (or pads in ones that forbid pads), decoupling capacitors (≤ decap_max_uf between a power rail and ground) farther than decap_max_mm from the nearest IC pin on their net, IC power pins with no capacitor near, and connectors farther than connector_edge_max_mm from the edge. Findings with refs, values and limits. Recorded; returns run_id.',
  input: z.object({
    project,
    edge_clearance_mm: z.number().min(0).default(0.5).describe('courtyard to board edge, for everything but connectors (0: only parts outside the edge)'),
    decap_max_mm: z.number().positive().default(3).describe('capacitor power pad to the nearest IC pin on the same net'),
    decap_max_uf: z.number().positive().default(10).describe('capacitors up to this value count as decoupling'),
    decap_refs: z.string().default('^C\\d').describe('regex of capacitor refs'),
    ic_refs: z.string().default('^(U|IC)\\d').describe('regex of IC refs'),
    connector_refs: z.string().default('^(J|P|CN|X)\\d').describe('regex of connector refs'),
    connector_edge_max_mm: z.number().min(0).default(2),
    interior_connectors: z.array(z.string()).default([]).describe('connector refs (globs) that belong inside the board (headers, test points)'),
    ground: z.string().optional().describe('regex of ground net names (default GND, AGND, VSS, 0V, …)'),
    power: z.string().optional().describe('regex of power nets a decoupling capacitor serves (default +rails, VCC/VDD/VBAT/VIN…, 3V3, 1V8…)'),
    min_overlap_mm2: z.number().min(0).default(0.001),
    ignore: z.array(z.string()).default([]).describe('refs (globs) to leave out: fiducials, logos, mounting holes'),
    limit: z.number().int().min(1).max(5000).default(200),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('pcb.placement_check', subject(p), a, async (run) => {
      const L = readLayout(needPcb(p))
      const r = placementCheck(L, {
        edge_clearance_mm: a.edge_clearance_mm, decap_max_mm: a.decap_max_mm, decap_max_uf: a.decap_max_uf, decap_refs: re(a.decap_refs, 'decap_refs'),
        ic_refs: re(a.ic_refs, 'ic_refs'), connector_refs: re(a.connector_refs, 'connector_refs'), connector_edge_max_mm: a.connector_edge_max_mm,
        interior_connectors: a.interior_connectors, ground: a.ground ? re(a.ground, 'ground') : GROUND, power: a.power ? re(a.power, 'power') : POWER, min_overlap_mm2: a.min_overlap_mm2, ignore: a.ignore,
      })
      const errors = r.findings.filter((f) => f.severity === 'error')
      const warnings = r.findings.filter((f) => f.severity === 'warning')
      run.measure('errors', errors.length)
      run.measure('warnings', warnings.length)
      run.artifact('findings.json', JSON.stringify(r.findings, null, 1), 'application/json')
      const c = cap(r.findings.sort((x, y) => ['error', 'warning', 'info'].indexOf(x.severity) - ['error', 'warning', 'info'].indexOf(y.severity)), a.limit)
      const passed = errors.length === 0
      return {
        status: passed ? 'pass' as const : 'fail' as const,
        summary: `${errors.length} error(s), ${warnings.length} warning(s): ${Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'clean'}`,
        result: {
          passed, footprints: L.footprints.length, outline: L.outline ? 'Edge.Cuts loop' : 'none found (edge checks skipped)', cutouts: L.cutouts.length, keepouts: L.keepouts.length,
          counts: r.counts, findings: c.items, findings_omitted: c.omitted, decoupling: r.decoupling, connectors: r.connectors,
        },
      }
    })
  },
})

export const lengthMatchTool = defineTool({
  name: 'pcb.length_match',
  description: 'Length matching on a routed KiCad board: differential pair skew (pairs found as KiCad pairs them, names ending +/- or P/N, plus pairs given) and length groups (nets or globs, matched to the longest or a target), against tolerances given here or skew/length constraints in the .kicad_dru (conditions on A.NetClass, A.NetName, A.inDiffPair). Lengths are routed copper: pad-to-pad for two-pad nets (with delay when the stackup is known), total otherwise; via barrels included unless include_vias is false. Recorded; returns run_id.',
  input: z.object({
    project,
    pairs: z.array(z.object({ p: z.string(), n: z.string(), max_skew_mm: z.number().nonnegative().optional() }).strict()).optional(),
    auto_pairs: z.boolean().default(true).describe('also check every +/- and P/N pair on the board'),
    max_skew_mm: z.number().nonnegative().optional().describe('skew tolerance for pairs without their own (else the .kicad_dru rule)'),
    groups: z.array(z.object({ name: z.string(), nets: z.array(z.string()).min(1).describe('net names or globs, e.g. ["/DDR/DQ*"]'), tolerance_mm: z.number().nonnegative().optional(), target_mm: z.number().positive().optional() }).strict()).optional(),
    include_vias: z.boolean().default(true),
    limit: z.number().int().min(1).max(2000).default(200),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('pcb.length_match', subject(p), a, async (run) => {
      const L = readLayout(needPcb(p))
      const dru = p.pro ? p.pro.replace(/\.kicad_pro$/, '.kicad_dru') : null
      const rules = dru && existsSync(dru) ? druRules(readFileSync(dru, 'utf8')) : { rules: [], skipped: [] }
      let r: ReturnType<typeof lengthMatch>
      try {
        r = lengthMatch(L.board, netNames(L.board), { pairs: a.pairs, auto_pairs: a.auto_pairs, max_skew_mm: a.max_skew_mm, groups: a.groups, include_vias: a.include_vias, rules: rules.rules, netClass: netClasses(p.pro) })
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e))
      }
      for (const pr of r.pairs as { p: string; skew_mm: number }[]) run.measure(`skew.${pr.p}`, pr.skew_mm, 'mm')
      for (const g of r.groups as { name: string; spread_mm: number }[]) run.measure(`spread.${g.name}`, g.spread_mm, 'mm')
      const pc = cap(r.pairs, a.limit)
      const passed = r.failures === 0
      return {
        status: passed ? 'pass' as const : 'fail' as const,
        summary: `${r.pairs.length} pair(s), ${r.groups.length} group(s): ${r.failures} failing, ${r.unknown} without a tolerance`,
        result: {
          passed, pairs: pc.items, pairs_omitted: pc.omitted, groups: r.groups, failures: r.failures, without_tolerance: r.unknown,
          dru_rules: rules.rules.map((x) => ({ name: x.name, condition: x.condition, skew_max_mm: x.skew_max_mm ?? null, length: x.length ?? null })),
          ...(rules.skipped.length ? { dru_skipped: rules.skipped } : {}),
          note: 'routed copper only: unrouted or partly routed nets are reported as unrouted',
        },
      }
    })
  },
})

export const floorplanTool = defineTool({
  name: 'pcb.floorplan',
  description: 'Placement summarised by functional block: footprints grouped by schematic sheet (hierarchical sheet name), by ref prefix, or by given blocks (ref globs); per block the count, sides, bounding box, area, courtyard density and centroid; block boxes that overlap (intermixed blocks); how many nets join each pair of blocks (ground excluded); board area and courtyard utilisation per side. A report: no placement is changed. Recorded; returns run_id.',
  input: z.object({
    project,
    group_by: z.enum(['sheet', 'ref_prefix']).default('sheet'),
    blocks: z.array(z.object({ name: z.string(), refs: z.array(z.string()).min(1) }).strict()).optional().describe('explicit blocks: [{"name":"power","refs":["U1","C1*","L1"]}] (overrides group_by)'),
    refs_per_block: z.number().int().min(0).max(5000).default(40),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('pcb.floorplan', subject(p), a, async (run) => {
      const L = readLayout(needPcb(p))
      const f = floorplan(L, { group_by: a.group_by, blocks: a.blocks, limitRefs: a.refs_per_block })
      run.measure('blocks', f.blocks.length)
      if (f.board.utilisation.top !== null) run.measure('utilisation.top', f.board.utilisation.top)
      if (f.board.utilisation.bottom !== null) run.measure('utilisation.bottom', f.board.utilisation.bottom)
      return {
        status: 'pass' as const,
        summary: `${f.blocks.length} block(s) by ${a.blocks ? 'given blocks' : a.group_by}, ${f.overlaps.length} overlapping pair(s)`,
        result: { ...f, unassigned: f.unassigned.slice(0, 200) },
      }
    })
  },
})

export const tools: AnyTool[] = [placementCheckTool, lengthMatchTool, floorplanTool] as unknown as AnyTool[]
