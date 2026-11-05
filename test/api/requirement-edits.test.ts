/**
 * A change that edits an accepted requirement (src/api/requirement-edits.ts, test-esp32 log #112): found by comparing
 * the change's database with the design's, said plainly, and turned into "Ask for changes" when nothing asked for it.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { answeredRequest } from '../../src/api/actions-journey.js'
import { REQUIREMENT_CHANGE_SAID, editsView, requirementAsked, requirementEdits, withRequirementEdits } from '../../src/api/requirement-edits.js'
import type { JobRow } from '../../src/core/job-index.js'

const PIN = 'J2 pin order is GND, 3V3, SCL, SDA'
const NOTE = 'J2 pin 1 is GND; matches the OLED module (note)'

function db(rows: { id: string; text?: string; acceptance?: string | null; status?: string; updated?: number }[], decisions: { target: string; choice: string; detail: Record<string, unknown>; at?: number }[] = []): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE requirements (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, acceptance TEXT, source TEXT, page INTEGER, status TEXT NOT NULL, tags TEXT, created REAL NOT NULL, updated REAL NOT NULL, by TEXT);
    CREATE TABLE design_decisions (id TEXT PRIMARY KEY, kind TEXT, target TEXT, choice TEXT, detail TEXT, by TEXT, by_hash TEXT, at REAL, superseded_at REAL, updated REAL);`)
  for (const r of rows) d.prepare('INSERT INTO requirements VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(r.id, r.text ?? 'The display connector', 'functional', r.acceptance === undefined ? PIN : r.acceptance, null, null, r.status ?? 'proposed', null, 1, r.updated ?? 10, 'verify')
  decisions.forEach((x, i) => d.prepare('INSERT INTO design_decisions VALUES (?,?,?,?,?,?,?,?,NULL,?)').run(`d${i}`, 'requirement', x.target, x.choice, JSON.stringify(x.detail), 'marc', 'h', x.at ?? 20, x.at ?? 20))
  return d
}

const job = (o: Partial<JobRow> & { id: string }): JobRow => ({
  handle: null, session: null, kind: 'task', agent: 'verify', title: 't', number: null, requestedBySub: null, requestedBy: null, state: 'succeeded', step: null,
  queuedAt: null, startedAt: null, endedAt: null, beatAt: null, where: null, branch: null, parentJob: null, handoff: null, resumeOf: null, resumedBy: null,
  summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: 0, ...o,
})
const asking = (request: string) => JSON.stringify({ request })

describe('requirementEdits: the accepted requirements a change\'s database edits', () => {
  it('finds a rewritten acceptance criterion of a requirement a person accepted (REQ-367d71, change #10)', () => {
    const design = db([{ id: 'REQ-367d71' }, { id: 'REQ-aaaaaa', text: 'Runs from USB-C' }], [{ target: 'REQ-367d71', choice: 'accepted', detail: { text: 'The display connector', acceptance: PIN } }])
    const head = db([{ id: 'REQ-367d71', acceptance: NOTE, updated: 30 }, { id: 'REQ-aaaaaa', text: 'Runs from USB-C or a battery' }])
    const edits = requirementEdits(design, head)
    // REQ-aaaaaa is only proposed: changing a proposal costs nothing
    expect(edits).toEqual([{ id: 'REQ-367d71', parts: ['acceptance'], before: { text: 'The display connector', acceptance: PIN, status: 'proposed' }, after: { text: 'The display connector', acceptance: NOTE, status: 'proposed' } }])
  })

  it('counts a row marked accepted, a struck or removed requirement, and an older copy that puts back old words (#74)', () => {
    const design = db([{ id: 'R1', status: 'accepted', acceptance: '3.1-3.6 V', updated: 50 }, { id: 'R2', status: 'accepted' }, { id: 'R3', status: 'accepted' }])
    const head = db([{ id: 'R1', status: 'accepted', acceptance: '±3 % (tolerance inferred)', updated: 20 }, { id: 'R2', status: 'obsolete' }])
    expect(requirementEdits(design, head).map((e) => [e.id, e.parts])).toEqual([['R1', ['acceptance']], ['R2', ['struck']], ['R3', ['removed']]])
  })

  it('finds nothing when the accepted rows are the same, or the change has no requirements table', () => {
    const design = db([{ id: 'R1', status: 'accepted' }])
    expect(requirementEdits(design, db([{ id: 'R1', status: 'accepted', updated: 99 }]))).toEqual([])
    expect(requirementEdits(design, new DatabaseSync(':memory:'))).toEqual([])
  })
})

describe('requirementAsked: what on the branch asked for a requirement change', () => {
  const rec = (lasts: string, jobId: string) => ({
    questions: [{ id: 'Q-1', jobId } as never],
    decisions: [{ id: 'd', at: 1, kind: 'question.answered', stage: 'capture', ref: 'Q-1', summary: '', by: 'marc', detail: { lasts } }],
  })

  it('an answer said to change a requirement backs it; a rule or a one-off never does', () => {
    const req = (lasts: 'once' | 'rule' | 'requirement') => answeredRequest({ id: 'Q-1', text: 'Which pin order?', jobId: 'j0', branch: 'claude/pins', answer: 'GND first', reason: null, by: 'Marc', lasts })
    expect(requirementAsked([job({ id: 'j1', branch: 'claude/pins', payload: asking(req('requirement')) })], ['claude/pins'], null)).toMatch(/said the answer changes a requirement/)
    expect(requirementAsked([job({ id: 'j1', branch: 'claude/pins', payload: asking(req('rule')) })], ['claude/pins'], null)).toBeNull()
    expect(requirementAsked([job({ id: 'j1', branch: 'claude/pins', payload: asking(req('once')) })], ['claude/pins'], null)).toBeNull()
    // and the specialist is told so: leave the requirements as they are
    expect(req('rule')).toMatch(/did not say it changes a requirement: leave every requirement's words, acceptance criterion and status as they are/)
    expect(req('requirement')).toContain(REQUIREMENT_CHANGE_SAID)
  })

  it('follows the jobs that started the one on the branch, and the branch a stacked change builds on', () => {
    const jobs = [
      job({ id: 'j0', branch: 'claude/impl', payload: asking(`Your question Q-1 is answered.\n${REQUIREMENT_CHANGE_SAID} Have the change proposed.`) }),
      job({ id: 'j1', branch: 'claude/worker', parentJob: 'j0', payload: asking('Update the requirement') }),
      job({ id: 'j2', branch: 'claude/handoff', payload: asking('Propose REQ-1 again') }),
    ]
    expect(requirementAsked(jobs, ['claude/worker'], null)).not.toBeNull()
    expect(requirementAsked(jobs, ['claude/handoff'], null)).toBeNull()
    expect(requirementAsked(jobs, ['claude/handoff', 'claude/impl'], null)).not.toBeNull()
    expect(requirementAsked([job({ id: 'j3', branch: 'claude/cr', payload: asking('Change request (requirement): widen the rail\n\nWhy: x') })], ['claude/cr'], null)).toMatch(/change request/)
  })

  it('an answer the running job read itself counts by its recorded decision', () => {
    const jobs = [job({ id: 'j1', branch: 'claude/pins' })]
    expect(requirementAsked(jobs, ['claude/pins'], rec('requirement', 'j1'))).toBe('The answer to question Q-1 said it changes a requirement.')
    expect(requirementAsked(jobs, ['claude/pins'], rec('rule', 'j1'))).toBeNull()
    expect(requirementAsked(jobs, ['claude/pins'], rec('requirement', 'other'))).toBeNull()
  })
})

describe('the words and the recommendation', () => {
  const edit = requirementEdits(db([{ id: 'REQ-367d71', status: 'accepted' }]), db([{ id: 'REQ-367d71', status: 'accepted', acceptance: NOTE }]))
  const accept = { verdict: 'accept' as const, why: 'All 3 checks passed, and it can be merged.' }

  it('past Define: says it reopens Define, and recommends asking for changes when nothing asked for it', () => {
    const v = editsView(edit, true, null)!
    expect(v.says).toBe('Changes a requirement (REQ-367d71): accepting it reopens Define and every gate after it.')
    expect(v.edits[0]!.what).toBe(`REQ-367d71: its acceptance criterion changes from "${PIN}" to "${NOTE}".`)
    const r = withRequirementEdits(accept, v)
    expect(r.verdict).toBe('ask')
    expect(r.why).toMatch(/^Changes a requirement \(REQ-367d71\): accepting it reopens Define and every gate after it\. Nothing asked for that.*Ask for changes so it leaves the requirement as agreed/)
  })

  it('asked for: still accept, with the cost said first', () => {
    const r = withRequirementEdits(accept, editsView(edit, true, 'The answer to question Q-1 said it changes a requirement.'))
    expect(r).toEqual({ verdict: 'accept', why: 'Changes a requirement (REQ-367d71): accepting it reopens Define and every gate after it. The answer to question Q-1 said it changes a requirement. All 3 checks passed, and it can be merged.' })
  })

  it('in Define: said, without the reopen; a failing check keeps its own recommendation; no edits: unchanged', () => {
    const v = editsView(edit, false, null)!
    expect(v.says).toBe('Changes an accepted requirement (REQ-367d71): accepting it sends it back to Requirements review to be agreed again.')
    expect(withRequirementEdits(accept, v).verdict).toBe('accept')
    const failing = { verdict: 'ask' as const, why: 'The erc check failed. Ask trace to fix it before accepting.' }
    expect(withRequirementEdits(failing, editsView(edit, true, null)).why).toMatch(/^Changes a requirement .* The erc check failed/)
    expect(editsView([], true, null)).toBeNull()
    expect(withRequirementEdits(accept, null)).toBe(accept)
  })
})
