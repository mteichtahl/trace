/**
 * render.showcase (docs/revision-renders.md): the names, dates and case looks it works out; a case shot without a case;
 * and, where Blender is installed, a real draft render of the sample board in its case with colours from a logo,
 * read back by the ontology as the revision's renders.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { buildGraph } from '../../../src/ontology/graph.js'
import { findBlender } from '../../../src/tools/render/blender.js'
import { caseLook, dayIn, outlineBounds, projectSlug, shotName, showcase } from '../../../src/tools/render/showcase.js'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIX = join(ROOT, 'test', 'fixtures', 'showcase')
const PCB = 'hardware/trace-sample.kicad_pro'
const run = (a: Record<string, unknown>) => showcase.run(showcase.input.parse(a) as never, { hardware: false, via: 'test' }) as Promise<Record<string, unknown>>

/** The sample project in a fresh repository, with its case and logo when asked. */
function sample(o: { case?: boolean; logo?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-showcase-'))
  cpSync(join(ROOT, 'templates', 'sample', 'hardware'), join(dir, 'hardware'), { recursive: true })
  mkdirSync(join(dir, '.git'))
  copyFileSync(join(FIX, 'board.glb'), join(dir, 'board.glb'))
  if (o.case) {
    mkdirSync(join(dir, 'mechanical', 'out'), { recursive: true })
    for (const f of ['case-base.stl', 'case-lid.stl']) copyFileSync(join(FIX, f), join(dir, 'mechanical', 'out', f))
    copyFileSync(join(ROOT, 'test', 'fixtures', 'case-build', 'good', 'case.json'), join(dir, 'mechanical', 'case.json'))
  }
  if (o.logo) {
    mkdirSync(join(dir, '.trace', 'brand'), { recursive: true })
    copyFileSync(join(FIX, 'logo.png'), join(dir, '.trace', 'brand', 'logo.png'))
  }
  return dir
}

const cwd = process.cwd()
afterEach(() => process.chdir(cwd))

describe('names, days and looks', () => {
  it('names each picture by project, revision, day and shot', () => {
    expect(shotName('Test ESP32', 'B', '2026-11-05', 'exploded')).toBe('test-esp32_rev-B_2026-11-05_exploded.png')
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

  it('puts the outline in the case frame (y flipped)', () => {
    expect(outlineBounds([[100, 100], [160, 100], [160, 140], [100, 140]])).toEqual([100, -140, 160, -100])
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
    const project = dir.split('/').pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    expect(r.shots).toEqual({ [`${project}_rev-C_2026-11-05_board.png`]: 'board', [`${project}_rev-C_2026-11-05_exploded.png`]: 'exploded' })
    const pal = r.palette as Record<string, unknown>
    expect(pal.source).toBe('logo')
    expect(pal.base).toBe('#1d3557')
    expect(pal.accent).toBe('#e63946')
    expect((pal.logo as Record<string, unknown>).path).toBe('.trace/brand/logo.png')
    expect(r.case).toEqual({ look: 'nylon' })
    // the run record (test/setup.ts points every test's at TRACE_PROJECT_DB), with this run alone in the graph
    const db = new DatabaseSync(process.env.TRACE_PROJECT_DB as string)
    const { store: all } = buildGraph({ project: db }, { installation: 't', project: 'p' })
    const set = `urn:trace:t:p:run:${String(r.run_id)}`
    const store = { getSubjects: (p: string, o: string) => all.getSubjects(p, o, null).filter((s) => s.value.startsWith(set.replace(':run:', ':artifact:'))) }
    const T = 'https://trace-eda.com/ns/trace#'
    expect(store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${T}Render`)).toHaveLength(2)
    const inputs = db.prepare('SELECT ref FROM run_inputs WHERE run_id=? ORDER BY ord').all(String(r.run_id)).map((x) => (x as { ref: string }).ref)
    expect(inputs).toEqual(['hardware/trace-sample.kicad_pcb', 'mechanical/out/case-base.stl', 'mechanical/out/case-lid.stl', '.trace/brand/logo.png'])
  }, 600_000)

  it('makes board shots only, in neutral colours, for a project with no case and no logo', async () => {
    process.chdir(sample())
    const r = await run({ revision: 'A', date: '2026-11-05', project: PCB, board_model: 'board.glb', quality: 'draft', width: 160, height: 100, samples: 4, device: 'cpu', shots: ['board-top'] })
    expect((r.palette as Record<string, unknown>).source).toBe('neutral')
    expect(r.case).toBeNull()
    expect(Object.values(r.shots as Record<string, string>)).toEqual(['board-top'])
  }, 600_000)
})
