/**
 * TraceRelease: where trace's own release workflow (.github/workflows/release-images.yml) publishes the two images, so
 * installations copy them instead of building them (src/infra/images.ts, images.source 'prebuilt'). One small stack,
 * deployed once by the project owner, in us-east-1 (the only region Amazon ECR Public has):
 *
 *   repositories  ECR Public `trace-agent` (linux/arm64, the AgentCore runtimes' image) and `trace-gpu` (linux/amd64,
 *                 the AWS Batch GPU and CPU jobs' image), with their gallery catalog data. Readable by anyone, from
 *                 any account, without credentials
 *   release role  `trace-release`, assumed with GitHub OIDC only by workflows of the source repository running on
 *                 main or on a `v*` tag; it may get the ECR Public push token and push to those two repositories,
 *                 nothing else (no delete, no other repository, no policy changes)
 *
 * The registry's address is `public.ecr.aws/<alias>`: its default alias, which ECR Public assigns by itself once the
 * account's first public repository exists (no console step; a custom alias is the only kind that needs the console,
 * and trace does not use one). CloudFormation can't read it, so `trace release setup` (src/installer/release.ts)
 * reads it with DescribeRegistries after the deploy and sets the source repository's TRACE_IMAGE_REGISTRY to it.
 *
 *   trace release setup         (deploys this stack and does the rest: README "Publishing images")
 *   npm run deploy:release      (this stack only: `cdk deploy TraceRelease --app "node dist/infra/release.js"`)
 *
 * Settings, from CDK context (-c) or the environment:
 *   repository         / TRACE_RELEASE_REPOSITORY   OWNER/REPO whose workflows may publish (default mteichtahl/trace)
 *   createOidcProvider / TRACE_CREATE_OIDC_PROVIDER 'true' when the account has no GitHub OIDC provider yet (default
 *                                                   false: use the account's)
 */
import { pathToFileURL } from 'node:url'
import { App, CfnOutput, Stack } from 'aws-cdk-lib'
import { CfnPublicRepository } from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import { projectSlug } from '../core/project.js'

export const RELEASE_STACK = 'TraceRelease'
/** ECR Public is in us-east-1 only. */
export const RELEASE_REGION = 'us-east-1'
export const RELEASE_ROLE_NAME = 'trace-release'
export const RELEASE_REPOSITORY = 'mteichtahl/trace'
export const RELEASE_ROLE_OUTPUT = 'ReleaseRoleArn'
/** The two repositories, by image kind (src/infra/images.ts ImageKind). */
export const RELEASE_REPOSITORIES = { agent: 'trace-agent', gpu: 'trace-gpu' } as const
/** The actions a push takes (ECR Public's "push an image" IAM requirements), on the repositories only. */
export const PUSH_ACTIONS = [
  'ecr-public:BatchCheckLayerAvailability', 'ecr-public:InitiateLayerUpload', 'ecr-public:UploadLayerPart',
  'ecr-public:CompleteLayerUpload', 'ecr-public:PutImage',
] as const

const ISSUER = 'token.actions.githubusercontent.com'

export interface ReleaseSettings { repository: string; createOidcProvider: boolean }

export function releaseSettings(context: (key: string) => unknown, env: NodeJS.ProcessEnv = process.env): ReleaseSettings {
  const get = (key: string, name: string): string | undefined => {
    const v = context(key) ?? env[name]
    return v === undefined || v === '' ? undefined : String(v)
  }
  const create = get('createOidcProvider', 'TRACE_CREATE_OIDC_PROVIDER')
  if (create !== undefined && create !== 'true' && create !== 'false') throw new Error(`createOidcProvider must be true or false, not ${create}`)
  return { repository: projectSlug(get('repository', 'TRACE_RELEASE_REPOSITORY') ?? RELEASE_REPOSITORY), createOidcProvider: create === 'true' }
}

const CATALOG = {
  agent: { about: 'The trace agent image: the runtime Amazon Bedrock AgentCore runs for each project (Claude Code, KiCad, the verification tools).', architectures: ['ARM 64'] },
  gpu: { about: 'The trace GPU and CPU job image: Blender, the PCB autorouters, openEMS and OpenFOAM, run as AWS Batch jobs.', architectures: ['x86-64'] },
} as const

export class TraceReleaseStack extends Stack {
  readonly repositories: Record<keyof typeof RELEASE_REPOSITORIES, CfnPublicRepository>
  readonly role: iam.Role

  constructor(scope: App, id: string, s: ReleaseSettings, env?: { account?: string }) {
    super(scope, id, { env: { ...env, region: RELEASE_REGION }, description: `trace's published images (ECR Public) and the role ${s.repository}'s release workflow pushes them with` })
    const repo = (kind: keyof typeof RELEASE_REPOSITORIES): CfnPublicRepository => new CfnPublicRepository(this, `${kind === 'agent' ? 'Agent' : 'Gpu'}Repository`, {
      repositoryName: RELEASE_REPOSITORIES[kind],
      repositoryCatalogData: {
        RepositoryDescription: `trace (${s.repository}): ${CATALOG[kind].about}`.slice(0, 1024),
        AboutText: `${CATALOG[kind].about}\n\nTagged with the content hash of the source it was built from (scripts/image-tag.mjs); \`latest\` follows main, \`vX.Y.Z\` a release. Installations copy it by digest into their own private ECR.`,
        UsageText: `Installations of trace pull it by itself (images.source 'prebuilt'). See https://github.com/${s.repository}#publishing-images.`,
        Architectures: [...CATALOG[kind].architectures],
        OperatingSystems: ['Linux'],
      },
      tags: [{ key: 'trace:release', value: s.repository }],
    })
    this.repositories = { agent: repo('agent'), gpu: repo('gpu') }

    const provider = s.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: `https://${ISSUER}`, clientIds: ['sts.amazonaws.com'] })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', `arn:${this.partition}:iam::${this.account}:oidc-provider/${ISSUER}`)
    this.role = new iam.Role(this, 'ReleaseRole', {
      roleName: RELEASE_ROLE_NAME,
      description: `Pushes trace's images to ECR Public: ${s.repository}'s workflows on main and v* tags only`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { [`${ISSUER}:aud`]: 'sts.amazonaws.com' },
        StringLike: { [`${ISSUER}:sub`]: [`repo:${s.repository}:ref:refs/heads/main`, `repo:${s.repository}:ref:refs/tags/v*`] },
      }),
      inlinePolicies: {
        Push: new iam.PolicyDocument({
          statements: [
            // the registry login (GetAuthorizationToken has no resource, and needs a service bearer token for ECR Public)
            new iam.PolicyStatement({ sid: 'Login', actions: ['ecr-public:GetAuthorizationToken'], resources: ['*'] }),
            new iam.PolicyStatement({ sid: 'BearerToken', actions: ['sts:GetServiceBearerToken'], resources: ['*'], conditions: { StringEquals: { 'sts:AWSServiceName': 'ecr-public.amazonaws.com' } } }),
            new iam.PolicyStatement({ sid: 'Push', actions: [...PUSH_ACTIONS], resources: Object.values(this.repositories).map((r) => r.attrArn) }),
          ],
        }),
      },
    })
    new CfnOutput(this, RELEASE_ROLE_OUTPUT, { value: this.role.roleArn, description: 'The release workflow\'s role (the source repository\'s TRACE_RELEASE_ROLE)' })
    new CfnOutput(this, 'AgentRepositoryArn', { value: this.repositories.agent.attrArn })
    new CfnOutput(this, 'GpuRepositoryArn', { value: this.repositories.gpu.attrArn })
    new CfnOutput(this, 'RegistryAlias', { value: 'aws ecr-public describe-registries --region us-east-1 (its default alias; trace release setup reads it)', description: 'The registry is public.ecr.aws/<its default alias>, which CloudFormation cannot read' })
  }
}

// run as the app (`cdk deploy TraceRelease --app "node dist/infra/release.js"`), not when imported by the tests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = new App()
  new TraceReleaseStack(app, RELEASE_STACK, releaseSettings((k) => app.node.tryGetContext(k)), { account: process.env.CDK_DEFAULT_ACCOUNT })
  app.synth()
}
