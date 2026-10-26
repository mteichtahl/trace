/**
 * `trace release setup` (src/installer/release.ts) against fakes: the us-east-1 bootstrap, TraceRelease, the
 * registry's default alias (there already, or assigned once the first repository exists), the source repository's
 * variables, trace's own CodeBuild runner (privileged, through a connection or the token), and the first release.
 */
import { describe, expect, it } from 'vitest'
import { type RegistryInfo, type ReleaseDeps, defaultAlias, releaseSetup } from '../../src/installer/release.js'

const ROLE = 'arn:aws:iam::123456789012:role/trace-release'
const alias = (name: string, status = 'ACTIVE'): RegistryInfo => ({ registryId: '123456789012', aliases: [{ name, status, defaultRegistryAlias: true, primaryRegistryAlias: true }] })

function deps(over: Partial<ReleaseDeps> & { registriesSeq?: RegistryInfo[][] } = {}): ReleaseDeps & { calls: string[]; vars: Map<string, string> } {
  const calls: string[] = []
  const vars = new Map<string, string>()
  const seq = [...(over.registriesSeq ?? [[alias('a1b2c3d4')]])]
  return {
    calls, vars,
    bootstrapped: async () => true,
    oidcProvider: async () => true,
    cdk: async (args, env) => { calls.push(`cdk ${args.join(' ')} @${env.AWS_REGION}`); return 0 },
    outputs: async (stack) => (stack === 'TraceRelease' ? { ReleaseRoleArn: ROLE } : null),
    registries: async () => { calls.push('registries'); return seq.length > 1 ? seq.shift() ?? [] : seq[0] ?? [] },
    catalog: async (n) => { calls.push(`catalog ${n}`) },
    setVariable: async (repo, name, value) => { vars.set(`${repo}:${name}`, value); return 'created' },
    dispatch: async (repo, wf, ref) => { calls.push(`dispatch ${repo} ${wf} ${ref}`) },
    runnerProject: async () => ({ privileged: true }),
    resolveConnection: async () => ({ name: 'trace-ci-github', ready: false, message: 'none authorized' }),
    sourceCredential: async (ours) => { calls.push(`credential ${ours}`); return { state: 'imported', detail: 'imported' } },
    log: () => undefined,
    sleep: async (ms) => { calls.push(`sleep ${ms}`) },
    ...over,
  }
}

describe('the registry alias', () => {
  it('is read at once when the account has a registry already', async () => {
    const d = deps()
    expect(await defaultAlias(d)).toBe('a1b2c3d4')
    expect(d.calls.filter((c) => c.startsWith('sleep'))).toEqual([])
  })

  it('is waited for when ECR Public assigns it only now, after the first repository', async () => {
    const d = deps({ registriesSeq: [[], [{ registryId: '123456789012', aliases: [] }], [alias('z9y8x7w6')]] })
    expect(await defaultAlias(d, 5, 10)).toBe('z9y8x7w6')
    expect(d.calls.filter((c) => c.startsWith('sleep'))).toEqual(['sleep 10', 'sleep 10'])
    // never assigned within the tries: says to run again, without guessing one
    await expect(defaultAlias(deps({ registriesSeq: [[]] }), 3, 1)).rejects.toThrow(/no alias yet .*run `trace release setup` again/)
    // a pending alias is not one to publish to
    await expect(defaultAlias(deps({ registriesSeq: [[alias('pending1', 'PENDING')]] }), 2, 1)).rejects.toThrow(/status PENDING/)
  })
})

describe('trace release setup', () => {
  it('deploys TraceRelease in us-east-1, sets both variables, keeps a privileged runner, and starts the first release', async () => {
    const d = deps({ bootstrapped: async () => false })
    const r = await releaseSetup(d, { account: '123456789012', ciRegion: 'ap-southeast-2', publish: true })
    expect(d.calls[0]).toBe('cdk bootstrap aws://123456789012/us-east-1 --app node dist/infra/release.js @us-east-1')
    expect(d.calls[1]).toBe('cdk deploy TraceRelease --app node dist/infra/release.js --require-approval never -c repository=mteichtahl/trace -c createOidcProvider=false @us-east-1')
    expect(d.calls).toContain('catalog trace')
    expect(Object.fromEntries(d.vars)).toEqual({ 'mteichtahl/trace:TRACE_RELEASE_ROLE': ROLE, 'mteichtahl/trace:TRACE_IMAGE_REGISTRY': 'public.ecr.aws/a1b2c3d4' })
    // trace-ci exists and is privileged: nothing deployed for it
    expect(d.calls.filter((c) => c.includes('TraceCi'))).toEqual([])
    expect(d.calls.at(-1)).toBe('dispatch mteichtahl/trace release-images.yml main')
    expect(r).toMatchObject({
      registry: 'public.ecr.aws/a1b2c3d4', roleArn: ROLE, dispatched: true, credential: null,
      images: ['public.ecr.aws/a1b2c3d4/trace-agent', 'public.ecr.aws/a1b2c3d4/trace-gpu'],
      gallery: ['https://gallery.ecr.aws/a1b2c3d4/trace-agent', 'https://gallery.ecr.aws/a1b2c3d4/trace-gpu'],
    })
  })

  it('makes the OIDC provider when the account has none, and the runner, with the token when no connection is authorized', async () => {
    const d = deps({ oidcProvider: async () => false, runnerProject: async () => null })
    const r = await releaseSetup(d, { account: '123456789012', ciRegion: 'eu-west-1' })
    expect(d.calls.find((c) => c.startsWith('cdk deploy TraceRelease'))).toContain('createOidcProvider=true')
    expect(d.calls).toContain('credential false')
    expect(d.calls.find((c) => c.startsWith('cdk deploy TraceCi'))).toBe('cdk deploy TraceCi --app node dist/infra/ci-app.js --require-approval never -c privileged=true -c repository=mteichtahl/trace -c auth=token @eu-west-1')
    expect(r).toMatchObject({ credential: 'imported', dispatched: false })
    expect(d.calls.filter((c) => c.startsWith('dispatch'))).toEqual([])
  })

  it('uses an authorized connection for the runner when there is one, and makes an unprivileged one privileged', async () => {
    const CONN = 'arn:aws:codeconnections:eu-west-1:123456789012:connection/11111111-2222-3333-4444-555555555555'
    const d = deps({
      runnerProject: async () => ({ privileged: false }),
      resolveConnection: async () => ({ pass: CONN, arn: CONN, name: 'trace-ci-github', ready: true, message: 'authorized' }),
    })
    await releaseSetup(d, { account: '123456789012', ciRegion: 'eu-west-1', repository: 'me/fork' })
    expect(d.calls.find((c) => c.startsWith('cdk deploy TraceCi'))).toBe(`cdk deploy TraceCi --app node dist/infra/ci-app.js --require-approval never -c privileged=true -c repository=me/fork -c connectionReady=true -c connectionArn=${CONN} @eu-west-1`)
    expect(d.calls.filter((c) => c.startsWith('credential'))).toEqual([])
    expect(d.vars.get('me/fork:TRACE_IMAGE_REGISTRY')).toBe('public.ecr.aws/a1b2c3d4')
  })

  it('stops, saying which step, when a deploy fails, and carries on when only the display name could not be set', async () => {
    await expect(releaseSetup(deps({ cdk: async (a) => (a.includes('TraceRelease') ? 1 : 0) }), { account: '1', ciRegion: 'us-east-1' })).rejects.toThrow(/cdk deploy TraceRelease exited 1/)
    await expect(releaseSetup(deps({ outputs: async () => null }), { account: '1', ciRegion: 'us-east-1' })).rejects.toThrow(/no output ReleaseRoleArn/)
    const r = await releaseSetup(deps({ catalog: async () => { throw new Error('denied') } }), { account: '1', ciRegion: 'us-east-1' })
    expect(r.registry).toBe('public.ecr.aws/a1b2c3d4')
  })
})
