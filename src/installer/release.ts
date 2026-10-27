/**
 * Publishing trace's images from this AWS account, set up end to end by API (no console step, no prework): a step of
 * the install itself whenever the installing token administers trace's source repository (src/installer/bootstrap.ts;
 * Advanced "Publish trace's images" overrides it either way), and `trace release setup` on its own.
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
 *   5 runner      trace's own CodeBuild runner project, trace-ci, which the release workflow runs on, made (or made
 *                 privileged, for Docker) when it is not: TraceCi (src/infra/ci-app.ts) through an authorized GitHub
 *                 connection when there is one, else with the token as CodeBuild's GitHub source credential, so no
 *                 console step either way
 *   6 record      the registry recorded where every installation finds it: the source repository's release
 *                 `trace-images` (a pre-release, never "latest"), whose body names it in a marker line. Installers read
 *                 it (publishedRegistry) when nothing else says where the images are, so nobody edits or commits a
 *                 registry anywhere
 *   7 publish     optionally, the first release run (workflow_dispatch), and where the images will appear
 *
 * Every step is safe to run again. Every AWS and GitHub call is a dependency, so the tests give fakes.
 */
import { CI_PREFIX, CI_STACK } from '../infra/ci-app.js'
import { RELEASE_REGION, RELEASE_REPOSITORIES, RELEASE_REPOSITORY, RELEASE_ROLE_OUTPUT, RELEASE_STACK } from '../infra/release.js'
import { SELF_CI_PROJECT, connectionName } from '../core/project.js'

/** The connections TraceCi reuses first, as `npm run deploy:ci` does (src/infra/ci-deploy.ts CI_PREFER). */
const CI_PREFER = [connectionName(CI_PREFIX), connectionName('trace')] as const
import type { AwsCredentialIdentity } from '@smithy/types'
import { type ConnectionChoice, type SourceCredential, awsEnv, chooseRunnerAuth } from './aws.js'

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
  /** GitHub: a repository variable; a workflow_dispatch */
  setVariable(repo: string, name: string, value: string): Promise<string>
  dispatch(repo: string, workflow: string, ref: string): Promise<void>
  /** the release REGISTRY_TAG on the repository, its body this text (made, or its body updated): 'created' | 'updated' */
  recordRegistry(repo: string, body: string): Promise<'created' | 'updated'>
  /** the runner project trace-ci in the CI region: null when there is none */
  runnerProject(): Promise<{ privileged: boolean } | null>
  /** the GitHub connection for TraceCi (src/installer/aws.ts resolveConnection with deploy:ci's preferences) */
  resolveConnection(o: { prefix: string; deployed: Record<string, string> | null; prefer: readonly string[] }): Promise<ConnectionChoice>
  /** CodeBuild's GitHub source credential in the CI region (src/installer/aws.ts ensureSourceCredential) */
  sourceCredential(ours: boolean): Promise<SourceCredential>
  log(line: string): void
  sleep(ms: number): Promise<void>
}

export interface ReleaseOptions {
  /** the AWS account (for the us-east-1 bootstrap's target) */
  account: string
  /** OWNER/REPO whose release workflow publishes (default trace's own) */
  repository?: string
  /** the region trace-ci runs in (the installation's) */
  ciRegion: string
  /** start the first release run */
  publish?: boolean
  /** trace imported CodeBuild's GitHub credential in the CI region before (it may refresh it) */
  credentialOurs?: boolean
}

export interface ReleaseResult { registry: string; roleArn: string; images: string[]; gallery: string[]; credential: SourceCredential['state'] | null; dispatched: boolean }

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
    if (i >= tries) throw new Error(`ECR Public has assigned this account's registry no alias yet (${regs.length ? `status ${aliases.map((a) => a.status).join(', ') || 'none'}` : 'no registry'}): run \`trace release setup\` again in a few minutes`)
    d.log(`waiting for ECR Public to assign the registry's default alias (it does once the first public repository exists): check ${i} of ${tries}`)
    await d.sleep(waitMs)
  }
}

/** trace-ci, privileged (the release workflow builds images), when it is not: through a connection authorized
 * already, else with the token as CodeBuild's GitHub source credential. */
export async function ensureCiRunner(d: ReleaseDeps, o: { repository: string; ciRegion: string; credentialOurs?: boolean }): Promise<SourceCredential['state'] | null> {
  const now = await d.runnerProject()
  if (now?.privileged) { d.log(`${SELF_CI_PROJECT}: exists, privileged`); return null }
  const deployed = await d.outputs(CI_STACK, o.ciRegion)
  const auth = await chooseRunnerAuth('auto', { prefix: CI_PREFIX, deployed }, (x) => d.resolveConnection({ ...x, prefer: CI_PREFER }))
  let credential: SourceCredential['state'] | null = null
  const args = ['deploy', CI_STACK, '--app', 'node dist/infra/ci-app.js', '--require-approval', 'never', '-c', 'privileged=true', '-c', `repository=${o.repository}`]
  if (auth.auth === 'connection') {
    d.log(auth.connection.message)
    args.push('-c', 'connectionReady=true', ...(auth.connection.pass ? ['-c', `connectionArn=${auth.connection.pass}`] : []))
  } else {
    d.log(auth.message)
    const c = await d.sourceCredential(Boolean(o.credentialOurs))
    d.log(c.detail)
    credential = c.state
    args.push('-c', 'auth=token')
  }
  d.log(`${SELF_CI_PROJECT}: ${now ? 'making it privileged (the release workflow builds images)' : 'creating it'} in ${o.ciRegion}`)
  const code = await d.cdk(args, { AWS_REGION: o.ciRegion, CDK_DEFAULT_REGION: o.ciRegion })
  if (code !== 0) throw new Error(`cdk deploy ${CI_STACK} exited ${code}`)
  return credential
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
  const code = await d.cdk(['deploy', RELEASE_STACK, '--app', 'node dist/infra/release.js', '--require-approval', 'never', '-c', `repository=${repository}`, '-c', `createOidcProvider=${createOidc}`], region)
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
  // 5 — the runner it publishes on
  const credential = await ensureCiRunner(d, { repository, ciRegion: o.ciRegion, ...(o.credentialOurs !== undefined ? { credentialOurs: o.credentialOurs } : {}) })
  // 6 — where installations find the registry
  d.log(`${repository}: release ${REGISTRY_TAG} ${await d.recordRegistry(repository, registryRecord(registry, repository))}: installations find the images there`)
  // 7 — the first release
  const images = Object.values(RELEASE_REPOSITORIES).map((r) => `${registry}/${r}`)
  const gallery = Object.values(RELEASE_REPOSITORIES).map((r) => `https://gallery.ecr.aws/${alias}/${r}`)
  let dispatched = false
  if (o.publish) {
    await d.dispatch(repository, 'release-images.yml', 'main')
    dispatched = true
    d.log(`started the release workflow on ${repository} (main): https://github.com/${repository}/actions/workflows/release-images.yml`)
  }
  d.log(`the images will appear at ${images.join(' and ')} (${gallery.join(', ')}), tagged with the content tag, latest and each vX.Y.Z`)
  return { registry, roleArn, images, gallery, credential, dispatched }
}

/** The real calls: these credentials, the CDK CLI of this trace, and the GitHub token. */
export async function liveReleaseDeps(creds: AwsCredentialIdentity, ciRegion: string, token: string, o: { cdk: (args: string[], env: Record<string, string>) => Promise<number>; log: (l: string) => void }): Promise<ReleaseDeps> {
  const [cfn, iam, signed, cb, cc, aws, gh, { z }] = await Promise.all([
    import('@aws-sdk/client-cloudformation'), import('@aws-sdk/client-iam'), import('./signed.js'), import('@aws-sdk/client-codebuild'),
    import('@aws-sdk/client-codeconnections'), import('./aws.js'), import('./github.js'), import('zod'),
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
  const codebuild = new cb.CodeBuildClient({ region: ciRegion, credentials: creds })
  const connections = new cc.CodeConnectionsClient({ region: ciRegion, credentials: creds })
  const env = (extra: Record<string, string>): Record<string, string> => ({ ...awsEnv(creds, extra.AWS_REGION ?? ciRegion), ...extra, CDK_DISABLE_VERSION_CHECK: '1', CI: '1' })
  return {
    bootstrapped: async () => {
      const b = await outputs('CDKToolkit', RELEASE_REGION)
      return Boolean(b) && Number(b?.BootstrapVersion ?? 0) >= 6
    },
    oidcProvider: async () => ((await new iam.IAMClient({ credentials: creds }).send(new iam.ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? [])
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
    runnerProject: async () => {
      const p = (await codebuild.send(new cb.BatchGetProjectsCommand({ names: [SELF_CI_PROJECT] }))).projects?.[0]
      return p ? { privileged: Boolean(p.environment?.privilegedMode) } : null
    },
    resolveConnection: (x) => aws.resolveConnection(connections, x),
    sourceCredential: (ours) => aws.ensureSourceCredential(codebuild, token, ours),
    log: o.log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
