// GitHub's immutable OIDC subjects (src/core/github-subject.ts): repositories made, renamed or moved after 15 July 2026,
// or opted in, send repo:OWNER@OWNER_ID/REPO@REPO_ID instead of repo:OWNER/REPO. Every role trace makes for GitHub
// trusts both forms when the ids are known, the name form alone when not, and never a wildcard over the ids.
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { projectHash } from '../../src/core/project.js'
import { InfraPropsSchema, githubSubjects, stackName } from '../../src/infra/props.js'
import { RELEASE_STACK, TraceReleaseStack, releaseSettings } from '../../src/infra/release.js'
import { RUNNERS, type Synth, synth } from './templates.js'

const TRACE = 'mteichtahl/trace'
const BOARD = 'mteichtahl/board'
const OTHER = 'pokeys-toolkit/potroller'
const TRACE_ID = 'repo:mteichtahl@1817657/trace@1433970189'
const BOARD_ID = 'repo:mteichtahl@1817657/board@1500000001'
const SUB = 'token.actions.githubusercontent.com:sub'

type Res = { Properties: { RoleName?: string; AssumeRolePolicyDocument?: { Statement: { Condition: Record<string, Record<string, unknown>> }[] } } }
const conditionOf = (t: Template, name: string): Record<string, Record<string, unknown>> => {
  const role = Object.values(t.findResources('AWS::IAM::Role') as Record<string, Res>).find((r) => r.Properties.RoleName === name)
  const c = role?.Properties.AssumeRolePolicyDocument?.Statement[0]?.Condition
  if (!c) throw new Error(`no role ${name}`)
  return c
}

describe('the roles GitHub workflows assume', () => {
  let syn: Synth
  beforeAll(() => {
    syn = synth(InfraPropsSchema.parse({
      account: '123456789012', region: 'us-east-1', repositories: [BOARD, `${OTHER}@develop`], ciRepositories: [TRACE],
      model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS,
      selfUpdate: { repository: TRACE }, githubSubjects: { [TRACE]: TRACE_ID, [BOARD]: BOARD_ID },
    }), stackName('trace'))
  }, 300_000)

  it('a project with ids: its default branch by name or by ids', () => {
    expect(conditionOf(syn.all, `trace-gh-${projectHash(BOARD)}-us-east-1`).StringLike?.[SUB]).toEqual([
      `repo:${BOARD}:ref:refs/heads/main`, `${BOARD_ID}:ref:refs/heads/main`,
    ])
  })

  it('a project without: its name form only, as before', () => {
    expect(conditionOf(syn.all, `trace-gh-${projectHash(OTHER)}-us-east-1`).StringLike?.[SUB]).toBe(`repo:${OTHER}:ref:refs/heads/develop`)
  })

  it('the self-update role: trace\'s own repository by name or by ids, still only its ci workflow', () => {
    const c = conditionOf(syn.parent, 'trace-self-update')
    expect(c.StringEquals?.[SUB]).toEqual([`repo:${TRACE}:ref:refs/heads/main`, `${TRACE_ID}:ref:refs/heads/main`])
    expect(c.StringLike).toEqual({ 'token.actions.githubusercontent.com:job_workflow_ref': `${TRACE}/.github/workflows/ci.yml@refs/heads/main` })
  })

  it('never a wildcard over the ids, and the settings take only real subjects', () => {
    expect(JSON.stringify(conditionOf(syn.all, `trace-gh-${projectHash(BOARD)}-us-east-1`))).not.toContain('*')
    expect(githubSubjects('Me/Repo', { 'me/repo': 'repo:Me@1/Repo@2' }, ':ref:refs/heads/main')).toEqual(['repo:Me/Repo:ref:refs/heads/main', 'repo:Me@1/Repo@2:ref:refs/heads/main'])
    const base = { account: '123456789012', region: 'us-east-1', repositories: [BOARD], model: 'm', adminEmail: 'marc@example.com', runners: RUNNERS }
    for (const bad of ['repo:mteichtahl/board', 'repo:mteichtahl@*/board@*', 'repo:mteichtahl@1/board@2:ref:refs/heads/main']) {
      expect(InfraPropsSchema.safeParse({ ...base, githubSubjects: { [BOARD]: bad } }).success).toBe(false)
    }
    expect(InfraPropsSchema.safeParse({ ...base, githubSubjects: { 'Mteichtahl/Board': BOARD_ID } }).success).toBe(false)
  })
})

describe('the release role', () => {
  const sub = (immutableSubject?: string): unknown => {
    const t = Template.fromStack(new TraceReleaseStack(new App(), RELEASE_STACK, { repository: TRACE, createOidcProvider: false, ...(immutableSubject ? { immutableSubject } : {}) }, { account: '123456789012' }))
    return conditionOf(t, 'trace-release').StringLike?.[SUB]
  }

  it('trusts main and v* tags by name, and by ids when it is given them', () => {
    expect(sub()).toEqual([`repo:${TRACE}:ref:refs/heads/main`, `repo:${TRACE}:ref:refs/tags/v*`])
    expect(sub(TRACE_ID)).toEqual([
      `repo:${TRACE}:ref:refs/heads/main`, `${TRACE_ID}:ref:refs/heads/main`, `repo:${TRACE}:ref:refs/tags/v*`, `${TRACE_ID}:ref:refs/tags/v*`,
    ])
  })

  it('takes the subject from context or the environment, and only a real one', () => {
    expect(releaseSettings((k) => ({ immutableSubject: TRACE_ID })[k], {})).toEqual({ repository: TRACE, createOidcProvider: false, immutableSubject: TRACE_ID })
    expect(releaseSettings(() => undefined, { TRACE_RELEASE_IMMUTABLE_SUBJECT: TRACE_ID }).immutableSubject).toBe(TRACE_ID)
    expect(() => releaseSettings((k) => ({ immutableSubject: 'repo:mteichtahl@*/trace@*' })[k], {})).toThrow(/repo:OWNER@ID\/REPO@ID/)
  })
})
