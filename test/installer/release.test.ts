/**
 * `trace release setup` (src/installer/release.ts) against fakes: the us-east-1 bootstrap, TraceRelease, the
 * registry's default alias (there already, or assigned once the first repository exists), the source repository's
 * variables, trace's own CodeBuild runner (privileged, through a connection or the token), and the first release.
 */
import { describe, expect, it } from 'vitest'
import { REGISTRY_TAG, type RegistryInfo, type ReleaseDeps, defaultAlias, parseRegistry, publishedRegistry, registryRecord, releaseSetup } from '../../src/installer/release.js'

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
    recordRegistry: async (repo, body) => { calls.push(`record ${repo} ${parseRegistry(body)}`); return 'created' },
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
  it('deploys TraceRelease in us-east-1, sets both variables, records the registry, and starts the first release', async () => {
    const d = deps({ bootstrapped: async () => false })
    const r = await releaseSetup(d, { account: '123456789012', publish: true })
    expect(d.calls[0]).toBe('cdk bootstrap aws://123456789012/us-east-1 --app node dist/infra/release.js @us-east-1')
    expect(d.calls[1]).toBe('cdk deploy TraceRelease --app node dist/infra/release.js --require-approval never -c repository=mteichtahl/trace -c createOidcProvider=false @us-east-1')
    expect(d.calls).toContain('catalog trace')
    expect(Object.fromEntries(d.vars)).toEqual({ 'mteichtahl/trace:TRACE_RELEASE_ROLE': ROLE, 'mteichtahl/trace:TRACE_IMAGE_REGISTRY': 'public.ecr.aws/a1b2c3d4' })
    // the release workflow's runner is the installation's (props.ts ciRepositories): nothing deployed for it here
    expect(d.calls.filter((c) => c.startsWith('cdk') && !c.includes('TraceRelease') && !c.startsWith('cdk bootstrap'))).toEqual([])
    // the registry recorded where installations find it, before the first release starts
    expect(d.calls.slice(-2)).toEqual(['record mteichtahl/trace public.ecr.aws/a1b2c3d4', 'dispatch mteichtahl/trace release-images.yml main'])
    expect(r).toMatchObject({
      registry: 'public.ecr.aws/a1b2c3d4', roleArn: ROLE, dispatched: true,
      images: ['public.ecr.aws/a1b2c3d4/trace-agent', 'public.ecr.aws/a1b2c3d4/trace-gpu'],
      gallery: ['https://gallery.ecr.aws/a1b2c3d4/trace-agent', 'https://gallery.ecr.aws/a1b2c3d4/trace-gpu'],
    })
  })

  it('makes the OIDC provider when the account has none, publishes for the repository given, and starts nothing unasked', async () => {
    const d = deps({ oidcProvider: async () => false })
    const r = await releaseSetup(d, { account: '123456789012', repository: 'me/fork' })
    expect(d.calls.find((c) => c.startsWith('cdk deploy TraceRelease'))).toBe('cdk deploy TraceRelease --app node dist/infra/release.js --require-approval never -c repository=me/fork -c createOidcProvider=true @us-east-1')
    expect(d.vars.get('me/fork:TRACE_IMAGE_REGISTRY')).toBe('public.ecr.aws/a1b2c3d4')
    expect(d.calls).toContain('record me/fork public.ecr.aws/a1b2c3d4')
    expect(r).toMatchObject({ dispatched: false })
    expect(d.calls.filter((c) => c.startsWith('dispatch'))).toEqual([])
  })

  it('stops, saying which step, when a deploy fails, and carries on when only the display name could not be set', async () => {
    await expect(releaseSetup(deps({ cdk: async (a) => (a.includes('TraceRelease') ? 1 : 0) }), { account: '1' })).rejects.toThrow(/cdk deploy TraceRelease exited 1/)
    await expect(releaseSetup(deps({ outputs: async () => null }), { account: '1' })).rejects.toThrow(/no output ReleaseRoleArn/)
    const r = await releaseSetup(deps({ catalog: async () => { throw new Error('denied') } }), { account: '1' })
    expect(r.registry).toBe('public.ecr.aws/a1b2c3d4')
  })
})

describe('where installations find the published images', () => {
  it('is the trace-images release, whose body names the registry for a person and in its marker line', async () => {
    const body = registryRecord('public.ecr.aws/a1b2c3d4', 'mteichtahl/trace')
    expect(body).toContain('`public.ecr.aws/a1b2c3d4/trace-agent`')
    expect(parseRegistry(body)).toBe('public.ecr.aws/a1b2c3d4')
    const asked: string[] = []
    const get = (b: { body?: string | null } | null) => async (p: string) => { asked.push(p); return b }
    expect(await publishedRegistry(get({ body }), 'mteichtahl/trace')).toBe('public.ecr.aws/a1b2c3d4')
    expect(asked).toEqual([`/repos/mteichtahl/trace/releases/tags/${REGISTRY_TAG}`])
    // no release (nothing published yet), or one whose body names no registry: build
    expect(await publishedRegistry(get(null), 'mteichtahl/trace')).toBeNull()
    expect(await publishedRegistry(get({ body: 'edited by hand' }), 'mteichtahl/trace')).toBeNull()
    expect(await publishedRegistry(get({ body: null }), 'mteichtahl/trace')).toBeNull()
    // only an ECR Public registry is taken from it
    expect(parseRegistry('<!-- trace-registry: evil.example.com/x -->')).toBeNull()
  })
})
