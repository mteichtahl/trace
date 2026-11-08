/**
 * Release review (#206, #208): each step shows what the record holds for it (the EMC precheck and its waiver, the parts
 * list's cost, stock, sellers and lifecycle, the DRC result, the changes since the last revision), each area is
 * acknowledged on its own step, single-source and not-active parts come from the parts check, and Decide releases or
 * returns to a stage with a note.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { type ReleaseView, inactiveLifecycle, partLine, releaseView } from '../../src/api/release-review.js'
import { type CheckInput, checkSkill } from '../../src/api/skill-checks.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { addWaiver, loadJourney, setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'rr-admin', email: 'rr-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'rr-user', email: 'rr-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/release-review'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-release-review-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-release-review-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
type Check = { id: string; status: string; detail?: string; unavailable?: string; confirmable?: boolean }
type View = { checks: Check[]; release: ReleaseView; recommendation: { recommended: string; options: { id: string; label: string }[]; why: string } }
const view = async (): Promise<View> => await run(USER, 'skill.get', { repo: REPO, skill: 'release-review' }) as View
const check = (v: View, id: string): Check | undefined => v.checks.find((c) => c.id === id)

const line = (n: number, mpn: string, o: Record<string, unknown> = {}) => ({
  line: n, mpn, refs: `U${n}`, need: 10, status: 'ok', flags: [], offer: { stock: 5000 }, unit_price: 0.5, sources: ['LCSC', 'Mouser'], asked: ['lcsc', 'mouser'], lifecycle: 'Active', ...o,
})
const parts = {
  boards: 10, currency: 'USD', total: 47.16, blocking: 0, line_count: 3, counts: { ok: 3 },
  lines: [line(1, 'ESP32-C3-MINI-1-N4', { sources: ['LCSC'] }), line(2, 'AP2112K-3.3TRG1', { lifecycle: 'NRND' }), line(3, 'GRM155R71C104KA88D')],
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Release review' })
  db.prepare("UPDATE journey SET current_stage='signoff' WHERE id='current'").run()
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === 'signoff' && x.id !== 'signoff.report' && x.id !== 'signoff.emc')) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'seed')
  addWaiver(db, { target: { kind: 'criterion', id: 'signoff.emc' }, reason: 'The radiated scan is booked with the lab for the first boards.', risk: 'A re-spin if the clock harmonics fail.', severity: 'degraded', caught_where: null, scope: 'this revision only' }, { hash: 'h', label: 'Ann', admin: true })
  const t = Date.now() / 1000
  const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
  runRow.run('emc-1', 'emc.precheck', 'hw/board.kicad_pcb', t - 50, 'fail', '1 errors, 1 warnings, 0 notes', JSON.stringify({ counts: { error: 1, warn: 1, info: 0 } }))
  db.prepare('INSERT INTO artifacts (run_id, name, mime, bytes) VALUES (?,?,?,?)').run('emc-1', 'findings.json', 'application/json', new TextEncoder().encode(JSON.stringify([
    { rule: 'edge_proximity', severity: 'warn', net: '/SCK', layer: 'F.Cu', at: null, message: '/SCK runs 0.8 mm from the board edge', evidence: {} },
    { rule: 'return_path', severity: 'error', net: '/USB_D+', layer: 'F.Cu', at: null, message: '/USB_D+ crosses a split in the ground plane', evidence: {} },
  ])))
  // the cable's emission spectra: one made before the newest precheck (an older board) and two with it (R60)
  runRow.run('spec-old', 'emc.spectrum', 'hw/board.kicad_pcb', t - 60, 'pass', 'an older board', '{}')
  runRow.run('spec-005', 'emc.spectrum', 'hw/board.kicad_pcb', t - 48, 'pass', '0.05 % common mode: 7.97 dB margin at 30 MHz', '{}')
  runRow.run('spec-1', 'emc.spectrum', 'hw/board.kicad_pcb', t - 47, 'fail', '1 % common mode: 18.05 dB over at 30 MHz', '{}')
  runRow.run('bom-1', 'parts.bom_check', 'rows', t - 40, 'pass', '3 lines for 10 boards: every line in stock; 47.16 USD', JSON.stringify(parts))
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('Release review: each step from the record', () => {
  it('EMC shows the precheck findings, errors first, and the waiver on signoff.emc', async () => {
    const v = await view()
    expect(v.release.emc.precheck).toMatchObject({ run: 'emc-1', counts: { error: 1, warn: 1, info: 0 }, more: 0 })
    expect(v.release.emc.precheck?.findings.map((f) => f.severity)).toEqual(['error', 'warn'])
    expect(v.release.emc.criterion).toMatchObject({ id: 'signoff.emc', status: 'waived' })
    expect(v.release.emc.waivers).toHaveLength(1)
    // the spectra made with the newest precheck, newest first; the one over the limit says so (test-esp32-run2 R60)
    expect(v.release.emc.estimates.map((e) => [e.run, e.kind, e.status])).toEqual([['spec-1', 'emc.spectrum', 'fail'], ['spec-005', 'emc.spectrum', 'pass']])
  })

  it('the parts list has cost per board and for the build, sellers and lifecycle, and what to acknowledge', async () => {
    const p = (await view()).release.parts!
    expect(p).toMatchObject({ run: 'bom-1', boards: 10, total: 47.16, per_board: 4.72, line_count: 3, unknown: 0 })
    expect(p.flagged).toEqual(['ESP32-C3-MINI-1-N4', 'AP2112K-3.3TRG1'])
  })

  it('the first revision says there is nothing to compare', async () => {
    expect((await view()).release.changes).toEqual({ revision: 'A', previous: null, started: null, items: [] })
  })

  it('each area is acknowledged on its own step, and each flagged part on the parts list', async () => {
    let v = await view()
    expect(check(v, 'areas')).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/^Acknowledge coverage, emc/) })
    expect(check(v, 'areas')?.confirmable).toBeUndefined()
    expect(check(v, 'single')).toMatchObject({ status: 'not_met', detail: 'Acknowledge ESP32-C3-MINI-1-N4 and AP2112K-3.3TRG1 on the parts list.' })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'release-review', step: 2, data: { acknowledged: ['coverage', 'emc', 'bom', 'fab', 'changes'], parts_ack: ['ESP32-C3-MINI-1-N4', 'AP2112K-3.3TRG1'] } })
    v = await view()
    expect(check(v, 'areas')?.status).toBe('met')
    expect(check(v, 'single')).toMatchObject({ status: 'met', detail: '2 parts acknowledged.' })
  })

  it('Decide offers release and a return to each stage so far; a return needs its note', async () => {
    const v = await view()
    expect(v.recommendation.options.map((o) => o.id).slice(0, 3)).toEqual(['release', 'return:signoff', 'return:layout'])
    expect(check(v, 'decision')).toMatchObject({ status: 'not_met', detail: 'Choose: release, or return to a stage.' })
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'release-review', draft: { choice: { option: 'return:layout' } } })).rejects.toThrow(/Say in the note what has to change/)
  })

  it('choosing against the recommendation takes the note as its reason, in the bar', async () => {
    expect((await view()).recommendation.recommended).toBe('release')
    await run(USER, 'skill.draft', { repo: REPO, skill: 'release-review', step: 5, data: { choice: { option: 'return:signoff' } } })
    expect(check(await view(), 'reasons')).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/^trace recommends release .*say in the note why you chose otherwise\.$/) })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'release-review', step: 5, data: { choice: { option: 'return:signoff' }, note: 'The USB pair needs a look first.' } })
    expect(check(await view(), 'reasons')?.status).toBe('met')
  })

  it('a return with a note returns the release gate and reopens the stage, without the rest of the bar', async () => {
    const out = await run(USER, 'skill.submit', { repo: REPO, skill: 'release-review', draft: { choice: { option: 'return:layout' }, note: 'Move /SCK away from the board edge.' } }) as { started: string[] }
    expect(out.started.join(' ')).toMatch(/Layout is reopened/)
  })
})

describe('Release review: pure pieces', () => {
  it('lifecycle: active, not active, not known', () => {
    expect(inactiveLifecycle('Active')).toBe(false)
    expect(inactiveLifecycle('Production (Last Updated: 1 month ago)')).toBe(false)
    expect(inactiveLifecycle('Obsolete')).toBe(true)
    expect(inactiveLifecycle('Not Recommended for New Designs')).toBe(true)
    expect(inactiveLifecycle(null)).toBeNull()
  })

  it('a single seller is single-source only when more than one provider answered', () => {
    expect(partLine(line(1, 'X', { sources: ['LCSC'] })).single).toBe(true)
    expect(partLine(line(1, 'X', { sources: ['LCSC'], asked: ['lcsc'] })).single).toBeNull()
    // a check from before sellers were recorded: not known
    expect(partLine({ line: 1, mpn: 'X', need: 1, status: 'ok' })).toMatchObject({ single: null, inactive: null })
  })

  it('untested requirements under the coverage criterion\'s waiver pass; a budget states the expected cost (test-esp32-run2 R59)', () => {
    const req = (id: string, evidence: string) => ({ id, evidence, status: 'accepted' })
    const waiver = { closedAt: null, targetKind: 'criterion', target: 'signoff.coverage', caughtWhere: 'bring-up: TST-004, TST-007.' }
    const input = (waivers: unknown[], build: Record<string, unknown>, reqs = [req('REQ-1', 'untested'), req('REQ-2', 'partial')]) => ({
      r: { waivers, journey: { build: { quantity: 10, currency: 'USD', unit_cost: null, budget: null, ...build } } }, viewer: { admin: false }, requirements: reqs, struck: [], erc: null, drc: null, bom: null, board: null, placement: null, instruments: [], orders: [], tests: [], draft: null, gate: null, question: null, release: null,
    }) as unknown as CheckInput
    const of = (i: CheckInput, id: string) => checkSkill('release-review', i)?.find((c) => c.id === id)
    expect(of(input([], {}), 'untested')).toMatchObject({ status: 'not_met', detail: '1 requirement untested: REQ-1.' })
    expect(of(input([waiver], {}), 'untested')).toMatchObject({ status: 'met', detail: '1 requirement untested, under the waiver of the coverage criterion (checked at bring-up: TST-004, TST-007).' })
    // a failing requirement still needs its own waiver
    expect(of(input([waiver], {}, [req('REQ-1', 'untested'), req('REQ-3', 'failing')]), 'untested')).toMatchObject({ status: 'not_met', detail: '1 requirement failing and not waived: REQ-3.' })
    expect(of(input([], {}), 'cost')).toMatchObject({ status: 'not_met', detail: "Set the expected unit cost or the build budget in the project's build plan." })
    expect(of(input([], { budget: 100 }), 'cost')).toMatchObject({ status: 'met', detail: '10 boards within USD 100.' })
    expect(of(input([], { unit_cost: 9, budget: 100 }), 'cost')).toMatchObject({ status: 'met', detail: '10 boards at USD 9 each.' })
  })

  it('a parts check with no sellers or lifecycle leaves single-source to the person, saying so', () => {
    const i = {
      r: null, viewer: { admin: false }, requirements: [], struck: [], erc: null, drc: null, bom: null, board: null, placement: null, instruments: [], orders: [], tests: [], draft: null, gate: null, question: null,
      release: { precheck: null, estimates: [], drcRun: null, parts: { id: 'b', status: 'pass', summary: null, started: 0, result: { lines: [{ line: 1, mpn: 'X', need: 10, status: 'ok' }] } } },
    } as unknown as CheckInput
    expect(checkSkill('release-review', i)?.find((c) => c.id === 'single')).toMatchObject({ confirmable: true, unavailable: 'the sellers and lifecycle of 1 part the parts check has none for' })
  })

  it('a later revision lists what started it and what changed since', () => {
    const r = { journey: { revision: 'B', build: { quantity: 10 } }, criteria: [], waivers: [], stages: [], decisions: [
      { id: 'd1', at: 100, kind: 'revision.started', stage: 'layout', ref: 'B', summary: 'Revision B started at Layout: move the USB connector.', by: 'Ann', detail: { from: 'A', revision: 'B' } },
      { id: 'd2', at: 110, kind: 'design.requirement', stage: 'define', ref: 'REQ-1', summary: 'REQ-1 accepted.', by: 'Ann', detail: {} },
      { id: 'd3', at: 120, kind: 'gate.signed', stage: 'layout', ref: 'layout', summary: 'Signed.', by: 'Ann', detail: {} },
    ] } as unknown as Parameters<typeof releaseView>[0]
    const c = releaseView(r, null, { drc: null, board: null, handPlaced: null }).changes
    expect(c).toMatchObject({ revision: 'B', previous: 'A', started: { summary: expect.stringMatching(/USB connector/) } })
    expect(c.items.map((x) => x.kind)).toEqual(['design.requirement'])
  })
})

describe('the board drawing', () => {
  it('an export of the sheets alone does not hide the board an earlier export drew', async () => {
    const { latestDrawings } = await import('../../src/api/record-read.js')
    const dir = mkdtempSync(join(scratch, 'drawings-'))
    mkdirSync(join(dir, '.git'))
    const db = openProject(dir)
    const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
    const art = db.prepare('INSERT INTO artifacts (run_id, name, mime, bytes) VALUES (?,?,?,?)')
    const json = (x: unknown) => new TextEncoder().encode(JSON.stringify(x))
    runRow.run('exp-old', 'kicad.export', 'hw', 100, 'pass', 'pcb_svg, sch_svg', null)
    art.run('exp-old', 'drawings.json', 'application/json', json({ drawings: [{ artifact: 'board/x.svg', kind: 'board', bytes: 1 }, { artifact: 'sheets/a.svg', kind: 'sheet', file: 'hw/a.kicad_sch', sheet: '/', bytes: 1 }] }))
    runRow.run('exp-new', 'kicad.export', 'hw', 200, 'pass', 'sch_svg', null)
    art.run('exp-new', 'drawings.json', 'application/json', json({ drawings: [{ artifact: 'sheets/a.svg', kind: 'sheet', file: 'hw/a.kicad_sch', sheet: '/', bytes: 1 }] }))
    const d = latestDrawings(db)
    db.close()
    expect(d?.run.id).toBe('exp-new')
    expect(d?.drawings.map((x) => x.path)).toEqual(['runs/exp-new/sheets/a.svg', 'runs/exp-old/board/x.svg'])
  })
})
