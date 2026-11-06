/**
 * Architecture choice through the API (test-esp32 #38, #96): skill.get lists the key parts of the option going ahead
 * with the newest parts check's stock and price, and an option another one outscores (trace's recommendation here)
 * asks for the person's own reason, in the bar and at Submit.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { mpnKey } from '../../src/tools/datasheets/mpn.js'
import { DesignDb } from '../../src/tools/design/db.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'k-admin', email: 'k-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'k-user', email: 'k-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/key-parts'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-key-parts-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-key-parts-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
type Check = { id: string; status: string; detail?: string }
type View = {
  checks: Check[]; pending_errors?: string[]
  recommendation: { recommended: string; reasonNeeded?: Record<string, string> }
  key_parts: { option: string; quantity: number | null; parts: { mpn: string; standing: string; why: string | null; check: { order_code: string | null; stock: number | null; unit_price: number | null; need: number } | null }[] }
}
const view = async (): Promise<View> => await run(USER, 'skill.get', { repo: REPO, skill: 'architecture-choice' }) as View
const reasons = async (): Promise<Check | undefined> => (await view()).checks.find((c) => c.id === 'reasons')

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'mixed', by: 'seed', name: 'Key parts' })
  setCriterion(db, 'architect.stock', 'met', [{ kind: 'run', ref: 'run-stock', label: 'the stock check' }], 'trace')
  const t = Date.now() / 1000
  db.prepare('INSERT INTO requirements (id, text, kind, acceptance, source, status, created, updated) VALUES (?,?,?,?,?,?,?,?)').run('REQ-1', 'Shows the reading', 'functional', 'on an OLED', 'intent', 'accepted', t, t)
  const d = new DesignDb(dir)
  // run 2's numbers: trace recommends A, but C scores higher (44 against 42.5)
  d.setOption({ id: 'A', name: 'ESP32-C3 module', summary: 'A module with the antenna on it.', recommended: true, why: 'Certified module, no RF layout.' })
  d.setOption({ id: 'C', name: 'ESP32-C3 chip', summary: 'The bare chip with a printed antenna.' })
  d.setCriteria([{ id: 'cost', name: 'Cost', weight: 5 }, { id: 'risk', name: 'Risk', weight: 4.5 }])
  d.setScores([
    { option: 'A', criterion: 'cost', score: 4, reason: 'Module costs more.' }, { option: 'A', criterion: 'risk', score: 5, reason: 'Certified.' },
    { option: 'C', criterion: 'cost', score: 5, reason: 'Chip is cheaper.' }, { option: 'C', criterion: 'risk', score: 4.2, reason: 'RF layout is ours.' },
  ])
  d.setBlocks('A', [
    { id: 'mcu', name: 'MCU', parts: [{ mpn: 'ESP32-C3-MINI-1-N4', key: true, role: 'module' }], requirements: ['REQ-1'], x: 0.2, y: 0.5 },
    { id: 'pwr', name: 'Power', parts: [{ mpn: '100nF-0402' }, { mpn: 'AP2112K-3.3TRG1', key: true }], requirements: [], x: 0.6, y: 0.5 },
  ])
  d.setBlocks('C', [{ id: 'mcu', name: 'MCU', parts: [{ mpn: 'ESP32-C3', key: true }], requirements: ['REQ-1'], x: 0.5, y: 0.5 }])
  d.close()
  const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
  const line = db.prepare('INSERT INTO parts_list_lines (run_id, line, mpn, part_key, order_code, refs, per_board, need, status, flags, stock, unit_price, line_total, currency, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const boards = db.prepare("INSERT INTO measurements (run_id, name, value) VALUES (?, 'boards', ?)")
  // an older check, then the newest: the newest line counts; an errored check is never read
  runRow.run('bom-old', 'parts.bom_check', 'rows', t - 100, 'fail', 'old', null)
  boards.run('bom-old', 10)
  line.run('bom-old', 1, 'ESP32-C3-MINI-1-N4', mpnKey('ESP32-C3-MINI-1-N4'), 'C2838502', null, 1, 10, 'short', '["short"]', 3, 2.9, 29, 'USD', null)
  runRow.run('bom-new', 'parts.bom_check', 'rows', t - 10, 'pass', 'new', null)
  boards.run('bom-new', 10)
  line.run('bom-new', 1, 'ESP32-C3-MINI-1-N4', mpnKey('ESP32-C3-MINI-1-N4'), 'C2838502', null, 1, 10, 'ok', '[]', 2140, 2.71, 27.1, 'USD', '2140 in stock, 10 needed')
  runRow.run('bom-err', 'parts.bom_check', 'rows', t - 5, 'error', 'no provider answered', null)
  line.run('bom-err', 1, 'AP2112K-3.3TRG1', mpnKey('AP2112K-3.3TRG1'), null, null, 1, 10, 'error', '[]', null, null, null, null, null)
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('Architecture choice: Accept the key parts', () => {
  it('lists the key parts of the option going ahead, with the newest check\'s supplier code, stock and price', async () => {
    const v = await view()
    expect(v.key_parts).toMatchObject({ option: 'A', quantity: 10 })
    expect(v.key_parts.parts.map((p) => [p.mpn, p.standing])).toEqual([['ESP32-C3-MINI-1-N4', 'ok'], ['AP2112K-3.3TRG1', 'unchecked']])
    expect(v.key_parts.parts[0]?.check).toMatchObject({ order_code: 'C2838502', stock: 2140, unit_price: 2.71, need: 10 })
  })
})

describe('Architecture choice: a reason for an option another one outscores', () => {
  it('the recommendation outscored asks for a reason: in the decision, in the bar, and at Submit', async () => {
    expect((await view()).recommendation.reasonNeeded).toEqual({ A: 'Option C scores higher (43.9 against 42.5)' })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: { choice: { option: 'A' }, deciding: ['risk'] } })
    expect(await reasons()).toMatchObject({ status: 'not_met', detail: 'Option C scores higher (43.9 against 42.5): say in a line why you chose A.' })
    expect((await view()).pending_errors?.join(' ')).toMatch(/Option C scores higher .*: say in a line why you chose A\./)
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'architecture-choice', draft: { choice: { option: 'A' }, deciding: ['risk'] } })).rejects.toThrow(/Option C scores higher/)
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: { choice: { option: 'A', reason: 'A certified module: no RF layout of our own.' }, deciding: ['risk'] } })
    expect((await reasons())?.status).toBe('met')
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: null })
  })

  it('the top score that is not the recommendation still needs its reason as against the recommendation', async () => {
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: { choice: { option: 'C' }, deciding: ['cost'] } })
    expect(await reasons()).toMatchObject({ status: 'not_met', detail: "Option A is trace's recommendation: say in a line why you chose C instead." })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: null })
  })
})
