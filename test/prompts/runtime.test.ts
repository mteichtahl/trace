/**
 * The overrides where prompts are used: the AgentCore job runner (the default branch's overrides, never the PR's;
 * provenance on the job's record and span; tools and limits untouched), the GitHub Actions steps, and the harness
 * reading the default branch's database.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context as otelContext, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SPECIALISTS, allowedToolsOf } from '../../src/agents/index.js'
import { type ClaudeOptions, type Exec, type RunnerDeps, createRunner } from '../../src/agents/runtime/job.js'
import { createJobs } from '../../src/agents/runtime/jobs.js'
import { delegateStep, specialistStep } from '../../src/harness/actions.js'
import { loadProject } from '../../src/harness/index.js'
import { entry } from '../../src/prompts/catalog.js'
import type { Layers, Override, PromptRecord } from '../../src/prompts/resolve.js'
import { writeProject } from '../../src/prompts/store.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from '../harness/fake.js'

const TOKEN = 'ghs_TESTTOKEN1234567890abcdef'
const ov = (id: string, text: string, version = 1): Override => ({ id, text, version, updated: version, by: 'h' })
const LAYERS: Layers = {
  project: new Map([['specialist.verify.workflow', ov('specialist.verify.workflow', 'WORKFLOW:\n1. PROJECT OVERRIDE for {{repository}}.', 4)]]),
  installation: new Map([['specialist.report', ov('specialist.report', 'REPORT: INSTALLATION OVERRIDE.', 2)], ['specialist.guardrails', ov('specialist.guardrails', 'none', 1)]]),
}

function runnerHarness(over: Partial<RunnerDeps> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'trace-prompts-ws-'))
  const exec: Exec = async () => ({ stdout: '', stderr: '' })
  const claudeCalls: { prompt: string; options: ClaudeOptions }[] = []
  const seenDirs: string[] = []
  const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] })
  const d: RunnerDeps = {
    exec, getToken: async () => TOKEN, github: () => f.gh,
    claude: (a) => { claudeCalls.push(a); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 3 } })() },
    settingsOf: () => cfgOf(), remoteSettings: async () => cfgOf(),
    workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, env: {}, now: Date.now,
    prompts: async (dir) => { seenDirs.push(dir); return LAYERS },
    ...over,
  }
  const recorded: PromptRecord[][] = []
  const lines: string[] = []
  const ctx = { jobId: 'job-p', signal: new AbortController().signal, log: (l: string) => { lines.push(l) }, startJob: () => ({ accepted: true, jobId: 'c' }), prompts: (r: readonly PromptRecord[]) => { recorded.push([...r]) } }
  return { d, claudeCalls, recorded, lines, ctx, seenDirs, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

describe('the job runner', () => {
  it('builds the specialist\'s prompt with the overrides, records which versions it used, and keeps tools and limits', async () => {
    const h = runnerHarness()
    try {
      await createRunner(h.d)({ kind: 'task', repository: 'o/r', request: 'Check coverage', requestedBy: 'm@example.com', agent: 'verify' }, h.ctx)
      const { prompt, options } = h.claudeCalls[0]!
      expect(prompt).toContain('WORKFLOW:\n1. PROJECT OVERRIDE for o/r.')
      expect(prompt).toContain('REPORT: INSTALLATION OVERRIDE.')
      // a locked override is not used: the guardrails are the catalog's, and last
      expect(prompt.trimEnd().endsWith(entry('specialist.guardrails').default)).toBe(true)
      expect(options.systemPrompt.append).toBe(entry('system.append').default)
      expect(options.allowedTools).toEqual(allowedToolsOf(SPECIALISTS.verify, { delegate: false }))
      expect(options.maxTurns).toBe(120)
      // read from the default branch's checkout (before any other branch is checked out)
      expect(h.seenDirs).toHaveLength(1)
      const rec = h.recorded.flat()
      expect(rec).toContainEqual({ id: 'specialist.verify.workflow', layer: 'project', version: 4, sha: expect.any(String) })
      expect(rec).toContainEqual({ id: 'specialist.report', layer: 'installation', version: 2, sha: expect.any(String) })
      expect(rec.find((r) => r.id === 'specialist.guardrails')).toMatchObject({ layer: 'default', version: null })
      expect(rec.find((r) => r.id === 'system.append')).toMatchObject({ layer: 'default' })
      expect(JSON.stringify(rec)).not.toContain('OVERRIDE')
      expect(h.lines.some((l) => /prompts: 2 overridden \(specialist\.verify\.workflow@project v4, specialist\.report@installation v2\)/.test(l))).toBe(true)
      expect(h.lines.some((l) => /the installation override v1 of specialist\.guardrails is not used: the prompt is locked/.test(l))).toBe(true)
    } finally { h.cleanup() }
  })

  it('a layer that cannot be read is logged, and the job runs on the defaults', async () => {
    const h = runnerHarness({ prompts: async () => ({ unavailable: [{ layer: 'installation', reason: 'AccessDenied' }] }) })
    try {
      await createRunner(h.d)({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm', agent: 'verify' }, h.ctx)
      expect(h.lines).toContain('prompts: the installation overrides could not be read, so they are not used: AccessDenied')
      expect(h.claudeCalls[0]!.prompt).toContain(entry('specialist.report').default)
    } finally { h.cleanup() }
    const h2 = runnerHarness({ prompts: async () => { throw new Error('boom') } })
    try {
      await createRunner(h2.d)({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm', agent: 'verify' }, h2.ctx)
      expect(h2.lines.some((l) => l.startsWith('prompts: overrides not used: boom'))).toBe(true)
    } finally { h2.cleanup() }
  })
})

describe('provenance on the job\'s record and its span', () => {
  const spans = new InMemorySpanExporter()
  beforeAll(() => {
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }))
  })
  afterAll(() => { trace.disable(); otelContext.disable() })

  it('the record keeps id, layer, version and sha; the span ids, layers and versions in step; never the text', async () => {
    const used: PromptRecord[] = [
      { id: 'specialist.verify.role', layer: 'default', version: null, sha: 'abcdef123456' },
      { id: 'specialist.verify.workflow', layer: 'project', version: 4, sha: '0123456789ab' },
    ]
    const jobs = createJobs(async (_p, ctx) => { ctx.prompts?.(used); return 'ok' }, { echo: () => undefined })
    const { jobId } = jobs.startJob({ kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm' })
    const end = Date.now() + 2000
    while (jobs.jobStatus(jobId)[0]?.state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
    expect(jobs.jobStatus(jobId)[0]?.prompts).toEqual(used)
    const job = spans.getFinishedSpans().find((s) => s.name.startsWith('trace.job'))!
    expect(job.attributes['trace.prompt.ids']).toEqual(['specialist.verify.role', 'specialist.verify.workflow'])
    expect(job.attributes['trace.prompt.layers']).toEqual(['default', 'project'])
    expect(job.attributes['trace.prompt.versions']).toEqual(['d-abcdef12', 'v4'])
    expect(job.attributes['trace.prompt.overridden']).toBe(1)
  })
})

describe('GitHub Actions', () => {
  const ITEM = { kind: 'ci-red', number: 5, sha: SHA('a'), ref: 'claude/x', own: true, title: 'Coverage', route: { kind: 'verify', reason: 'label agent:verify', confidence: 1, source: 'label' } }
  const env = (more: Record<string, string> = {}) => ({ ITEM: JSON.stringify(ITEM), ...more }) as never

  it('the steps build their prompts with the overrides and output which versions they used', async () => {
    const core = fakeCore()
    await specialistStep({ ...deps(fakeGithub(), core, cfgOf(), context(), env()), prompts: LAYERS }, null)
    expect(core.outputs.prompt).toContain('WORKFLOW:\n1. PROJECT OVERRIDE for o/r.')
    expect(core.outputs.prompts).toContain('specialist.verify.workflow@project:v4')
    expect(core.outputs.prompts).toMatch(/specialist\.guardrails@default:d-[0-9a-f]{8}/)
    expect(core.infos.some((l) => /prompts: 2 overridden/.test(l))).toBe(true)
    expect(core.warnings.some((l) => /specialist\.guardrails: the installation override v1 is not used/.test(l))).toBe(true)

    const d = fakeCore()
    const layers: Layers = { project: new Map([['worker.item.ci-red', ov('worker.item.ci-red', 'Fix {{repository}} the house way.', 2)]]) }
    const spec = JSON.stringify({ report: 'r', delegate: true, brief: 'Do it.', acceptance: ['passes'] })
    await delegateStep({ ...deps(fakeGithub(), d, cfgOf(), context(), env({ SPECIALIST: spec })), prompts: layers }, null)
    expect(d.outputs.prompt).toContain('Fix o/r the house way.')
    expect(d.outputs.prompts).toContain('worker.item.ci-red@project:v2')
    expect(d.outputs.prompts).toContain('actions.check@default')
    expect(d.outputs.prompts).toContain('delegate.brief@default')
  })

  it('the harness reads the project\'s overrides from the default branch\'s database, and says when the installation\'s are out of reach', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-prompts-gh-'))
    mkdirSync(join(root, '.git'))
    writeProject({ op: 'set', id: 'specialist.verify.done', text: 'DONE: green.', reason: 'r', by: null }, root)
    const b64 = readFileSync(join(root, '.trace', 'project.db')).toString('base64')
    const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'repos.getContent': { type: 'file', content: b64, encoding: 'base64', sha: 'x' } })
    const core = fakeCore()
    const { cfg, prompts } = await loadProject(f.gh, context(), core, {})
    expect(cfg.branch).toBe('main')
    expect(prompts.project?.get('specialist.verify.done')?.text).toBe('DONE: green.')
    expect(prompts.unavailable).toEqual([{ layer: 'installation', reason: 'TRACE_HOME is not set for this step' }])
    expect(core.infos.some((l) => /installation's prompt overrides are not used here/.test(l))).toBe(true)
    expect(f.called('repos.getContent')[0]!.args).toMatchObject({ path: '.trace/project.db', ref: 'main' })
  })
})
