/**
 * The production ports (src/web/ports.ts): one AWS SDK v3 client each, made on first use and kept for the container.
 * Cognito's user-pool calls are public (no IAM): the client signs nothing it does not have to, and the calls that act
 * for a person carry their access token in the request. Everything else runs as the Lambda's role.
 */
import {
  AssociateSoftwareTokenCommand, CognitoIdentityProviderClient, CompleteWebAuthnRegistrationCommand,
  ConfirmForgotPasswordCommand, DeleteWebAuthnCredentialCommand, ForgotPasswordCommand, InitiateAuthCommand,
  ListWebAuthnCredentialsCommand, RespondToAuthChallengeCommand, RevokeTokenCommand, SetUserMFAPreferenceCommand,
  StartWebAuthnRegistrationCommand, VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly'
import { CloudWatchClient, DescribeAlarmsCommand, GetDashboardCommand, GetMetricDataCommand, type MetricAlarm, type MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { Verifier } from '../api/jwt.js'
import { configLoader, issuerOf, ssmReader } from './config.js'
import { type WebDeps, once } from './deps.js'
import { DynamoDebounceStore } from './hooks-store.js'
import type { BedrockPort, CloudWatchPort, CognitoPort, PollyPort, SecretsPort, StorePort } from './ports.js'

export function cognitoPort(region: string): CognitoPort {
  const c = new CognitoIdentityProviderClient({ region })
  return {
    initiateAuth: (i) => c.send(new InitiateAuthCommand(i)),
    respondToAuthChallenge: (i) => c.send(new RespondToAuthChallengeCommand(i)),
    revokeToken: async (i) => { await c.send(new RevokeTokenCommand(i)) },
    forgotPassword: async (i) => { await c.send(new ForgotPasswordCommand(i)) },
    confirmForgotPassword: async (i) => { await c.send(new ConfirmForgotPasswordCommand(i)) },
    startWebAuthnRegistration: (i) => c.send(new StartWebAuthnRegistrationCommand(i)),
    completeWebAuthnRegistration: async (i) => { await c.send(new CompleteWebAuthnRegistrationCommand(i)) },
    listWebAuthnCredentials: (i) => c.send(new ListWebAuthnCredentialsCommand(i)),
    deleteWebAuthnCredential: async (i) => { await c.send(new DeleteWebAuthnCredentialCommand(i)) },
    associateSoftwareToken: (i) => c.send(new AssociateSoftwareTokenCommand(i)),
    verifySoftwareToken: (i) => c.send(new VerifySoftwareTokenCommand(i)),
    setUserMfaPreference: async (i) => { await c.send(new SetUserMFAPreferenceCommand(i)) },
  }
}

export function bedrockPort(region: string): BedrockPort {
  const c = new BedrockRuntimeClient({ region })
  return {
    async *converseStream(i, signal) {
      const out = await c.send(new ConverseStreamCommand(i), signal ? { abortSignal: signal } : {})
      if (out.stream) yield* out.stream
    },
  }
}

export function pollyPort(region: string): PollyPort {
  const c = new PollyClient({ region })
  return {
    async describeVoices(i) {
      const voices = []
      let next: string | undefined
      do {
        const out = await c.send(new DescribeVoicesCommand({ ...i, ...(next ? { NextToken: next } : {}) }))
        voices.push(...(out.Voices ?? []))
        next = out.NextToken
      } while (next)
      return voices
    },
    async synthesize(i) {
      const out = await c.send(new SynthesizeSpeechCommand(i))
      if (!out.AudioStream) throw new Error('Polly answered without audio')
      return out.AudioStream.transformToByteArray()
    },
  }
}

export function storePort(region: string): StorePort {
  const c = new S3Client({ region })
  return {
    async exists(Bucket, Key) {
      try {
        await c.send(new HeadObjectCommand({ Bucket, Key }))
        return true
      } catch (e) {
        if (e instanceof Error && (e.name === 'NotFound' || e.name === 'NoSuchKey')) return false
        throw e
      }
    },
    async getText(Bucket, Key) {
      const out = await c.send(new GetObjectCommand({ Bucket, Key }))
      return out.Body ? out.Body.transformToString('utf8') : ''
    },
    async put(Bucket, Key, Body, ContentType) { await c.send(new PutObjectCommand({ Bucket, Key, Body, ContentType })) },
    presignGet: (Bucket, Key, expiresIn) => getSignedUrl(c, new GetObjectCommand({ Bucket, Key }), { expiresIn }),
  }
}

export function cloudwatchPort(region: string): CloudWatchPort {
  const c = new CloudWatchClient({ region })
  return {
    async getDashboard(DashboardName) {
      const out = await c.send(new GetDashboardCommand({ DashboardName }))
      return out.DashboardBody ?? '{"widgets":[]}'
    },
    async getMetricData(MetricDataQueries, StartTime, EndTime) {
      const results = new Map<string, MetricDataResult>()
      let next: string | undefined
      do {
        const out = await c.send(new GetMetricDataCommand({ MetricDataQueries, StartTime, EndTime, ScanBy: 'TimestampAscending', ...(next ? { NextToken: next } : {}) }))
        for (const r of out.MetricDataResults ?? []) {
          // a SEARCH answers many series under ids of its own; a page continues a series under the same id and label
          const key = `${r.Id ?? ''}|${r.Label ?? ''}`
          const had = results.get(key)
          if (had) {
            had.Timestamps = [...(had.Timestamps ?? []), ...(r.Timestamps ?? [])]
            had.Values = [...(had.Values ?? []), ...(r.Values ?? [])]
          } else {
            results.set(key, { ...r })
          }
        }
        next = out.NextToken
      } while (next)
      return [...results.values()]
    },
    async describeAlarms(prefix) {
      const alarms: MetricAlarm[] = []
      for (const StateValue of ['ALARM', 'INSUFFICIENT_DATA'] as const) {
        let next: string | undefined
        do {
          const out = await c.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix, StateValue, AlarmTypes: ['MetricAlarm'], ...(next ? { NextToken: next } : {}) }))
          alarms.push(...(out.MetricAlarms ?? []))
          next = out.NextToken
        } while (next)
      }
      return alarms
    },
  }
}

export function secretsPort(region: string): SecretsPort {
  const c = new SecretsManagerClient({ region })
  return {
    async get(SecretId) {
      const out = await c.send(new GetSecretValueCommand({ SecretId }))
      if (!out.SecretString) throw new Error('the secret is empty')
      return out.SecretString
    },
  }
}

/** How long a container keeps the settings before reading them again: a deploy's new apiBuild reaches calls within it. */
export const CONFIG_TTL_MS = 60_000

/** The web backend's dependencies in AWS. TRACE_WEB_CONFIG_PARAM names the SSM parameter. */
export function awsDeps(env: NodeJS.ProcessEnv = process.env): WebDeps {
  const param = env.TRACE_WEB_CONFIG_PARAM
  if (!param) throw new Error('TRACE_WEB_CONFIG_PARAM is not set')
  const creds = fromNodeProviderChain()
  return {
    config: configLoader(ssmReader(env.AWS_REGION), param, { ttlMs: CONFIG_TTL_MS }),
    verifier: once((c) => new Verifier({ issuer: issuerOf(c), clientId: c.clientId })),
    cognito: once((c) => cognitoPort(c.region)),
    bedrock: once((c) => bedrockPort(c.region)),
    polly: once((c) => pollyPort(c.region)),
    store: once((c) => storePort(c.region)),
    cloudwatch: once((c) => cloudwatchPort(c.region)),
    secrets: once((c) => secretsPort(c.region)),
    hookStore: once((c) => (c.hooks?.table ? new DynamoDebounceStore({ table: c.hooks.table, region: c.region, credentials: creds }) : null)),
    credentials: creds,
    fetch: (input, init) => fetch(input, init),
    ...(env.TRACE_AGENTCORE_ENDPOINT ? { agentcoreEndpoint: env.TRACE_AGENTCORE_ENDPOINT } : {}),
    log: (l) => { process.stdout.write(`${JSON.stringify(l)}\n`) },
    now: Date.now,
  }
}
