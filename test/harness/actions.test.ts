/**
 * worker.runner = actions: the specialist runs read only, a delegated worker step runs with write tools on the
 * specialist's brief and criteria, the specialist checks them, and one report is posted; memory as on AgentCore.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateEventCommand, ListEventsCommand, ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore'
import { afterAll, describe, expect, it } from 'vitest'
import { SPECIALISTS, toolsOf } from '../../src/agents/index.js'
import { AgentMemory, type SendClient } from '../../src/agents/runtime/memory.js'
import { SPECIALIST_BUILTINS, SPECIALIST_DENIED, WORKER_TOOLS } from '../../src/agents/specialist.js'
import { OUTPUT_JSON_SCHEMA, delegateStep, parseOutput, reportStep, specialistStep } from '../../src/harness/actions.js'
import { TASKS } from '../../src/harness/index.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

type Cmd = CreateEventCommand | ListEventsCommand | RetrieveMemoryRecordsCommand | ListMemoryRecordsCommand
class FakeMemory implements SendClient {
  sent: Cmd[] = []
  records: { memoryRecordId: string; content: { text: string }; namespaces: string[]; score?: number }[] = []
  async send(cmd: Cmd): Promise<unknown> {
    this.sent.push(cmd)
    if (cmd instanceof CreateEventCommand) return { event: { eventId: `e${this.sent.length}`, eventTimestamp: new Date(), payload: cmd.input.payload ?? [] } }
    if (cmd instanceof ListEventsCommand) return { events: [] }
    const ns = cmd.input.namespace ?? ''
    return { memoryRecordSummaries: this.records.filter((r) => r.namespaces.some((n) => n.startsWith(ns))) }
  }
  events(): { actor: string; session: string; text: string }[] {
    return this.sent.filter((c): c is CreateEventCommand => c instanceof CreateEventCommand).map((c) => ({
      actor: c.input.actorId ?? '', session: c.input.sessionId ?? '',
      text: (c.input.payload?.[0] as { conversational: { content: { text: string } } }).conversational.content.text,
    }))
  }
}

const MEMORY_ID = 'trace_m_abcd-abcdefghij'
const cfg = cfgOf({ worker: { max_turns: 77 } })
const ITEM = { kind: 'ci-red', number: 5, sha: SHA('a'), ref: 'claude/x', own: true, title: 'Timing fails', route: { kind: 'impl', reason: 'label agent:impl', confidence: 1, source: 'label' } }
const env = (more: Record<string, string> = {}) => ({ ITEM: JSON.stringify(ITEM), ...more }) as never
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const file = (messages: unknown[]): string => {
  const d = mkdtempSync(join(tmpdir(), 'trace-actions-')); dirs.push(d)
  const p = join(d, 'claude-execution-output.json')
  writeFileSync(p, JSON.stringify(messages))
  return p
}
const toolUse = (name: string, result: string): unknown[] => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t-${name}`, content: result }] } },
]
/** claude_args lines → flag → value */
const flags = (args: string): Map<string, string> => new Map(args.split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)] as [string, string] }))

const DELEGATION = { report: 'Worst slack -2.1 ns (run R7).', delegate: true, brief: 'Commit the seed 7 placer settings from run R7.', acceptance: ['fpga_timing: closure closed, worst slack >= 0'] }

describe('actions runner: the specialist step', () => {
  it('runs the specialist read only, with its own trace tools and a structured output', async () => {
    expect(TASKS['worker-prompt']).toBeTypeOf('function')
    const core = fakeCore()
    await specialistStep(deps(fakeGithub(), core, cfg, context(), env()), null)
    const a = flags(core.outputs.args!)
    expect(a.get('--tools')).toBe(SPECIALIST_BUILTINS.join(','))
    const allowed = a.get('--allowedTools')!.split(',')
    for (const t of ['Bash', 'Write', 'Edit', 'Task']) expect(allowed).not.toContain(t)
    expect(allowed).toContain('mcp__trace__fpga_closure')
    expect(allowed).not.toContain('mcp__trace__agent_delegate')
    expect(a.get('--disallowedTools')!.split(',')).toEqual([...SPECIALIST_DENIED])
    expect(JSON.parse(a.get('--json-schema')!.slice(1, -1))).toEqual(OUTPUT_JSON_SCHEMA)
    // TRACE_MCP_TOOLS for the install action: the specialist's tools only
    expect(core.outputs.tools!.split(',')).toEqual(toolsOf(SPECIALISTS.impl, { delegate: false }))
    expect(core.outputs.prompt).toMatch(/DELIVERY \(GitHub Actions\)/)
    expect(core.outputs).toMatchObject({ agent: 'impl', 'memory-session': 'pr-5', 'memory-actor': 'o/r/impl', 'worker-memory-actor': 'o/r/worker' })
    // hardware tools only on a runner wired to hardware
    const hw = fakeCore()
    await specialistStep(deps(fakeGithub(), hw, cfgOf(), context(), env({ AGENT: 'verify', HARDWARE: 'true' })), null)
    expect(hw.outputs.tools!.split(',')).toEqual(toolsOf(SPECIALISTS.verify, { delegate: false, hardware: true }))
  })

  it('recalls the specialist\'s memory into the prompt and records the request, as the AgentCore job does', async () => {
    const f = new FakeMemory()
    f.records = [{ memoryRecordId: 'r1', content: { text: 'Seed 7 closes timing.' }, namespaces: ['/trace/o/r/impl/facts/'], score: 0.9 },
      { memoryRecordId: 'r2', content: { text: 'Old worker note.' }, namespaces: ['/trace/o/r/worker/facts/'], score: 0.5 }]
    const core = fakeCore()
    await specialistStep(deps(fakeGithub(), core, cfg, context(), env()), new AgentMemory(MEMORY_ID, f, Date.now, () => ({ inactive: async () => new Map() }) as never))
    expect(core.outputs.prompt).toContain('- [fact] Seed 7 closes timing.')
    expect(core.outputs.prompt).toContain('- [legacy worker fact] Old worker note.')
    expect(f.events()).toEqual([{ actor: 'o/r/impl', session: 'pr-5', text: 'The required check failed on pull request #5: Timing fails (branch claude/x)' }])
  })
})

describe('actions runner: the delegation', () => {
  const mem = (f: FakeMemory) => new AgentMemory(MEMORY_ID, f, Date.now, () => ({ inactive: async () => new Map() }) as never)

  it('hands the brief and criteria to a worker step with write tools, and has the specialist check them read only', async () => {
    const f = new FakeMemory()
    const core = fakeCore()
    const exec = file([...toolUse('mcp__trace__fpga_timing', 'worst slack -2.1 ns'), { type: 'result', subtype: 'success', result: 'x' }])
    await delegateStep(deps(fakeGithub(), core, cfg, context(), env({ SPECIALIST: JSON.stringify(DELEGATION), EXECUTION_FILE: exec })), mem(f))
    expect(core.outputs.delegate).toBe('true')
    expect(core.outputs.prompt).toMatch(/You are the trace worker for o\/r/)
    expect(core.outputs.prompt).toContain('> Commit the seed 7 placer settings from run R7.')
    expect(core.outputs.prompt).toContain('> 1. fpga_timing: closure closed, worst slack >= 0')
    expect(core.outputs.prompt).toMatch(/Do not post a report on #5/)
    const w = flags(core.outputs.args!)
    expect(w.get('--allowedTools')).toBe(WORKER_TOOLS.join(','))
    expect(w.get('--max-turns')).toBe('77')
    expect(w.has('--json-schema')).toBe(false)
    expect(core.outputs['check-prompt']).toMatch(/THIS RUN IS THE CHECK/)
    expect(core.outputs['check-prompt']).toContain('1. fpga_timing: closure closed, worst slack >= 0')
    const c = flags(core.outputs['check-args']!)
    expect(c.get('--tools')).toBe(SPECIALIST_BUILTINS.join(','))
    expect(c.get('--allowedTools')!.split(',')).not.toContain('Bash')
    // the specialist's key tool outcome as itself; the worker's request as the worker, in the same session
    expect(f.events()).toEqual([
      { actor: 'o/r/impl', session: 'pr-5', text: 'trace fpga_timing: ok: worst slack -2.1 ns' },
      { actor: 'o/r/worker', session: 'pr-5', text: expect.stringContaining('Commit the seed 7 placer settings') as unknown as string },
    ])
  })

  it('delegates nothing without a brief and criteria, or without a structured output, and records the result', async () => {
    const f = new FakeMemory()
    const core = fakeCore()
    await delegateStep(deps(fakeGithub(), core, cfg, context(), env({ SPECIALIST: JSON.stringify({ report: 'Nothing to change: timing closes (run R8).', delegate: false }) })), mem(f))
    expect(core.outputs.delegate).toBe('false')
    expect(core.outputs.prompt).toBeUndefined()
    expect(f.events()).toEqual([{ actor: 'o/r/impl', session: 'pr-5', text: 'Result: Nothing to change: timing closes (run R8).' }])
    for (const bad of [JSON.stringify({ report: 'x', delegate: true }), 'not json', '']) {
      const c = fakeCore()
      await delegateStep(deps(fakeGithub(), c, cfg, context(), env({ SPECIALIST: bad })), null)
      expect(c.outputs.delegate).toBe('false')
    }
    expect(parseOutput(JSON.stringify({ report: 'r', delegate: false, extra: 1 }))).toMatchObject({ report: 'r', delegate: false })
  })
})

describe('actions runner: the report', () => {
  it('posts one report headed by the specialist and its route, with each criterion as the check found it', async () => {
    const f = new FakeMemory()
    const gh = fakeGithub()
    const core = fakeCore()
    const check = { report: 'Timing closes now (run R9).', delegate: false, criteria: [{ criterion: 'fpga_timing: closure closed, worst slack >= 0', met: true, evidence: 'run R9: slack +0.3 ns' }] }
    const worker = file([...toolUse('Bash', 'ok'), { type: 'result', subtype: 'success', result: '1. met: committed abc1234' }])
    const checkExec = file(toolUse('mcp__trace__fpga_timing', 'slack +0.3 ns'))
    await reportStep(deps(gh, core, cfg, context(), env({ SPECIALIST: JSON.stringify(DELEGATION), CHECK: JSON.stringify(check), WORKER_CONCLUSION: 'success', WORKER_EXECUTION_FILE: worker, EXECUTION_FILE: checkExec })),
      new AgentMemory(MEMORY_ID, f, Date.now, () => ({ inactive: async () => new Map() }) as never))
    const body = String(gh.called('issues.createComment')[0]!.args.body)
    expect(body).toMatch(/^\*\*trace Implementation specialist\*\* \(`impl`, GitHub Actions\)\. Routed here: label agent:impl/)
    expect(body).toContain('> Timing closes now (run R9).')
    expect(body).toContain('It delegated to the worker (success)')
    expect(body).toContain('1. met: fpga_timing: closure closed, worst slack >= 0 (run R9: slack +0.3 ns)')
    expect(core.failed).toBeNull()
    expect(f.events()).toEqual([
      { actor: 'o/r/worker', session: 'pr-5', text: 'Result: 1. met: committed abc1234' },
      { actor: 'o/r/impl', session: 'pr-5', text: 'trace fpga_timing: ok: slack +0.3 ns' },
      { actor: 'o/r/impl', session: 'pr-5', text: 'Result: Timing closes now (run R9).' },
    ])
  })

  it('says a criterion was not met or not checked, names escalate_to on an escalation, and fails without a report', async () => {
    const gh = fakeGithub()
    await reportStep(deps(gh, fakeCore(), cfgOf({ worker: { escalate_to: '@marc' } }), context(), env({ SPECIALIST: JSON.stringify(DELEGATION), WORKER_CONCLUSION: 'failure' })), null)
    const body = String(gh.called('issues.createComment')[0]!.args.body)
    expect(body).toContain('1. not checked: fpga_timing')
    expect(body).toContain('The check did not run or gave no structured answer.')
    const g2 = fakeGithub()
    await reportStep(deps(g2, fakeCore(), cfgOf({ worker: { escalate_to: '@marc' } }), context(), env({ SPECIALIST: JSON.stringify({ report: 'ESCALATE: the clock target needs a decision', delegate: false }) })), null)
    expect(String(g2.called('issues.createComment')[0]!.args.body)).toContain('@marc it needs a person:')
    const c3 = fakeCore()
    await reportStep(deps(fakeGithub(), c3, cfg, context(), env()), null)
    expect(c3.failed).toMatch(/without its structured output/)
  })
})

describe('actions runner: the workflow and the install action', () => {
  const root = join(import.meta.dirname, '..', '..')
  const template = readFileSync(join(root, 'templates', 'workflows', 'trace-worker.yml'), 'utf8')
  const install = readFileSync(join(root, 'harness', 'actions', 'install', 'action.yml'), 'utf8')

  it('lets pick claim a pull request: it comments on it, which needs pull-requests: write', () => {
    const pick = template.slice(template.indexOf('\n  pick:'), template.indexOf('\n  dispatch:'))
    expect(pick).toMatch(/permissions:\n(\s+#.*\n|\s+[\w-]+: \w+\n)*\s+pull-requests: write\n/)
    expect(pick).toMatch(/issues: write/)
  })

  it('runs the specialist, then the worker only when it delegated, then the check, then the report', () => {
    const work = template.slice(template.indexOf('\n  work:'))
    const order = ['task: worker-prompt', 'harness/actions/install@', 'id: specialist', 'task: worker-delegate', 'id: worker', 'id: check', 'task: worker-report']
    const at = order.map((o) => work.indexOf(o))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(work).toContain("if: ${{ !cancelled() && steps.delegate.outputs.delegate == 'true' }}")
    expect(work).toContain('${{ steps.delegate.outputs.args }}')
    expect(work).toContain("--mcp-config '${{ steps.tools.outputs.mcp-config-worker }}'")
    expect(work).toContain('tools: ${{ steps.prompt.outputs.tools }}')
    // memory: the repository variable reaches every step that uses it, after the AWS credentials
    expect(work.match(/memory-id: \$\{\{ vars\.TRACE_MEMORY_ID \}\}/g)?.length).toBe(4)
    expect(work.indexOf('configure-aws-credentials')).toBeLessThan(work.indexOf('task: worker-prompt'))
    // the old single step that added Bash/Write/Edit to the specialist is gone
    expect(template).not.toMatch(/ACTIONS_WORKER_TOOLS|worker-instructions/)
  })

  it('builds an MCP config limited to the specialist\'s tools, and the worker\'s without a limit, each with its memory actor', () => {
    const m = /node -e '\n([\s\S]*?)\n\s*'\n/.exec(install)
    expect(m).not.toBeNull()
    const script = m![1]!.replace(/^ {10}/gm, '')
    const d = mkdtempSync(join(tmpdir(), 'trace-install-')); dirs.push(d)
    const out = join(d, 'out')
    writeFileSync(out, '')
    execFileSync(process.execPath, ['-e', script], { env: {
      PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, TRACE_BIN: '/t/trace', HARDWARE: 'false', TOOLS: 'kicad.drc,fpga.timing',
      MEMORY_ID: MEMORY_ID, MEMORY_ACTOR: 'o/r/impl', WORKER_MEMORY_ACTOR: 'o/r/worker', MEMORY_SESSION: 'pr-5', AWS_REGION: 'us-east-1',
    } })
    const lines = new Map(readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), JSON.parse(l.slice(l.indexOf('=') + 1)) as { mcpServers: { trace: { command: string; env: Record<string, string> } } }]))
    expect(lines.get('mcp')!.mcpServers.trace).toEqual({ command: '/t/trace', args: ['mcp'], env: {
      TRACE_HARDWARE: '0', TRACE_MCP_TOOLS: 'kicad.drc,fpga.timing', TRACE_MEMORY_ID: MEMORY_ID, TRACE_MEMORY_SESSION: 'pr-5', TRACE_MEMORY_ACTOR: 'o/r/impl', AWS_REGION: 'us-east-1',
    } })
    expect(lines.get('mcp-worker')!.mcpServers.trace.env).toEqual({ TRACE_HARDWARE: '0', TRACE_MEMORY_ID: MEMORY_ID, TRACE_MEMORY_SESSION: 'pr-5', TRACE_MEMORY_ACTOR: 'o/r/worker', AWS_REGION: 'us-east-1' })
    // nothing given: every tool, no memory
    writeFileSync(out, '')
    execFileSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, TRACE_BIN: '/t/trace', HARDWARE: 'true' } })
    expect(JSON.parse(readFileSync(out, 'utf8').split('\n')[0]!.slice(4))).toEqual({ mcpServers: { trace: { command: '/t/trace', args: ['mcp'], env: { TRACE_HARDWARE: '1' } } } })
  })
})
