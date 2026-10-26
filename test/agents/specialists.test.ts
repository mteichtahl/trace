import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DELEGATE_TOOL, SHARED_TOOLS, SPECIALISTS, SPECIALIST_BUILTINS, SPECIALIST_KINDS, allowedToolsOf, mcpToolName, specialistPrompt, toolsOf,
} from '../../src/agents/index.js'
import { mcpName as specialistMcpName } from '../../src/agents/specialist.js'
import { type RouteInput, classificationPrompt, labelKind, route, routeJob, sdkClassifier } from '../../src/agents/router.js'
import { createDelegations, delegatedRequest } from '../../src/agents/runtime/delegation.js'
import { type ClaudeOptions, type RunnerDeps, TOOLS, createRunner } from '../../src/agents/runtime/job.js'
import { type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import { DelegatedTaskPayload, InvocationSchema, type JobPayload, TaskPayload } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'
import { resolve } from '../../src/core/config.js'
import { allowlist, mcpName, offered } from '../../src/core/mcp.js'
import { dispatchTask } from '../../src/harness/dispatch.js'
import * as worker from '../../src/harness/worker.js'
import { delegate, delegateEnv } from '../../src/tools/agent/tools.js'
import { allTools } from '../../src/tools/index.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from '../harness/fake.js'

const cfg = cfgOf()
const TOKEN = 'ghs_TESTTOKEN1234567890abcdef'

// ------------------------------------------------------------------ the definitions

describe('specialists', () => {
  it('cover verify, impl, ams, emc and render, each with a substantive definition', () => {
    expect(Object.keys(SPECIALISTS).sort()).toEqual([...SPECIALIST_KINDS].sort())
    for (const k of SPECIALIST_KINDS) {
      const s = SPECIALISTS[k]
      expect(s.kind).toBe(k)
      expect(s.memoryAgent).toBe(k)
      expect(s.workflow.length).toBeGreaterThanOrEqual(5)
      expect(s.done.length).toBeGreaterThanOrEqual(2)
      expect(s.escalate.length).toBeGreaterThanOrEqual(2)
      expect(s.keywords.length).toBeGreaterThan(0)
    }
  })

  it('allow only tools that exist in the registry', () => {
    const names = new Set(allTools().list().map((t) => t.name))
    for (const k of SPECIALIST_KINDS) {
      const all = toolsOf(SPECIALISTS[k], { hardware: true, delegate: true })
      const missing = all.filter((t) => !names.has(t))
      expect(missing, `${k} allows tools the registry does not have`).toEqual([])
      for (const t of SHARED_TOOLS) expect(all).toContain(t)
      expect(all).toContain(DELEGATE_TOOL)
    }
  })

  it('keep to their area', () => {
    const area = (k: (typeof SPECIALIST_KINDS)[number]): string[] => SPECIALISTS[k].tools.map((t) => t.split('.')[0]!)
    expect(new Set(area('verify'))).toEqual(new Set(['verify', 'sim', 'kicad']))
    expect(area('impl')).toEqual(expect.arrayContaining(['fpga', 'pcb', 'kicad', 'render']))
    expect(SPECIALISTS.impl.tools).not.toContain('verify.run')
    expect(new Set(area('ams'))).toEqual(new Set(['ams', 'sim', 'calc', 'datasheets', 'parts']))
    expect(new Set(area('emc'))).toEqual(new Set(['emc', 'calc', 'kicad']))
    expect(new Set(area('render'))).toEqual(new Set(['render']))
    // hardware only when allowed, and only for verification
    expect(toolsOf(SPECIALISTS.verify)).not.toContain('hil.psu')
    expect(toolsOf(SPECIALISTS.verify, { hardware: true })).toContain('hil.psu')
    for (const k of ['impl', 'ams', 'emc', 'render'] as const) expect(toolsOf(SPECIALISTS[k], { hardware: true }).some((t) => t.startsWith('hil.'))).toBe(false)
  })

  it('have read-only built-ins and MCP names as the SDK spells them', () => {
    const a = allowedToolsOf(SPECIALISTS.emc)
    expect(a.slice(0, SPECIALIST_BUILTINS.length)).toEqual([...SPECIALIST_BUILTINS])
    for (const t of ['Bash', 'Write', 'Edit', 'Task', 'mcp__trace']) expect(a).not.toContain(t)
    expect(a).toContain('mcp__trace__emc_precheck')
    expect(a).toContain('mcp__trace__agent_delegate')
    expect(allowedToolsOf(SPECIALISTS.emc, { delegate: false })).not.toContain('mcp__trace__agent_delegate')
    expect(mcpToolName('kicad.net_length')).toBe('mcp__trace__kicad_net_length')
    expect(specialistMcpName('a.b_c')).toBe(mcpName('a.b_c'))
  })
})

// ------------------------------------------------------------------ prompts

describe('specialist prompts', () => {
  const job = { kind: 'work-item' as const, item: { kind: 'ci-red' as const, number: 4, sha: SHA('c'), ref: 'claude/x', own: true, title: 'timing fails' } }

  it('include the project rules, the specialist\'s own instructions, the route and its tools', () => {
    const c = cfgOf({ agents: { impl: { instructions: 'Always try seeds 1..8 before touching RTL.' } } })
    const r = { kind: 'impl' as const, reason: 'label agent:impl', confidence: 1, source: 'label' as const }
    const p = specialistPrompt(SPECIALISTS.impl, { cfg: c, repository: 'o/r', job, rules: 'Never change the clock target.\n', route: r })
    expect(p).toMatch(/You are trace's Implementation specialist for o\/r/)
    expect(p).toContain('<rules>\nNever change the clock target.\n</rules>')
    expect(p).toContain('agents.impl.instructions')
    expect(p).toContain('<instructions>\nAlways try seeds 1..8 before touching RTL.\n</instructions>')
    // the rules come before the specialist's own instructions, and win
    expect(p.indexOf('<rules>')).toBeLessThan(p.indexOf('<instructions>'))
    expect(p).toContain('You were given this job because: label agent:impl (routing: label, confidence 1.00)')
    expect(p).toContain('ci-red #4')
    expect(p).toContain('fpga_closure')
    expect(p).toContain('agent_delegate')
    expect(p).toMatch(/GUARDRAILS/)
    expect(p).toMatch(/ESCALATE/)
    expect(p).not.toMatch(/\b\d+x faster\b/i)
  })

  it('say so when there are no rules, leave out empty instructions, and cut very long rules', () => {
    const p = specialistPrompt(SPECIALISTS.verify, { cfg, repository: 'o/r', job: { kind: 'preview' }, rules: null })
    expect(p).toMatch(/no rules file, or it is empty/)
    expect(p).not.toContain('<instructions>')
    const long = specialistPrompt(SPECIALISTS.verify, { cfg, repository: 'o/r', job: { kind: 'preview' }, rules: 'x'.repeat(30_000) })
    expect(long).toMatch(/cut at 20000 characters/)
  })

  it('inline the worker\'s instructions where there is no runtime to delegate to', () => {
    const p = specialistPrompt(SPECIALISTS.ams, { cfg, repository: 'o/r', job, rules: '', delivery: { inline: 'WORKER TEXT' } })
    expect(p).toContain('<worker-instructions>\nWORKER TEXT\n</worker-instructions>')
    expect(p).not.toContain('agent_delegate')
  })
})

// ------------------------------------------------------------------ the router

describe('router', () => {
  it('maps the agent:<kind> labels from the settings', () => {
    expect(labelKind('agent:verify', cfg)).toBe('verify')
    expect(labelKind('AGENT:EMC', cfg)).toBe('emc')
    expect(labelKind('needs-emc', cfgOf({ labels: { agent_emc: 'needs-emc' } }))).toBe('emc')
    expect(labelKind('agent-fix', cfg)).toBeNull()
  })

  it('takes an explicit kind first, then a label, then evidence, then keywords, then the default', () => {
    const everything: RouteInput = {
      kind: 'ams', labels: ['agent:emc'], checks: [{ name: 'nextpnr timing' }], text: 'cocotb testbench coverage',
    }
    expect(route(everything, cfg)).toMatchObject({ kind: 'ams', source: 'explicit', confidence: 1 })
    expect(route({ ...everything, kind: undefined }, cfg)).toMatchObject({ kind: 'emc', source: 'label', confidence: 1, reason: 'label agent:emc' })
    expect(route({ ...everything, kind: undefined, labels: [] }, cfg)).toMatchObject({ kind: 'impl', source: 'evidence' })
    expect(route({ text: everything.text }, cfg)).toMatchObject({ kind: 'verify', source: 'keyword' })
    expect(route({ text: 'tidy the README' }, cfg)).toMatchObject({ kind: 'verify', source: 'default', confidence: 0.2 })
    expect(route({ text: 'tidy the README' }, cfgOf({ agents: { default: 'impl' } }))).toMatchObject({ kind: 'impl', source: 'default' })
  })

  it('reads failing checks, their logs and changed files', () => {
    expect(route({ checks: [{ name: 'verify / cocotb (uart)' }] }, cfg)).toMatchObject({ kind: 'verify', source: 'evidence' })
    expect(route({ checks: [{ name: 'build', log: 'ERROR: Max frequency for clock clk: 41 MHz (FAIL at 48 MHz)\nnegative slack' }] }, cfg).kind).toBe('impl')
    expect(route({ checks: [{ name: 'build', log: 'ams.spec PSRR: out of spec at ss/125C' }] }, cfg).kind).toBe('ams')
    expect(route({ checks: [{ name: 'build', log: 'emc.precheck: 3 return-path gaps' }] }, cfg).kind).toBe('emc')
    expect(route({ files: ['hw/fifo.sby'] }, cfg)).toMatchObject({ kind: 'verify', reason: 'changed hw/fifo.sby (SymbiYosys files)' })
    expect(route({ files: ['tb/test_uart.py', 'tb/tb_top.sv'] }, cfg).kind).toBe('verify')
    expect(route({ files: ['fpga/top.pcf'] }, cfg).kind).toBe('impl')
    expect(route({ files: ['hw/board.kicad_pcb'] }, cfg).kind).toBe('impl')
    expect(route({ files: ['sim/ldo.cir', 'models/opa.lib'] }, cfg).kind).toBe('ams')
    expect(route({ files: ['si/usb.s4p'] }, cfg).kind).toBe('emc')
    // many files of one kind count once: a big testbench change does not drown out the constraints
    const r = route({ files: ['fpga/top.lpf', 'tb/a_tb.sv', 'tb/b_tb.sv', 'tb/c_tb.sv'] }, cfg)
    expect(r.kind).toBe('impl')
    expect(r.confidence).toBeGreaterThanOrEqual(0.5)
    expect(r.confidence).toBeLessThanOrEqual(0.95)
  })

  it('ignores the summary gate name and breaks an evidence tie with keywords, or leaves it undecided', () => {
    const tie: RouteInput = { files: ['fpga/top.pcf', 'sim/amp.cir'] }
    expect(route(tie, cfg).source).toBe('default')
    expect(route(tie, cfg).reason).toMatch(/tied between impl, ams/)
    expect(route({ ...tie, text: 'phase margin of the op-amp' }, cfg)).toMatchObject({ kind: 'ams', source: 'evidence', confidence: 0.5 })
  })

  it('only routes to enabled specialists', () => {
    const only = cfgOf({ agents: { enabled: ['verify', 'impl'] } })
    expect(route({ kind: 'emc' }, only).source).toBe('default')
    expect(route({ kind: 'emc' }, only).reason).toMatch(/emc was asked for but is not enabled/)
    expect(route({ labels: ['agent:ams', 'agent:impl'] }, only)).toMatchObject({ kind: 'impl', source: 'label' })
    expect(route({ files: ['si/x.s2p'] }, only).source).toBe('default')
    expect(resolve({ 'agents.enabled': ['impl'] }).errors.join()).toMatch(/agents\.default: verify is not in agents\.enabled/)
    expect(resolve({ 'agents.enabled': ['impl'], 'agents.default': 'impl' }).errors).toEqual([])
  })

  it('asks the model only when nothing else decided, and never trusts it past its schema or the enabled list', async () => {
    const asked: string[] = []
    const model = (answer: unknown) => async (prompt: string): Promise<unknown> => { asked.push(prompt); return answer }
    expect(await routeJob({ labels: ['agent:emc'] }, cfg, model({ kind: 'ams', reason: 'x', confidence: 1 }))).toMatchObject({ kind: 'emc', source: 'label' })
    expect(asked).toHaveLength(0)
    const r = await routeJob({ text: 'make the rail quieter' }, cfg, model({ kind: 'ams', reason: 'supply noise is an analog question', confidence: 0.95 }))
    expect(r).toEqual({ kind: 'ams', source: 'model', confidence: 0.8, reason: 'the model: supply noise is an analog question' })
    expect(asked[0]).toContain('<job>\nmake the rail quieter\n</job>')
    expect(asked[0]).toContain('- emc: EMC & Simulation')
    expect(await routeJob({ text: 'x' }, cfg, model({ kind: 'worker', reason: 'r', confidence: 1 }))).toMatchObject({ source: 'default', kind: 'verify' })
    expect((await routeJob({ text: 'x' }, cfg, model('nonsense'))).reason).toMatch(/the model could not decide/)
    expect(await routeJob({ text: 'x' }, cfgOf({ agents: { enabled: ['verify', 'impl'] } }), model({ kind: 'emc', reason: 'r', confidence: 1 })))
      .toMatchObject({ kind: 'verify', source: 'default' })
    expect((await routeJob({ text: 'x' }, cfg, async () => { throw new Error('throttled') })).reason).toMatch(/throttled/)
    const n = asked.length
    await routeJob({ text: 'x' }, cfgOf({ agents: { route_with_model: false } }), model({ kind: 'ams', reason: 'r', confidence: 1 }))
    expect(asked).toHaveLength(n)
  })

  it('classifies with one tool-less, schema-constrained SDK call', async () => {
    const seen: Record<string, unknown>[] = []
    const q = sdkClassifier(({ options }) => { seen.push(options); return (async function* () {
      yield { type: 'result', subtype: 'success', structured_output: { kind: 'emc', reason: 'crosstalk', confidence: 0.7 } }
    })() }, { model: 'claude-small' })
    expect(await q(classificationPrompt({ text: 'crosstalk?' }, cfg))).toEqual({ kind: 'emc', reason: 'crosstalk', confidence: 0.7 })
    expect(seen[0]).toMatchObject({ model: 'claude-small', tools: [], mcpServers: {}, settingSources: [], maxTurns: 2, outputFormat: { type: 'json_schema' } })
    const failing = sdkClassifier(() => (async function* () { yield { type: 'result', subtype: 'error_max_turns' } })())
    await expect(failing('x')).rejects.toThrow(/error_max_turns/)
  })
})

// ------------------------------------------------------------------ schemas

describe('task schemas', () => {
  const base = { kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm@example.com' }
  it('accept a specialist or none, and never the worker from outside', () => {
    expect(TaskPayload.safeParse({ ...base, agent: 'impl' }).success).toBe(true)
    expect(TaskPayload.safeParse(base).success).toBe(true)
    expect(InvocationSchema.safeParse({ ...base, agent: 'worker' }).success).toBe(false)
    const delegation = { parentJobId: 'job-1', specialist: 'verify', acceptance: ['a'], depth: 1 }
    expect(InvocationSchema.safeParse({ ...base, agent: 'worker', delegation }).success).toBe(false)
    expect(DelegatedTaskPayload.safeParse({ ...base, agent: 'worker', delegation }).success).toBe(true)
    expect(DelegatedTaskPayload.safeParse({ ...base, agent: 'worker', delegation: { ...delegation, depth: 2 } }).success).toBe(false)
  })
})

// ------------------------------------------------------------------ delegation

describe('delegation', () => {
  const parent = (over: Partial<Parameters<ReturnType<typeof createDelegations>['register']>[0]> = {}) => ({
    jobId: 'job-p', kind: 'impl' as const, repository: 'o/r', dir: '/w/o__r/5', cfg, branch: 'claude/x', defaultBranch: 'main', session: 'pr-5', ...over,
  })

  it('starts a worker job carrying the brief and acceptance criteria, for the token\'s specialist only', () => {
    const d = createDelegations()
    const token = d.register(parent())
    const started: JobPayload[] = []
    const r = d.start({ token, brief: 'Commit the seed 7 placer settings of closure run R1.', acceptance: ['fpga_timing: closure closed'] }, (p) => { started.push(p); return { accepted: true, jobId: 'job-w' } })
    expect(r).toEqual({ accepted: true, jobId: 'job-w' })
    const p = started[0]!
    expect(DelegatedTaskPayload.parse(p)).toMatchObject({
      kind: 'task', agent: 'worker', repository: 'o/r', branch: 'claude/x', requestedBy: 'the trace impl specialist (job job-p)',
      delegation: { parentJobId: 'job-p', specialist: 'impl', acceptance: ['fpga_timing: closure closed'], depth: 1 },
    })
    expect((p as { request: string }).request).toBe(delegatedRequest('impl', 'job-p', 'Commit the seed 7 placer settings of closure run R1.', ['fpga_timing: closure closed']))
    expect((p as { request: string }).request).toMatch(/Implementation specialist \(job job-p\) delegated this to you/)
    expect((p as { request: string }).request).toContain('1. fpga_timing: closure closed')
    // one at a time
    expect(() => d.start({ token, brief: 'again', acceptance: ['x'] }, () => ({ accepted: true, jobId: 'job-w2' }))).toThrow(/still running/)
    expect(d.status(token, 'job-w', () => [{ id: 'job-w', kind: 'task', key: 'k', state: 'succeeded', startedAt: '', log: [] }]).state).toBe('succeeded')
    expect(() => d.start({ token, brief: 'again', acceptance: ['x'] }, () => ({ accepted: true, jobId: 'job-w2' }))).not.toThrow()
  })

  it('refuses unknown tokens, other specialists\' jobs, finished parents and the default branch', () => {
    const d = createDelegations()
    const a = d.register(parent())
    const b = d.register(parent({ jobId: 'job-q' }))
    d.start({ token: a, brief: 'x', acceptance: ['y'] }, () => ({ accepted: true, jobId: 'job-a' }))
    expect(() => d.start({ token: 'f'.repeat(64), brief: 'x', acceptance: ['y'] }, () => ({ accepted: true, jobId: 'z' }))).toThrow(/not a running specialist job/)
    expect(() => d.status(b, 'job-a', () => [])).toThrow(/not a job this specialist delegated/)
    d.unregister('job-p')
    expect(() => d.start({ token: a, brief: 'x', acceptance: ['y'] }, () => ({ accepted: true, jobId: 'z' }))).toThrow(/not a running specialist job/)
    expect(d.parent('job-p')).toBeNull()
    // on the default branch (an issue) the worker gets a branch of its own
    const c = d.register(parent({ jobId: 'job-abc', branch: 'main' }))
    const got: JobPayload[] = []
    d.start({ token: c, brief: 'x', acceptance: ['y'] }, (p) => { got.push(p); return { accepted: true, jobId: 'w' } })
    expect((got[0] as { branch: string }).branch).toBe('claude/impl-abc')
    const e = d.register(parent({ jobId: 'job-e', branch: 'main' }))
    expect(() => d.start({ token: e, brief: 'x', acceptance: ['y'], branch: 'main' }, () => ({ accepted: true, jobId: 'w' }))).toThrow(/never works on the default branch/)
  })

  describe('through the runtime server and the agent.delegate tool', () => {
    let close: (() => Promise<void>) | null = null
    const saved = { ...process.env }
    afterEach(async () => {
      await close?.(); close = null
      for (const k of ['TRACE_DELEGATE_URL', 'TRACE_DELEGATE_TOKEN', 'TRACE_DELEGATE_POLL_MS', 'TRACE_DELEGATE_TIMEOUT_S']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    })

    it('blocks until the worker ends and returns its summary; refuses without a token', async () => {
      const delegations = createDelegations()
      const release: (() => void)[] = []
      const runner: JobRunner = () => new Promise((r) => { release.push(() => r('branch claude/x, done in 3 turns')) })
      const jobs = createJobs(runner, { echo: () => undefined })
      const s = createAgentServer(jobs, { delegations })
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
      close = () => new Promise((r) => s.close(() => r()))
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`

      delete process.env.TRACE_DELEGATE_TOKEN
      expect(delegateEnv()).toBeNull()
      expect([...offered(allTools(), false).keys()]).not.toContain('agent_delegate')

      process.env.TRACE_DELEGATE_URL = url
      process.env.TRACE_DELEGATE_TOKEN = delegations.register(parent())
      process.env.TRACE_DELEGATE_POLL_MS = '10'
      expect([...offered(allTools(), false).keys()]).toContain('agent_delegate')
      const call = allTools().call('agent.delegate', { brief: 'fix it', acceptance: ['kicad_drc: 0 errors'] }, { hardware: false, via: 'test' })
      await new Promise((r) => setTimeout(r, 50))
      const running = jobs.jobStatus()
      expect(running).toHaveLength(1)
      expect(running[0]).toMatchObject({ kind: 'task', agent: 'worker', parentJobId: 'job-p', state: 'running' })
      release.forEach((r) => r())
      expect(await call).toMatchObject({ state: 'succeeded', summary: 'branch claude/x, done in 3 turns', job_id: running[0]!.id })

      process.env.TRACE_DELEGATE_TOKEN = 'a'.repeat(64)
      await expect(delegate.run({ brief: 'x', acceptance: ['y'] }, { hardware: false, via: 'test' })).rejects.toThrow(/not a running specialist job/)
      // /invocations never takes a worker task
      const r = await fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm', agent: 'worker', delegation: { parentJobId: 'job-p', specialist: 'impl', acceptance: ['y'], depth: 1 } }) })
      expect(r.status).toBe(400)
    })

    it('gives up after the timeout, saying the worker still runs', async () => {
      const delegations = createDelegations()
      const jobs = createJobs(() => new Promise(() => undefined), { echo: () => undefined })
      const s = createAgentServer(jobs, { delegations })
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
      close = async () => { await jobs.shutdown(100); await new Promise((r) => s.close(() => r(undefined))) }
      process.env.TRACE_DELEGATE_URL = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
      process.env.TRACE_DELEGATE_TOKEN = delegations.register(parent())
      process.env.TRACE_DELEGATE_POLL_MS = '10'
      process.env.TRACE_DELEGATE_TIMEOUT_S = '0.05'
      expect(await delegate.run({ brief: 'x', acceptance: ['y'] }, { hardware: false, via: 'test' })).toMatchObject({ state: 'timeout' })
    })
  })

  describe('in the job runner', () => {
    const dirs: string[] = []
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

    function setup(messages: unknown[] = [{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 4 }]) {
      const ws = mkdtempSync(join(tmpdir(), 'trace-spec-ws-')); dirs.push(ws)
      const calls: { prompt: string; options: ClaudeOptions }[] = []
      const cmds: string[] = []
      const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] })
      const delegations = createDelegations()
      const d: RunnerDeps = {
        exec: async (_c, args) => { cmds.push(args.join(' ')); return { stdout: args[0] === 'log' ? 'abc1234 Commit the settings' : '', stderr: '' } },
        getToken: async () => TOKEN, github: () => f.gh,
        claude: (a) => { calls.push(a); return (async function* () { for (const m of messages) yield m })() },
        settingsOf: (dir) => { writeRules(dir); return cfgOf({ agents: { emc: { instructions: 'Target class B.', max_turns: 33, model: 'claude-emc' } } }) },
        remoteSettings: async () => cfgOf(), workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, env: { PATH: '/usr/bin' }, now: Date.now,
        delegations, delegateUrl: 'http://127.0.0.1:8080',
      }
      return { d, calls, cmds, f, delegations, ws }
    }
    const writeRules = (dir: string): void => { mkdirSync(join(dir, '.trace'), { recursive: true }); writeFileSync(join(dir, '.trace', 'rules.md'), 'Ask before changing the stackup.') }
    const ctxOf = (jobId: string, startJob: (p: JobPayload) => { accepted: boolean; jobId: string } = () => ({ accepted: true, jobId: 'x' })) => {
      const routes: unknown[] = []
      return { routes, ctx: { jobId, signal: new AbortController().signal, log: () => undefined, startJob, route: (r: unknown) => { routes.push(r) } } }
    }

    it('runs the routed specialist with its prompt, rules, instructions, tools, model, memory actor and a delegation token', async () => {
      const h = setup()
      let tokenSeen: string | undefined
      h.d.claude = (a) => {
        h.calls.push(a)
        tokenSeen = a.options.mcpServers.trace!.env?.TRACE_DELEGATE_TOKEN
        // while the specialist runs, its job is registered as a parent
        expect(h.delegations.parent('job-s')).toMatchObject({ kind: 'emc', branch: expect.stringMatching(/^claude\/task-/) as unknown, dir: expect.stringContaining(join(h.ws, 'o__r')) as unknown })
        return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'Precheck clean.', num_turns: 4 } })()
      }
      const { ctx, routes } = ctxOf('job-s')
      const out = await createRunner(h.d)({ kind: 'task', repository: 'o/r', request: 'Check crosstalk between USB_D+ and CLK', requestedBy: 'm@example.com' }, ctx)
      expect(out).toMatch(/^emc: done in 4 turns: Precheck clean\./)
      expect(routes).toEqual([expect.objectContaining({ kind: 'emc', source: 'keyword' })])
      const { prompt, options } = h.calls[0]!
      expect(prompt).toMatch(/EMC & Simulation specialist/)
      expect(prompt).toContain('<rules>\nAsk before changing the stackup.\n</rules>')
      expect(prompt).toContain('<instructions>\nTarget class B.\n</instructions>')
      expect(options).toMatchObject({ model: 'claude-emc', maxTurns: 33, tools: [...SPECIALIST_BUILTINS] })
      expect(options.allowedTools).toEqual(allowedToolsOf(SPECIALISTS.emc))
      const env = options.mcpServers.trace!.env!
      expect(env.TRACE_MCP_TOOLS!.split(',')).toEqual(toolsOf(SPECIALISTS.emc))
      expect(env.TRACE_DELEGATE_URL).toBe('http://127.0.0.1:8080')
      expect(tokenSeen).toMatch(/^[0-9a-f]{64}$/)
      expect(Number(env.MCP_TOOL_TIMEOUT)).toBeGreaterThan(240 * 60 * 1000)
      // unregistered once the specialist ended: its token is dead
      expect(h.delegations.parent('job-s')).toBeNull()
    })

    it('runs a delegated worker in the specialist\'s checkout with the worker\'s own prompt and tools, and no way to delegate again', async () => {
      const h = setup([{ type: 'result', subtype: 'success', is_error: false, result: '1. met: fpga_timing closed', num_turns: 9 }])
      const dir = join(h.ws, 'o__r', '5')
      mkdirSync(dir, { recursive: true })
      const token = h.delegations.register({ jobId: 'job-p', kind: 'impl', repository: 'o/r', dir, cfg: cfgOf({ worker: { max_turns: 77 } }), branch: 'claude/x', defaultBranch: 'main', session: 'pr-5' })
      let payload: JobPayload | null = null
      h.delegations.start({ token, brief: 'Commit seed 7.', acceptance: ['fpga_timing: closure closed'] }, (p) => { payload = p; return { accepted: true, jobId: 'job-w' } })
      const { ctx } = ctxOf('job-w')
      const out = await createRunner(h.d)(payload!, ctx)
      expect(out).toContain('branch claude/x, done in 9 turns')
      expect(out).toContain('abc1234 Commit the settings')
      const { prompt, options } = h.calls[0]!
      expect(prompt).toMatch(/You are the trace worker for o\/r/)
      expect(prompt).toContain('> 1. fpga_timing: closure closed')
      expect(prompt).toContain('> Commit seed 7.')
      expect(options).toMatchObject({ cwd: dir, maxTurns: 77 })
      expect(options.allowedTools).toEqual(TOOLS)
      expect(options.tools).toBeUndefined()
      // depth 1: no token, no URL, no allowlist that would offer agent.delegate
      expect(options.env.TRACE_DELEGATE_TOKEN).toBeUndefined()
      expect(options.mcpServers.trace!.env?.TRACE_DELEGATE_TOKEN).toBeUndefined()
      expect(options.mcpServers.trace!.env?.TRACE_DELEGATE_URL).toBeUndefined()
      // the specialist's checkout: no clone, and nothing removed
      expect(h.cmds.some((c) => c.startsWith('clone'))).toBe(false)
      expect(h.f.called('issues.createComment')).toHaveLength(0)
      // a delegation whose specialist has gone is refused
      h.delegations.unregister('job-p')
      await expect(createRunner(h.d)(payload!, ctx)).rejects.toThrow(/is not running/)
    })
  })
})

// ------------------------------------------------------------------ the MCP server's allowlist

describe('MCP allowlist', () => {
  it('offers only the listed tools when TRACE_MCP_TOOLS is set', () => {
    expect(allowlist({})).toBeNull()
    const only = allowlist({ TRACE_MCP_TOOLS: 'kicad.drc, calc.via' })
    expect([...offered(allTools(), false, only).keys()].sort()).toEqual(['calc_via', 'kicad_drc'])
  })
})

// ------------------------------------------------------------------ the harness

describe('harness: pick → kind', () => {
  const pr = (n: number, over: Record<string, unknown> = {}) => ({
    number: n, draft: false, title: `PR ${n}`, body: '', labels: [], head: { ref: `claude/b${n}`, sha: SHA(String(n)), repo: { full_name: 'o/r' } }, ...over,
  })

  it('routes each picked item by label, failing checks and files, and says so in the claim', async () => {
    const f = fakeGithub({
      'pulls.list': [pr(1, { labels: [{ name: 'ci-red' }, { name: 'agent:emc' }] }), pr(2, { labels: [{ name: 'ci-red' }] }), pr(3)],
      'pulls.get': (a: Record<string, unknown>) => ({ number: a.pull_number, mergeable: a.pull_number === 3 ? false : true }),
      'pulls.listFiles': (a: Record<string, unknown>) => (a.pull_number === 3 ? [{ filename: 'sim/ldo.cir' }] : [{ filename: 'README.md' }]),
      'checks.listForRef': { check_runs: [{ name: 'tests pass', conclusion: 'failure' }, { name: 'fpga / nextpnr timing', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }] },
      'issues.listForRepo': [{ number: 9, title: 'Phase margin of the LDO loop is too low', body: '', labels: [{ name: 'agent-fix' }] }],
      'issues.listComments': [],
    })
    const core = fakeCore()
    await worker.pick(deps(f, core, cfg))
    const items = worker.WorkItemSchema.array().parse(JSON.parse(core.outputs.items!))
    const by = new Map(items.map((i) => [i.number, i]))
    expect(by.get(1)?.route).toMatchObject({ kind: 'emc', source: 'label' })
    expect(by.get(2)?.route).toMatchObject({ kind: 'impl', source: 'evidence' })
    expect(by.get(2)?.route?.reason).toMatch(/nextpnr timing/)
    expect(by.get(2)?.route?.reason).not.toMatch(/tests pass/)
    expect(by.get(3)).toMatchObject({ kind: 'conflict', route: { kind: 'ams', source: 'evidence' } })
    expect(by.get(9)?.route).toMatchObject({ kind: 'ams', source: 'keyword' })
    const claims = f.called('issues.createComment').map((c) => String(c.args.body))
    expect(claims).toHaveLength(4)
    expect(claims.some((b) => /It goes to the \*\*EMC & Simulation\*\* specialist \(`emc`\): label agent:emc/.test(b))).toBe(true)
  })

  it('leaves an item with nothing to go on to the runtime, and the pick still works when the evidence calls fail', async () => {
    const f = fakeGithub({
      'pulls.list': [], 'issues.listComments': [],
      'issues.listForRepo': [{ number: 4, title: 'Tidy up', body: '', labels: [] }],
    })
    const core = fakeCore()
    await worker.pick(deps(f, core, cfg))
    const [item] = worker.WorkItemSchema.array().parse(JSON.parse(core.outputs.items!))
    expect(item?.route).toBeUndefined()
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/the runtime routes it/)
    const g = fakeGithub({
      'pulls.list': [pr(5, { labels: [{ name: 'ci-red' }] })], 'issues.listForRepo': [], 'issues.listComments': [],
      'pulls.listFiles': () => new Error('500'), 'checks.listForRef': () => new Error('500'),
    })
    const c2 = fakeCore()
    await worker.pick(deps(g, c2, cfg))
    expect(JSON.parse(c2.outputs.items!)).toHaveLength(1)
  })

  it('worker-prompt (actions) builds the routed specialist\'s prompt, its tools and the kind; AGENT overrides', async () => {
    const item = { kind: 'ci-red', number: 5, sha: SHA('a'), ref: 'claude/x', own: true, title: 'x', route: { kind: 'impl', reason: 'label agent:impl', confidence: 1, source: 'label' } }
    const f = fakeGithub({ 'repos.getContent': { type: 'file', content: Buffer.from('No force pushes.').toString('base64') } })
    const core = fakeCore()
    await worker.prompt(deps(f, core, cfg, context(), { ITEM: JSON.stringify(item) }))
    expect(core.outputs.agent).toBe('impl')
    expect(core.outputs.prompt).toMatch(/Implementation specialist/)
    expect(core.outputs.prompt).toContain('<rules>\nNo force pushes.\n</rules>')
    expect(core.outputs.prompt).toContain('<worker-instructions>')
    expect(core.outputs.args).toMatch(/--max-turns 120/)
    expect(core.outputs.args).toMatch(/mcp__trace__fpga_closure/)
    expect(core.outputs.args).not.toMatch(/mcp__trace__emc_run/)
    expect(core.outputs.args).toMatch(/,Bash,/)
    const c2 = fakeCore()
    await worker.prompt(deps(f, c2, cfg, context(), { ITEM: JSON.stringify(item), AGENT: 'emc' }))
    expect(c2.outputs.agent).toBe('emc')
  })

  it('worker-dispatch sends the route in the payload and names the specialist on the item', async () => {
    const item = { kind: 'agent-fix', number: 9, sha: 'issue', ref: '', own: true, title: 'x', route: { kind: 'ams', reason: 'the words "ldo"', confidence: 0.75, source: 'keyword' } }
    const f = fakeGithub()
    const sent: unknown[] = []
    await dispatchTask(deps(f, fakeCore(), cfg, context(), { ITEM: JSON.stringify(item), TRACE_AGENT_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/x' } as never),
      async (it) => { sent.push(it); return { accepted: true, jobId: 'job-1' } })
    expect(sent[0]).toMatchObject({ number: 9, route: { kind: 'ams' } })
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/Analog & Mixed-Signal\*\* specialist \(`ams`\)/)
  })
})
