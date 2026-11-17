/**
 * Starting a project from fabrication files (docs/fab-import.md): uploading in parts, the check, projects.create with an
 * import (the files committed and recorded as an import change, the journey entered with the earlier gates signed on
 * the import evidence, the entry stage's work asked for), and refusing an import the check blocks before anything is
 * made. Over the shared fake GitHub (with commitFiles and openPull) and a central bucket in a temporary folder.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { IMPORT_PART, importBranch, importWork, joinParts, overviewDoc, partKey, refusalOf, sourceWords } from '../../src/api/actions-import.js'
import { metOnImport } from '../../src/api/evidence-freshness.js'
import { editStore } from '../../src/api/edits.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { AccessDenied } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { appliesOf } from '../../src/core/app-edits.js'
import { IMPORT_SIGNATURE_NOTE, enterImported, gatesBefore, loadJourney, startJourney } from '../../src/core/journey.js'
import { open } from '../../src/core/store.js'
import { Registry } from '../../src/core/registry.js'
import { applyJourneySchema } from '../../src/core/journey.js'
import { zipOf } from '../fixtures/zip.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'f-admin', email: 'f-admin@example.com', groups: ['trace-admins'] }
const OTHER_ADMIN = { sub: 'f-admin2', email: 'f-admin2@example.com', groups: ['trace-admins'] }
const USER = { sub: 'f-user', email: 'f-user@example.com', groups: ['trace-users'] }

const fixtures = join(import.meta.dirname, '../fixtures/fab-import')
const ZIP = readFileSync(join(fixtures, 'potroller-supervisor-gerbers.zip'))
const BOM = readFileSync(join(fixtures, 'potroller-carrier-bom-jlc.csv'))
const CPL = readFileSync(join(fixtures, 'potroller-carrier-cpl-jlc.csv'))
const OVERVIEW = [
  'The Potroller carrier is a board that hosts a Raspberry Pi CM5 and eight hot-pluggable capability modules for a flight simulator cockpit.',
  'It is powered from 12 to 24 V DC through a 30 A blade fuse and makes 5 V and 3.3 V rails.',
  'Interfaces: USB-C, Ethernet, two micro HDMI, I2C to each module and a GPIO header.',
  'It is 200 x 160 mm, mounted on standoffs in a rack enclosure. We will build 5 boards for a prototype run with a budget of 1500 USD.',
].join(' ')

class ImportGitHub extends FakeGitHub {
  pulls: { head: string; base: string; title: string; body: string }[] = []
  committed: { branch: string; base: string; message: string; files: string[] }[] = []
  async openPull(_repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }> {
    this.pulls.push(o)
    return { number: 200 + this.pulls.length, existed: false }
  }
  async commitFiles(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array | null }[] }): Promise<{ commit: string }> {
    this.committed.push({ branch: o.branch, base: o.base, message: o.message, files: o.files.map((f) => f.path) })
    for (const f of o.files) if (f.content) this.files.set(`${repo}:${o.branch}:${f.path}`, f.content)
    return { commit: 'c'.repeat(40) }
  }
}

const github = new ImportGitHub(['acme/carrier', 'acme/built', 'acme/blocked', 'acme/design'])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-import-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-import-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const started: { repository: string; agent?: string | undefined; request: string; headline?: string | undefined }[] = []
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, tools: () => new Registry([]), scratch,
  jobs: async () => ({ repositoryOf: () => null, startJob: async (p) => { started.push(p); return { accepted: true, jobId: `j${started.length}` } }, jobStatus: async () => [] }),
  store: (p) => backendFor(join(bucket, p)),
  onboard: async (repo, o) => ({ repo, state: o.create ? 'created' : 'unchanged', pr: null, settings: [], notes: [] }),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await perform(action, args, ctx(who))).result as Record<string, unknown>

/** Upload a file in parts of `size` bytes, as the app does. */
let gives = 1_700_000_000_000
async function upload(who: Context['principal'], id: string, file: 'source' | 'gerbers' | 'bom' | 'cpl', bytes: Uint8Array, size = IMPORT_PART): Promise<void> {
  const parts = Math.max(1, Math.ceil(bytes.length / size))
  const give = String(gives++)
  for (let i = 0; i < parts; i++) {
    await run(who, 'projects.import_upload', { upload: id, file, give, part: i, parts, base64: Buffer.from(bytes.subarray(i * size, (i + 1) * size)).toString('base64') })
  }
}

describe('the parts of an upload', () => {
  it('joins each file from its newest give\'s parts, and says which file is missing a part', () => {
    const old = '1700000000000'
    const now = '1700000000001'
    const bodies: Record<string, Uint8Array> = {
      [`u/x/bom.${old}.0-of-3`]: new Uint8Array([7]), [`u/x/bom.${old}.1-of-3`]: new Uint8Array([7]), [`u/x/bom.${old}.2-of-3`]: new Uint8Array([7]),
      [`u/x/bom.${now}.0-of-2`]: new Uint8Array([1, 2]), [`u/x/bom.${now}.1-of-2`]: new Uint8Array([3]), [`u/x/cpl.${now}.1-of-2`]: new Uint8Array([9]),
    }
    const r = joinParts(Object.keys(bodies), (k) => bodies[k] ?? null)
    expect([...r.files.bom!]).toEqual([1, 2, 3])
    expect(r.files.cpl).toBeUndefined()
    expect(r.incomplete.cpl).toMatch(/1 of its 2 parts did not arrive/)
    expect(partKey('h', 'u1', 'gerbers', now, 0, 3)).toBe(`h/u1/gerbers.${now}.0-of-3`)
  })

  it('names the branch and the overview document, and refuses on blocking findings only', () => {
    expect(importBranch('Potroller Supervisor', 36 ** 3)).toBe('trace/import-potroller-supervisor-1000')
    expect(overviewDoc('Carrier', '  Words.  ', 'Marc', '2026-11-16T00:00:00Z')).toBe('# Carrier: project overview\n\nGiven by Marc when the project was started from its fabrication files (2026-11-16). trace\'s intent and requirements start from it.\n\nWords.\n')
    expect(refusalOf({ findings: [{ id: 'a', severity: 'warning', file: 'bom', text: 'x', fix: 'y' }] })).toBeNull()
    expect(refusalOf({ findings: [{ id: 'a', severity: 'blocking', file: 'bom', text: 'No BOM.', fix: 'y' }] })).toBe('The files cannot start a project yet: No BOM.')
  })

  it('asks the Implementation agent for the package and stock at Fabricate, and the Verification agent for requirements', () => {
    const fab = importWork({ entry: 'fabricate', dir: 'hardware/b/release/revA', bom: 'hardware/b/release/revA/b-jlc-bom.csv', quantity: 5, change: 'Import the fabrication files' })
    expect(fab.map((w) => w.agent)).toEqual(['impl', 'verify'])
    expect(fab[0]!.request).toMatch(/fab\.import \(dir hardware\/b\/release\/revA, boards 5\)/)
    expect(fab[0]!.request).toMatch(/Do not run kicad\.fab or kicad\.board/)
    expect(fab[1]!.request).toMatch(/docs\/overview\.md/)
    expect(importWork({ entry: 'bringup', dir: 'd', bom: 'b', quantity: 1, change: 'c' }).map((w) => w.agent)).toEqual(['verify'])
    expect(appliesOf('import', false)).toBe('auto')
  })
})

describe('what the import says of the design it was given', () => {
  it('names its revision, project and tool, and where trace keeps it; nothing when the Gerbers name nothing', () => {
    expect(sourceWords({ project: { name: 'carrier', revision: 'M.20' }, tool: 'KiCad Pcbnew 10.0.8' }, 'hardware/carrier/release/revA'))
      .toBe('The files are revision M.20 of carrier, made in KiCad Pcbnew 10.0.8; trace keeps them as its revision A, under hardware/carrier/release/revA, named after the design.')
    expect(sourceWords({ project: { name: null, revision: null }, tool: null }, 'hardware/board/release/revA')).toBe('')
    expect(sourceWords({ project: { name: null, revision: null }, tool: 'EasyEDA' }, 'hardware/board/release/revA')).toBe('The files are the design, made in EasyEDA; trace keeps them as its revision A, under hardware/board/release/revA.')
  })
  it('a criterion met on the import\'s files has no rule check to read again', () => {
    const imported = { decisions: [{ kind: 'journey.imported' }] } as never
    expect(metOnImport(imported, { evidence: [{ kind: 'file', ref: 'docs/overview.md' }] })).toBe(true)
    // one an agent checked with a run is read again as ever, and so is any criterion of a project not imported
    expect(metOnImport(imported, { evidence: [{ kind: 'run', ref: 'abc' }] })).toBe(false)
    expect(metOnImport({ decisions: [] } as never, { evidence: [{ kind: 'file', ref: 'docs/overview.md' }] })).toBe(false)
  })
})

describe('entering a journey on an import', () => {
  it('meets and signs every gate before the entry, finishes those stages, and logs it', () => {
    const db = open(join(mkdtempSync(join(scratch, 'j-')), 'journey.db'), { wal: false })
    applyJourneySchema(db)
    startJourney(db, { template: 'board', start: 'import', by: 'a@example.com' })
    const before = loadJourney(db)!
    const gates = gatesBefore(before, 'fabricate').map((g) => g.id)
    expect(gates.length).toBeGreaterThan(3)
    const r = enterImported(db, { entry: 'fabricate', signer: { hash: 'h', label: 'a@example.com' }, evidence: [{ kind: 'file', ref: 'docs/overview.md' }], summary: 'Imported.' })
    expect(r).toEqual({ entered: 'fabricate', signed: gates })
    const after = loadJourney(db)!
    expect(after.journey.currentStage).toBe('fabricate')
    expect(after.signatures.map((s) => s.gate)).toEqual(gates)
    expect(after.signatures.every((s) => s.notes === IMPORT_SIGNATURE_NOTE)).toBe(true)
    expect(after.criteria.filter((c) => gates.includes(c.gate)).every((c) => c.status === 'met')).toBe(true)
    expect(after.criteria.filter((c) => !gates.includes(c.gate)).every((c) => c.status === 'not_met')).toBe(true)
    expect(after.stages.filter((s) => s.ord < after.stages.find((x) => x.id === 'fabricate')!.ord).every((s) => s.finished !== null)).toBe(true)
    expect(after.decisions.find((d) => d.kind === 'journey.imported')).toMatchObject({ kind: 'journey.imported', stage: 'fabricate', summary: expect.stringMatching(/^Imported\. The project starts at Fabricate; \d+ gates before it were signed on the import evidence\.$/) })
    // once moved on, it is not entered again
    expect(() => enterImported(db, { entry: 'bringup', signer: { hash: 'h', label: 'a' }, evidence: [], summary: 'x' })).toThrow(/just started/)
    db.close()
  })
})

describe('projects.import_upload and projects.import_check', () => {
  it('are an admin\'s only', async () => {
    await expect(run(USER, 'projects.import_check', { upload: 'u-00000001' })).rejects.toThrow(AccessDenied)
  })

  it('takes the files in parts, joins them and checks them with the overview', async () => {
    const id = 'upload-check-1'
    await upload(ADMIN, id, 'gerbers', ZIP, 16 * 1024)
    await upload(ADMIN, id, 'bom', BOM)
    const half = await run(ADMIN, 'projects.import_check', { upload: id, overview: OVERVIEW }) as { ok: boolean; sizes: Record<string, number | null>; findings: { id: string }[] }
    expect(half.sizes).toEqual({ source: null, gerbers: ZIP.length, bom: BOM.length, cpl: null })
    // the pick and place file is optional: left out, it is a note and the files still check
    expect(half.ok).toBe(true)
    expect(half.findings.find((f) => f.id === 'cpl.missing')).toMatchObject({ severity: 'note' })
    await upload(ADMIN, id, 'cpl', CPL)
    const r = await run(ADMIN, 'projects.import_check', { upload: id, overview: OVERVIEW, quantity: 5 }) as { ok: boolean; summary: { board: { layers: number }; placements: { total: number } }; recommended: { entry: string }; layers: unknown[] }
    expect(r.ok).toBe(true)
    expect(r.summary.board.layers).toBe(10)
    expect(r.summary.placements.total).toBe(774)
    expect(r.recommended.entry).toBe('fabricate')
    expect(r).not.toHaveProperty('placements')
    // another admin does not see this upload
    const theirs = await run(OTHER_ADMIN, 'projects.import_check', { upload: id, overview: OVERVIEW }) as { sizes: Record<string, number | null> }
    expect(theirs.sizes).toEqual({ source: null, gerbers: null, bom: null, cpl: null })
  })

  it('refuses a part that is not one, and a file over its size', async () => {
    await expect(run(ADMIN, 'projects.import_upload', { upload: 'upload-bad-1', file: 'bom', give: '1700000000000', part: 2, parts: 2, base64: 'AA==' })).rejects.toThrow(/not a part of this file/)
    await upload(ADMIN, 'upload-big-1', 'bom', new Uint8Array(2.2 * 1024 * 1024).fill(65), 1024 * 1024)
    const r = await run(ADMIN, 'projects.import_check', { upload: 'upload-big-1', overview: OVERVIEW }) as { findings: { id: string; text: string }[] }
    expect(r.findings.find((f) => f.id === 'bom.missing')?.text).toBe('The bill of materials is too large: it is 2.2 MB, and at most 2 MB is taken.')
  })

  it('says which file did not arrive whole', async () => {
    await run(ADMIN, 'projects.import_upload', { upload: 'upload-torn-1', file: 'bom', give: '1700000000000', part: 1, parts: 2, base64: Buffer.from('x').toString('base64') })
    const r = await run(ADMIN, 'projects.import_check', { upload: 'upload-torn-1', overview: OVERVIEW }) as { findings: { id: string; text: string }[] }
    expect(r.findings.find((f) => f.id === 'bom.missing')?.text).toMatch(/^The bill of materials did not arrive whole: 1 of its 2 parts/)
  })
})

describe('projects.create with an import', () => {
  it('commits the files as an import change, enters at Fabricate with the earlier gates signed, and asks for the work', async () => {
    const id = 'upload-create-1'
    await upload(ADMIN, id, 'gerbers', ZIP)
    await upload(ADMIN, id, 'bom', BOM)
    await upload(ADMIN, id, 'cpl', CPL)
    started.length = 0
    const r = await run(ADMIN, 'projects.create', {
      repo: 'acme/carrier', name: 'Potroller carrier', template: 'board', start: 'import', build: { quantity: 5 },
      import: { upload: id, overview: OVERVIEW, entry: 'fabricate' },
    }) as { ok: boolean; steps: { id: string; state: string; detail: string }[] }
    expect(r.steps.map((s) => [s.id, s.state])).toEqual([['repository', 'done'], ['registry', 'done'], ['people', 'skipped'], ['journey', 'done'], ['import', 'done'], ['cloud', expect.any(String)]])
    expect(r.steps.find((s) => s.id === 'import')?.detail).toMatch(/Its change "Import the fabrication files" is on the project's Changes.* The project starts at Fabricate, with \d+ earlier gates signed on the import evidence\. 3 warnings from the check are carried into the project\./)
    const c = github.committed.at(-1)!
    expect(c.branch).toMatch(/^trace\/import-potroller-supervisor-[0-9a-z]+$/)
    expect(c.files).toEqual([
      'hardware/potroller-supervisor/release/revA/potroller-supervisor-gerbers.zip', 'hardware/potroller-supervisor/release/revA/potroller-supervisor-jlc-bom.csv',
      'hardware/potroller-supervisor/release/revA/potroller-supervisor-jlc-cpl.csv', 'hardware/potroller-supervisor/release/revA/import.json', 'docs/overview.md',
    ])
    expect(Buffer.from(github.files.get(`acme/carrier:${c.branch}:${c.files[0]}`)!).equals(ZIP)).toBe(true)
    expect(new TextDecoder().decode(github.files.get(`acme/carrier:${c.branch}:docs/overview.md`))).toContain('hosts a Raspberry Pi CM5')
    const edits = await editStore(ctx(ADMIN)).list('acme/carrier')
    expect(edits.find((e) => e.branch === c.branch)).toMatchObject({ kind: 'import', applies: 'auto', paths: c.files, number: expect.any(Number) })
    const bytes = await journeyStore(ctx(ADMIN), 'acme/carrier').bytes()
    expect(bytes).toBeTruthy()
    const j = await run(ADMIN, 'journey.get', { repo: 'acme/carrier' }) as { current_stage: string; start: string; imported?: unknown; decisions: { kind: string; summary: string }[]; stale_evidence?: unknown[] }
    expect(j).toMatchObject({ current_stage: 'fabricate', start: 'import' })
    // the design's own name, revision and tool, and where trace keeps it (potroller-carrier-m20: M.20 became "Rev A"
    // and the files were renamed after the Gerbers' project, with nothing saying so)
    expect(j.imported).toEqual({ entry: 'fabricate', name: 'potroller-supervisor', revision: 'M.20', tool: 'KiCad Pcbnew 10.0.8', dir: 'hardware/potroller-supervisor/release/revA' })
    expect(j.decisions.find((d) => d.kind === 'journey.imported')?.summary).toContain('The files are revision M.20 of potroller-supervisor, made in KiCad Pcbnew 10.0.8; trace keeps them as its revision A, under hardware/potroller-supervisor/release/revA, named after the design.')
    // never "started … at Define" beside "starts at Fabricate"
    expect(j.decisions.find((d) => d.kind === 'journey.started')?.summary).toBe('The project started from the Board template: its design comes from outside trace, and the import says where it enters.')
    expect(r.steps.find((s) => s.id === 'journey')?.detail).toMatch(/the fabrication files place it at Fabricate\.$/)
    // the rule checks the import signed for are not "out of date": there is no schematic or board file to run them on
    expect(j.stale_evidence ?? []).toEqual([])
    expect(started.map((s) => [s.repository, s.agent, s.headline])).toEqual([
      ['acme/carrier', 'impl', 'Recording the imported release package'],
      ['acme/carrier', 'verify', 'Drafting requirements from the overview'],
    ])
  })

  it('enters at Bring up for boards already built, asking only for requirements', async () => {
    const id = 'upload-built-1'
    await upload(ADMIN, id, 'gerbers', ZIP)
    await upload(ADMIN, id, 'bom', BOM)
    await upload(ADMIN, id, 'cpl', CPL)
    started.length = 0
    const r = await run(ADMIN, 'projects.create', { repo: 'acme/built', name: 'Built', template: 'board', start: 'import', import: { upload: id, overview: OVERVIEW, entry: 'bringup' } }) as { steps: { id: string; state: string; detail: string }[] }
    expect(r.steps.find((s) => s.id === 'import')).toMatchObject({ state: 'done', detail: expect.stringMatching(/starts at Bring up/) })
    expect(started.map((s) => s.agent)).toEqual(['verify'])
  })

  it('refuses before anything is made when the check blocks', async () => {
    const id = 'upload-blocked-1'
    await upload(ADMIN, id, 'gerbers', ZIP)
    const made = github.committed.length
    await expect(run(ADMIN, 'projects.create', { repo: 'acme/blocked', name: 'Blocked', template: 'board', start: 'import', import: { upload: id, overview: 'Too short.', entry: 'fabricate' } }))
      .rejects.toThrow(/cannot start a project yet: The overview is 10 characters/)
    expect(github.committed.length).toBe(made)
    await expect(journeyStore(ctx(ADMIN), 'acme/blocked').bytes()).resolves.toBeNull()
  })

  it('starts from the design files alone: they are unpacked into the repository and the missing fabrication files are built from them', async () => {
    const id = 'upload-source-1'
    await upload(ADMIN, id, 'source', zipOf({ 'carrier/carrier.kicad_pro': '{}', 'carrier/carrier.kicad_sch': '(kicad_sch)', 'carrier/carrier.kicad_pcb': '(kicad_pcb)' }))
    started.length = 0
    const r = await run(ADMIN, 'projects.create', { repo: 'acme/design', name: 'Design only', template: 'board', start: 'import', build: { quantity: 3 }, import: { upload: id, overview: OVERVIEW, entry: 'fabricate' } }) as { steps: { id: string; state: string; detail: string }[] }
    expect(r.steps.find((s) => s.id === 'import')).toMatchObject({ state: 'done', detail: expect.stringMatching(/Its change "Import the design files"/) })
    const c = github.committed.at(-1)!
    expect(c.files).toEqual([
      'hardware/design-only/source/carrier.kicad_pcb', 'hardware/design-only/source/carrier.kicad_pro', 'hardware/design-only/source/carrier.kicad_sch',
      'hardware/design-only/release/revA/import.json', 'docs/overview.md',
    ])
    expect(c.message).toContain('hardware/design-only/source/ (3 design files)')
    const j = await run(ADMIN, 'journey.get', { repo: 'acme/design' }) as { decisions: { kind: string; summary: string }[] }
    expect(j.decisions.find((d) => d.kind === 'journey.imported')?.summary).toContain('The project was started from its design files: 1 schematic, 1 board layout and 0 net lists')
    // the agent builds the fabrication files that were not given, from the design
    expect(started.map((s) => [s.agent, s.headline])).toEqual([['impl', 'Preparing the order from the imported design'], ['verify', 'Drafting requirements from the overview']])
    expect(started[0]!.request).toContain('Fabrication files not given: the Gerbers, the bill of materials, the pick and place file')
  })

  it('takes an import only with start: import', async () => {
    await expect(run(ADMIN, 'projects.create', { repo: 'acme/blocked', name: 'B', template: 'board', import: { upload: 'upload-x-0001', overview: OVERVIEW } })).rejects.toThrow(/start: import/)
  })
})
