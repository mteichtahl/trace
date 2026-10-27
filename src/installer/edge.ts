/**
 * The web app's WAF outside us-east-1 (src/infra/edge.ts): the stack `<prefix>-edge` in us-east-1, deployed before the
 * main stack by the installer (src/installer/bootstrap.ts) and the self-update (src/installer/update.ts), and its
 * WebAclArn output passed to the main stack as web.waf.aclArn. Its own small step, so both tools share it:
 *
 *   1 bootstrap  CDK in us-east-1 when it is not there (version 6 or later), the installer only: the self-update role
 *                cannot create the CDKToolkit stack, so without it the self-update keeps the ACL it had and says so
 *   2 deploy     `cdk deploy <prefix>-edge` from the same app and settings as the main stack
 *   3 output     its WebAclArn
 *
 * A failure never stops the main deploy: the main stack is deployed with the ACL it had before (the saved settings'
 * web.waf.aclArn), and the run says what to do. Turning the WAF off (or moving to us-east-1, where the ACL is in the
 * web app's own stack) leaves `<prefix>-edge` unused: the installer deletes it after the main deploy, once nothing
 * points at its ACL.
 */
import { type InfraInput, type InfraProps, InfraPropsSchema } from '../infra/props.js'
import { EDGE_ACL_OUTPUT, EDGE_COST, EDGE_REGION, edgeNeeded, edgeStackName, wafEnabled } from '../infra/edge.js'

export interface EdgeDeps {
  /** `cdk …` with these environment variables; its exit code */
  cdk: (args: string[], env: Record<string, string>, onLine: (l: string) => void) => Promise<number>
  /** a stack's outputs in a region, or null when there is no such stack */
  outputs: (stack: string, region: string) => Promise<Record<string, string> | null>
  log: (line: string) => void
}

export interface EdgeResult {
  /** the ACL the main stack is deployed with (null: none) */
  aclArn: string | null
  /** what happened, in a line for the plan, the log and the summary */
  note: string | null
  ok: boolean
}

/** The settings with web.waf.aclArn set (or removed with null). */
export function withAcl(input: InfraInput, aclArn: string | null): InfraInput {
  const web = (input.web ?? {}) as NonNullable<InfraInput['web']>
  const now = (web as { waf?: Record<string, unknown> }).waf
  if (!aclArn && !now?.aclArn) return input
  const waf = { ...(now ?? {}) }
  if (aclArn) waf.aclArn = aclArn
  else delete waf.aclArn
  return { ...input, web: { ...web, waf } } as InfraInput
}

/** Said in the plan about the WAF: what it is, where it is made, and what it costs. */
export function wafPlan(props: InfraProps): string {
  if (!props.web.enabled) return ''
  if (props.web.webAclArn) return `, behind your web ACL ${props.web.webAclArn}`
  if (!wafEnabled(props)) return ', without AWS WAF (Advanced › Web app turns it on)'
  const where = props.region === EDGE_REGION ? 'in the web app\'s stack' : `in its own small stack ${edgeStackName(props.prefix)} in ${EDGE_REGION} (CloudFront takes web ACLs from there only), deployed first`
  return `, protected by AWS WAF ${where}: AWS's managed rules, at most ${props.web.waf.apiRequestsPer5Minutes} requests to the API and ${props.web.waf.authRequestsPer5Minutes} sign-in requests per address in 5 minutes, and no request body over 5 MB (about US$${EDGE_COST.monthly} a month and US$${EDGE_COST.perMillion.toFixed(2)} per million requests)`
}

/**
 * Deploy `<prefix>-edge` when the settings need it, and answer the ACL to deploy the main stack with. `env` is the
 * main deploy's environment (credentials and TRACE_INFRA); `bootstrap`: whether this caller may bootstrap CDK there.
 */
export async function deployEdge(o: { input: InfraInput; account: string; app: readonly string[]; env: Record<string, string>; bootstrap: boolean; deps: EdgeDeps }): Promise<EdgeResult> {
  const props = InfraPropsSchema.parse(o.input)
  if (!edgeNeeded(props)) return { aclArn: props.web.waf.aclArn ?? null, note: null, ok: true }
  const stack = edgeStackName(props.prefix)
  // the ACL the app has now: the settings', else the edge stack's own output (the installer's settings are rebuilt
  // from its answers, which do not carry it)
  let had = props.web.waf.aclArn ?? null
  if (!had) { try { had = (await o.deps.outputs(stack, EDGE_REGION))?.[EDGE_ACL_OUTPUT] ?? null } catch { /* none known */ } }
  const keep = (why: string): EdgeResult => ({
    aclArn: had, ok: false,
    note: `The web app's AWS WAF was not ${had ? 'updated' : 'set up'}: ${why}. ${had ? 'The app keeps the web ACL it had.' : 'The app has no WAF until it is.'} Run the installer again to carry on.`,
  })
  try {
    const toolkit = await o.deps.outputs('CDKToolkit', EDGE_REGION)
    if (!toolkit || Number(toolkit.BootstrapVersion ?? 0) < 6) {
      if (!o.bootstrap) return keep(`CDK is not bootstrapped in ${EDGE_REGION}, and this job may not bootstrap it`)
      o.deps.log(`bootstrapping CDK in ${EDGE_REGION} for ${stack} (CloudFront takes web ACLs from there only)`)
      const code = await o.deps.cdk(['bootstrap', `aws://${o.account}/${EDGE_REGION}`, ...o.app], o.env, o.deps.log)
      if (code !== 0) return keep(`cdk bootstrap in ${EDGE_REGION} exited ${code}`)
    }
    o.deps.log(`deploying ${stack} in ${EDGE_REGION}: the web app's web ACL`)
    const code = await o.deps.cdk(['deploy', stack, ...o.app, '--require-approval', 'never', '--progress', 'events'], { ...o.env, TRACE_INFRA: JSON.stringify(o.input) }, o.deps.log)
    if (code !== 0) return keep(`cdk deploy ${stack} exited ${code}`)
    const arn = (await o.deps.outputs(stack, EDGE_REGION))?.[EDGE_ACL_OUTPUT]
    if (!arn) return keep(`${stack} has no output ${EDGE_ACL_OUTPUT}`)
    return { aclArn: arn, ok: true, note: `The web app is behind AWS WAF (${stack} in ${EDGE_REGION}).` }
  } catch (e) {
    return keep(e instanceof Error ? e.message.slice(0, 300) : String(e))
  }
}

/** Whether `<prefix>-edge` is left over (the WAF is off, or the installation is in us-east-1 now) and may be deleted. */
export const edgeLeftOver = (props: InfraProps, exists: boolean): boolean => exists && !edgeNeeded(props)
