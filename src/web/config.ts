/**
 * The web backend's settings: one SSM parameter, `/<prefix>/web/config` (its name in TRACE_WEB_CONFIG_PARAM), JSON.
 * Read once per Lambda container and kept; a failed read is not kept, so the next request tries again. Nothing in it
 * is secret: GET /api/config hands the app the public part.
 *
 *   region, prefix          the installation
 *   userPoolId, clientId    the user pool and the web app client (no client secret: public sign-in calls)
 *   apiRuntimeArn           the API runtime (AgentCore), called with the person's bearer token
 *   events                  AppSync Events: http and realtime DNS names, the API id
 *   voiceBucket/Prefix      where Polly's speech is cached
 *   dashboards              the CloudWatch dashboards Operations shows
 *   model                   the Bedrock model or inference profile for the chat agent (default below)
 *   features                passkeys, email, voice, ops
 */
import { z } from 'zod'

export const DEFAULT_MODEL = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'

export const WebConfig = z.object({
  region: z.string().min(1),
  prefix: z.string().min(1),
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  apiRuntimeArn: z.string().min(1),
  events: z.object({ http: z.string().min(1), realtime: z.string().min(1), apiId: z.string().min(1) }),
  voiceBucket: z.string().min(1),
  voicePrefix: z.string().default('voice'),
  dashboards: z.array(z.string().min(1)).default([]),
  model: z.string().min(3).default(DEFAULT_MODEL),
  features: z.object({
    passkeys: z.boolean().default(true),
    email: z.boolean().default(true),
    voice: z.boolean().default(true),
    ops: z.boolean().default(true),
  }).default({ passkeys: true, email: true, voice: true, ops: true }),
})
export type WebConfig = z.output<typeof WebConfig>

/** The issuer of the pool's tokens. */
export const issuerOf = (c: Pick<WebConfig, 'region' | 'userPoolId'>): string => `https://cognito-idp.${c.region}.amazonaws.com/${c.userPoolId}`

/** What the app may know (GET /api/config): no ARNs, no bucket. */
export function publicConfig(c: WebConfig): Record<string, unknown> {
  return {
    region: c.region, prefix: c.prefix, userPoolId: c.userPoolId, clientId: c.clientId,
    events: { http: c.events.http, realtime: c.events.realtime }, features: c.features,
  }
}

export type ParameterReader = (name: string) => Promise<string>

/** A cached loader: the parameter is read on first use and kept for the life of the container. */
export function configLoader(read: ParameterReader, name: string): () => Promise<WebConfig> {
  let pending: Promise<WebConfig> | null = null
  return () => {
    pending ??= (async () => WebConfig.parse(JSON.parse(await read(name))))().catch((e: unknown) => { pending = null; throw e })
    return pending
  }
}

/** SSM GetParameter (the SDK is loaded on first use). */
export const ssmReader = (region?: string): ParameterReader => async (name) => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
  const r = await new SSMClient(region ? { region } : {}).send(new GetParameterCommand({ Name: name }))
  const v = r.Parameter?.Value
  if (!v) throw new Error(`the parameter ${name} is empty`)
  return v
}
