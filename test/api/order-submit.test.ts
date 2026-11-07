/**
 * Order submit (test-esp32 #225): each step shows what the record holds for it (today's stock and what changed since
 * the release approval, the package's files with their place in the repository, the options to enter with where each
 * comes from, the package's parts list with its LCSC parts, the order gate and the order), the options and the part
 * matching are ticked one by one, and Submit before the order gate meets "The order sheet matches the release".
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { type OrderView, orderLines, orderOptions } from '../../src/api/order-submit.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { loadJourney, setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'os-admin', email: 'os-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'os-user', email: 'os-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/order-submit'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-order-submit-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-order-submit-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
type Check = { id: string; status: string; detail?: string; unavailable?: string }
type View = { checks: Check[]; order: OrderView }
const view = async (): Promise<View> => await run(USER, 'skill.get', { repo: REPO, skill: 'order-submit' }) as View
const check = (v: View, id: string): Check | undefined => v.checks.find((c) => c.id === id)

const line = (n: number, mpn: string, lcsc: string, refs: string, price: number, o: Record<string, unknown> = {}) => ({ line: n, mpn, lcsc, refs, qty_per_board: 1, need: 10, status: 'ok', offer: { stock: 5000 }, unit_price: price, ...o })
const BOM_CSV = 'Quantity,References,Value,Footprint,MPN,Manufacturer,LCSC,Description\r\n2,C1 C2,10uF,C_0805,CL21A106KAYNNNE,Samsung,C15850,Cap\r\n1,U1,ESP32-WROOM-32E-N4,ESP32-WROOM-32E,ESP32-WROOM-32E-N4,Espressif,C701341,"RF Module, SMD"\r\n1,U3,AMS1117-3.3,SOT-223,AMS1117-3.3,AMS,C6186,LDO\r\n'

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Order submit' })
  db.prepare("UPDATE journey SET current_stage='fabricate' WHERE id='current'").run()
  for (const id of ['fabricate.order.package', 'fabricate.order.stock']) setCriterion(db, id, 'met', [{ kind: 'run', ref: `run-${id}` }], 'seed')
  const t = Date.now() / 1000
  // the release approval was signed between the two parts checks
  db.prepare('INSERT INTO gate_signatures (id, gate, revision, by, by_hash, at, criteria, waivers, notes) VALUES (?,?,?,?,?,?,?,?,?)').run('sig-1', 'signoff', 'A', 'Ann', 'h', t - 100, '[]', '[]', null)
  const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, args, result) VALUES (?,?,?,?,?,?,?,?)')
  runRow.run('bom-0', 'parts.bom_check', 'rows', t - 200, 'pass', '3 lines for 10 boards; 47.16 USD', '{}', JSON.stringify({ boards: 10, currency: 'USD', total: 47.16, blocking: 0, lines: [line(1, 'CL21A106KAYNNNE', 'C15850', 'C1 C2', 0.0312), line(2, 'ESP32-WROOM-32E-N4', 'C701341', 'U1', 3.4)] }))
  runRow.run('bom-1', 'parts.bom_check', 'rows', t - 40, 'pass', '3 lines for 10 boards; 46.94 USD', '{}', JSON.stringify({ boards: 10, currency: 'USD', total: 46.94, blocking: 0, lines: [line(1, 'CL21A106KAYNNNE', 'C15850', 'C1 C2', 0.0312), line(2, 'ESP32-WROOM-32E-N4', 'C701341', 'U1', 3.38), line(3, 'AMS1117-3.3', 'C6186', 'U3', 0.1)] }))
  runRow.run('board-1', 'kicad.board', 'hw/b.kicad_pcb', t - 30, 'pass', '2 layers', '{}', JSON.stringify({
    copper_layers: 2, thickness_mm: 1.6, outline: { width_mm: 50, height_mm: 35 }, footprints: { total: 4, top: 4, bottom: 0 },
    stackup: [{ name: 'F.Cu', outer: true, copper_um: 35 }, { name: 'B.Cu', outer: true, copper_um: 35 }],
    design_rules: { rules: { min_track_width: 0.15, min_clearance: 0.15, min_through_hole_diameter: 0.3 } },
  }))
  runRow.run('fab-1', 'kicad.fab', 'hw/b.kicad_pcb', t - 20, 'pass', '6 fab files', JSON.stringify({ out_dir: 'hardware/b/release/revA', house: 'jlcpcb' }), JSON.stringify({
    problems: [], placements: 4, hand_placed: [],
    files: [{ path: 'gerbers/b-F_Cu.gtl', bytes: 100 }, { path: 'b-bom.csv', bytes: 50 }, { path: 'b-gerbers.zip', bytes: 4000 }, { path: 'b-jlc-bom.csv', bytes: 60 }, { path: 'b-jlc-cpl.csv', bytes: 70 }],
  }))
  db.prepare('INSERT INTO artifacts (run_id, name, mime, bytes) VALUES (?,?,?,?)').run('fab-1', 'bom.csv', 'text/csv', new TextEncoder().encode(BOM_CSV))
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('Order submit: each step from the record', () => {
  it('Re-check stock: today\'s lines and what changed since the release approval', async () => {
    const s = (await view()).order.stock!
    expect(s).toMatchObject({ run: 'bom-1', today: true, total: 46.94, build_quantity: 10, changed: 2, signed: { run: 'bom-0', total: 47.16 } })
    expect(s.lines.map((l) => [l.mpn, l.change])).toEqual([['CL21A106KAYNNNE', null], ['ESP32-WROOM-32E-N4', 'price'], ['AMS1117-3.3', 'new']])
    expect(s.lines[1]).toMatchObject({ unit_price: 3.38, was_price: 3.4 })
  })

  it('Download the package: the files in the release folder, the ones to upload first', async () => {
    const p = (await view()).order.package!
    expect(p).toMatchObject({ run: 'fab-1', dir: 'hardware/b/release/revA', placements: 4, hand_placed: [] })
    expect(p.files.slice(0, 3).map((f) => [f.name, f.upload])).toEqual([['b-gerbers.zip', true], ['b-jlc-bom.csv', true], ['b-jlc-cpl.csv', true]])
    expect(p.files.find((f) => f.name === 'b-F_Cu.gtl')?.repo_path).toBe('hardware/b/release/revA/gerbers/b-F_Cu.gtl')
  })

  it('Enter the options: each from the board, the build plan or the package; defaults marked not decided', async () => {
    const o = (await view()).order.options
    const of = (id: string) => o.find((x) => x.id === id)
    expect(of('layers')).toMatchObject({ value: '2', source: 'kicad.board board-1', decided: true })
    expect(of('size')?.value).toBe('50 × 35 mm')
    expect(of('copper')?.value).toBe('1 oz (35 µm)')
    expect(of('track')?.value).toBe('0.15 mm / 0.15 mm')
    expect(of('quantity')).toMatchObject({ value: '10', source: 'the build plan' })
    expect(of('mask')).toMatchObject({ value: 'Green', decided: false })
    expect(of('side')?.value).toBe('Top side')
  })

  it('Review the part matching: the package\'s parts list with each LCSC part', async () => {
    const v = await view()
    expect(v.order.lines_from).toBe('package')
    expect(v.order.lines.map((l) => [l.refs, l.lcsc])).toEqual([['C1 C2', 'C15850'], ['U1', 'C701341'], ['U3', 'C6186']])
  })

  it('Pay and record: the order gate, not signed yet, and no order', async () => {
    const v = await view()
    expect(v.order.pay).toEqual({ gate: { id: 'fabricate.order', signed: null }, sheet: 'not_met', order: null })
    // not due yet, never "waived" (a risk accepted): nothing is paid before the gate, and it holds Submit back no more
    // than a waiver would (#227)
    expect(check(v, 'recorded')).toMatchObject({ status: 'not_due', detail: expect.stringMatching(/^not due yet: .*after the order gate is signed/) })
  })

  it('the options and the matching are ticked one by one, and Submit then meets the order sheet, keeping the draft', async () => {
    let v = await view()
    expect(check(v, 'options')).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/^Tick layers, dimensions/) })
    expect(check(v, 'options')?.unavailable).toBeUndefined()
    expect(check(v, 'matching')).toMatchObject({ status: 'not_met', detail: 'Confirm C1 C2, U1 and U3 against JLCPCB\'s matching.' })
    const draft = { entered: v.order.options.map((o) => o.id), matched: ['C1 C2', 'U1'], unplaced: ['U3'] }
    await run(USER, 'skill.draft', { repo: REPO, skill: 'order-submit', step: 3, data: draft })
    v = await view()
    expect(check(v, 'options')?.status).toBe('met')
    expect(check(v, 'matching')).toMatchObject({ status: 'met', detail: 'JLCPCB will not place U3.' })
    const out = await run(USER, 'skill.submit', { repo: REPO, skill: 'order-submit', draft }) as { criteria: { id: string; status: string }[]; draft_kept?: boolean; started: string[] }
    expect(out.criteria).toEqual([expect.objectContaining({ id: 'fabricate.order.sheet', status: 'met' })])
    expect(out.draft_kept).toBe(true)
    expect(out.started.join(' ')).toMatch(/order gate can be signed/)
    expect((await view()).order.pay.sheet).toBe('met')
  })
})

describe('Order submit: pure pieces', () => {
  it('with no package the lines come from the parts check, and with no board only the defaults and quantity are offered', () => {
    const rec = { parts: { id: 'p', status: 'pass', summary: null, started: 0, result: { lines: [{ line: 1, mpn: 'X', lcsc: 'C1', refs: 'R1', qty_per_board: 2 }] } }, signedParts: null, fab: null, board: null }
    expect(orderLines(rec)).toEqual({ lines: [{ key: 'R1', refs: 'R1', value: null, mpn: 'X', lcsc: 'C1', qty: 2 }], from: 'parts' })
    expect(orderOptions(null, rec).map((o) => o.id)).toEqual(['impedance', 'mask', 'silk', 'finish'])
  })

  it('a package that recorded its order options gives them, with the build plan\'s quantities', () => {
    const fab = { id: 'f', status: 'pass', summary: null, started: 0, outDir: null, bomCsv: null, result: { order_options: [
      { group: 'pcb', option: 'Layers', value: '4', source: 'the board file', decided: true },
      { group: 'pcb', option: 'Surface finish', value: 'HASL', source: 'JLCPCB\'s default', decided: false },
      { group: 'pcba', option: 'Assembly side', value: 'Top side (3 placed parts)', source: 'the placements', decided: true },
    ] } }
    const r = { journey: { build: { quantity: 5 } } } as unknown as Parameters<typeof orderOptions>[0]
    expect(orderOptions(r, { parts: null, signedParts: null, fab, board: { id: 'b', result: { copper_layers: 2 } } }).map((o) => [o.id, o.value])).toEqual([
      ['layers', '4'], ['surface-finish', 'HASL'], ['quantity', '5'], ['assembly-side', 'Top side (3 placed parts)'], ['assembled', '5'],
    ])
  })
})
