/**
 * The runner webhook custom resource (src/infra/lambda/runner-webhook.ts): a runner project gets its GitHub webhook if
 * GitHub allows it, and when GitHub refuses, the deploy goes on and the runner reports `none`, so the tools leave that
 * repository's jobs on GitHub's runners.
 */
import { BatchGetProjectsCommand, CreateWebhookCommand, DeleteWebhookCommand } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { RUNNER_NONE, runnerOf } from '../../src/core/project.js'
import { type Clients, RUNNER_FILTER_GROUPS, handle } from '../../src/infra/lambda/runner-webhook.js'

const NAME = 'trace-ci-600177d2'
const REFUSED = Object.assign(new Error('Failed to create webhook. GitHub API limit reached or permission issue encountered when creating the webhook.'), { name: 'InvalidInputException' })

function fake(o: { webhook?: boolean; create?: Error | null; exists?: boolean; deleteFails?: boolean }) {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  const c: Clients = {
    codebuild: {
      send: (async (cmd: unknown) => {
        const x = cmd as { constructor: { name: string }; input: Record<string, unknown> }
        calls.push({ name: x.constructor.name, input: x.input })
        if (cmd instanceof BatchGetProjectsCommand) {
          return { projects: o.exists === false ? [] : [{ name: NAME, ...(o.webhook ? { webhook: { url: 'https://api.github.com/repos/x/y/hooks/1' } } : {}) }] }
        }
        if (cmd instanceof CreateWebhookCommand) { if (o.create) throw o.create; return { webhook: { url: 'u' } } }
        if (cmd instanceof DeleteWebhookCommand) { if (o.deleteFails) throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }); return {} }
        throw new Error(`unexpected ${x.constructor.name}`)
      }) as Clients['codebuild']['send'],
    },
  }
  return { c, calls }
}

const event = (RequestType: 'Create' | 'Update' | 'Delete'): CloudFormationCustomResourceEvent => ({
  RequestType, ServiceToken: 't', ResponseURL: 'u', StackId: 's', RequestId: 'r', LogicalResourceId: 'l', ResourceType: 'Custom::RunnerWebhook',
  ResourceProperties: { ServiceToken: 't', ProjectName: NAME, Attempt: '2026-10-28T00:00:00.000Z' },
  ...(RequestType === 'Create' ? {} : { PhysicalResourceId: `runner-webhook-${NAME}` }),
  ...(RequestType === 'Update' ? { OldResourceProperties: {} } : {}),
} as CloudFormationCustomResourceEvent)

describe('the runner webhook custom resource', () => {
  it('makes the webhook, on WORKFLOW_JOB_QUEUED, and reports the runner', async () => {
    const f = fake({})
    const r = await handle(event('Create'), f.c)
    expect(r).toEqual({ PhysicalResourceId: `runner-webhook-${NAME}`, Data: { Runner: NAME, Reason: '' } })
    expect(f.calls.find((x) => x.name === 'CreateWebhookCommand')?.input).toEqual({ projectName: NAME, filterGroups: RUNNER_FILTER_GROUPS, buildType: 'BUILD' })
    expect(RUNNER_FILTER_GROUPS).toEqual([[{ type: 'EVENT', pattern: 'WORKFLOW_JOB_QUEUED' }]])
  })

  it('keeps a webhook the project has already, on every later deploy', async () => {
    const f = fake({ webhook: true })
    expect((await handle(event('Update'), f.c)).Data).toEqual({ Runner: NAME, Reason: '' })
    expect(f.calls.map((x) => x.name)).toEqual(['BatchGetProjectsCommand'])
  })

  it('never fails the deploy when GitHub refuses: the runner is none, with why, and the next deploy tries again', async () => {
    for (const type of ['Create', 'Update'] as const) {
      const r = await handle(event(type), fake({ create: REFUSED }).c)
      expect(r.Data?.Runner).toBe(RUNNER_NONE)
      expect(r.Data?.Reason).toContain('GitHub API limit reached or permission issue')
    }
    // and the tools read none as no runner at all
    expect(runnerOf(RUNNER_NONE)).toBeNull()
    expect(runnerOf(undefined)).toBeNull()
    expect(runnerOf(NAME)).toBe(NAME)
    // a project that is not there is reported the same way rather than failing the stack
    expect((await handle(event('Create'), fake({ exists: false }).c)).Data?.Runner).toBe(RUNNER_NONE)
  })

  it('counts a webhook that exists already as made', async () => {
    const r = await handle(event('Create'), fake({ create: Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' }) }).c)
    expect(r.Data).toEqual({ Runner: NAME, Reason: '' })
  })

  it('removes the webhook on delete, and never fails over one that is gone', async () => {
    const f = fake({})
    expect(await handle(event('Delete'), f.c)).toEqual({ PhysicalResourceId: `runner-webhook-${NAME}` })
    expect(f.calls.map((x) => x.name)).toEqual(['DeleteWebhookCommand'])
    await expect(handle(event('Delete'), fake({ deleteFails: true }).c)).resolves.toEqual({ PhysicalResourceId: `runner-webhook-${NAME}` })
  })
})
