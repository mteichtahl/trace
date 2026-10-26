import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { afterEach, describe, expect, it } from 'vitest'
import { dispatch, sessionId } from '../../src/agents/runtime/dispatch.js'
import {
  type ClaudeOptions, DONE, type Exec, type RunnerDeps, TOOLS, authHeader, cloneDir, createRunner, parseSecret, redactor,
} from '../../src/agents/runtime/job.js'
import { type JobRunner, type Jobs, createJobs } from '../../src/agents/runtime/jobs.js'
import { taskBranch, taskPrompt } from '../../src/agents/worker/prompt.js'
import { SPECIALISTS, SPECIALIST_BUILTINS, allowedToolsOf, specialistPrompt, toolsOf } from '../../src/agents/index.js'
import { InvocationSchema, type JobPayload, TaskPayload, WrongProject, checkProject } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'
import { dispatchTask } from '../../src/harness/dispatch.js'
import { TASKS } from '../../src/harness/index.js'
import type { WorkItem } from '../../src/harness/worker.js'
import * as worker from '../../src/harness/worker.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from '../harness/fake.js'

const ITEM: WorkItem = { kind: 'ci-red', number: 5, sha: SHA('a'), ref: 'claude/x', own: true, title: 'Fix it' }
const TOKEN = 'ghs_TESTTOKEN1234567890abcdef'

const until = async (f: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

// ------------------------------------------------------------------ server

describe('agent server', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => { await close?.(); close = null })

  const serve = async (jobs: Jobs, o: { project?: string; log?: (l: string) => void } = {}): Promise<string> => {
    const s = createAgentServer(jobs, o)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    close = () => new Promise((r) => s.close(() => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  }
  const post = async (base: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${base}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: r.status, json: (await r.json()) as Record<string, unknown> }
  }

  it('answers Healthy, HealthyBusy while a job runs, dedupes by item, and lists jobs', async () => {
    const release: (() => void)[] = []
    const seen: JobPayload[] = []
    const runner: JobRunner = (p) => { seen.push(p); return new Promise((r) => { release.push(() => r('ok')) }) }
    const jobs = createJobs(runner, { echo: () => undefined })
    const base = await serve(jobs)
    const ping = async (): Promise<unknown> => ((await (await fetch(`${base}/ping`)).json()) as { status: string }).status
    expect(await ping()).toBe('Healthy')

    const a = await post(base, { kind: 'work-item', repository: 'o/r', item: ITEM })
    expect(a.status).toBe(200)
    expect(a.json.accepted).toBe(true)
    expect(String(a.json.jobId)).toMatch(/^job-/)
    expect(await ping()).toBe('HealthyBusy')

    const dup = await post(base, { kind: 'work-item', repository: 'O/R', item: { ...ITEM, sha: SHA('b') } })
    expect(dup.json).toMatchObject({ accepted: false, jobId: a.json.jobId })
    const other = await post(base, { kind: 'work-item', repository: 'o/r', item: { ...ITEM, number: 6 } })
    expect(other.json.accepted).toBe(true)
    expect(seen).toHaveLength(2)

    const st = await post(base, { kind: 'status' })
    expect((st.json.jobs as { state: string }[]).map((j) => j.state)).toEqual(['running', 'running'])
    release.forEach((r) => r())
    await until(() => !jobs.busy())
    expect(await ping()).toBe('Healthy')
    const one = await post(base, { kind: 'status', jobId: a.json.jobId })
    expect((one.json.jobs as { state: string; summary: string }[])[0]).toMatchObject({ state: 'succeeded', summary: 'ok' })
    // finished: the same item can be started again
    expect((await post(base, { kind: 'work-item', repository: 'o/r', item: ITEM })).json.accepted).toBe(true)
  })

  it('rejects bad bodies and unknown routes', async () => {
    const base = await serve(createJobs(async () => 'x', { echo: () => undefined }))
    expect((await post(base, 'not json')).status).toBe(400)
    expect((await post(base, { kind: 'nope' })).status).toBe(400)
    const bad = await post(base, { kind: 'work-item', repository: '../etc', item: ITEM })
    expect(bad.status).toBe(400)
    expect(String(bad.json.issues)).toMatch(/repository/)
    expect((await post(base, { kind: 'work-item', repository: 'o/r', item: { ...ITEM, extra: 1 } })).status).toBe(400)
    expect((await post(base, { kind: 'sweep', repositories: [] })).status).toBe(400)
    expect((await fetch(`${base}/nowhere`)).status).toBe(404)
  })

  it('records failures and aborts running jobs on shutdown', async () => {
    const jobs = createJobs(async (p, ctx) => {
      if (p.kind === 'sweep') throw new Error('boom')
      await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('stopped'))))
      return 'never'
    }, { echo: () => undefined })
    const f = jobs.startJob({ kind: 'sweep', repositories: ['o/r'] })
    const w = jobs.startJob({ kind: 'work-item', repository: 'o/r', item: ITEM })
    await until(() => jobs.jobStatus(f.jobId)[0]?.state === 'failed')
    expect(jobs.jobStatus(f.jobId)[0]?.error).toBe('boom')
    await jobs.shutdown(1000)
    expect(jobs.jobStatus(w.jobId)[0]?.state).toBe('aborted')
  })

  it('in single-project mode, refuses (403, logged) anything for another repository', async () => {
    const seen: JobPayload[] = []
    const logged: string[] = []
    const jobs = createJobs(async (p) => { seen.push(p); return 'ok' }, { echo: () => undefined, project: 'acme/board' })
    const base = await serve(jobs, { project: 'acme/board', log: (l) => logged.push(l) })
    const other = await post(base, { kind: 'work-item', repository: 'other/repo', item: ITEM })
    expect(other.status).toBe(403)
    expect(other.json.error).toMatch(/serves acme\/board only, not other\/repo/)
    const task = await post(base, { kind: 'task', repository: 'acme/firmware', request: 'x', requestedBy: 'm' })
    expect(task.status).toBe(403)
    const sweep = await post(base, { kind: 'sweep', repositories: ['acme/board', 'other/repo'] })
    expect(sweep.status).toBe(403)
    expect(logged).toHaveLength(3)
    expect(logged[0]).toMatch(/"refused":"work-item"/)
    expect(seen).toHaveLength(0)
    // its own project, in any case, is served; status needs no repository
    expect((await post(base, { kind: 'work-item', repository: 'Acme/Board', item: ITEM })).json.accepted).toBe(true)
    expect((await post(base, { kind: 'status' })).status).toBe(200)
    await until(() => !jobs.busy())
    expect(seen).toHaveLength(1)
    // and the jobs and the runner refuse on their own, whoever calls them
    expect(() => jobs.startJob({ kind: 'work-item', repository: 'other/repo', item: ITEM })).toThrow(WrongProject)
    const h = harness({ project: 'acme/board' })
    try {
      await expect(createRunner(h.d)({ kind: 'work-item', repository: 'other/repo', item: ITEM }, h.ctx)).rejects.toThrow(WrongProject)
      expect(h.cmds).toHaveLength(0)
    } finally { h.cleanup() }
    expect(() => checkProject({ kind: 'status' }, 'acme/board')).not.toThrow()
    expect(() => checkProject({ kind: 'sweep', repositories: ['x/y'] }, undefined)).not.toThrow()
  })

  it('validates task payloads', () => {
    expect(TaskPayload.safeParse({ kind: 'task', repository: 'o/r', request: 'add a test', requestedBy: 'marc' }).success).toBe(true)
    expect(InvocationSchema.safeParse({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm', branch: '--upload-pack=x' }).success).toBe(false)
    expect(InvocationSchema.safeParse({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm', branch: 'a/../b' }).success).toBe(false)
  })
})

// ------------------------------------------------------------------ dispatch

class FakeClient {
  sent: InvokeAgentRuntimeCommand[] = []
  constructor(private readonly answer: string, private readonly status = 200) {}
  async send(cmd: InvokeAgentRuntimeCommand): Promise<{ response: { transformToString(): Promise<string> }; statusCode: number }> {
    this.sent.push(cmd)
    return { response: { transformToString: async () => this.answer }, statusCode: this.status }
  }
}

describe('dispatch', () => {
  it('makes deterministic session ids inside the limits and charset', () => {
    const a = sessionId('o/r', ITEM)
    expect(a).toBe(sessionId('o/r', ITEM))
    expect(a).not.toBe(sessionId('o/r', { ...ITEM, sha: SHA('b') }))
    expect(a.startsWith('trace-o-r-5-aaaaaaaaaaaa')).toBe(true)
    const cases = [sessionId('o/r', { number: 1, sha: 'issue' }), sessionId('owner.with.dots/repo_x', ITEM), sessionId(`${'a'.repeat(39)}/${'b'.repeat(100)}`, { number: 123456, sha: SHA('c') }),
      sessionId(`${'a'.repeat(200)}/${'b'.repeat(200)}`, ITEM)]
    for (const s of [a, ...cases]) {
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(s.length).toBeGreaterThanOrEqual(33)
      expect(s.length).toBeLessThanOrEqual(256)
    }
    expect(sessionId(`${'a'.repeat(200)}/${'b'.repeat(200)}`, ITEM)).not.toBe(sessionId(`${'a'.repeat(200)}/${'b'.repeat(199)}c`, ITEM))
  })

  it('invokes the runtime with the payload and parses the answer', async () => {
    const c = new FakeClient(JSON.stringify({ accepted: true, jobId: 'job-1' }))
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/trace-worker-abc'
    const r = await dispatch(ITEM, 'o/r', { runtimeArn: arn, client: c, runUrl: 'https://github.com/o/r/actions/runs/1' })
    expect(r).toMatchObject({ accepted: true, jobId: 'job-1' })
    const input = c.sent[0]!.input
    expect(input.agentRuntimeArn).toBe(arn)
    expect(input.qualifier).toBe('DEFAULT')
    expect(input.runtimeSessionId).toBe(sessionId('o/r', ITEM))
    const body = JSON.parse(new TextDecoder().decode(input.payload as Uint8Array)) as Record<string, unknown>
    expect(body).toEqual({ kind: 'work-item', repository: 'o/r', item: ITEM, runUrl: 'https://github.com/o/r/actions/runs/1' })
  })

  it('fails clearly without an ARN, on an error status, or on a strange answer', async () => {
    const prev = process.env.TRACE_AGENT_RUNTIME_ARN
    delete process.env.TRACE_AGENT_RUNTIME_ARN
    await expect(dispatch(ITEM, 'o/r', { client: new FakeClient('{}') })).rejects.toThrow(/TRACE_AGENT_RUNTIME_ARN/)
    if (prev !== undefined) process.env.TRACE_AGENT_RUNTIME_ARN = prev
    await expect(dispatch(ITEM, 'o/r', { runtimeArn: 'arn:x', client: new FakeClient('nope', 500) })).rejects.toThrow(/500/)
    await expect(dispatch(ITEM, 'o/r', { runtimeArn: 'arn:x', client: new FakeClient('[1]') })).rejects.toThrow(/unexpected/)
  })
})

// ------------------------------------------------------------------ worker-dispatch task

describe('worker-dispatch', () => {
  it('is registered, dispatches the item and comments the job id', async () => {
    expect(TASKS['worker-dispatch']).toBeTypeOf('function')
    const f = fakeGithub()
    const core = fakeCore()
    const calls: { item: WorkItem; repository: string; arn?: string }[] = []
    const env = { ITEM: JSON.stringify(ITEM), TRACE_AGENT_RUNTIME_ARN: 'arn:rt' }
    await dispatchTask(deps(f, core, cfgOf(), context(), env), async (item, repository, opts) => {
      calls.push({ item, repository, ...(opts.runtimeArn ? { arn: opts.runtimeArn } : {}) })
      return { accepted: true, jobId: 'job-42' }
    })
    expect(calls).toEqual([{ item: ITEM, repository: 'o/r', arn: 'arn:rt' }])
    const body = String(f.called('issues.createComment')[0]!.args.body)
    expect(body).toMatch(/Dispatched to the trace agent on AgentCore \(job job-42\)/)
    expect(f.called('issues.createComment')[0]!.args.issue_number).toBe(5)
    expect(core.outputs.job).toBe('job-42')
  })

  it('fails the step without an ARN or when the runtime refuses', async () => {
    const prev = process.env.TRACE_AGENT_RUNTIME_ARN
    delete process.env.TRACE_AGENT_RUNTIME_ARN
    let core = fakeCore()
    await dispatchTask(deps(fakeGithub(), core, cfgOf(), context(), { ITEM: JSON.stringify(ITEM) }), async () => ({ accepted: true, jobId: 'x' }))
    expect(core.failed).toMatch(/TRACE_AGENT_RUNTIME_ARN/)
    if (prev !== undefined) process.env.TRACE_AGENT_RUNTIME_ARN = prev
    core = fakeCore()
    const f = fakeGithub()
    await dispatchTask(deps(f, core, cfgOf(), context(), { ITEM: JSON.stringify(ITEM), TRACE_AGENT_RUNTIME_ARN: 'a' } as never), async () => { throw new Error('AccessDenied') })
    expect(core.failed).toMatch(/AccessDenied/)
    expect(f.called('issues.createComment')).toHaveLength(0)
  })

  it('worker-pick outputs the runner setting', async () => {
    const core = fakeCore()
    await worker.pick(deps(fakeGithub({ 'pulls.list': [], 'issues.listForRepo': [] }), core, cfgOf({ worker: { runner: 'actions' } })))
    expect(core.outputs.runner).toBe('actions')
    const c2 = fakeCore()
    await worker.pick(deps(fakeGithub({ 'pulls.list': [], 'issues.listForRepo': [] }), c2, cfgOf()))
    expect(c2.outputs.runner).toBe('agentcore')
  })
})

// ------------------------------------------------------------------ job runner

interface Recorded { cmd: string; args: readonly string[]; cwd?: string | undefined; env?: Record<string, string> | undefined }

function harness(over: Partial<RunnerDeps> = {}, claudeMessages: unknown[] = [{ type: 'result', subtype: 'success', is_error: false, result: 'Pushed abc.', num_turns: 7 }]) {
  const ws = mkdtempSync(join(tmpdir(), 'trace-agent-ws-'))
  const cmds: Recorded[] = []
  const exec: Exec = async (cmd, args, opts) => { cmds.push({ cmd, args, cwd: opts?.cwd, env: opts?.env }); return { stdout: '', stderr: '' } }
  const claudeCalls: { prompt: string; options: ClaudeOptions }[] = []
  const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] })
  const d: RunnerDeps = {
    exec,
    getToken: async () => TOKEN,
    github: () => f.gh,
    claude: (a) => { claudeCalls.push(a); return (async function* () { for (const m of claudeMessages) yield m })() },
    settingsOf: () => cfgOf({ worker: { max_turns: 42 } }),
    remoteSettings: async () => cfgOf(),
    workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, model: 'claude-test', env: { PATH: '/usr/bin' }, now: Date.now,
    ...over,
  }
  const lines: string[] = []
  const started: JobPayload[] = []
  const ctx = { jobId: 'job-t', signal: new AbortController().signal, log: (l: string) => { lines.push(l) }, startJob: (p: JobPayload) => { started.push(p); return { accepted: true, jobId: 'child' } } }
  return { d, cmds, claudeCalls, f, ctx, lines, started, ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

describe('job runner', () => {
  it('clones with the token only in environment, sets identity and the merge driver, then runs Claude', async () => {
    const h = harness()
    try {
      const s = await createRunner(h.d)({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)
      expect(s).toMatch(/7 turns/)
      for (const c of h.cmds) {
        expect(c.cmd).toBe('git')
        expect(c.args.join(' ')).not.toContain(TOKEN)
        expect(c.args.join(' ')).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))
        expect(c.args.join(' ')).not.toMatch(/https:\/\/[^/]*@/)
        expect(c.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
        expect(c.env?.GIT_CONFIG_VALUE_0).toBe(authHeader(TOKEN))
      }
      const flat = h.cmds.map((c) => c.args.join(' '))
      const dir = cloneDir(h.ws, 'o/r', '5')
      expect(flat[0]).toBe(`clone --depth=300 --branch main -- https://github.com/o/r.git ${dir}`)
      expect(flat).toContain('config user.name trace worker (Claude)')
      expect(flat).toContain('config user.email noreply@anthropic.com')
      expect(flat).toContain('config merge.trace-db.driver node /app/dist/cli.js db merge %O %A %B')
      expect(flat).toContain('fetch --depth=300 origin +refs/heads/claude/x:refs/remotes/origin/claude/x')
      expect(flat.at(-1)).toBe('checkout -B claude/x --track origin/claude/x')

      const { prompt, options } = h.claudeCalls[0]!
      // "Fix it" says nothing and no model is configured: the default specialist (verify), with its own prompt
      const cfg = cfgOf({ worker: { max_turns: 42 } })
      const route = { kind: 'verify' as const, reason: 'nothing points to a specialist: the default (agents.default)', confidence: 0.2, source: 'default' as const }
      const { route: _none, ...item } = ITEM
      expect(prompt).toBe(specialistPrompt(SPECIALISTS.verify, { cfg, repository: 'o/r', job: { kind: 'work-item', item }, rules: null, route, hardware: false, delivery: 'delegate' }))
      expect(prompt).toMatch(/Verification specialist/)
      expect(prompt).toMatch(/Bedrock AgentCore Runtime/)
      // the specialist's own turn limit (agents.verify.max_turns), not the worker's
      expect(options).toMatchObject({ cwd: dir, model: 'claude-test', maxTurns: 120, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
      expect(options.tools).toEqual([...SPECIALIST_BUILTINS])
      expect(options.allowedTools).toEqual(allowedToolsOf(SPECIALISTS.verify, { delegate: false }))
      expect(options.allowedTools).not.toContain('Bash')
      expect(options.allowedTools).not.toEqual(TOOLS)
      expect(options.mcpServers.trace).toMatchObject({ type: 'stdio', command: 'node', args: ['/app/dist/cli.js', 'mcp'] })
      expect(options.mcpServers.trace!.env?.TRACE_MCP_TOOLS).toBe(toolsOf(SPECIALISTS.verify, { delegate: false }).join(','))
      expect(options.env.GH_TOKEN).toBe(TOKEN)
      // Claude commented? The fake has no comments since start, so the runner posts its summary once.
      const posted = h.f.called('issues.createComment')
      expect(posted).toHaveLength(1)
      const body = String(posted[0]!.args.body)
      expect(body).toContain(DONE('job-t'))
      // which specialist acted, and why it was routed there
      expect(body).toMatch(/\*\*trace Verification specialist\*\* \(`verify`, job `job-t`\)\. Routed here: nothing points to a specialist/)
      expect(body).toContain('> Pushed abc.')
      expect(h.lines.join('\n')).not.toContain(TOKEN)
    } finally { h.cleanup() }
  })

  it('posts the specialist\'s report once per job, even when a worker commented meanwhile', async () => {
    const h = harness()
    try {
      const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [{ body: 'Fixed in abc', created_at: new Date(Date.now() + 1000).toISOString() }] })
      await createRunner({ ...h.d, github: () => f.gh })({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)
      expect(f.called('issues.createComment')).toHaveLength(1)
      const g = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [{ body: `done ${DONE('job-t')}`, created_at: new Date().toISOString() }] })
      await createRunner({ ...h.d, github: () => g.gh })({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)
      expect(g.called('issues.createComment')).toHaveLength(0)
    } finally { h.cleanup() }
  })

  it('mentions escalate_to when the specialist escalates', async () => {
    const h = harness({ settingsOf: () => cfgOf({ worker: { escalate_to: 'marc' } }) }, [{ type: 'result', subtype: 'success', is_error: false, result: 'ESCALATE: the spec gives no limit for VOUT ripple', num_turns: 3 }])
    try {
      const s = await createRunner(h.d)({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)
      expect(s).toMatch(/escalated/)
      expect(String(h.f.called('issues.createComment')[0]!.args.body)).toMatch(/@marc it needs a person/)
    } finally { h.cleanup() }
  })

  it('reports a failure on the item without the token', async () => {
    const h = harness({ exec: async () => { throw new Error(`git clone failed: remote said no to ${TOKEN}`) } })
    try {
      await expect(createRunner(h.d)({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)).rejects.toThrow(/remote said no/)
      const body = String(h.f.called('issues.createComment')[0]!.args.body)
      expect(body).toMatch(/could not finish/)
      expect(body).not.toContain(TOKEN)
      expect(body).toContain('***')
      expect(h.claudeCalls).toHaveLength(0)
    } finally { h.cleanup() }
  })

  it('fails when Claude stops early', async () => {
    const h = harness({}, [{ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 42, errors: [] }])
    try {
      await expect(createRunner(h.d)({ kind: 'work-item', repository: 'o/r', item: ITEM }, h.ctx)).rejects.toThrow(/error_max_turns/)
      expect(String(h.f.called('issues.createComment')[0]!.args.body)).toMatch(/error_max_turns/)
    } finally { h.cleanup() }
  })

  it('stays on the default branch for an agent-fix issue and runs a task on a claude/task branch', async () => {
    const h = harness()
    try {
      await createRunner(h.d)({ kind: 'work-item', repository: 'o/r', item: { kind: 'agent-fix', number: 9, sha: 'issue', ref: '', own: true, title: 't' } }, h.ctx)
      expect(h.cmds.some((c) => c.args[0] === 'checkout')).toBe(false)
      h.cmds.length = 0
      const task = { kind: 'task' as const, repository: 'o/r', request: 'Add a 3V3 rail check', requestedBy: 'marc@example.com' }
      await createRunner(h.d)(task, h.ctx)
      const branch = taskBranch(task, cfgOf())
      expect(branch).toMatch(/^claude\/task-add-a-3v3-rail-check-[0-9a-f]{6}$/)
      const flat = h.cmds.map((c) => c.args.join(' '))
      expect(flat).toContain(`ls-remote --heads origin refs/heads/${branch}`)
      expect(flat.at(-1)).toBe(`checkout -B ${branch} origin/main`)
      const p = h.claudeCalls.at(-1)!.prompt
      expect(p).toMatch(/> Add a 3V3 rail check/)
      expect(p).toMatch(/"marc@example.com"/)
      expect(p).toMatch(/\.trace\/rules\.md/)
      expect(p).toMatch(/never push to the default branch/)
      expect(p).toContain(`Your working directory is the branch \`${branch}\``)
      // the retained worker's prompt, unchanged, for what a specialist delegates
      expect(taskPrompt(task, cfgOf(), branch)).toMatch(/There is no issue to comment on/)
      expect(taskPrompt({ ...task, issue: 12 }, cfgOf(), branch)).toMatch(/Finish with a comment on #12/)
    } finally { h.cleanup() }
  })

  it('sweeps: runs pick per repository and starts one job per claimed item', async () => {
    const f = fakeGithub({ 'pulls.list': [], 'issues.listForRepo': [{ number: 10, title: 'Broken' }], 'issues.listComments': [] })
    const h = harness({ github: () => f.gh, remoteSettings: async (_g, ctx) => cfgOf(ctx.repo.repo === 'b' ? { worker: { runner: 'actions' } } : {}) })
    try {
      const s = await createRunner(h.d)({ kind: 'sweep', repositories: ['o/a', 'o/b'] }, h.ctx)
      expect(h.started).toEqual([{ kind: 'work-item', repository: 'o/a', item: { kind: 'agent-fix', number: 10, sha: 'issue', ref: '', own: true, title: 'Broken' } }])
      expect(s).toMatch(/o\/a#10/)
      const claims = f.called('issues.createComment').map((c) => String(c.args.body))
      expect(claims).toHaveLength(1)
      expect(claims[0]).toMatch(/trace-claim/)
      expect(claims[0]).toMatch(/AgentCore \(sweep `job-t`\)/)
    } finally { h.cleanup() }
  })

  it('parses and redacts the secret', () => {
    expect(parseSecret(` ${TOKEN}\n`)).toBe(TOKEN)
    expect(parseSecret(JSON.stringify({ token: TOKEN }))).toBe(TOKEN)
    expect(() => parseSecret('')).toThrow()
    expect(redactor(TOKEN)(`a ${TOKEN} b`)).toBe('a *** b')
  })
})
