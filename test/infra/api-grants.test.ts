import { App, Stack } from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { describe, expect, it } from 'vitest'
import { grantApiRuntime } from '../../src/infra/api-grants.js'

/** The chat statements (CreateEvent) of the people's API role, in a stack of `region`. */
function chatResources(region: string): unknown[] {
  const stack = new Stack(new App(), `Grants${region.replace(/-/g, '')}`, { env: { account: '123456789012', region } })
  const role = new iam.Role(stack, 'ApiRole', { assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com') })
  grantApiRuntime(role, {
    scope: stack, runtimeName: 'trace_api', region, account: '123456789012', partition: stack.partition, prefix: 'trace', installationTag: 'trace:installation',
    images: new ecr.Repository(stack, 'Images'), central: new s3.Bucket(stack, 'Central'), githubToken: new secrets.Secret(stack, 'Token'),
    workers: [], memories: [], chatMemories: [{ repository: 'mteichtahl/trace', name: 'trace_m_0123abcd' }], knowledgeBases: [], orderWatchArn: 'arn:aws:lambda:x:1:function:w',
  }, { people: true })
  const doc = stack.resolve((role.node.tryFindChild('DefaultPolicy') as iam.Policy).document) as { Statement: { Action: unknown; Resource: unknown }[] }
  return doc.Statement.filter((s) => s.Action === 'bedrock-agentcore:CreateEvent').map((s) => s.Resource)
}

describe("the people's API role's chat events", () => {
  it("name each project's memory in the region's own partition, not always aws", () => {
    expect(chatResources('us-east-1')).toEqual(['arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/trace_m_0123abcd-*'])
    expect(chatResources('cn-north-1')).toEqual(['arn:aws-cn:bedrock-agentcore:cn-north-1:123456789012:memory/trace_m_0123abcd-*'])
    expect(chatResources('us-gov-west-1')).toEqual(['arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:123456789012:memory/trace_m_0123abcd-*'])
  })
})
