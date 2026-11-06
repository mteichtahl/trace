/**
 * One verdict rule for a requirement, shared by the verification report (verify.coverage, verify.report) and the
 * record's trace (requirements.trace): a waiver on a verified requirement is said beside "Verified", never hidden
 * (test-esp32 #209: REQ-d16b43 showed a bare "Verified" while its order test was waived to Fabricate).
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requirementEvidence } from '../../src/api/record-read.js'
import '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { VerifyDb } from '../../src/tools/verify/db.js'
import { buildMatrix, reportMarkdown } from '../../src/tools/verify/matrix.js'
import { type WaiverRef, requirementVerdict, setAsideWords } from '../../src/tools/verify/verdict.js'

const test = (id: string, status: string) => ({ id, status })
const waiver = (id: string, targetKind: string, target: string, caughtWhere: string | null = null, closedAt: number | null = null): WaiverRef => ({ id, targetKind, target, caughtWhere, closedAt })

describe('requirementVerdict', () => {
  it('reads the tests not set aside, as before', () => {
    expect(requirementVerdict('R', []).verdict).toBe('no_test')
    expect(requirementVerdict('R', [test('T1', 'pass')]).verdict).toBe('verified')
    expect(requirementVerdict('R', [test('T1', 'pass'), test('T2', 'fail')]).verdict).toBe('failing')
    expect(requirementVerdict('R', [test('T1', 'pass'), test('T2', 'planned')]).verdict).toBe('partial')
    expect(requirementVerdict('R', [test('T1', 'planned')]).verdict).toBe('untested')
    expect(requirementVerdict('R', [test('T1', 'waived')]).verdict).toBe('waived')
    expect(requirementVerdict('R', [test('T1', 'pass')], [], [{ met: false }]).verdict).toBe('coverage_gap')
  })

  it('a verified requirement keeps its verdict and says what was set aside', () => {
    // its pre-build tests pass, its order test waived (by status), with a waiver on the requirement naming Fabricate
    const v = requirementVerdict('REQ-d16b43', [test('TST-020', 'pass'), test('TST-029', 'pass'), test('TST-031', 'waived')], [waiver('W-1', 'requirement', 'REQ-d16b43', 'Fabricate')])
    expect(v).toMatchObject({ verdict: 'verified', set_aside: [{ test: 'TST-031', waiver: 'W-1', to: 'Fabricate' }], waiver: { id: 'W-1' } })
    expect(setAsideWords(v.set_aside)).toBe('TST-031 waived to Fabricate')
  })

  it('a person\'s waiver on a test sets it aside like a waived status; a closed waiver does not', () => {
    const tests = [test('T1', 'pass'), test('T2', 'planned')]
    expect(requirementVerdict('R', tests, [waiver('W-2', 'test', 'T2', 'Fabricate', 5)]).verdict).toBe('partial')
    const v = requirementVerdict('R', tests, [waiver('W-2', 'test', 'T2', 'the first article inspection at the board house')])
    expect(v.verdict).toBe('verified')
    expect(setAsideWords(v.set_aside)).toBe('T2 waived (checked instead: the first article inspection at the board house)')
  })

  it('a waiver on the requirement makes any verdict but verified waived', () => {
    const w = [waiver('W-3', 'requirement', 'R', null)]
    expect(requirementVerdict('R', [test('T1', 'fail')], w).verdict).toBe('waived')
    expect(requirementVerdict('R', [], w).verdict).toBe('waived')
    const v = requirementVerdict('R', [test('T1', 'pass')], w)
    expect(v.verdict).toBe('verified')
    expect(setAsideWords(v.set_aside)).toBe('waiver W-3 recorded')
    expect(setAsideWords([])).toBeNull()
  })
})

describe('the verification report and the trace say the same', () => {
  let dir = ''
  beforeEach(() => {
    for (const k of ['TRACE_PROJECT', 'TRACE_MEMORY_REPOSITORY', 'GITHUB_REPOSITORY', 'TRACE_PROJECT_HOME']) vi.stubEnv(k, '')
    dir = mkdtempSync(join(tmpdir(), 'trace-verdict-'))
    mkdirSync(join(dir, '.git'))
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('REQ-d16b43: verified with its order test waived to Fabricate, in the matrix, the report and requirements.trace', () => {
    const v = new VerifyDb(dir)
    v.addRequirement({ id: 'REQ-d16b43', text: 'At most 9 USD per board', kind: 'functional' })
    v.addRequirement({ id: 'REQ-f3f79d', text: 'At most 275 USD in all', kind: 'functional' })
    v.addTest({ id: 'TST-029', title: 'Cost estimate per board', requirements: ['REQ-d16b43'], method: 'inspection', status: 'pass' })
    v.addTest({ id: 'TST-031', title: 'Order cost', requirements: ['REQ-d16b43'], method: 'inspection', status: 'waived' })
    v.addTest({ id: 'TST-030', title: 'Cost estimate in all', requirements: ['REQ-f3f79d'], method: 'inspection', status: 'pass' })
    const t = Date.now() / 1000
    v.db.prepare(`INSERT INTO waivers (id, stage, gate, target_kind, target, reason, risk, severity, caught_where, scope, by, at, updated)
      VALUES ('W-9', 'signoff', NULL, 'requirement', 'REQ-d16b43', 'The order cost is known only when ordering.', 'Over budget at order.', 'degraded', 'Fabricate', 'this revision only', 'marc', ?, ?)`).run(t, t)
    const m = buildMatrix(v, { code: false })
    const row = m.requirements.find((r) => r.id === 'REQ-d16b43')
    expect(row).toMatchObject({ verdict: 'verified', note: 'TST-031 waived to Fabricate' })
    expect(m.requirements.find((r) => r.id === 'REQ-f3f79d')).not.toHaveProperty('note')
    expect(reportMarkdown(m, v.tests(), { title: 'V', generated: 'now' })).toContain('| REQ-d16b43 | functional | verified (TST-031 waived to Fabricate) |')
    v.close()

    const db = openProject(dir)
    const waivers = [{ id: 'W-9', closedAt: null, targetKind: 'requirement', target: 'REQ-d16b43', severity: 'degraded', reason: 'The order cost is known only when ordering.', caughtWhere: 'Fabricate' }]
    const q = requirementEvidence(db, { waivers }).find((x) => x.id === 'REQ-d16b43')
    expect(q).toMatchObject({ evidence: 'verified', waiver: 'W-9', note: 'TST-031 waived to Fabricate', why: 'TST-029 passed; TST-031 waived to Fabricate.' })
    // a failing requirement with a waiver on it is waived, as before
    db.prepare("UPDATE test_items SET status='fail' WHERE id='TST-029'").run()
    expect(requirementEvidence(db, { waivers }).find((x) => x.id === 'REQ-d16b43')).toMatchObject({ evidence: 'waived', why: 'Waived (degraded): The order cost is known only when ordering.' })
    db.close()
  })
})
