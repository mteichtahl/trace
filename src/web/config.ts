/**
 * The web backend's settings: one SSM parameter, `/<prefix>/web/config` (its name in TRACE_WEB_CONFIG_PARAM), JSON.
 * Read on first use and again after `ttlMs` (awsDeps: a minute, so a deploy's apiBuild arrives soon); a failed read is
 * not kept: the last good settings are used, or the next request tries again. Nothing in it
 * is secret: GET /api/config hands the app the public part.
 *
 *   region, prefix          the installation
 *   userPoolId, clientId    the user pool and the web app client (no client secret: public sign-in calls)
 *   apiRuntimeArn           the API runtime (AgentCore), called with the person's bearer token
 *   apiBuild                the API's build and runtime version, part of each person's runtime session
 *                           (src/web/call.ts runtimeSession). It is here, and not in the function's environment, because
 *                           this parameter is updated only after the API runtime is: a session named for a new build
 *                           must not start on the old version, which would keep it for hours
 *   events                  AppSync Events: http and realtime DNS names, the API id
 *   voiceBucket/Prefix      where Polly's speech is cached
 *   dashboards              the CloudWatch dashboards Operations shows
 *   model                   the Bedrock model or inference profile for the chat agent (default below)
 *   features                passkeys, email, voice, ops
 *   waf                     whether AWS WAF is in front of the app, and its limits per address (shown on Admin)
 *   hooks                   GitHub's webhook (web.hooks, src/web/hooks.ts): the webhook secret's name, the backend's
 *                           own client secret's name (two secrets, both written by the installer: the self-update may
 *                           read the first only), the pool's token address, the backend's own app client and scope,
 *                           and the debounce table. Absent: no live updates from GitHub (the app polls)
 */
import { z } from 'zod'

export const DEFAULT_MODEL = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'

export const WebConfig = z.object({
  region: z.string().min(1),
  prefix: z.string().min(1),
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  apiRuntimeArn: z.string().min(1),
  apiBuild: z.string().min(1).optional(),
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
  /** the app's AWS WAF (src/infra/edge.ts): whether one is in front of it, and its limits; absent: an older stack */
  waf: z.object({ enabled: z.boolean(), own: z.boolean().default(false), apiRequestsPer5Minutes: z.number(), authRequestsPer5Minutes: z.number() }).optional(),
  hooks: z.object({
    secret: z.string().min(1), clientSecret: z.string().min(1).optional(), tokenUrl: z.string().url(), clientId: z.string().min(1), scope: z.string().min(1), table: z.string().min(1).optional(),
  }).optional(),
})
export type WebConfig = z.output<typeof WebConfig>

/** The issuer of the pool's tokens. */
export const issuerOf = (c: Pick<WebConfig, 'region' | 'userPoolId'>): string => `https://cognito-idp.${c.region}.amazonaws.com/${c.userPoolId}`

/** What the app may know (GET /api/config): no ARNs, no bucket. */
export function publicConfig(c: WebConfig): Record<string, unknown> {
  return {
    region: c.region, prefix: c.prefix, userPoolId: c.userPoolId, clientId: c.clientId,
    events: { http: c.events.http, realtime: c.events.realtime }, features: c.features,
    ...(c.waf ? { waf: c.waf } : {}),
  }
}

export type ParameterReader = (name: string) => Promise<string>

/**
 * A cached loader: the parameter is read on first use and kept, for `ttlMs` when given (otherwise for the life of the
 * container). A read that fails keeps the last good settings when there are some; without any, it is not kept, so
 * the next call tries again.
 */
export function configLoader(read: ParameterReader, name: string, o: { ttlMs?: number; now?: () => number } = {}): () => Promise<WebConfig> {
  const now = o.now ?? Date.now
  let pending: Promise<WebConfig> | null = null
  let good: WebConfig | null = null
  let at = 0
  return () => {
    if (pending && o.ttlMs !== undefined && good && now() - at >= o.ttlMs) pending = null
    pending ??= (async () => {
      at = now()
      const c = WebConfig.parse(JSON.parse(await read(name)))
      good = c
      return c
    })().catch((e: unknown) => {
      if (good) return good
      pending = null
      throw e
    })
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
