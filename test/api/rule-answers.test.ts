/**
 * Rules from answers (test-esp32 log #109; src/api/rule-answers.ts): a question answered as "A rule for the project"
 * is added to .trace/rules.md, where every agent reads its rules from the default branch, through a change of trace's
 * own that says who decided and which question it answers. Before, the answer only reached the job that asked, and the
 * rules file stayed empty on every branch.
 *
 * The rules file first, as plain functions; then the answer paths (question.answer and the Question answer skill)
 * over a fake GitHub, Settings' list of rules (project.rules) and adding an older answer's rule from there, and the
 * change made again on the newest rules file when another rule landed first.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { answeredRequest } from '../../src/api/actions-journey.js'
import { redo } from '../../src/api/apply-edits.js'
import { editStore } from '../../src/api/edits.js'
import { RULES_PATH, type RuleAnswer, ruleEntry, rulesIn, withRule } from '../../src/api/rule-answers.js'
import { assign } from '../../src/core/access.js'
import { AgentFactsStore, addAgentQuestion } from '../../src/core/agent-facts.js'
import { putFollowup } from '../../src/core/answer-followups.js'
import { backendFor } from '../../src/core/central.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const thermal: RuleAnswer = {
  question: 'aq-thermal', asked: 'Can the modem transmit continuously, or should the design assume modem sleep?', askedBy: 'the Thermal specialist',
  rule: 'Design to modem sleep: no continuous transmit', reason: 'the case has no airflow', decidedBy: 'Marc Teichtahl', on: '2026-11-05',
}

describe('the rules file', () => {
  it('adds a rule under "Rules from answers", with who decided it and which question it answers', () => {
    const text = withRule(null, thermal) as string
    expect(text).toMatch(/^## Rules from answers\n/)
    expect(text).toContain('- Design to modem sleep: no continuous transmit.')
    expect(text).toContain('  - Why: the case has no airflow')
    expect(text).toContain('Decided by Marc Teichtahl on 2026-11-05, answering the Thermal specialist\'s question aq-thermal: "Can the modem transmit continuously')
    expect(rulesIn(text)).toEqual(['aq-thermal'])
  })

  it('adds it once, and keeps what the owner wrote', () => {
    const owner = '# Rules\n\nNever change the USB-C footprint.\n'
    const one = withRule(owner, thermal) as string
    expect(one.startsWith(owner.trimEnd())).toBe(true)
    expect(withRule(one, thermal)).toBeNull()
    // a second rule goes at the end of the section, before a heading the owner wrote after it
    const later = `${one}\n## Release\n\nTag every release.\n`
    const two = withRule(later, { ...thermal, question: 'aq-pins', rule: 'J2 is GND, VCC, SCL, SDA', reason: null }) as string
    expect(rulesIn(two)).toEqual(['aq-thermal', 'aq-pins'])
    expect(two.indexOf('J2 is GND')).toBeLessThan(two.indexOf('## Release'))
    expect(two).toContain('Tag every release.')
  })

  it('keeps a person\'s words from closing the marker or mentioning anyone', () => {
    const e = ruleEntry({ ...thermal, rule: 'sleep --> @someone <!-- x' })
    expect(e.split('\n').slice(1).join('\n')).not.toMatch(/-->|<!--|@s/)
  })

  it('tells the agent that carries on to apply it, and that trace writes the rules file, not the agent', () => {
    const r = answeredRequest({ id: 'aq-thermal', text: 'Modem sleep?', jobId: 'j', branch: 'b', answer: 'Sleep', reason: null, by: 'Marc', lasts: 'rule' })
    expect(r).toMatch(/memory\.remember/)
    expect(r).toMatch(/adds it to the project's rules \(\.trace\/rules\.md\)[\s\S]*do not edit \.trace\/rules\.md yourself/)
  })
})

// ------------------------------------------------------------------ the actions, over the fake GitHub

const REPO = 'acme/rules'
const ADMIN = { sub: 'r-admin', email: 'r-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'r-user', email: 'r-user@example.com', groups: ['trace-users'] }

class RulesGitHub extends FakeGitHub {
  pulls = 40
  opened: { head: string; title: string; body: string }[] = []
  resets: string[] = []
  async openPull(_repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }> {
    this.opened.push(o)
    return { number: ++this.pulls, existed: false }
  }
  async resetBranch(repo: string, branch: string, sha: string): Promise<void> { this.resets.push(branch); this.branches.set(`${repo}:${branch}`, sha) }
}

const github = new RulesGitHub([REPO])
const cognito = new FakeCognito()
cognito.add(USER.email, USER.sub, 'trace-users', 'Marc Teichtahl')
const scratch = mkdtempSync(join(tmpdir(), 'trace-rules-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-rules-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, tools: () => new Registry([]), scratch,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  store: (p) => backendFor(join(bucket, p)),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who))).result as Record<string, unknown>
const text = (branch: string): string => new TextDecoder().decode(github.files.get(`${REPO}:${branch}:${RULES_PATH}`) ?? new Uint8Array())

/** An agent's question, asked in a job that has ended. */
async function ask(q: string): Promise<string> {
  const record = (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
  let id = ''
  await new AgentFactsStore(backendFor(join(bucket, 'projects')), REPO).update((d) => {
    id = addAgentQuestion(d, { agent: 'thermal', label: 'the Thermal specialist', jobId: 'job-ask' }, {
      text: q, options: [{ id: 'a', label: 'Design to modem sleep: no continuous transmit', recommended: true, why: 'the case has no airflow' }, { id: 'b', label: 'Allow continuous transmit', why: 'simpler firmware' }],
    }, record)
    return { result: null }
  })
  return id
}

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Rules' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
})

describe('an answer made a rule for the project (log #109)', () => {
  let question = ''
  let branch = ''
  let once = ''

  it('question.answer adds it to .trace/rules.md through a change of trace\'s own, saying who decided and which question', async () => {
    question = await ask('Can the modem transmit continuously, or should the design assume modem sleep?')
    const r = await run(USER, 'question.answer', { repo: REPO, question, option: 'a', lasts: 'rule' })
    expect(r.rule).toMatchObject({ state: 'proposed', change: 41 })
    expect(r.started).toEqual(expect.arrayContaining([expect.stringMatching(/The rule goes into the project's rules \(\.trace\/rules\.md\) in change #41: it applies once an admin accepts it/)]))
    branch = String((r.rule as { branch: string }).branch)
    expect(branch).toMatch(/^trace\/rule-/)
    const file = text(branch)
    expect(file).toContain('- Design to modem sleep: no continuous transmit.')
    expect(file).toContain(`Decided by Marc Teichtahl on ${new Date().toISOString().slice(0, 10)}, answering the Thermal specialist's question ${question}`)
    expect(file).not.toContain(USER.email)
    expect(github.opened.at(-1)).toMatchObject({ head: branch, title: 'Project rule: Design to modem sleep: no continuous transmit' })
    // recorded as an app edit that changes the rules file only, and made again from its entry
    const edit = await editStore(ctx(ADMIN)).get(REPO, branch)
    expect(edit).toMatchObject({ kind: 'rule', number: 41, applies: 'review', paths: [RULES_PATH], redo: { op: 'rule', rule: { question, decidedBy: 'Marc Teichtahl' } } })
    // and on the record: the answer says it is a rule, and the rule's change is a decision
    const rec = (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
    expect(rec?.decisions.find((d) => d.kind === 'question.answered' && d.ref === question)?.detail).toEqual({ lasts: 'rule' })
    expect(rec?.decisions.find((d) => d.kind === 'rule.proposed' && d.ref === question)).toMatchObject({ by: USER.email, detail: { change: 41, branch } })
  })

  it('an answer for this time only writes no rule', async () => {
    once = await ask('Which log level for this test build?')
    const before = github.opened.length
    const r = await run(USER, 'question.answer', { repo: REPO, question: once, option: 'a', lasts: 'once' })
    expect(r.rule).toBeUndefined()
    expect(github.opened.length).toBe(before)
  })

  it('Settings lists it as waiting in its change, then as in the rules once that is on the default branch', async () => {
    const waiting = await run(USER, 'project.rules', { repo: REPO }) as { text: string | null; answers: { question: string; state: string; change: number | null; by: string }[] }
    expect(waiting.text).toBeNull()
    expect(waiting.answers).toEqual([expect.objectContaining({ question, state: 'waiting', change: 41, by: USER.email, rule: 'Design to modem sleep: no continuous transmit' })])
    // asking again does not make a second change
    expect(await run(USER, 'project.rule_from_answer', { repo: REPO, question })).toMatchObject({ state: 'waiting', change: 41 })
    // accepted: the default branch has it
    github.files.set(`${REPO}:main:${RULES_PATH}`, new TextEncoder().encode(text(branch)))
    await editStore(ctx(ADMIN)).remove(REPO, branch)
    const merged = await run(USER, 'project.rules', { repo: REPO }) as { text: string; answers: { state: string }[] }
    expect(merged.text).toContain('Design to modem sleep')
    expect(merged.answers).toEqual([expect.objectContaining({ question, state: 'in_rules', change: null })])
    expect(await run(USER, 'project.rule_from_answer', { repo: REPO, question })).toMatchObject({ state: 'in_rules' })
  })

  it('the Question answer skill records that the answer is a rule and adds it too', async () => {
    const q = await ask('Which pin order does the OLED header J2 need?')
    const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'question-answer', draft: { option: 'a', lasts: 'rule' } })
    expect(r).toMatchObject({ ok: true, ref: q, rule: { state: 'proposed', change: 42 } })
    const rec = (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
    expect(rec?.decisions.find((d) => d.kind === 'question.answered' && d.ref === q)?.detail).toEqual({ lasts: 'rule' })
    const file = text(String((r.rule as { branch: string }).branch))
    // made on the newest default branch: the thermal rule is there, and this one after it
    expect(rulesIn(file)).toEqual([question, q])
  })

  it('an answer made a rule before trace wrote them is listed as not in the rules, and is added from Settings', async () => {
    // answered through the skill before this fix: no lasts on the decision, only on the answer kept for its job
    const q = await ask('May the firmware log over the USB serial port in production?')
    await journeyStore(ctx(ADMIN), REPO).update((d) => {
      d.prepare('INSERT INTO questions (id, kind, asked_by, asked_of, stage, text, blocks, options, sources, job_id, asked_at, updated, answer, answered_by, answered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(q, 'question', 'the Thermal specialist', null, 'capture', 'May the firmware log over the USB serial port in production?', null, '[]', '[]', 'job-ask', 1, 1, 'No logging in production builds', 'someone@example.com', 1_762_300_000)
      putFollowup(d, { question: q, text: 'May the firmware log?', askedJob: 'job-ask', branch: 'claude/x', agent: 'thermal', answer: 'No logging in production builds', reason: null, lasts: 'rule', by: 'someone@example.com', bySub: 'x', job: null, attempts: 1, answeredAt: 1, startedAt: 1, stackOn: null }, 1)
      return { result: null }
    })
    const listed = await run(USER, 'project.rules', { repo: REPO }) as { answers: { question: string; state: string }[] }
    expect(listed.answers.find((x) => x.question === q)).toMatchObject({ state: 'missing' })
    const r = await run(USER, 'project.rule_from_answer', { repo: REPO, question: q })
    expect(r).toMatchObject({ state: 'proposed', change: 43 })
    // someone else answered it: their initials, never their email
    const file = text(String(r.branch))
    expect(file).toContain('Decided by a person on the project (S) on 2025-11-04')
    expect(file).not.toContain('someone@example.com')
    // an answer that was not made a rule is not added
    await expect(run(USER, 'project.rule_from_answer', { repo: REPO, question: once })).rejects.toThrow(/was not made a rule/)
  })

  it('made again on the newest rules file when another rule landed first, so the two never conflict', async () => {
    const edits = (await editStore(ctx(ADMIN)).list(REPO)).filter((e) => e.kind === 'rule')
    const pins = edits.find((e) => e.number === 42)!
    // change #43 was accepted first: the default branch now has the thermal and the logging rules
    const logging = edits.find((e) => e.number === 43)!
    github.files.set(`${REPO}:main:${RULES_PATH}`, new TextEncoder().encode(text(logging.branch)))
    await redo(ctx(ADMIN), github, REPO, pins)
    expect(github.resets).toContain(pins.branch)
    const ids = rulesIn(text(pins.branch))
    expect(ids).toHaveLength(3)
    expect(ids.at(-1)).toBe(pins.redo?.op === 'rule' ? pins.redo.rule.question : '')
  })
})
