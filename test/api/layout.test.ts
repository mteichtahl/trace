/** installation.layout: what a flat installation has and lacks, and how to move, for New project and Admin ›
 * Installation; and what projects.create's wait says there. */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { ADD_PROJECTS_INPUT, cloudWait, startUpdate } from '../../src/api/actions-projects.js'
import { GitHubError } from '../../src/api/github.js'
import { AccessDenied } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { FLAT_UPDATE_MAX } from '../../src/installer/pending.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const deps = (layout?: string): ActionDeps => ({
  github: async () => new FakeGitHub([]), cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch: mkdtempSync(join(tmpdir(), 'trace-api-layout-')), ...(layout ? { layout } : {}),
})
const GUEST = { sub: 'g-layout', email: 'g@example.com', groups: ['trace-guests'] }
const NOBODY = { sub: 'n-layout', email: 'n@example.com', groups: [] as string[] }
const ctx = (p: Context['principal'], layout?: string): Context => ({ principal: p, deps: deps(layout) })

describe('installation.layout', () => {
  it('nested: 60 projects and everything', async () => {
    expect((await perform('installation.layout', {}, ctx(GUEST, 'nested'))).result).toMatchObject({ layout: 'nested', projects: { max: 60 }, has: { knowledgeBase: true, cpuQueue: true, answerEvents: true } })
    expect((await perform('installation.layout', {}, ctx(GUEST))).result).toMatchObject({ layout: 'nested' })
  })

  it('flat: what it lacks, the cap on updates, a recommendation and the move\'s steps and costs', async () => {
    const r = (await perform('installation.layout', {}, ctx(GUEST, 'flat'))).result as Record<string, any>
    expect(r).toMatchObject({ layout: 'flat', projects: { max: 20, updateMax: FLAT_UPDATE_MAX }, has: { knowledgeBase: false, cpuQueue: false, answerEvents: false } })
    expect(r.note).toMatch(/one stack.*About 20 projects fit.*fewer than 15.*no knowledge base/)
    expect(r.recommendation).toMatch(/Move to one nested stack per project/)
    expect(r.move.how).toMatch(/Move to one nested stack per project/)
    expect(r.move.steps).toHaveLength(3)
    expect(r.move.costs).toMatch(/memory records are deleted.*offline/)
  })

  it('needs an account class', async () => {
    await expect(perform('installation.layout', {}, ctx(NOBODY, 'flat'))).rejects.toThrow(AccessDenied)
  })

  it('projects.create\'s wait says what a flat installation gives a new project, and where to read about the move', () => {
    expect(cloudWait('mteichtahl/trace@main', 'nested')).toMatch(/agent and knowledge base are added at the next update/)
    const flat = cloudWait('mteichtahl/trace@main', 'flat')
    expect(flat).toMatch(/agent is added at the next update.*flat layout.*no knowledge base.*fewer than 15.*Admin › Installation/)
    expect(cloudWait(undefined, 'flat')).toMatch(/next time an admin runs the installer.*flat layout.*about 20 projects fit/)
  })
})

describe('projects.create starts the installation update', () => {
  it('runs trace\'s ci workflow on the self-update\'s branch, only adding projects, and says so in plain words (log #2, #4)', async () => {
    const runs: string[] = []
    const gh = {
      dispatchWorkflow: async (repo: string, wf: string, ref: string) => { runs.push(`${repo} ${wf} ${ref}`) },
      dispatchWorkflowWith: async (repo: string, wf: string, ref: string, inputs: Record<string, string>) => { runs.push(`${repo} ${wf} ${ref} ${JSON.stringify(inputs)}`) },
    }
    const r = await startUpdate(gh, 'mteichtahl/trace@main', 'nested')
    // the tests are skipped: main passed them already, and they were half the wait
    expect(runs).toEqual(['mteichtahl/trace ci.yml main {"add_projects":"true"}'])
    expect(r).toEqual({ started: true, text: "trace is updating itself to add this project's agent and knowledge base. The project page shows how far it has got and about when it will be ready." })
    // no GitHub jargon for the person who made the project: no workflow, branch or repository named
    expect(r.text).not.toMatch(/ci workflow|mteichtahl\/trace|\bmain\b/)
    expect((await startUpdate(gh, 'mteichtahl/trace@main', 'flat')).text).toMatch(/add this project's agent\. .*flat layout/)
  })

  it('a branch whose ci workflow does not know add_projects yet (GitHub: 422) gets a plain run', async () => {
    const runs: string[] = []
    const gh = {
      dispatchWorkflow: async (repo: string, wf: string, ref: string) => { runs.push(`${repo} ${wf} ${ref}`) },
      dispatchWorkflowWith: async () => { throw new GitHubError(422, 'Unexpected inputs provided: ["add_projects"]') },
    }
    expect((await startUpdate(gh, 'mteichtahl/trace@main', 'nested')).started).toBe(true)
    expect(runs).toEqual(['mteichtahl/trace ci.yml main'])
    // any other refusal is not retried
    const refused = await startUpdate({ ...gh, dispatchWorkflowWith: async () => { throw new GitHubError(403, 'Resource not accessible') } }, 'mteichtahl/trace@main', 'nested')
    expect(refused.started).toBe(false)
    expect(runs).toHaveLength(1)
  })

  it('without the self-update, or when GitHub refuses, waits as before and says why', async () => {
    const runs: string[] = []
    expect(await startUpdate({ dispatchWorkflow: async () => { runs.push('x') } }, undefined, 'nested')).toEqual({ started: false, text: cloudWait(undefined, 'nested') })
    expect(runs).toEqual([])
    expect(await startUpdate({}, 'mteichtahl/trace@main', 'nested')).toEqual({ started: false, text: cloudWait('mteichtahl/trace@main', 'nested') })
    const refused = await startUpdate({ dispatchWorkflow: async () => { throw new Error('GitHub POST /repos/mteichtahl/trace/actions/workflows/ci.yml/dispatches: 403') } }, 'mteichtahl/trace@main', 'nested')
    expect(refused.started).toBe(false)
    expect(refused.text).toMatch(/^The project's agent and knowledge base are added at the next update.*\(trace could not start it itself: .*403\.\)$/)
  })
})


describe('trace\'s ci workflow, run to add projects only', () => {
  const ci = parse(readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } }
    jobs: Record<string, { if?: string; needs?: string | string[]; steps?: { env?: Record<string, string>; run?: string }[] }>
  }

  it('takes the input startUpdate sends, off unless asked for', () => {
    expect(ci.on.workflow_dispatch.inputs[ADD_PROJECTS_INPUT]).toMatchObject({ type: 'boolean', default: false })
  })

  it('skips the tests "tests pass" waits for, and counts them passed only in such a run; the update still runs after it', () => {
    const pass = ci.jobs['tests-pass']!
    const needs = [pass.needs ?? []].flat()
    expect(needs.length).toBeGreaterThan(0)
    for (const j of needs) expect(ci.jobs[j]?.if).toBe(`\${{ !inputs.${ADD_PROJECTS_INPUT} }}`)
    const step = pass.steps?.[0]
    expect(step?.env?.ADD_PROJECTS).toContain(`inputs.${ADD_PROJECTS_INPUT}`)
    expect(step?.run).toMatch(/"\$r" = success \] \|\| \{ \[ "\$ADD_PROJECTS" = true \] && \[ "\$r" = skipped \]; \}/)
    const update = ci.jobs['update-installation']!
    expect(update.needs).toBe('tests-pass')
    expect(update.if).toMatch(/workflow_dispatch/)
    expect(update.if).not.toMatch(/add_projects/)
  })
})
