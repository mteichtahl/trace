/**
 * render.showcase (docs/revision-renders.md): the names, dates and case looks it works out; a case shot without a case;
 * and, where Blender is installed, a real draft render of the sample board in its case with colours from a logo,
 * read back by the ontology as the revision's renders.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { buildGraph } from '../../../src/ontology/graph.js'
import { findBlender } from '../../../src/tools/render/blender.js'
import { caseLook, caseScrews, dayIn, outlineBounds, projectSlug, shotName, showcase, svgColours } from '../../../src/tools/render/showcase.js'
import { extraCaseParts, offBoardDrawn, recordFacts, showcaseName } from '../../../src/tools/render/subject.js'

/** A small SVG logo in the same colours as logo.png: navy block (used twice), red bar, grey band, white text. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256">
  <rect x="20" y="40" width="360" height="176" rx="24" fill="#1D3557"/>
  <path d="M30 50h20v20h-20z" style="fill:#1d3557;stroke:none"/>
  <rect x="400" y="40" width="90" height="176" fill="rgb(230, 57, 70)"/>
  <rect x="60" y="110" width="280" height="36" fill="#a8b0ba"/>
  <text x="80" y="140" fill="#fff" stroke="currentColor">ACME</text>
</svg>`

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIX = join(ROOT, 'test', 'fixtures', 'showcase')
const PCB = 'hardware/trace-sample.kicad_pro'
const run = (a: Record<string, unknown>) => showcase.run(showcase.input.parse(a) as never, { hardware: false, via: 'test' }) as Promise<Record<string, unknown>>

/** The sample project in a fresh repository, with its case and logo when asked. */
function sample(o: { case?: boolean; screws?: boolean; logo?: boolean | 'svg' } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-showcase-'))
  cpSync(join(ROOT, 'templates', 'sample', 'hardware'), join(dir, 'hardware'), { recursive: true })
  mkdirSync(join(dir, '.git'))
  copyFileSync(join(FIX, 'board.glb'), join(dir, 'board.glb'))
  if (o.case) {
    mkdirSync(join(dir, 'mechanical', 'out'), { recursive: true })
    for (const f of ['case-base.stl', 'case-lid.stl']) copyFileSync(join(FIX, f), join(dir, 'mechanical', 'out', f))
    copyFileSync(join(ROOT, 'test', 'fixtures', 'case-build', 'good', 'case.json'), join(dir, 'mechanical', 'case.json'))
    if (o.screws) copyFileSync(join(FIX, 'case-screws.jsonld'), join(dir, 'mechanical', 'out', 'case.jsonld'))
  }
  if (o.logo) {
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true })
    if (o.logo === 'svg') writeFileSync(join(dir, 'docs', 'design', 'logo.svg'), SVG)
    else copyFileSync(join(FIX, 'logo.png'), join(dir, 'docs', 'design', 'logo.png'))
  }
  return dir
}

const cwd = process.cwd()
afterEach(() => process.chdir(cwd))

describe('names, days and looks', () => {
  it('names each picture by project, revision, day and shot', () => {
    expect(shotName('Test ESP32', 'B', '2026-11-05', 'exploded')).toBe('test-esp32_rev-B_2026-11-05_exploded.png')
    expect(shotName('Test ESP32', 'B', '2026-11-05', 'turntable')).toBe('test-esp32_rev-B_2026-11-05_turntable.mp4')
    expect(projectSlug('--My__Board v2--')).toBe('my-board-v2')
    expect(projectSlug('***')).toBe('project')
  })

  it('takes the day in the time zone given, else UTC', () => {
    const at = new Date('2026-11-04T20:30:00Z')
    expect(dayIn(at)).toBe('2026-11-04')
    expect(dayIn(at, 'Australia/Melbourne')).toBe('2026-11-05')
    expect(dayIn(at, 'Not/A_Zone')).toBe('2026-11-04')
  })

  it('shows the case as what it is made of', () => {
    expect(caseLook(undefined)).toBe('nylon')
    expect(caseLook({ process: 'MJF', material: 'PA12-HP' })).toBe('nylon')
    expect(caseLook({ process: 'MJF', material: 'PAC-HP' })).toBe('black')
    expect(caseLook({ process: 'SLA', material: '9600' })).toBe('resin')
    expect(caseLook({ process: 'SLA', material: 'Black Resin' })).toBe('black')
    expect(caseLook({ process: 'FDM', material: 'PLA' })).toBe('pla')
    expect(caseLook({ service: 'jlccnc', process: 'CNC', material: '6061' })).toBe('aluminium')
  })

  it('reads an SVG logo\'s colours from its fills and strokes, most used first', () => {
    expect(svgColours(SVG)).toEqual([{ hex: '#1d3557', uses: 2 }, { hex: '#a8b0ba', uses: 1 }, { hex: '#e63946', uses: 1 }, { hex: '#ffffff', uses: 1 }])
    expect(svgColours('<svg><rect fill="none" stroke="url(#g)"/></svg>')).toEqual([])
  })

  it('puts the outline in the case frame (y flipped)', () => {
    expect(outlineBounds([[100, 100], [160, 100], [160, 140], [100, 140]])).toEqual([100, -140, 160, -100])
  })

  it('reads the case\'s screws from its records, in the case frame', () => {
    const jsonld = JSON.parse(readFileSync(join(FIX, 'case-screws.jsonld'), 'utf8'))
    expect(caseScrews(jsonld)).toEqual([
      { ref: 'H1', size: 'M3', length_mm: 6, x_mm: 104, y_mm: -104 }, { ref: 'H2', size: 'M3', length_mm: 6, x_mm: 140, y_mm: -104 },
      { ref: 'H3', size: 'M3', length_mm: 6, x_mm: 104, y_mm: -136 }, { ref: 'H4', size: 'M3', length_mm: 6, x_mm: 156, y_mm: -136 },
    ])
    // a case held by rests and lid posts, a record without its fastener, an odd size: no screws
    expect(caseScrews(JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'case-build', 'good', 'case.jsonld'), 'utf8')))).toEqual([])
    expect(caseScrews({ '@graph': [{ '@type': 'MountingPoint', positionX: 1, positionY: 2, fastener: { '@id': 'fastener:x' } }] })).toEqual([])
    expect(caseScrews({ '@graph': [{ '@id': 'f', '@type': 'Fastener', size: '#4-40', length: 6 }, { '@type': 'MountingPoint', positionX: 1, positionY: 2, fastener: { '@id': 'f' } }] })).toEqual([])
    expect(caseScrews(null)).toEqual([])
  })

  it('names the pictures after the project in its record, the working folder only as a last resort (#215)', () => {
    const folder = 'task-revision-a-was-cut-on-2026-11'
    expect(showcaseName({ journey: 'test-esp32', kicad: 'desk-gadget', repository: 'mteichtahl/test-esp32-e2e', folder })).toEqual({ name: 'test-esp32', from: 'journey' })
    expect(showcaseName({ given: 'Desk Gadget', journey: 'test-esp32', folder })).toEqual({ name: 'Desk Gadget', from: 'given' })
    expect(showcaseName({ journey: ' ', kicad: 'desk-gadget', folder })).toEqual({ name: 'desk-gadget', from: 'kicad' })
    expect(showcaseName({ repository: 'mteichtahl/test-esp32-e2e', folder })).toEqual({ name: 'test-esp32-e2e', from: 'repository' })
    expect(showcaseName({ folder })).toEqual({ name: folder, from: 'folder' })
    expect(shotName(showcaseName({ journey: 'test-esp32', folder }).name, 'A', '2026-11-06', 'case')).toBe('test-esp32_rev-A_2026-11-06_case.png')
  })

  it('reads the journey\'s name and the off-board parts from the project database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'trace-showcase-db-')), 'project.db')
    expect(recordFacts(path)).toEqual({ journey: null, offBoard: [] })
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE journey (id TEXT, name TEXT); INSERT INTO journey VALUES ('current', 'test-esp32')")
    db.exec('CREATE TABLE arch_blocks (option TEXT, id TEXT, parts TEXT, status TEXT)')
    const parts = JSON.stringify([{ mpn: '2.54-1*4PFemale', key: true }, { mpn: 'SSD1306-0.96-OLED-128x64-I2C-module', role: 'Lid-mounted OLED, cable to J2', key: true, off_board: true, size_mm: [27.3, 27.3, 2.37] }])
    const ins = db.prepare('INSERT INTO arch_blocks VALUES (?,?,?,?)')
    ins.run('A', 'oled', parts, 'proposed')
    ins.run('B', 'oled', parts, 'proposed')
    ins.run('C', 'batt', JSON.stringify([{ mpn: 'LiPo-1S', off_board: true }]), 'withdrawn')
    db.close()
    expect(recordFacts(path)).toEqual({ journey: 'test-esp32', offBoard: [{ mpn: 'SSD1306-0.96-OLED-128x64-I2C-module', role: 'Lid-mounted OLED, cable to J2', size_mm: [27.3, 27.3, 2.37] }] })
  })

  it('draws an off-board module the case places, and lists what it cannot draw (#214)', () => {
    // the test run's case records: the OLED module is a case part at its mount on the lid
    const jsonld = { '@graph': [
      { '@id': 'case:base', '@type': 'EnclosurePart', partKind: 'base', boundingBox: [59.4, 44.4, 6.6] },
      { '@id': 'case:lid', '@type': 'EnclosurePart', partKind: 'lid', boundingBox: [59.4, 44.4, 16] },
      { '@id': 'case:oled-module', '@type': 'EnclosurePart', partKind: 'oled-module', boundingBox: [27.3, 27.3, 3.87] },
      { '@id': 'case:x', '@type': 'EnclosurePart', partKind: '../evil' },
    ] }
    expect(extraCaseParts(jsonld)).toEqual([{ kind: 'oled-module', size_mm: [27.3, 27.3, 3.87] }])
    expect(extraCaseParts(null)).toEqual([])
    const oled = { mpn: 'SSD1306-0.96-OLED-128x64-I2C-module', role: 'Lid-mounted OLED, cable to J2', size_mm: [27.3, 27.3, 2.37] }
    const cable = { part: 'SSD1306-0.96-OLED-128x64-I2C-module cable', why: 'trace has no shape for cables' }
    expect(offBoardDrawn([oled], [{ kind: 'oled-module', size_mm: [27.3, 27.3, 3.87], drawn: true }])).toEqual({
      drawn: [{ part: oled.mpn, as: 'case part oled-module' }], not_drawn: [cable],
    })
    // the case part's file is not there; the case does not place it at all; the record has no size
    expect(offBoardDrawn([oled], [{ kind: 'oled-module', size_mm: [27.3, 27.3, 3.87], drawn: false }]).not_drawn[0]!.why).toMatch(/case-oled-module\.stl is not there/)
    expect(offBoardDrawn([oled], []).not_drawn[0]!.why).toMatch(/the case does not place it/)
    expect(offBoardDrawn([{ mpn: 'Sensor', role: null, size_mm: null }], [])).toEqual({ drawn: [], not_drawn: [{ part: 'Sensor', why: 'the record has no size or place for it' }] })
  })

  it('refuses a case shot when the case has not been built', async () => {
    process.chdir(sample())
    await expect(run({ revision: 'A', project: PCB, board_model: 'board.glb', shots: ['exploded'] })).rejects.toThrow(/mech\.build/)
  })
})

const blender = findBlender()
let works = false
if (blender) {
  try { execFileSync(blender, ['-b', '--factory-startup', '--version'], { timeout: 60_000, stdio: 'pipe' }); works = true } catch { works = false }
}

describe.skipIf(!works)('with Blender', () => {
  it('renders the board in its case with the logo\'s colours, and the ontology reads them as the revision\'s renders', async () => {
    const dir = sample({ case: true, logo: true })
    process.chdir(dir)
    const r = await run({ revision: 'C', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 4, device: 'cpu', shots: ['board', 'exploded'] })
    // named after the KiCad project (the test's database has no journey), never the folder it runs in (#215)
    const project = 'trace-sample'
    expect(r.shots).toEqual({ [`${project}_rev-C_2026-11-05_board.png`]: 'board', [`${project}_rev-C_2026-11-05_exploded.png`]: 'exploded' })
    const pal = r.palette as Record<string, unknown>
    expect(pal.source).toBe('logo')
    expect(pal.base).toBe('#1d3557')
    expect(pal.accent).toBe('#e63946')
    expect((pal.logo as Record<string, unknown>).path).toBe('docs/design/logo.png')
    expect(r.name).toEqual({ name: 'trace-sample', from: 'kicad' })
    expect(r.case).toEqual({ look: 'nylon', screws: [], parts: [] })
    expect(r.notes).toContain('mechanical/out/case.jsonld is not there (build the case again with mech.build): no screws shown')
    // the run record (test/setup.ts points every test's at TRACE_PROJECT_DB), with this run alone in the graph
    const db = new DatabaseSync(process.env.TRACE_PROJECT_DB as string)
    const { store: all } = buildGraph({ project: db }, { installation: 't', project: 'p' })
    const set = `urn:trace:t:p:run:${String(r.run_id)}`
    const store = { getSubjects: (p: string, o: string) => all.getSubjects(p, o, null).filter((s) => s.value.startsWith(set.replace(':run:', ':artifact:'))) }
    const T = 'https://trace-eda.com/ns/trace#'
    expect(store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${T}Render`)).toHaveLength(2)
    const inputs = db.prepare('SELECT ref FROM run_inputs WHERE run_id=? ORDER BY ord').all(String(r.run_id)).map((x) => (x as { ref: string }).ref)
    expect(inputs).toEqual(['hardware/trace-sample.kicad_pcb', 'mechanical/out/case-base.stl', 'mechanical/out/case-lid.stl', 'docs/design/logo.png'])
  }, 600_000)

  it('shows the case\'s screws seated in the open case and lifted out of their holes in the exploded view', async () => {
    process.chdir(sample({ case: true, screws: true }))
    const r = await run({ revision: 'B', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 4, device: 'cpu', shots: ['board-in-case', 'exploded'] })
    expect(r.case).toEqual({ look: 'nylon', screws: ['M3x6', 'M3x6', 'M3x6', 'M3x6'], parts: [] })
    const db = new DatabaseSync(process.env.TRACE_PROJECT_DB as string)
    const inputs = db.prepare('SELECT ref FROM run_inputs WHERE run_id=? ORDER BY ord').all(String(r.run_id)).map((x) => (x as { ref: string }).ref)
    expect(inputs).toContain('mechanical/out/case.jsonld')
  }, 600_000)

  it('makes the turntable: the board (no case here) turning once, as one MP4 named like the pictures', async () => {
    const dir = sample()
    process.chdir(dir)
    const r = await run({ revision: 'A', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 2, device: 'cpu', shots: ['board', 'turntable'], turntable_frames: 8, out_dir: 'out' })
    // named after the KiCad project (the test's database has no journey), never the folder it runs in (#215)
    const project = 'trace-sample'
    const mp4 = `${project}_rev-A_2026-11-05_turntable.mp4`
    expect(r.shots).toEqual({ [`${project}_rev-A_2026-11-05_board.png`]: 'board', [mp4]: 'turntable' })
    expect(r.turntable).toMatchObject({ width: 160, height: 100, frames: 8, fps: 24 })
    expect((r.artifacts as Record<string, unknown>[]).find((x) => x.shot === 'turntable')).toMatchObject({ name: mp4, frames: 8, fps: 24, width: 160 })
    // an MP4 (ISO base media: an ftyp box first), written beside the picture, and kept as the run's artifact
    const written = (r.written as string[]).find((w) => w.endsWith('.mp4')) as string
    expect(readFileSync(written).subarray(4, 8).toString('latin1')).toBe('ftyp')
    const db = new DatabaseSync(process.env.TRACE_PROJECT_DB as string)
    const row = db.prepare('SELECT mime FROM artifacts WHERE run_id=? AND name=?').get(String(r.run_id), mp4) as { mime: string }
    expect(row.mime).toBe('video/mp4')
  }, 600_000)

  it('takes the colours of an SVG logo from the colours it paints with', async () => {
    process.chdir(sample({ logo: 'svg' }))
    const r = await run({ revision: 'A', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 4, device: 'cpu', shots: ['board'] })
    expect(r.palette).toMatchObject({ source: 'logo', base: '#1d3557', accent: '#e63946', logo: { path: 'docs/design/logo.svg' } })
  }, 600_000)

  it('makes board shots only, in neutral colours, for a project with no case and no logo', async () => {
    process.chdir(sample())
    const r = await run({ revision: 'A', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 4, device: 'cpu', shots: ['board-top'] })
    expect((r.palette as Record<string, unknown>).source).toBe('neutral')
    expect(r.case).toBeNull()
    expect(Object.values(r.shots as Record<string, string>)).toEqual(['board-top'])
  }, 600_000)
})
