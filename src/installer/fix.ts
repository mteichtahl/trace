/**
 * What the installer can fix itself when the preflight finds it (src/installer/preflight.ts), run only when the
 * person presses the finding's button (POST /api/fix):
 *
 *   bedrock-use-case     Anthropic's first-time-use form (PutUseCaseForModelAccess): the person's own answers
 *   bedrock-agreement    the model's agreement (ListFoundationModelAgreementOffers, CreateFoundationModelAgreement)
 *   quota-increase       a Service Quotas increase request (RequestServiceQuotaIncrease)
 *   delete-failed-stack  the trace stack after a failed first deploy (ROLLBACK_COMPLETE), which cannot be updated
 *   continue-rollback    the trace stack stuck in UPDATE_ROLLBACK_FAILED (ContinueUpdateRollback)
 *   delete-cognito-domain  a removed installation's Cognito domain `<prefix>-<account>` (DeleteUserPoolDomain; its
 *                        user pool and users stay), which a new installation's pool needs
 *   share-source         trace's own private repository's actions, shared with its owner's repositories
 *   clear-leftovers      a removed installation's kept image repositories and token secret (preflight leftoverNames)
 *   delete-tools-repository  the `<prefix>-tools` ECR repository a failed deploy left behind (it is not the stack's:
 *                        preflight toolsLeftover), which the next deploy would collide with
 */
import type { AwsCredentialIdentity } from '@smithy/types'
import { z } from 'zod'
import { SOURCE } from '../core/onboard.js'

/** Anthropic's use-case form (the Bedrock model access documentation's fields and limits). */
export const UseCaseForm = z.object({
  companyName: z.string().trim().min(1).max(128),
  companyWebsite: z.string().trim().min(1).max(128),
  /** 0 internal, 1 external, 2 both */
  intendedUsers: z.enum(['0', '1', '2']),
  industryOption: z.string().trim().min(1).max(128),
  otherIndustryOption: z.string().trim().max(128).default(''),
  useCases: z.string().trim().min(1).max(8192),
}).strict()

export const FixRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bedrock-use-case'), form: UseCaseForm }),
  z.object({ action: z.literal('bedrock-agreement'), model: z.string().regex(/^[a-z0-9-]+\.[a-z0-9.:-]+$/) }),
  z.object({ action: z.literal('quota-increase'), service: z.enum(['ec2', 'vpc']), code: z.string().regex(/^L-[0-9A-F]{8}$/), value: z.number().int().min(1).max(100_000) }),
  z.object({ action: z.literal('delete-failed-stack'), stack: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/) }),
  z.object({ action: z.literal('continue-rollback'), stack: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/) }),
  z.object({ action: z.literal('delete-cognito-domain'), domain: z.string().regex(/^[a-z0-9-]{1,63}$/), userPoolId: z.string().regex(/^[\w-]+_[0-9a-zA-Z]+$/) }),
  z.object({ action: z.literal('share-source') }),
  z.object({ action: z.literal('clear-leftovers'), prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/) }),
  z.object({ action: z.literal('delete-tools-repository'), prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/) }),
])
export type FixRequest = z.infer<typeof FixRequest>

export async function fix(r: FixRequest, ctx: { creds: AwsCredentialIdentity; region: string; token: string }): Promise<string> {
  const cfg = { region: ctx.region, credentials: ctx.creds }
  switch (r.action) {
    case 'bedrock-use-case': {
      const b = await import('@aws-sdk/client-bedrock')
      await new b.BedrockClient(cfg).send(new b.PutUseCaseForModelAccessCommand({ formData: new TextEncoder().encode(JSON.stringify(r.form)) }))
      return 'Submitted. Access is usually granted within minutes (AWS emails when the agreement is set up); the installer does not need to wait for it.'
    }
    case 'bedrock-agreement': {
      const b = await import('@aws-sdk/client-bedrock')
      const c = new b.BedrockClient(cfg)
      const offers = (await c.send(new b.ListFoundationModelAgreementOffersCommand({ modelId: r.model, offerType: 'PUBLIC' }))).offers ?? []
      const token = offers[0]?.offerToken
      if (!token) throw new Error(`${r.model} has no public offer to accept here: its access is enabled on first use (the agents' first call), with the use-case form sent`)
      await c.send(new b.CreateFoundationModelAgreementCommand({ modelId: r.model, offerToken: token }))
      return `Accepted ${r.model}'s agreement; access follows within minutes.`
    }
    case 'quota-increase': {
      const { signedCaller, serviceQuotas } = await import('./signed.js')
      const res = await signedCaller(ctx.creds, ctx.region)(serviceQuotas(ctx.region, 'RequestServiceQuotaIncrease', { ServiceCode: r.service, QuotaCode: r.code, DesiredValue: r.value }))
      const req = res.RequestedQuota as { Id?: string; Status?: string } | undefined
      return `Requested ${r.value} (${r.code}): ${req?.Status ?? 'PENDING'}${req?.Id ? `, request ${req.Id}` : ''}. AWS usually answers within a day; run the installer again afterwards to turn on what it allows.`
    }
    case 'delete-failed-stack': {
      const cfn = await import('@aws-sdk/client-cloudformation')
      const c = new cfn.CloudFormationClient(cfg)
      const s = (await c.send(new cfn.DescribeStacksCommand({ StackName: r.stack }))).Stacks?.[0]
      if (!s || !['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED'].includes(s.StackStatus ?? '')) throw new Error(`${r.stack} is ${s?.StackStatus ?? 'gone'}: only a stack whose first deploy failed is deleted here`)
      await c.send(new cfn.DeleteStackCommand({ StackName: r.stack }))
      return `Deleting ${r.stack} (a few minutes); check again when it is gone.`
    }
    case 'continue-rollback': {
      const cfn = await import('@aws-sdk/client-cloudformation')
      const c = new cfn.CloudFormationClient(cfg)
      const st = (await c.send(new cfn.DescribeStacksCommand({ StackName: r.stack }))).Stacks?.[0]?.StackStatus
      if (st !== 'UPDATE_ROLLBACK_FAILED') throw new Error(`${r.stack} is ${st ?? 'gone'}: only a stack in UPDATE_ROLLBACK_FAILED is rolled on here`)
      await c.send(new cfn.ContinueUpdateRollbackCommand({ StackName: r.stack }))
      return `Continuing ${r.stack}'s rollback (a few minutes); check again when it is UPDATE_ROLLBACK_COMPLETE.`
    }
    case 'delete-cognito-domain': {
      const cog = await import('@aws-sdk/client-cognito-identity-provider')
      const c = new cog.CognitoIdentityProviderClient(cfg)
      const d = (await c.send(new cog.DescribeUserPoolDomainCommand({ Domain: r.domain }))).DomainDescription
      if (d?.UserPoolId !== r.userPoolId) throw new Error(`the domain ${r.domain} is not user pool ${r.userPoolId}'s any more: check again`)
      await c.send(new cog.DeleteUserPoolDomainCommand({ Domain: r.domain, UserPoolId: r.userPoolId }))
      return `Deleted the domain ${r.domain} (the user pool ${r.userPoolId} and its users stay). Check again.`
    }
    case 'share-source': {
      const { shareSource } = await import('./github.js')
      await shareSource(ctx.token, SOURCE)
      return `${SOURCE}'s actions are now usable from repositories of the same owner.`
    }
    case 'clear-leftovers': {
      const [{ signedCaller, ecr }, sm] = await Promise.all([import('./signed.js'), import('@aws-sdk/client-secrets-manager')])
      const call = signedCaller(ctx.creds, ctx.region)
      const done: string[] = []
      for (const name of [`${r.prefix}-agent`, `${r.prefix}-gpu`, `${r.prefix}-tools`]) {
        try { await call(ecr(ctx.region, 'DeleteRepository', { repositoryName: name, force: true })); done.push(`deleted the ECR repository ${name}`) } catch { /* not there */ }
      }
      try {
        await new sm.SecretsManagerClient(cfg).send(new sm.DeleteSecretCommand({ SecretId: `${r.prefix}/github-token`, ForceDeleteWithoutRecovery: true }))
        done.push(`deleted the secret ${r.prefix}/github-token`)
      } catch { /* not there */ }
      return done.length ? `${done.join('; ')}. Check again.` : 'nothing was left to delete'
    }
    case 'delete-tools-repository': {
      const { signedCaller, ecr } = await import('./signed.js')
      const call = signedCaller(ctx.creds, ctx.region)
      const name = `${r.prefix}-tools`
      // its images are the tools image only, which the deploy copies or builds again
      await call(ecr(ctx.region, 'DeleteRepository', { repositoryName: name, force: true }))
      return `Deleted the ECR repository ${name}. Check again.`
    }
  }
}
