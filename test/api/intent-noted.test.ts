/**
 * The statements trace's Intent builder chat notes in the person's draft (test log R5; rows #7, #11, #84): they show
 * in the Draft intent panel at once and the quality bar checks them, with no job, branch or change; Submit intent
 * records them in the person's words (a decision of choice stated in the journey record, read as rows beside the
 * agents': src/tools/design/record.ts statedRows), the person's edit folded in and a rejected one left out.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { draftedStatements, pendingDecisions } from '../../src/api/actions-skills.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb, type DesignRows } from '../../src/tools/design/db.js'
import type { DesignDecision } from '../../src/tools/design/decisions.js'
import { intentView, linksView, statedRows } from '../../src/tools/design/record.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'n-admin', email: 'n-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'n-user', email: 'n-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/noted'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-noted-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-noted-bucket-'))
const started: unknown[] = []
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito,
  jobs: async () => ({ repositoryOf: () => null, jobStatus: async () => [], startJob: async (p) => { started.push(p); return { accepted: true, jobId: `job-${started.length}` } } }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Gadget' })
  // a new project: no agent has proposed any intent (the panel said "0 statements · from the record")
  new DesignDb(dir).close()
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})

/** Every topic answered, as the chat notes them (note_intent), one vague and one to reject. */
const NOTED = [
  { id: 'INT-a00001', topic: 'purpose', text: 'A desk gadget that shows the time and the room temperature, for one person at a desk.' },
  { id: 'INT-a00002', topic: 'environment', text: 'Indoors, 10 to 35 °C, no enclosure rating needed.' },
  { id: 'INT-a00003', topic: 'power', text: 'Powered from USB at 5 V, under 0.5 W.' },
  { id: 'INT-a00004', topic: 'interfaces', text: 'USB-C receptacle, USB 2.0 full speed, 12 Mbit/s, both directions.' },
  { id: 'INT-a00005', topic: 'performance', text: 'Shows the temperature to within 0.5 °C.' },
  { id: 'INT-a00006', topic: 'physical', text: 'A small board.' },
  { id: 'INT-a00007', topic: 'compliance', kind: 'dont_care', text: 'Internal prototype, no marks.' },
  { id: 'INT-a00008', topic: 'build', text: '5 boards per run, under 20 USD each.' },
  { id: 'INT-a00009', topic: 'constraints', kind: 'dont_care', text: 'No preferred parts.' },
  { id: 'INT-a00010', topic: 'references', text: 'None yet.' },
  { id: 'INT-a00011', topic: 'references', text: 'The old prototype board.' },
]

type View = { intent?: { topic: number; statements: { id: string; topic: string; text: string; state: string; flag?: string; interface?: Record<string, string> }[] }; checks: { id: string; status: string; detail?: string }[] }
const view = async (data: Record<string, unknown>): Promise<View> => {
  await run(USER, 'skill.draft', { repo: REPO, skill: 'intent-builder', step: 0, data })
  return await run(USER, 'skill.get', { repo: REPO, skill: 'intent-builder' }) as View
}

describe('statements noted in the Intent builder draft', () => {
  it('show in the panel as Draft at once and the quality bar checks them, with no job started', async () => {
    const v = await view({ proposed: NOTED.slice(0, 6) })
    const st = (id: string) => v.intent?.statements.find((x) => x.id === id)
    expect(st('INT-a00001')).toMatchObject({ topic: 'Purpose', state: 'draft' })
    // the bar reads them: a vague word with no number is flagged, and the topics not noted yet are named
    expect(st('INT-a00006')).toMatchObject({ state: 'needs_number', flag: 'Needs a number' })
    const c = Object.fromEntries(v.checks.map((x) => [x.id, x]))
    expect(c.vague).toMatchObject({ status: 'not_met', detail: expect.stringContaining('INT-a00006') })
    expect(c.answered).toMatchObject({ status: 'not_met', detail: '4 topics not answered or marked: Compliance, Build, Constraints, References.' })
    // an interface's fields are read from its words
    expect(c.interfaces?.status).toBe('met')
    expect(st('INT-a00004')?.interface).toMatchObject({ connector: 'USB-C receptacle', protocol: 'USB 2.0 full speed', rate: '12 Mbit/s', direction: 'both' })
    // the builder moves to the first topic not noted
    expect(v.intent?.topic).toBe(6)
    expect(started).toEqual([])
  })

  it('the person\'s decisions on them count in the preview: an edit gives the number, a rejection drops it', async () => {
    const v = await view({ proposed: NOTED, decisions: [{ statement: 'INT-a00006', choice: 'edit', text: 'The board is at most 60 × 40 mm.' }, { statement: 'INT-a00011', choice: 'reject', reason: 'there is no old board' }] })
    expect(v.checks.every((x) => x.status === 'met')).toBe(true)
    expect(v.intent?.statements.find((x) => x.id === 'INT-a00006')?.text).toBe('The board is at most 60 × 40 mm.')
    expect(v.intent?.statements.some((x) => x.id === 'INT-a00011')).toBe(false)
  })

  it('Submit intent records them in the person\'s words; the record has them accepted, the rejected one never', async () => {
    const draft = { proposed: NOTED, decisions: [{ statement: 'INT-a00006', choice: 'edit', text: 'The board is at most 60 × 40 mm.' }, { statement: 'INT-a00011', choice: 'reject', reason: 'there is no old board' }] }
    const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft }) as { ok: boolean; recorded?: string; jobId?: string }
    expect(r).toMatchObject({ ok: true, jobId: 'job-1' })
    expect(r.recorded).toMatch(/10 intent statements decided/)
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { intent: { id: string; text: string; state: string; source: { kind: string } | null; decided?: { by: string } }[] }
    expect(t.intent.map((x) => x.id).sort()).toEqual(NOTED.slice(0, 10).map((x) => x.id).sort())
    expect(t.intent.every((x) => x.state === 'accepted')).toBe(true)
    expect(t.intent.find((x) => x.id === 'INT-a00006')).toMatchObject({ text: 'The board is at most 60 × 40 mm.', source: { kind: 'person' }, decided: { by: USER.email } })
    // the draft is done with; coming back, the builder reads them from the record
    const v = await run(USER, 'skill.get', { repo: REPO, skill: 'intent-builder' }) as View & { draft: unknown }
    expect(v.draft).toBeNull()
    expect(v.intent?.statements).toHaveLength(10)
    expect(v.intent?.statements.every((x) => x.state === 'accepted')).toBe(true)
  })

  it('a stated statement is decided on later like any other: reworded with design.decide', async () => {
    await run(USER, 'design.decide', { repo: REPO, decision: { kind: 'intent', statement: 'INT-a00005', choice: 'edit', text: 'Shows the temperature to within 0.3 °C.' } })
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { intent: { id: string; text: string; state: string }[] }
    // the edit supersedes the stated decision; the statement is still there, in the new words
    expect(t.intent.find((x) => x.id === 'INT-a00005')).toMatchObject({ text: 'Shows the temperature to within 0.3 °C.', state: 'edited' })
    // and one cannot be stated over it from a draft (or over an agent's row)
    await expect(run(USER, 'design.decide', { repo: REPO, decision: { kind: 'stated', statement: 'INT-a00099', topic: 'purpose', text: 'x' } })).rejects.toThrow()
  })
})

describe('statedRows and the draft\'s statements (pure)', () => {
  const dec = (target: string, choice: string, detail: Record<string, unknown>, at: number, superseded: number | null = null): DesignDecision => ({ id: `${target}-${at}`, kind: 'intent', target, choice, detail, by: 'p@example.com', byHash: 'h', at, supersededAt: superseded })
  const none: DesignRows = { intent: [], links: [], options: [], criteria: [], scores: [], blocks: [], connections: [], pins: [], sheets: [] }

  it('reads a stated statement as the person\'s row, accepted; a drafted one as proposed; an agent\'s row of the same id wins', () => {
    const ds = [dec('INT-b1', 'stated', { topic: 'power', text: 'Runs from 5 V.' }, 1), dec('INT-b2', 'drafted', { topic: 'build', text: '5 boards.' }, 2)]
    const v = intentView(none, ds)
    expect(v.find((x) => x.id === 'INT-b1')).toMatchObject({ state: 'accepted', source: { kind: 'person' }, decided: { by: 'p@example.com' } })
    expect(v.find((x) => x.id === 'INT-b2')).toMatchObject({ state: 'proposed', decided: null })
    const agent = { ...statedRows([], ds)[0]!, text: 'The agent\'s words.', source: null }
    expect(statedRows([agent], ds).map((x) => x.id)).toEqual(['INT-b2'])
  })

  it('keeps the row once a later decision supersedes the stated one, and links reach it', () => {
    const ds = [dec('INT-c1', 'stated', { topic: 'power', text: 'Runs from 5 V.' }, 1, 2), dec('INT-c1', 'rejected', { text: 'Runs from 5 V.', reason: 'no' }, 2)]
    expect(intentView(none, ds).find((x) => x.id === 'INT-c1')?.state).toBe('rejected')
    const linked = { ...none, links: [{ requirement: 'R1', intent: 'INT-c1', removed: false, updated: 1, by: null }] }
    expect(linksView(linked)).toEqual([])
    expect(linksView(linked, ds)).toEqual([{ requirement: 'R1', intent: 'INT-c1' }])
  })

  it('takes only well-formed statements from the draft, never one an agent\'s row has, each once', () => {
    const rows = { intent: [{ id: 'INT-0000aa' }] } as unknown as DesignRows
    const got = draftedStatements({ proposed: [
      { id: 'INT-00000b', topic: 'power', text: 'Runs from 5 V.' }, { id: 'INT-00000b', topic: 'power', text: 'Twice.' }, { id: 'INT-0000aa', topic: 'power', text: 'Over the agent\'s.' },
      { id: 'bad', topic: 'power', text: 'Bad id.' }, { id: 'INT-00000c', topic: 'nowhere', text: 'Bad topic.' }, { id: 'INT-00000d', topic: 'compliance', kind: 'dont_care', text: 'No marks.' },
    ] }, rows)
    expect(got.map((x) => [x.statement, x.statement_kind])).toEqual([['INT-00000b', 'statement'], ['INT-00000d', 'dont_care']])
    // Submit leaves a rejected one out and folds an edit in; the preview keeps both, as drafted
    const ds = pendingDecisions('intent-builder', { proposed: [{ id: 'INT-00000b', topic: 'power', text: 'Runs from 5 V.' }, { id: 'INT-00000d', topic: 'build', text: '5 boards.' }], decisions: [{ statement: 'INT-00000b', choice: 'reject', reason: 'not so' }, { statement: 'INT-00000d', choice: 'edit', text: '10 boards per run.' }] }, none)
    expect(ds).toEqual([expect.objectContaining({ kind: 'stated', statement: 'INT-00000d', text: '10 boards per run.', draft: false })])
    const pre = pendingDecisions('intent-builder', { proposed: [{ id: 'INT-00000b', topic: 'power', text: 'Runs from 5 V.' }], decisions: [{ statement: 'INT-00000b', choice: 'reject', reason: 'not so' }] }, none, [], { acceptRest: false })
    expect(pre.map((d) => [d.kind, 'draft' in d ? d.draft : undefined])).toEqual([['stated', true], ['intent', undefined]])
  })
})
