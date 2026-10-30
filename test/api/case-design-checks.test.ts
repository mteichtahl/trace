/**
 * The Case design skill's checks (src/api/skill-checks.ts, case-design/*) over the latest mech.build run, and the stale
 * check they share with mech.fit (src/tools/mech/stale.ts): met, not met, and not met when the build is stale.
 */
import { describe, expect, it } from 'vitest'
import { type CheckInput, checkSkill } from '../../src/api/skill-checks.js'
import { type BuildInputs, ENGINE_VERSION, engineStamp, filesNow, sha256, staleReasons, staleSentence } from '../../src/tools/mech/stale.js'
import { PY_DIR } from '../../src/tools/mech/engine.js'

const inputs: BuildInputs = {
  board: 'hardware/x.kicad_pcb', board_sha256: 'b1', case_json_sha256: 'j1', case_py_sha256: 'p1', case_file: null, case_file_sha256: null,
  facts_sha256: 'f1', capabilities_checked: '2026-10-29', capabilities_sha256: 'c1', engine: { ts: ENGINE_VERSION, py_version: null, py_sha256: 'e1' },
}

const passing = {
  passed: true, fit_status: 'pass', process: { service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' }, problems: [],
  rules: [{ rule: 'wall', ok: true, detail: 'wall 2 mm' }, { rule: 'size', ok: true, detail: 'fits' }], warnings: [], inputs,
}

function input(result: Record<string, unknown> | null, o: Partial<CheckInput> = {}): CheckInput {
  return {
    r: null, viewer: { admin: false } as CheckInput['viewer'], requirements: [], struck: [], erc: null, drc: null, bom: null, board: null, placement: null,
    caseBuild: result ? { id: 'abcdef0123456789', status: result.passed ? 'pass' : 'fail', summary: 'fit …', result } : null,
    instruments: [], orders: [], tests: [], draft: null, gate: null, question: null, ...o,
  }
}

const byId = (rs: ReturnType<typeof checkSkill>) => Object.fromEntries((rs ?? []).map((c) => [c.id, c]))

describe('Case design checks', () => {
  it('are not met with no build', () => {
    const c = byId(checkSkill('case-design', input(null)))
    for (const id of ['process', 'clearances', 'fit', 'rules']) expect(c[id], id).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/No case build is recorded yet/) })
  })

  it('are met by a current, passing build', () => {
    const c = byId(checkSkill('case-design', input(passing, { caseStale: [] })))
    expect(c.process).toMatchObject({ status: 'met', detail: 'MJF PA12-HP at jlc3dp, within its build size.' })
    expect(c.clearances?.status).toBe('met')
    expect(c.fit).toMatchObject({ status: 'met', detail: expect.stringMatching(/^Build abcdef01: no clash/) })
    expect(c.rules?.status).toBe('met')
  })

  it('are not met by a failing build, each saying why', () => {
    const failing = {
      ...passing, passed: false, fit_status: 'fail', problems: ['J2 above: 3 mm, needs 40 mm', 'J1 clashes with the base (2.4 mm³)'],
      rules: [{ rule: 'wall', ok: false, detail: 'wall 1.0 mm is under MJF\'s 1.5 mm for a 55 mm part' }, { rule: 'size', ok: false, detail: 'the case is over 370 mm' }],
      warnings: ['clearance.parts.J1 differs from the recommendation without a reason in mechanical/case.json (set it with mech.settings)'],
    }
    const c = byId(checkSkill('case-design', input(failing, { caseStale: [] })))
    expect(c.process).toMatchObject({ status: 'not_met', detail: 'MJF PA12-HP at jlc3dp: the case is over 370 mm.' })
    expect(c.clearances).toMatchObject({ status: 'not_met', detail: '1 clearance changed without a reason: clearance.parts.J1.' })
    expect(c.fit).toMatchObject({ status: 'not_met', detail: 'J2 above: 3 mm, needs 40 mm; J1 clashes with the base (2.4 mm³).' })
    expect(c.rules).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/wall 1\.0 mm is under/) })
  })

  it('fit is not met by a passing build that is stale', () => {
    const c = byId(checkSkill('case-design', input(passing, { caseStale: ['mechanical/case.py changed since the build'] })))
    expect(c.fit).toMatchObject({ status: 'not_met', detail: 'The case was built before mechanical/case.py changed: run mech.build.' })
  })
})

describe('the stale check', () => {
  const now = (o: Partial<BuildInputs>): BuildInputs => ({ ...inputs, ...o })
  it('is current when nothing changed, and names each input that did', () => {
    expect(staleReasons(inputs, now({}))).toEqual([])
    expect(staleReasons(inputs, now({ board_sha256: 'b2' }))).toEqual(['hardware/x.kicad_pcb changed since the build'])
    expect(staleReasons(inputs, now({ board: 'hw/y.kicad_pcb' }))).toEqual(['the case\'s board is now hw/y.kicad_pcb (it was hardware/x.kicad_pcb)'])
    expect(staleReasons(inputs, now({ case_json_sha256: 'j2', case_py_sha256: 'p2' }))).toEqual(['mechanical/case.json changed since the build', 'mechanical/case.py changed since the build'])
    expect(staleReasons(inputs, now({ facts_sha256: 'f2' }))).toEqual(['the board facts trace reads from the board changed since the build (the facts reader or the height table)'])
    // a board change explains the facts' change: one reason
    expect(staleReasons(inputs, now({ board_sha256: 'b2', facts_sha256: 'f2' }))).toHaveLength(1)
    // the scheduled check moving the date on, with the same figures, leaves the build current; a changed figure does not
    expect(staleReasons(inputs, now({ capabilities_checked: '2027-01-15' }))).toEqual([])
    expect(staleReasons(inputs, now({ capabilities_checked: '2027-01-15', capabilities_sha256: 'c2' }))).toEqual(['the process capabilities changed (confirmed 2027-01-15; the build used the table of 2026-10-29)'])
    expect(staleReasons(inputs, now({ engine: { ts: ENGINE_VERSION, py_version: null, py_sha256: 'e2' } }))).toEqual(['the enclosure engine\'s code changed since the build'])
    expect(staleReasons(inputs, now({ engine: { ts: '2', py_version: null, py_sha256: 'e1' } }))[0]).toMatch(/contract changed/)
    expect(staleReasons({ ...inputs, engine: { ts: ENGINE_VERSION, py_version: '0.1', py_sha256: 'e1' } }, now({ engine: { ts: ENGINE_VERSION, py_version: '0.2', py_sha256: 'e1' } }))[0]).toMatch(/tracebridge\.mech 0\.1 to 0\.2/)
  })

  it('treats an older build without the new fields as stale, and skips fields it cannot compute', () => {
    const { facts_sha256: _f, capabilities_checked: _c, capabilities_sha256: _s, engine: _e, ...old } = inputs
    expect(staleReasons(old, now({}))).toEqual(expect.arrayContaining(['the build records no engine version']))
    expect(staleReasons(inputs, { board: inputs.board, board_sha256: 'b1', case_json_sha256: 'j1' })).toEqual([])
    expect(staleReasons(null, now({}))).toEqual(['the build recorded no inputs'])
  })

  it('reads the files a build recorded through a reader (the API reads the default branch)', async () => {
    const files: Record<string, string> = { 'hardware/x.kicad_pcb': 'board', 'mechanical/case.json': '{}', 'mechanical/case.py': 'print(1)' }
    const was: BuildInputs = { ...inputs, board_sha256: sha256('board'), case_json_sha256: sha256('{}'), case_py_sha256: sha256('print(1)') }
    const read = async (p: string) => (p in files ? new TextEncoder().encode(files[p]) : null)
    expect(staleReasons(was, await filesNow(was, read, { checked: '2026-10-29', sha256: 'c1' }))).toEqual([])
    files['mechanical/case.py'] = 'print(2)'
    const r = staleReasons(was, await filesNow(was, read, { checked: '2026-10-29', sha256: 'c1' }))
    expect(r).toEqual(['mechanical/case.py changed since the build'])
    expect(staleSentence(r)).toBe('The case was built before mechanical/case.py changed: run mech.build.')
  })

  it('fingerprints the Python engine from its source', () => {
    const e = engineStamp(PY_DIR)
    expect(e.ts).toBe(ENGINE_VERSION)
    expect(e.py_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(engineStamp('/nonexistent')).toEqual({ ts: ENGINE_VERSION, py_version: null, py_sha256: null })
  })
})
