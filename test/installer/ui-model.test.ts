import { describe, expect, it } from 'vitest'
import { AnswersSchema } from '../../src/installer/answers.js'
import { answers, awsErrors, blockers, fieldErrors, githubTokenError, initialState, newRepoError, loadSaved, numberError, preflightBody, preflightKey, reconcileProjects } from '../../src/installer/ui/model.js'

const FINE = `github_pat_11AAAAAAA0${'a'.repeat(70)}`
const CLASSIC = `ghp_${'A1'.repeat(18)}`

describe('the installer page: what was typed', () => {
  it('knows a GitHub token from a mistyped one before asking GitHub', () => {
    expect(githubTokenError('')).toMatch(/Paste/)
    expect(githubTokenError('', false)).toBe('')
    expect(githubTokenError('ghp_short')).toMatch(/too short/)
    expect(githubTokenError(`${CLASSIC} x`)).toMatch(/spaces/)
    expect(githubTokenError(`ghs_${'a'.repeat(36)}`)).toMatch(/expires/)
    expect(githubTokenError('github_pat_!!!!!!!!!!!!!!!!!!!!!!!!!!!!')).toMatch(/fine-grained/)
    expect(githubTokenError(FINE)).toBe('')
    expect(githubTokenError(` ${CLASSIC} `)).toBe('')
  })

  it('checks AWS access keys and profiles', () => {
    const a = initialState().aws
    expect(awsErrors({ ...a, profile: 'nope' }, ['default'])).toHaveProperty('profile')
    expect(awsErrors({ ...a, profile: 'default' }, ['default'])).toEqual({})
    const keys = { ...a, mode: 'keys' as const }
    expect(Object.keys(awsErrors(keys)).sort()).toEqual(['keyId', 'secret'])
    expect(awsErrors({ ...keys, keyId: 'AKIA123', secret: 'x' })).toMatchObject({ keyId: expect.stringMatching(/20 characters/), secret: expect.stringMatching(/40/) })
    const ok = { ...keys, keyId: 'ASIAABCDEFGHIJKLMNOP', secret: 'a'.repeat(40) }
    expect(awsErrors(ok)).toEqual({ session: expect.stringMatching(/session token/) })
    expect(awsErrors({ ...ok, session: 'token' })).toEqual({})
    expect(awsErrors({ ...ok, keyId: 'AKIAABCDEFGHIJKLMNOP', session: 'token' })).toHaveProperty('session')
  })

  it('names a new repository, and refuses one that exists', () => {
    const taken = (r: string): boolean => r === 'me/board'
    expect(newRepoError('', 'me', taken)).toBe('')
    expect(newRepoError('new', 'me', taken)).toBe('')
    expect(newRepoError('board', 'me', taken)).toMatch(/exists already/)
    expect(newRepoError('bad name', 'me', taken)).toMatch(/letters/)
    expect(newRepoError('x', '', taken)).toMatch(/OWNER\/NAME/)
  })

  it('says numbers out of range in words', () => {
    expect(numberError('maxLifetimeHours', '9')).toMatch(/0.25 and 8/)
    expect(numberError('idleMinutes', '1.5')).toMatch(/whole/)
    expect(numberError('gpuMaxVcpus', '6')).toMatch(/multiple of 4/)
    expect(numberError('cpuVcpus', 'x')).toMatch(/A number/)
    expect(numberError('cpuVcpus', '')).toBe('')
  })
})

describe('the installer page: the answers and what stops each step', () => {
  it('builds answers the server accepts, from defaults', () => {
    const s = initialState()
    s.pre = { checks: [], ok: true, token: null, repos: [], region: 'us-east-1', profileRegion: '', self: null, facts: { account: '123456789012', email: 'me@example.com', login: 'me' } }
    expect(AnswersSchema.safeParse(answers(s)).success).toBe(true)
    expect(answers(s).adminEmail).toBe('me@example.com')
    expect(fieldErrors(s).size).toBe(0)
  })

  it('keeps the external access switch off by default, and round-trips it through the saved answers', () => {
    const s = initialState()
    s.pre = { checks: [], ok: true, token: null, repos: [], region: 'us-east-1', profileRegion: '', self: null, facts: { account: '123456789012', email: 'me@example.com', login: 'me' } }
    expect(s.agents.externalAccess).toBe(false)
    expect(AnswersSchema.parse(answers(s)).agents.externalAccess).toBe(false)
    s.agents.externalAccess = true
    const saved = answers(s)
    expect(AnswersSchema.parse(saved).agents.externalAccess).toBe(true)
    const again = initialState()
    loadSaved(again, { profiles: { names: ['default'], regions: {} }, saved, installed: null, node: 'v22', defaultRegion: 'us-east-1' })
    expect(again.agents.externalAccess).toBe(true)
    loadSaved(again, { profiles: { names: ['default'], regions: {} }, saved: { ...saved, agents: { ...saved.agents, externalAccess: undefined } }, installed: null, node: 'v22', defaultRegion: 'us-east-1' })
    expect(again.agents.externalAccess).toBe(false)
  })

  it('puts each problem on its field and its step', () => {
    const s = initialState()
    s.pre = { checks: [], ok: true, token: null, repos: [], region: 'us-east-1', profileRegion: '', self: null, facts: { account: '123456789012', email: null } }
    s.agents.prefix = 'aws-trace'
    s.agents.cpuVcpus = '128'
    s.agents.cpuMaxVcpus = '64'
    s.people.push({ id: 1, email: 'nope', class: 'user', projects: new Set() })
    s.integrations.nexar.NEXAR_CLIENT_ID = 'id-only'
    const e = fieldErrors(s)
    expect(e.get('agents.prefix')).toMatch(/aws/)
    expect(e.get('agents.cpuVcpus')).toMatch(/more vCPUs/)
    expect(e.get('people.1.email')).toMatch(/email address/)
    expect(e.get('adminEmail')).toMatch(/first administrator/)
    expect(e.get('integrations.nexar')).toMatch(/or none/)
    expect(blockers(s, 'people').map((b) => b.text).join(' ')).toMatch(/first administrator/)
    expect(blockers(s, 'optional').length).toBeGreaterThanOrEqual(3)
    expect(new Set(blockers(s, 'review').map((b) => b.step))).toEqual(new Set(['github', 'aws', 'projects', 'people', 'optional']))
  })

  it('asks for the checks again once what they checked has changed', () => {
    const s = initialState()
    s.github.token = CLASSIC
    expect(blockers(s, 'github')[0]?.text).toMatch(/Check the token/)
    s.pre = { checks: [{ id: 'github.repo:me/a', status: 'fail', title: 'me/a', detail: 'no access' }], ok: false, token: null, repos: [], region: 'us-east-1', profileRegion: '', self: null, facts: { account: '123456789012' } }
    s.preKey = preflightKey(s)
    expect(blockers(s, 'aws')).toEqual([])
    // a failing repository blocks only while it is chosen
    expect(blockers(s, 'projects')).toEqual([])
    s.projects.set('me/a', { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: null })
    expect(blockers(s, 'projects').map((b) => b.text)).toEqual(['The projects changed: check access to them.', 'me/a: no access'])
    s.aws.region = 'eu-west-1'
    expect(blockers(s, 'aws')[0]?.text).toMatch(/Check the AWS account/)
  })
})

describe('the installer page: projects an earlier run installed', () => {
  const project = { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: null }
  const check = (repos: string[], access: { repo: string; ok: boolean; reason: string }[]) => ({
    login: 'me', name: null, kind: 'fine-grained', scopes: [], warnings: [], self: null, access,
    repos: repos.map((fullName) => ({ fullName, private: true, admin: true, push: true, defaultBranch: 'main' })),
  })
  const savedRun = () => {
    const s = initialState()
    s.sample.repo = 'me/trace-sample'
    s.sample.private = false
    for (const r of ['me/board', 'me/trace-sample', 'me/old']) s.projects.set(r, { ...project })
    return s
  }

  it('creates the sample again when it was deleted, and leaves out other projects the token no longer reaches', () => {
    const s = savedRun()
    reconcileProjects(s, check(['me/board'], [
      { repo: 'me/board', ok: true, reason: '' },
      { repo: 'me/trace-sample', ok: false, reason: 'GET /repos/me/trace-sample/actions/secrets/public-key: 404 Not Found' },
      { repo: 'me/old', ok: false, reason: 'GET /repos/me/old/actions/secrets/public-key: 404 Not Found' },
    ]))
    expect(s.projects.get('me/trace-sample')?.create).toEqual({ template: 'sample', private: false })
    expect(s.sample.gone).toBe(true)
    expect([...s.projects.keys()]).toEqual(['me/board', 'me/trace-sample'])
    expect(s.dropped).toEqual(['me/old'])
    // what the installer is sent: the sample to create (so the checks look for it as a new repository), not to configure
    expect(preflightBody(s)).toMatchObject({ repos: ['me/board'], create: ['me/trace-sample'] })
    expect(answers(s).sample).toMatchObject({ enabled: true, repo: 'me/trace-sample' })
    expect(AnswersSchema.safeParse(answers(s)).success).toBe(true)
    // checking again changes nothing more
    reconcileProjects(s, check(['me/board'], []))
    expect(s.projects.get('me/trace-sample')?.create).toEqual({ template: 'sample', private: false })
    expect(s.dropped).toEqual(['me/old'])
  })

  it('keeps a project GitHub refused for another reason (not a missing repository)', () => {
    const s = savedRun()
    reconcileProjects(s, check(['me/board', 'me/trace-sample', 'me/old'], [
      { repo: 'me/trace-sample', ok: false, reason: 'GET /repos/me/trace-sample/actions/secrets/public-key: 403 Resource not accessible' },
      { repo: 'me/old', ok: true, reason: '' },
    ]))
    expect(s.projects.get('me/trace-sample')?.create).toBeNull()
    expect(s.sample.gone).toBe(false)
    expect(s.dropped).toEqual([])
  })
})
