/**
 * mech.options (plan P7.4, P7.5) on the sample board: the case designs that could work, ranked with why, the rest
 * pruned with their rule; and, with ask, the feasible ones put to a person as a question in the journey's questions
 * record, recommended first. The rules run on the Python bridge (tracebridge.case_options), which needs no build123d.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentFactsStore, loadAgentFacts } from '../../../src/core/agent-facts.js'
import { backendFor } from '../../../src/core/central.js'
import { startJourney } from '../../../src/core/journey.js'
import { JourneyStore } from '../../../src/core/journey-store.js'
import { Registry } from '../../../src/core/registry.js'
import { Work } from '../../../src/core/store.js'
import { optionProcesses, tools } from '../../../src/tools/mech/tools.js'

const SAMPLE = join(import.meta.dirname, '..', '..', '..', 'templates', 'sample', 'hardware')
const python = process.env.TRACE_PYTHON || 'python3'
const ok = spawnSync(python, ['-c', 'import sys; sys.path.insert(0, "python"); import tracebridge.case_options'], { stdio: 'ignore', cwd: join(import.meta.dirname, '..', '..', '..') }).status === 0

describe.skipIf(!ok)('mech.options on the sample board', () => {
  const home = mkdtempSync(join(tmpdir(), 'trace-options-'))
  const repo = join(home, 'repo')
  const projects = backendFor(join(home, 'central', 'projects'))
  const ENV = { TRACE_HOME: join(home, 'central'), TRACE_PROJECT: 'acme/cased', TRACE_AGENT: 'impl', TRACE_AGENT_LABEL: 'the Implementation specialist', TRACE_JOB_ID: 'job-9' }
  const saved: Record<string, string | undefined> = {}
  const registry = new Registry(tools)
  const call = async (name: string, args: unknown) => (await registry.call(name, args, { hardware: false, via: 'test' })) as Record<string, any>
  const cwd = process.cwd()

  beforeAll(async () => {
    mkdirSync(join(repo, 'hardware'), { recursive: true })
    for (const ext of ['kicad_pcb', 'kicad_pro', 'kicad_sch']) copyFileSync(join(SAMPLE, `trace-sample.${ext}`), join(repo, 'hardware', `trace-sample.${ext}`))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    process.chdir(repo)
    const w = new Work()
    w.db.exec("CREATE TABLE IF NOT EXISTS requirements (id TEXT PRIMARY KEY, text TEXT, kind TEXT, acceptance TEXT, status TEXT, tags TEXT, created REAL, updated REAL, by TEXT)")
    w.db.prepare('INSERT INTO requirements (id, text, kind, status) VALUES (?,?,?,?)').run('REQ-MECH-1', 'The unit mounts on a DIN rail in the control cabinet.', 'mechanical', 'accepted')
    w.close()
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v }
    await new JourneyStore(projects, 'acme/cased').update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'Cased' }); return { result: null } })
  })
  afterAll(() => {
    process.chdir(cwd)
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('offers at least two designs with reasons, the requirement\'s first, and keeps the pruned ones with their rule', async () => {
    const r = await call('mech.options', {})
    expect(r.run_id).toMatch(/^[0-9a-f]{16}$/)
    expect(r.offered.length).toBeGreaterThanOrEqual(2)
    expect(r.offered[0]).toMatchObject({ rank: 1, recommended: true, choices: { template: 'din-rail', process: 'mjf' } })
    expect(r.offered[0].why.join(' ')).toMatch(/DIN rail/)
    for (const o of r.offered) expect(o.why.length && o.gives_up).toBeTruthy()
    expect(r.pruned.length).toBe(3 * 3 * 2 * optionProcesses().length - r.offered.length)
    for (const p of r.pruned) expect(p.rule && p.why).toBeTruthy()
    expect(r.asked).toBeUndefined()
  }, 60_000)

  it('with ask, puts the feasible ones to a person as a question, recommended first', async () => {
    const r = await call('mech.options', { ask: true })
    expect(r.asked.question_id).toMatch(/^aq/)
    const f = (await new AgentFactsStore(projects, 'acme/cased').read((db) => loadAgentFacts(db))).result
    const q = f.questions.find((x) => x.id === r.asked.question_id)!
    expect(q.text).toMatch(/^Which case should trace build for hardware\/trace-sample\.kicad_pcb\?/)
    expect(q.options.length).toBe(Math.min(6, r.offered.length))
    expect(q.options.filter((o) => o.recommended).map((o) => o.label)).toEqual([r.offered[0].label])
    expect(q.options[0]).toMatchObject({ id: 'case-1', recommended: true })
    expect(q.sources).toEqual([expect.objectContaining({ kind: 'run', ref: r.run_id })])
  }, 60_000)
})
