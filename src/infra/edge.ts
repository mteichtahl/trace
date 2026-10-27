/**
 * The web app's AWS WAF (web.waf; README "Web app"): a WAFv2 web ACL of CLOUDFRONT scope in front of the app's one
 * address. CloudFront takes only a web ACL made in us-east-1, so where it is made depends on the installation's region:
 *
 *   us-east-1        in the web app's own nested stack (src/infra/web.ts), beside the distribution
 *   any other        in a small stack of its own, `<prefix>-edge` in us-east-1 (TraceEdgeStack, from the same CDK app:
 *                    src/infra/app.ts). The installer and the self-update deploy it first, read its output
 *                    (EDGE_ACL_OUTPUT) and deploy the main stack with it as web.waf.aclArn. That was chosen over CDK's
 *                    crossRegionReferences, which writes the ARN to SSM in us-east-1 and reads it back with a custom
 *                    resource (a Lambda and its role in the main stack, and an SSM parameter the two stacks then hold
 *                    each other to); passing one ARN between two deploys needs neither, and a failed edge deploy leaves
 *                    the main stack with the ACL it had
 *
 * The rules, in order (WCUs about 950 of the 1,500 a web ACL has before requests cost more):
 *
 *   1 BodyTooLarge      a request to /api/* whose Content-Length is 5,000,000 bytes or more is blocked. At CloudFront WAF
 *                       inspects at most 64 KB of a body, so the size is read from the header; the backend's own limits
 *                       (1 MB for /api/call, 4 MB for a chat) stay, and catch a body sent without one
 *   2 AuthRate          at most authRequestsPer5Minutes (100) requests to /api/auth/* per address in 5 minutes: sign-in
 *                       is the one unauthenticated part, and each try costs a Cognito call (and an email with SES)
 *   3 ApiRate           at most apiRequestsPer5Minutes (1,000) requests to /api/* per address in 5 minutes
 *   4 IpReputation      AWS's Amazon IP reputation list (known bots, scanners)
 *   5 KnownBadInputs    AWS's known bad inputs (Log4j, Java deserialization, …)
 *   6 Common            AWS's core rule set, with two of its rules only counted: SizeRestrictions_BODY (it blocks any
 *                       body over 8 KB: a chat or a prompt is larger) and CrossSiteScripting_BODY (people paste HTML and
 *                       code into chat; the app renders no HTML from them and its content security policy runs no
 *                       inline script)
 *
 * Blocked requests answer 403 (rate rules 429). Every rule has CloudWatch metrics and sampled requests.
 *
 * Cost (AWS WAF pricing, us-east-1): US$5 a month for the web ACL and US$1 for each rule or managed rule group (six),
 * so US$11 a month, plus US$0.60 per million requests (EDGE_COST).
 */
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import { Construct } from 'constructs'
import type { InfraProps } from './props.js'

/** CloudFront's region: a CLOUDFRONT-scope web ACL is made here. */
export const EDGE_REGION = 'us-east-1'
/** The edge stack's output: the web ACL's ARN, which the main stack is deployed with (web.waf.aclArn). */
export const EDGE_ACL_OUTPUT = 'WebAclArn'
export const edgeStackName = (prefix: string): string => `${prefix}-edge`
/** The web ACL's name. */
export const webAclName = (prefix: string): string => `${prefix}-web`
/** Requests at or above this Content-Length are refused (the chat's 4 MB limit, and some room). */
export const MAX_BODY_BYTES = 5_000_000
/** Content-Length values of MAX_BODY_BYTES or more: eight digits or more, or seven starting 5 to 9. */
export const BODY_TOO_LARGE = '^(\\d{8,}|[5-9]\\d{6})$'
/** What the web ACL costs (USD): a month, and per million requests. */
export const EDGE_COST = { monthly: 11, perMillion: 0.6 } as const

/** Whether the app gets the WAF this stack makes (not when web.webAclArn names one of the person's own). */
export const wafEnabled = (cfg: Pick<InfraProps, 'web'>): boolean => cfg.web.enabled && cfg.web.waf.enabled && !cfg.web.webAclArn
/** Whether the WAF is in a stack of its own in us-east-1 (the installation is elsewhere). */
export const edgeNeeded = (cfg: Pick<InfraProps, 'web' | 'region'>): boolean => wafEnabled(cfg) && cfg.region !== EDGE_REGION

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName })
const startsWith = (path: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: path, textTransformations: [{ priority: 0, type: 'NONE' }] },
})
const managed = (name: string, priority: number, metric: string, count: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
  name: metric, priority, overrideAction: { none: {} }, visibilityConfig: visibility(`${metric}`),
  statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ...(count.length ? { ruleActionOverrides: count.map((r) => ({ name: r, actionToUse: { count: {} } })) } : {}) } },
})

/** The web ACL (see the file's comment). */
export class TraceWebAcl extends Construct {
  readonly acl: wafv2.CfnWebACL

  constructor(scope: Construct, id: string, p: { prefix: string; waf: InfraProps['web']['waf'] }) {
    super(scope, id)
    const tooMany = { customResponse: { responseCode: 429 } }
    this.acl = new wafv2.CfnWebACL(this, 'Acl', {
      name: webAclName(p.prefix),
      description: `trace web app (${p.prefix}): AWS's managed rules, rate limits per address, and a request size limit`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${p.prefix}-web`),
      rules: [
        {
          name: 'BodyTooLarge', priority: 1, action: { block: {} }, visibilityConfig: visibility('BodyTooLarge'),
          statement: {
            andStatement: {
              statements: [
                startsWith('/api/'),
                { regexMatchStatement: { fieldToMatch: { singleHeader: { Name: 'content-length' } }, regexString: BODY_TOO_LARGE, textTransformations: [{ priority: 0, type: 'NONE' }] } },
              ],
            },
          },
        },
        {
          name: 'AuthRate', priority: 2, action: { block: tooMany }, visibilityConfig: visibility('AuthRate'),
          statement: { rateBasedStatement: { limit: p.waf.authRequestsPer5Minutes, evaluationWindowSec: 300, aggregateKeyType: 'IP', scopeDownStatement: startsWith('/api/auth/') } },
        },
        {
          name: 'ApiRate', priority: 3, action: { block: tooMany }, visibilityConfig: visibility('ApiRate'),
          statement: { rateBasedStatement: { limit: p.waf.apiRequestsPer5Minutes, evaluationWindowSec: 300, aggregateKeyType: 'IP', scopeDownStatement: startsWith('/api/') } },
        },
        managed('AWSManagedRulesAmazonIpReputationList', 4, 'IpReputation'),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 5, 'KnownBadInputs'),
        managed('AWSManagedRulesCommonRuleSet', 6, 'Common', ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY']),
      ],
    })
  }

  get arn(): string { return this.acl.attrArn }
}

/** `<prefix>-edge`, in us-east-1: the web ACL alone, and its ARN as an output. */
export class TraceEdgeStack extends Stack {
  readonly webAcl: TraceWebAcl

  constructor(scope: Construct, cfg: InfraProps, props: StackProps = {}) {
    super(scope, edgeStackName(cfg.prefix), {
      ...props, stackName: edgeStackName(cfg.prefix), env: { account: cfg.account, region: EDGE_REGION },
      description: `trace (${cfg.prefix}): the web app's AWS WAF web ACL (CloudFront takes web ACLs from ${EDGE_REGION} only)`,
    })
    this.webAcl = new TraceWebAcl(this, 'Waf', { prefix: cfg.prefix, waf: cfg.web.waf })
    new CfnOutput(this, EDGE_ACL_OUTPUT, { value: this.webAcl.arn, description: `The web app's web ACL: the main stack's web.waf.aclArn` })
  }
}
