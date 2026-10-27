import type { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { describe, expect, it } from 'vitest'
import { projectHash } from '../../src/core/project.js'
import { jobHandle, parseHandle, parseWorkerRuntimes, remoteJobs, taskSession, toolSession } from '../../src/api/workers.js'

/** A fake AgentCore data plane: one microVM (job list) per runtime and session. */
function fakeAgentCore() {
  const calls: { arn: string; session: string; body: Record<string, unknown> }[] = []
  const jobs = new Map<string, { id: string; kind: string; state: string; repository: string }[]>()
  const client = {
    async send(cmd: InvokeAgentRuntimeCommand) {
      const i = cmd.input
      const body = JSON.parse(new TextDecoder().decode(i.payload as Uint8Array)) as Record<string, unknown>
      calls.push({ arn: i.agentRuntimeArn ?? '', session: i.runtimeSessionId ?? '', body })
      const key = `${i.agentRuntimeArn}#${i.runtimeSessionId}`
      const vm = jobs.get(key) ?? []
      jobs.set(key, vm)
      let out: unknown
      if (body.kind === 'tool') {
        out = body.name === 'calc.fail' ? { ok: false, error: 'bad input' } : { ok: true, result: { ran: body.name, args: body.args } }
      } else if (body.kind === 'task') {
        const id = `job-${vm.length + 1}`
        vm.push({ id, kind: 'task', state: 'running', repository: String(body.repository) })
        out = { accepted: true, jobId: id }
      } else if (body.kind === 'cancel') {
        const j = vm.find((x) => x.id === body.jobId && x.state === 'running')
        if (j) j.state = 'aborted'
        out = j ? { ok: true, state: 'aborted', kept: 'Commits the agent had already pushed stay on their branch.' } : { ok: false, state: null, reason: 'There is no such job on this worker.' }
      } else out = { jobs: vm.filter((j) => j.id === body.jobId), busy: true }
      return { statusCode: 200, response: { transformToString: async () => JSON.stringify(out) } }
    },
  }
  return { client, calls }
}

const RUNTIMES = 'acme/board=trace_w_aaaaaaaa-AbCdEf1234 acme/fw=trace_w_bbbbbbbb-ZyXwVu9876'

describe('the API\'s remote jobs', () => {
  it('reads the stack\'s list of workers and refuses anything malformed', () => {
    expect([...parseWorkerRuntimes(RUNTIMES)]).toEqual([['acme/board', 'trace_w_aaaaaaaa-AbCdEf1234'], ['acme/fw', 'trace_w_bbbbbbbb-ZyXwVu9876']])
    expect(parseWorkerRuntimes('').size).toBe(0)
    expect(() => parseWorkerRuntimes('acme/board')).toThrow(/TRACE_WORKER_RUNTIMES/)
    expect(() => parseWorkerRuntimes('acme/board=arn:aws:x')).toThrow(/TRACE_WORKER_RUNTIMES/)
  })

  it('names sessions by project, agent and request, and job ids by session', () => {
    const t = { repository: 'Acme/Board', request: 'add a test point' }
    const s = taskSession(t)
    expect(s).toMatch(new RegExp(`^trace-api-${projectHash('acme/board')}-[0-9a-f]{24}$`))
    expect(s.length).toBeGreaterThanOrEqual(33)
    expect(taskSession({ ...t, repository: 'acme/board' })).toBe(s)
    expect(taskSession({ ...t, agent: 'render' })).not.toBe(s)
    expect(parseHandle(jobHandle(s, 'job-abc-12345678'))).toEqual({ session: s, jobId: 'job-abc-12345678', hash: projectHash('acme/board') })
    for (const bad of ['job-1', `${s}`, `${s}.`, `trace-api-zzzzzzzz-${'0'.repeat(24)}.job-1`, `${s}.job/../x`]) expect(parseHandle(bad)).toBeNull()
  })

  it('starts a task on its own project\'s worker and follows it in the same session', async () => {
    const f = fakeAgentCore()
    const jobs = remoteJobs({ runtimes: parseWorkerRuntimes(RUNTIMES), region: 'us-east-1', account: '123456789012', client: f.client })
    const r = await jobs.startJob({ kind: 'task', repository: 'acme/fw', request: 'bump the version', requestedBy: 'dev@example.com' })
    expect(f.calls[0]).toMatchObject({ arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_bbbbbbbb-ZyXwVu9876', body: { kind: 'task', repository: 'acme/fw', requestedBy: 'dev@example.com' } })
    expect(r.accepted).toBe(true)
    expect(jobs.repositoryOf(r.jobId)).toBe('acme/fw')
    const [j] = await jobs.jobStatus(r.jobId)
    expect(j).toMatchObject({ id: r.jobId, workerJobId: 'job-1', state: 'running', repository: 'acme/fw' })
    expect(f.calls[1]).toMatchObject({ arn: f.calls[0]?.arn, session: f.calls[0]?.session, body: { kind: 'status', jobId: 'job-1' } })
    // an id of a project this installation does not have names nothing
    const stranger = jobHandle(taskSession({ repository: 'other/repo', request: 'x' }), 'job-1')
    expect(jobs.repositoryOf(stranger)).toBeNull()
    expect(await jobs.jobStatus(stranger)).toEqual([])
    expect(f.calls).toHaveLength(2)
    await expect(jobs.startJob({ kind: 'task', repository: 'other/repo', request: 'x', requestedBy: 'm' })).rejects.toThrow(/no worker runtime/)
  })

  it('forwards a tool call to its own project\'s worker, in one session per project, and returns the tool\'s answer', async () => {
    const f = fakeAgentCore()
    const jobs = remoteJobs({ runtimes: parseWorkerRuntimes(RUNTIMES), region: 'us-east-1', account: '123456789012', client: f.client })
    expect(await jobs.runTool!({ kind: 'tool', repository: 'acme/board', name: 'kicad.drc', args: { project: 'hw/b.kicad_pro' } })).toEqual({ ran: 'kicad.drc', args: { project: 'hw/b.kicad_pro' } })
    await jobs.runTool!({ kind: 'tool', repository: 'acme/board', name: 'calc.via', args: {} })
    expect(f.calls[0]).toMatchObject({ arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_aaaaaaaa-AbCdEf1234', session: toolSession('acme/board'), body: { kind: 'tool', repository: 'acme/board', name: 'kicad.drc' } })
    expect(f.calls[1]!.session).toBe(f.calls[0]!.session)
    expect(toolSession('acme/board')).toMatch(new RegExp(`^trace-api-${projectHash('acme/board')}-[0-9a-f]{24}$`))
    expect(toolSession('acme/fw')).not.toBe(toolSession('acme/board'))
    await expect(jobs.runTool!({ kind: 'tool', repository: 'acme/board', name: 'calc.fail', args: {} })).rejects.toThrow('bad input')
    await expect(jobs.runTool!({ kind: 'tool', repository: 'other/repo', name: 'calc.via', args: {} })).rejects.toThrow(/no worker runtime/)
  })

  it('cancels a job on its own worker, in its own session, and says what was kept', async () => {
    const f = fakeAgentCore()
    const jobs = remoteJobs({ runtimes: parseWorkerRuntimes(RUNTIMES), region: 'us-east-1', account: '123456789012', client: f.client })
    const r = await jobs.startJob({ kind: 'task', repository: 'acme/board', request: 'route it', requestedBy: 'dev@example.com' })
    expect(await jobs.cancel!(r.jobId, 'cancelled by dev')).toEqual({ ok: true, state: 'aborted', kept: 'Commits the agent had already pushed stay on their branch.' })
    expect(f.calls[1]).toMatchObject({ session: f.calls[0]?.session, body: { kind: 'cancel', jobId: 'job-1', reason: 'cancelled by dev' } })
    expect(await jobs.cancel!(r.jobId, 'again')).toMatchObject({ ok: false, reason: 'There is no such job on this worker.' })
    expect(await jobs.cancel!('nonsense', 'x')).toMatchObject({ ok: false })
  })
})
