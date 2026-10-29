/**
 * Publishing trace's images from this AWS account, set up end to end by API (no console step, no prework): a step of
 * the install itself whenever the installing token administers trace's source repository (src/installer/bootstrap.ts;
 * Advanced "Publish trace's images" overrides it either way), and `tracectl release setup` on its own.
 *
 *   1 bootstrap   CDK in us-east-1 (ECR Public's only region), when it isn't
 *   2 stack       deploy TraceRelease (src/infra/release.ts): the ECR Public repositories trace-agent and trace-gpu,
 *                 and the release role (GitHub OIDC, the source repository's main and v* tags; the account's OIDC
 *                 provider when it has one)
 *   3 registry    the registry's default alias (DescribeRegistries), which ECR Public assigns by itself once the
 *                 account's first public repository exists: read now, waiting a little when the repositories are
 *                 brand new. Its gallery display name is set by API (PutRegistryCatalogData)
 *   4 variables   TRACE_RELEASE_ROLE and TRACE_IMAGE_REGISTRY (`public.ecr.aws/<alias>`) on the source repository,
 *                 with the GitHub token already given (REST)
 *   5 record      the registry recorded where every installation finds it: the source repository's release
 *                 `trace-images` (a pre-release, never "latest"), whose body names it in a marker line. Installers read
 *                 it (publishedRegistry) when nothing else says where the images are, so nobody edits or commits a
 *                 registry anywhere
 *   6 publish     optionally, the first release run (workflow_dispatch), and where the images will appear
 *
 * The release workflow runs where every trace workflow does: the source repository's own AWS CodeBuild runner, which the
 * installation makes (props.ts ciRepositories; Docker-in-Docker with runners.ciPrivileged when it publishes), and
 * GitHub's ubuntu-24.04 runner until that exists.
 *
 * Every step is safe to run again. Every AWS and GitHub call is a dependency, so the tests give fakes.
 */
import type { AwsCredentialIdentity } from '@smithy/types'
import { RELEASE_REGION, RELEASE_REPOSITORIES, RELEASE_REPOSITORY, RELEASE_ROLE_OUTPUT, RELEASE_STACK } from '../infra/release.js'
import { awsEnv } from './aws.js'

/** The registry's aliases as DescribeRegistries gives them. */
export interface RegistryInfo { registryId: string; aliases: { name: string; status: string; defaultRegistryAlias: boolean; primaryRegistryAlias: boolean }[] }

export interface ReleaseDeps {
  /** whether CDK is bootstrapped in us-east-1 (version 6 or later) */
  bootstrapped(): Promise<boolean>
  /** whether the account has GitHub's OIDC provider (the stack then uses it) */
  oidcProvider(): Promise<boolean>
  /** `cdk …` with these extra environment variables; its exit code */
  cdk(args: string[], env: Record<string, string>): Promise<number>
  /** a stack's outputs in a region, or null when there is no such stack */
  outputs(stack: string, region: string): Promise<Record<string, string> | null>
  /** ECR Public DescribeRegistries (us-east-1) */
  registries(): Promise<RegistryInfo[]>
  /** ECR Public PutRegistryCatalogData */
  catalog(displayName: string): Promise<void>
  /** GitHub: the repository's immutable OIDC subject prefix (github.ts immutableSubject), which the role trusts beside its
   * name form; absent in tests that do not need it */
  subject?(repo: string): Promise<string>
  /** GitHub: a repository variable; a workflow_dispatch */
  setVariable(repo: string, name: string, value: string): Promise<string>
  dispatch(repo: string, workflow: string, ref: string): Promise<void>
  /** the release REGISTRY_TAG on the repository, its body this text (made, or its body updated): 'created' | 'updated' */
  recordRegistry(repo: string, body: string): Promise<'created' | 'updated'>
  log(line: string): void
  sleep(ms: number): Promise<void>
}

export interface ReleaseOptions {
  /** the AWS account (for the us-east-1 bootstrap's target) */
  account: string
  /** OWNER/REPO whose release workflow publishes (default trace's own) */
  repository?: string
  /** start the first release run */
  publish?: boolean
}

export interface ReleaseResult { registry: string; roleArn: string; images: string[]; gallery: string[]; dispatched: boolean }

/** The source repository's release that records where its images are published. */
export const REGISTRY_TAG = 'trace-images'

const MARKER = /<!--\s*trace-registry:\s*(public\.ecr\.aws\/[a-z0-9][a-z0-9._-]*)\s*-->/

/** The release's body: what it is, for a person, and the marker line installers read. */
export function registryRecord(registry: string, repository: string): string {
  const repos = Object.values(RELEASE_REPOSITORIES)
  return [
    `trace's container images are published to \`${registry}\` (${repos.map((r) => `\`${registry}/${r}\``).join(' and ')}) from ${repository}'s main branch and v* tags, tagged with each content tag, \`latest\` and \`vX.Y.Z\`.`,
    '',
    'Installers read this release to find them and copy the image for their version into their own account, pinned by digest; this release has no assets and is not a version of trace.',
    '',
    `<!-- trace-registry: ${registry} -->`,
  ].join('\n')
}

/** The registry a release body names, or null. */
export function parseRegistry(body: string | null | undefined): string | null {
  return MARKER.exec(body ?? '')?.[1] ?? null
}

/** Where `source`'s images are published, from its REGISTRY_TAG release; null when it has none (nothing published:
 * installations build their images). Any token that can read the repository can read it. */
export async function publishedRegistry(get: (path: string) => Promise<{ body?: string | null } | null>, source: string): Promise<string | null> {
  return parseRegistry((await get(`/repos/${source}/releases/tags/${REGISTRY_TAG}`))?.body)
}

/** How long to wait for ECR Public to assign the default alias after the first repository: 10 checks, 6 s apart. */
export const ALIAS_TRIES = 10
export const ALIAS_WAIT_MS = 6000

/**
 * The registry's default alias. ECR Public assigns it when the account's first public repository is created, so right
 * after the stack made the repositories it may not be there yet: check again a few times. An account with a
 * registry already (any repository before) has it at once.
 */
export async function defaultAlias(d: Pick<ReleaseDeps, 'registries' | 'sleep' | 'log'>, tries = ALIAS_TRIES, waitMs = ALIAS_WAIT_MS): Promise<string> {
  for (let i = 1; ; i++) {
    const regs = await d.registries()
    const aliases = regs.flatMap((r) => r.aliases)
    const pick = aliases.find((a) => a.defaultRegistryAlias && a.status === 'ACTIVE') ?? aliases.find((a) => a.primaryRegistryAlias && a.status === 'ACTIVE')
    if (pick) return pick.name
    if (i >= tries) throw new Error(`ECR Public has assigned this account's registry no alias yet (${regs.length ? `status ${aliases.map((a) => a.status).join(', ') || 'none'}` : 'no registry'}): run \`tracectl release setup\` again in a few minutes`)
    d.log(`waiting for ECR Public to assign the registry's default alias (it does once the first public repository exists): check ${i} of ${tries}`)
    await d.sleep(waitMs)
  }
}

export async function releaseSetup(d: ReleaseDeps, o: ReleaseOptions): Promise<ReleaseResult> {
  const repository = o.repository ?? RELEASE_REPOSITORY
  const region = { AWS_REGION: RELEASE_REGION, CDK_DEFAULT_REGION: RELEASE_REGION }
  // 1 — CDK in us-east-1
  if (!(await d.bootstrapped())) {
    d.log(`bootstrapping CDK in ${RELEASE_REGION} (ECR Public's region)`)
    const code = await d.cdk(['bootstrap', `aws://${o.account}/${RELEASE_REGION}`, '--app', 'node dist/infra/release.js'], region)
    if (code !== 0) throw new Error(`cdk bootstrap exited ${code}`)
  }
  // 2 — the repositories and the role
  const createOidc = !(await d.oidcProvider())
  d.log(`deploying ${RELEASE_STACK} in ${RELEASE_REGION}: ECR Public ${Object.values(RELEASE_REPOSITORIES).join(' and ')}, and the release role for ${repository} (main and v* tags)${createOidc ? ', with GitHub\'s OIDC provider (the account has none)' : ''}`)
  // the repository's immutable subject: GitHub sends it instead of repo:OWNER/REPO for repositories made, renamed or moved
  // after 15 July 2026, or opted in, and the role trusts both. Best effort: without it, the name form only (and said)
  let subject: string | null = null
  if (d.subject) {
    try { subject = await d.subject(repository) } catch (e) {
      d.log(`${repository}'s GitHub ids could not be read (${e instanceof Error ? e.message : String(e)}): the release role trusts repo:${repository} only, which GitHub does not send when the repository uses immutable subjects`)
    }
  }
  const code = await d.cdk(['deploy', RELEASE_STACK, '--app', 'node dist/infra/release.js', '--require-approval', 'never', '-c', `repository=${repository}`, '-c', `createOidcProvider=${createOidc}`, ...(subject ? ['-c', `immutableSubject=${subject}`] : [])], region)
  if (code !== 0) throw new Error(`cdk deploy ${RELEASE_STACK} exited ${code}`)
  const out = await d.outputs(RELEASE_STACK, RELEASE_REGION)
  const roleArn = out?.[RELEASE_ROLE_OUTPUT]
  if (!roleArn) throw new Error(`${RELEASE_STACK} has no output ${RELEASE_ROLE_OUTPUT}`)
  // 3 — the registry's address
  const alias = await defaultAlias(d)
  const registry = `public.ecr.aws/${alias}`
  await d.catalog('trace').then(() => d.log('the registry\'s gallery display name: trace'), (e: unknown) => d.log(`the registry's display name was not set (${e instanceof Error ? e.message : String(e)}); nothing depends on it`))
  // 4 — the source repository's variables
  for (const [k, v] of [['TRACE_RELEASE_ROLE', roleArn], ['TRACE_IMAGE_REGISTRY', registry]] as const) d.log(`${repository}: ${k} ${await d.setVariable(repository, k, v)} (${v})`)
  // 5 — where installations find the registry
  d.log(`${repository}: release ${REGISTRY_TAG} ${await d.recordRegistry(repository, registryRecord(registry, repository))}: installations find the images there`)
  // 6 — the first release
  const images = Object.values(RELEASE_REPOSITORIES).map((r) => `${registry}/${r}`)
  const gallery = Object.values(RELEASE_REPOSITORIES).map((r) => `https://gallery.ecr.aws/${alias}/${r}`)
  let dispatched = false
  if (o.publish) {
    await d.dispatch(repository, 'release-images.yml', 'main')
    dispatched = true
    d.log(`started the release workflow on ${repository} (main): https://github.com/${repository}/actions/workflows/release-images.yml`)
  }
  d.log(`the images will appear at ${images.join(' and ')} (${gallery.join(', ')}), tagged with the content tag, latest and each vX.Y.Z`)
  return { registry, roleArn, images, gallery, dispatched }
}

/** The real calls: these credentials, the CDK CLI of this trace, and the GitHub token. */
export async function liveReleaseDeps(creds: AwsCredentialIdentity, token: string, o: { cdk: (args: string[], env: Record<string, string>) => Promise<number>; log: (l: string) => void }): Promise<ReleaseDeps> {
  const [cfn, iam, signed, gh, { z }] = await Promise.all([
    import('@aws-sdk/client-cloudformation'), import('@aws-sdk/client-iam'), import('./signed.js'), import('./github.js'), import('zod'),
  ])
  const outputs = async (stack: string, region: string): Promise<Record<string, string> | null> => {
    try {
      const s = (await new cfn.CloudFormationClient({ region, credentials: creds }).send(new cfn.DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]
      if (!s || s.StackStatus === 'DELETE_COMPLETE') return null
      return Object.fromEntries((s.Outputs ?? []).map((x) => [x.OutputKey ?? '', x.OutputValue ?? '']))
    } catch (e) {
      if (/does not exist/.test(e instanceof Error ? e.message : String(e))) return null
      throw e
    }
  }
  const ecr = signed.signedCaller(creds, RELEASE_REGION)
  const env = (extra: Record<string, string>): Record<string, string> => ({ ...awsEnv(creds, extra.AWS_REGION ?? RELEASE_REGION), ...extra, CDK_DISABLE_VERSION_CHECK: '1', CI: '1' })
  return {
    bootstrapped: async () => {
      const b = await outputs('CDKToolkit', RELEASE_REGION)
      return Boolean(b) && Number(b?.BootstrapVersion ?? 0) >= 6
    },
    oidcProvider: async () => ((await new iam.IAMClient({ region: RELEASE_REGION, credentials: creds }).send(new iam.ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? [])
      .some((p) => (p.Arn ?? '').endsWith('/token.actions.githubusercontent.com')),
    cdk: (args, extra) => o.cdk(args, env(extra)),
    outputs,
    registries: async () => {
      type Raw = { registryId?: string; aliases?: { name?: string; status?: string; defaultRegistryAlias?: boolean; primaryRegistryAlias?: boolean }[] }
      const r = await ecr(signed.ecrPublic('DescribeRegistries', {}))
      return ((r.registries ?? []) as Raw[]).map((x) => ({
        registryId: x.registryId ?? '',
        aliases: (x.aliases ?? []).map((a) => ({ name: a.name ?? '', status: a.status ?? '', defaultRegistryAlias: Boolean(a.defaultRegistryAlias), primaryRegistryAlias: Boolean(a.primaryRegistryAlias) })),
      }))
    },
    catalog: async (displayName) => { await ecr(signed.ecrPublic('PutRegistryCatalogData', { displayName })) },
    subject: (repo) => gh.immutableSubject(token, repo),
    setVariable: (repo, name, value) => gh.setVariable(token, repo, name, value),
    dispatch: async (repo, workflow, ref) => { await new gh.Github(token).request('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, z.unknown(), { ref }) },
    recordRegistry: async (repo, body) => {
      const api = new gh.Github(token)
      const Release = z.object({ id: z.number() }).loose()
      let id: number | null = null
      try { id = (await api.request('GET', `/repos/${repo}/releases/tags/${REGISTRY_TAG}`, Release)).data.id } catch (e) { if (!(e instanceof gh.GithubError && e.status === 404)) throw e }
      if (id !== null) { await api.request('PATCH', `/repos/${repo}/releases/${id}`, z.unknown(), { body }); return 'updated' }
      await api.request('POST', `/repos/${repo}/releases`, z.unknown(), {
        tag_name: REGISTRY_TAG, target_commitish: 'main', name: 'trace\'s published images', body, prerelease: true, make_latest: 'false',
      })
      return 'created'
    },
    log: o.log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
