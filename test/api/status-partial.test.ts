/**
 * status: one GitHub read refused (a token without Deployments: read answers 403 on the last deploy) leaves the
 * project's pull requests, issues and runs readable, and says which part could not be read.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, perform } from '../../src/api/actions.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 's-admin', email: 's-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 's-user', email: 's-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/status'

class NoDeployments extends FakeGitHub {
  override async openPulls(): Promise<never[]> { return [{ number: 9, title: 'J1 swap' } as never] }
  override async lastDeploy(): Promise<null> { throw new Error('GET /repos/acme/status/deployments answered 403') }
}
const github = new NoDeployments([REPO])
const cognito = new FakeCognito()
const bucket = mkdtempSync(join(tmpdir(), 'trace-status-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito,
  jobs: async () => ({ repositoryOf: () => null, jobStatus: async () => [], startJob: async () => ({ accepted: true, jobId: 'j' }) }),
  tools: () => new Registry([]), scratch: mkdtempSync(join(tmpdir(), 'trace-status-')), store: (p) => backendFor(join(bucket, p)),
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
})

describe('status', () => {
  it('shows what it could read and names what it could not', async () => {
    const r = (await perform('status', { repo: REPO }, { principal: USER, deps })).result as Record<string, unknown>
    expect(r).toMatchObject({ repo: REPO, pulls: [{ number: 9 }], agent_fix_issues: [], runs: [], last_deploy: null })
    expect(r.unreadable).toEqual([{ part: 'last deploy (the token needs Deployments: read)', error: 'GET /repos/acme/status/deployments answered 403' }])
  })
})
