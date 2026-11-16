/**
 * trace's own GitLab as synthesized (src/infra/gitlab.ts, docs/gitlab-projects.md): one instance with no public way
 * in, reached by CloudFront only; its data on a kept, snapshotted volume; its address handed to it through SSM; the
 * API given its address and admin token, and nothing at all when GitLab is off.
 */
import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { beforeAll, describe, expect, it } from 'vitest'
import { GitlabServer, gitlabUserData } from '../../src/infra/gitlab.js'
import { InfraPropsSchema } from '../../src/infra/props.js'
import { RUNNERS, synth } from './templates.js'

const ENV = { account: '123456789012', region: 'ap-southeast-2' }

function gitlabTemplate(domain?: { name: string; certificateArn: string }): Template {
  const stack = new Stack(new App(), 'Parent', { env: ENV })
  const central = new s3.Bucket(stack, 'Central')
  return Template.fromStack(new GitlabServer(stack, 'Gitlab', { prefix: 'tr', central, instanceType: 'm7g.large', volumeGb: 100, domain, root: process.cwd() }))
}

describe('GitlabServer', () => {
  let t: Template
  beforeAll(() => { t = gitlabTemplate() })

  it('runs one Graviton instance in a private subnet, IMDSv2 only, with no key pair', () => {
    t.resourceCountIs('AWS::EC2::Instance', 1)
    const [inst] = Object.values(t.findResources('AWS::EC2::Instance')) as { Properties: Record<string, unknown> }[]
    expect(inst?.Properties.InstanceType).toBe('m7g.large')
    expect(inst?.Properties.KeyName).toBeUndefined()
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } } })
    t.resourceCountIs('AWS::EC2::NatGateway', 1)
  })

  it('lets only CloudFront\'s origin-facing addresses in, on port 80, and nothing on SSH', () => {
    const groups = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as { Properties: { SecurityGroupIngress?: Record<string, unknown>[] } }[]
    const rules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')) as { Properties: Record<string, unknown> }[]
    const ingress = [...groups.flatMap((g) => g.Properties.SecurityGroupIngress ?? []), ...rules.map((r) => r.Properties)]
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({ FromPort: 80, ToPort: 80, IpProtocol: 'tcp' })
    expect(ingress[0]?.SourcePrefixListId).toBeDefined()
    expect(JSON.stringify(ingress)).not.toMatch(/"FromPort":22/)
  })

  it('keeps its data on an encrypted volume that outlives the stack, snapshotted daily for 14 days', () => {
    t.hasResource('AWS::EC2::Volume', { Properties: { Encrypted: true, Size: 100, VolumeType: 'gp3' }, DeletionPolicy: 'Retain' })
    t.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: { TargetTags: [{ Key: 'trace:gitlab-data', Value: 'tr' }], Schedules: [Match.objectLike({ RetainRule: { Count: 14 } })] },
    })
  })

  it('is served by CloudFront from a VPC origin, HTTPS to people, nothing cached', () => {
    t.resourceCountIs('AWS::CloudFront::VpcOrigin', 1)
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: Match.arrayWith(['PUT', 'POST', 'DELETE']) }),
      }),
    })
  })

  it('makes its two secrets, kept when the stack goes, the token a placeholder until the instance writes it', () => {
    t.hasResource('AWS::SecretsManager::Secret', { Properties: { Name: 'tr/gitlab/root', GenerateSecretString: Match.anyValue() }, DeletionPolicy: 'Retain' })
    t.hasResource('AWS::SecretsManager::Secret', { Properties: { Name: 'tr/gitlab/admin-token', SecretString: 'pending' }, DeletionPolicy: 'Retain' })
  })

  it('rotates the agents\' tokens twice a day, with a role that may only touch the agents\' secrets', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'tr-gitlab-token-rotate' })
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(12 hours)' })
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'))
    expect(policies).toContain('secret:tr/gitlab/agents/*')
    expect(policies).toContain('aws:RequestTag/trace:installation')
  })

  it('makes an IAM OIDC provider for GitLab\'s pipeline ID tokens, audience STS', () => {
    t.resourceCountIs('AWS::IAM::OIDCProvider', 1)
    t.hasResourceProperties('AWS::IAM::OIDCProvider', { ClientIdList: ['sts.amazonaws.com'] })
  })

  it('writes its address where the instance reads it: the distribution\'s, or the installation\'s own domain', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/tr/gitlab/external-url', Value: Match.objectLike({ 'Fn::Join': Match.anyValue() }) })
    const own = gitlabTemplate({ name: 'git.trace-eda.com', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/0f0e0d0c-1111-2222-3333-444455556666' })
    own.hasResourceProperties('AWS::SSM::Parameter', { Name: '/tr/gitlab/external-url', Value: 'https://git.trace-eda.com' })
    own.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['git.trace-eda.com'] }) })
  })
})

describe('gitlabUserData', () => {
  const script = gitlabUserData({
    prefix: 'tr', region: 'ap-southeast-2', bucket: 'central-b', volumeId: 'vol-0abc', rootSecret: 'tr/gitlab/root',
    tokenSecret: 'tr/gitlab/admin-token', urlParameter: '/tr/gitlab/external-url', vpcCidr: '10.0.0.0/16',
  })

  it('installs Community Edition behind CloudFront: HTTP inside, no Let\'s Encrypt, no SSH port', () => {
    expect(script).toContain('gitlab-ce')
    expect(script).not.toContain('gitlab-ee')
    expect(script).toContain("nginx['listen_https'] = false")
    expect(script).toContain("letsencrypt['enable'] = false")
    expect(script).toContain("gitlab_rails['gitlab_shell_ssh_port'] = 0")
  })

  it('reads its address from SSM and keeps it in step', () => {
    expect(script).toContain("--name '/tr/gitlab/external-url'")
    expect(script).toContain('trace-gitlab-address.timer')
  })

  it('backs up to the central bucket nightly, with GitLab\'s secrets file', () => {
    expect(script).toContain("'central-b/gitlab-backups'")
    expect(script).toContain('s3://central-b/gitlab-backups/gitlab-secrets.json')
    expect(script).toContain('trace-gitlab-backup.timer')
  })

  it('never writes the root password or the token to disk', () => {
    expect(script).toContain('unset GITLAB_ROOT_PASSWORD')
    expect(script).not.toMatch(/token.*>\s*\/(etc|var|tmp)/)
  })
})

describe('the installation with trace\'s GitLab', () => {
  const base = { account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/board'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

  it('is off by default', () => {
    expect(InfraPropsSchema.parse(base).gitlab).toEqual({ enabled: false, instanceType: 'm7g.large', volumeGb: 100 })
  })

  it('refuses a certificate CloudFront cannot use', () => {
    const r = InfraPropsSchema.safeParse({ ...base, gitlab: { enabled: true, domain: { name: 'git.example.com', certificateArn: 'arn:aws:acm:ap-southeast-2:123456789012:certificate/0f0e0d0c-1111-2222-3333-444455556666' } } })
    expect(r.success).toBe(false)
  })

  it('gives the API GitLab\'s address and admin token, and outputs both', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, gitlab: { enabled: true } }), 'GitlabOn')
    const env = JSON.stringify(s.parent.findResources('AWS::BedrockAgentCore::Runtime'))
    expect(env).toContain('TRACE_GITLAB_URL')
    expect(env).toContain('TRACE_GITLAB_SECRET_ARN')
    expect(Object.keys(s.parent.findOutputs('GitlabUrl'))).toEqual(['GitlabUrl'])
    expect(Object.keys(s.parent.findOutputs('GitlabAdminTokenSecretArn'))).toEqual(['GitlabAdminTokenSecretArn'])
    expect(Object.keys(s.parent.findOutputs('GitlabOidcProviderArn'))).toEqual(['GitlabOidcProviderArn'])
  }, 300_000)

  it('without it, the API has no GitLab at all', () => {
    const s = synth(InfraPropsSchema.parse(base), 'GitlabOff')
    expect(JSON.stringify(s.parent.findResources('AWS::BedrockAgentCore::Runtime'))).not.toContain('TRACE_GITLAB')
    expect(s.parent.findOutputs('GitlabUrl')).toEqual({})
  }, 300_000)

  it('refuses a GitLab project without trace\'s GitLab, or two that would share a path there', () => {
    expect(InfraPropsSchema.safeParse({ ...base, projectSettings: { 'mteichtahl/board': { forge: 'gitlab' } } }).success).toBe(false)
    const two = InfraPropsSchema.safeParse({
      ...base, repositories: ['mteichtahl/board', 'acme/board'], gitlab: { enabled: true },
      projectSettings: { 'mteichtahl/board': { forge: 'gitlab' }, 'acme/board': { forge: 'gitlab' } },
    })
    expect(two.success).toBe(false)
    expect(JSON.stringify(two.error?.issues)).toContain('would both be trace/board')
  })

  it('gives a project on trace\'s GitLab a role its default branch\'s pipelines assume with GitLab\'s ID token, and its own agents\' token', () => {
    const cfg = InfraPropsSchema.parse({ ...base, repositories: ['mteichtahl/board', 'mteichtahl/other'], gitlab: { enabled: true }, projectSettings: { 'mteichtahl/board': { forge: 'gitlab' } } })
    const s = synth(cfg, 'GitlabProject')
    const all = JSON.stringify(s.all.toJSON())
    expect(all).toContain('project_path:trace/board:ref_type:branch:ref:main')
    expect(all).toContain('secret:trace/gitlab/agents/board-??????')
    expect(all).not.toContain('trace/gitlab/agents/other')
    const env = JSON.stringify(s.parent.findResources('AWS::BedrockAgentCore::Runtime'))
    expect(env).toMatch(/TRACE_GITLAB_REPOS":"mteichtahl\/board"/)
  }, 300_000)
})

