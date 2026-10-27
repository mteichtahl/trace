import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Registry, ToolError } from '../../../src/core/registry.js'
import { Work } from '../../../src/core/store.js'
import { discover, fileVersion, fromPath, resolveProject } from '../../../src/tools/kicad/project.js'
import { tools } from '../../../src/tools/kicad/tools.js'
import { DEMO, DEMO_PCB, DEMO_PRO, DEMO_SCH, FIXTURES, hasKicad } from './helpers.js'

const reg = new Registry(tools)
const ctx = { hardware: false, via: 'test' } as const
type Dict = Record<string, unknown>
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, ctx)) as Dict

describe('project discovery', () => {
  it('maps any of the three files, or the folder, to the project', () => {
    for (const p of [DEMO_PRO, DEMO_PCB, DEMO]) {
      const pr = fromPath(p)
      expect(pr.name).toBe('demo')
      expect(pr.sch).toBe(DEMO_SCH)
      expect(pr.pcb).toBe(DEMO_PCB)
    }
    expect(() => fromPath(join(DEMO, 'nope.kicad_pcb'))).toThrow(ToolError)
    expect(() => fromPath(FIXTURES)).toThrow(/0 .kicad_pro/)
  })

  it('discovers projects and reads file versions', () => {
    expect(discover(join(DEMO, '..'))).toEqual([DEMO_PRO])
    expect(discover(FIXTURES)).toEqual([join(FIXTURES, 'demo', 'demo.kicad_pro')])
    expect(fileVersion(DEMO_SCH)).toEqual({ format: 20250114, generator: 'eeschema', generator_version: '9.0', kicad: '9' })
  })

  it('refuses to choose between several projects', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kp-'))
    writeFileSync(join(d, 'a.kicad_pro'), '{}')
    writeFileSync(join(d, 'b.kicad_pro'), '{}')
    await expect(resolveProject(d)).rejects.toThrow(/2 .kicad_pro files; name one: a.kicad_pro, b.kicad_pro/)
  })
})

describe('kicad tools (offline)', () => {
  it('registers exactly the eleven tools', () => {
    expect(reg.list().map((t) => t.name)).toEqual(['kicad.board', 'kicad.bom', 'kicad.components', 'kicad.drc', 'kicad.erc', 'kicad.export',
      'kicad.fab', 'kicad.net', 'kicad.net_length', 'kicad.netlist', 'kicad.projects'])
    for (const t of reg.list()) expect(Registry.jsonSchema(t)).toHaveProperty('type', 'object')
  })

  it('kicad.components lists parts and records the run', async () => {
    const r = await call('kicad.components', { project: DEMO_PRO, prefix: 'R' })
    expect(r.total).toBe(6)
    expect((r.components as Dict[]).map((c) => c.ref)).toEqual(['R1', 'R2', 'R3', 'R10', 'R101', 'R201'])
    const run = new Work().run(r.run_id as string)
    expect(run).toMatchObject({ kind: 'kicad.components', status: 'pass', summary: '6 parts' })
  })

  it('kicad.bom stores the CSV and writes it when asked', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bom-'))
    const r = await call('kicad.bom', { project: DEMO_SCH, out_dir: out, jlc: true })
    expect(r).toMatchObject({ total_parts: 7, unique_lines: 4, excluded_total: 2, lines_without_lcsc: 2 })
    expect(readFileSync(join(out, 'demo-jlc-bom.csv'), 'utf8')).toContain('R1,R2')
    const w = new Work()
    expect(new TextDecoder().decode(w.getArtifact(r.run_id as string, 'bom.csv') ?? new Uint8Array())).toContain('C101 C201')
    expect(w.run(r.run_id as string)?.measurements).toContainEqual({ name: 'parts', value: 7, unit: '' })
  })

  it('kicad.board summarises the board and lists footprints', async () => {
    const r = await call('kicad.board', { project: DEMO_PCB, trace_width_mm: 0.2, refs: ['C1'] })
    expect(r).toMatchObject({ outline: { width_mm: 50, height_mm: 30 }, copper_layers: 4, stackup_known: true, nets: 4, vias: 2,
      zones: { total: 1, copper: 1, keepout: 0 }, footprints: { total: 4, top: 3, bottom: 1 } })
    expect((r.stackup as Dict[])[0]?.z0_ohm).toBeGreaterThan(40)
    expect((r.footprint_list as Dict[])[0]).toMatchObject({ ref: 'C1', rotation_deg: 90 })
    expect((r.design_rules as Dict).rules).toMatchObject({ min_track_width: 0.15 })
  })

  it('kicad.net_length gives lengths, a path and its electrical figures', async () => {
    const r = await call('kicad.net_length', { project: DEMO_PCB, nets: ['MID', 'GND'], from: 'R1.2', to: 'C1.1' })
    const [mid, gnd] = r.nets as Dict[]
    expect(mid?.length_mm).toBeCloseTo(29.5 + Math.PI * 2.5, 3)
    expect(mid?.unreached_pads).toEqual(['R101.1'])
    expect(gnd?.length_mm).toBe(0)
    expect(r.path).toMatchObject({ from: 'R1.2', to: 'C1.1', vias: 2, model: 'analytic' })
    expect(r.note).toMatch(/pours/)
    await expect(call('kicad.net_length', { project: DEMO_PCB, nets: ['NOPE'] })).rejects.toThrow(/not a net/)
  })

  it('validates inputs', async () => {
    await expect(call('kicad.board', { project: DEMO_PCB, bogus: 1 })).rejects.toThrow(ToolError)
    await expect(call('kicad.net_length', { project: DEMO_PCB, nets: ['MID'], from: 'R1.2' })).rejects.toThrow(/from and to go together/)
  })
})

describe.skipIf(!hasKicad)('kicad tools through kicad-cli', () => {
  it('kicad.projects reports kicad-cli', async () => {
    const r = await call('kicad.projects', {})
    expect(r.kicad_cli_version).toMatch(/^\d+\.\d+/)
  })

  it('kicad.netlist and kicad.net', async () => {
    const nl = await call('kicad.netlist', { project: DEMO_PRO })
    expect(nl).toMatchObject({ nets_total: 6, components_total: 9, single_pin_nets: 2 })
    const n = await call('kicad.net', { project: DEMO_PRO, name: 'OUT' })
    expect(n.net).toBe('/Filter A/OUT')
    expect((n.nodes as Dict[]).map((x) => x.ref).sort()).toEqual(['C101', 'R101'])
    expect(n.routed).toMatchObject({ length_mm: 0, pads: 1 })
  })

  it('kicad.erc and kicad.drc record the full report', async () => {
    const e = await call('kicad.erc', { project: DEMO_PRO, limit: 3 })
    expect(e).toMatchObject({ errors: 2, listed: 35, omitted: 32 })
    const w = new Work()
    expect(w.run(e.run_id as string)?.status).toBe('fail')
    expect(w.getArtifact(e.run_id as string, 'erc-report.json')).not.toBeNull()
    const d = await call('kicad.drc', { project: DEMO_PRO, severity: 'error' })
    expect(d).toMatchObject({ unconnected: 2, parity_issues: 9 })
    expect((d.violations as Dict[]).every((v) => v.severity === 'error')).toBe(true)
  })

  it('kicad.fab writes a JLCPCB package', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fab-'))
    const r = await call('kicad.fab', { project: DEMO_PRO, out_dir: out })
    const files = (r.files as { path: string }[]).map((f) => f.path)
    expect(files).toEqual(expect.arrayContaining(['demo-gerbers.zip', 'demo-bom.csv', 'demo-jlc-bom.csv', 'demo-jlc-cpl.csv', 'demo-pos.csv']))
    expect(files.some((f) => f.startsWith('gerbers/') && f.endsWith('.drl'))).toBe(true)
    expect(files.some((f) => /gerbers\/demo-F_Cu\.(gtl|gbr)$/.test(f))).toBe(true)
    expect(r.placements).toBe(4)
    expect((r.warnings as string[]).join(' ')).toMatch(/no placement.*R201/)
    expect(readFileSync(join(out, 'demo-jlc-cpl.csv'), 'utf8')).toContain('R101,40mm,-20mm,Bottom,180')
    const zip = readFileSync(join(out, 'demo-gerbers.zip'))
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  })

  it('kicad.export writes plots and STEP', async () => {
    const out = mkdtempSync(join(tmpdir(), 'exp-'))
    const r = await call('kicad.export', { project: DEMO_PRO, out_dir: out, kinds: ['sch_pdf', 'pcb_svg', 'step'] })
    for (const f of ['demo-schematic.pdf', 'demo-board.svg', 'demo.step']) expect(existsSync(join(out, f))).toBe(true)
    expect(r.files_total).toBeGreaterThanOrEqual(3)
  }, 300_000)

  it('kicad.export keeps each sheet\'s drawing and the board\'s in its run, mapped to their files', async () => {
    const out = mkdtempSync(join(tmpdir(), 'exp-'))
    const r = await call('kicad.export', { project: DEMO_PRO, out_dir: out, kinds: ['sch_svg', 'pcb_svg'] })
    const drawings = r.drawings as { artifact: string; kind: string; file?: string; width_mm?: number }[]
    expect(drawings.some((d) => d.kind === 'sheet' && d.file?.endsWith('demo.kicad_sch') && (d.width_mm ?? 0) > 0)).toBe(true)
    expect(drawings.some((d) => d.kind === 'board')).toBe(true)
    const run = new Work().run(r.run_id as string)
    expect(run?.artifacts.map((a) => a.name)).toEqual(expect.arrayContaining(['drawings.json', ...drawings.map((d) => d.artifact)]))
  }, 300_000)
})
