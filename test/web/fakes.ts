/** Fakes for the web backend: config, Cognito, the API runtime (fetch), Bedrock, Polly, S3, CloudWatch, AppSync. */
import type { ConverseStreamCommandInput, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime'
import type { MetricAlarm, MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import type { SynthesizeSpeechCommandInput, Voice } from '@aws-sdk/client-polly'
import { app } from '../../src/web/app.js'
import { WebConfig } from '../../src/web/config.js'
import type { WebDeps } from '../../src/web/deps.js'
import type { LiveEvent, Publisher } from '../../src/web/events.js'
import type { Sink, WebRequest } from '../../src/web/http.js'
import type { BedrockPort, CloudWatchPort, CognitoPort, PollyPort, StorePort } from '../../src/web/ports.js'
import { CLIENT_ID, ISSUER, sign, verifier } from '../api/fixtures.js'

export const CONFIG = WebConfig.parse({
  region: 'us-east-1', prefix: 'trace', userPoolId: 'us-east-1_TEST', clientId: CLIENT_ID,
  apiRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/trace_api-abc',
  events: { http: 'abc.appsync-api.us-east-1.amazonaws.com', realtime: 'abc.appsync-realtime-api.us-east-1.amazonaws.com', apiId: 'abc' },
  voiceBucket: 'voice-bucket', voicePrefix: 'web/voice', dashboards: ['trace-agents'],
})

export const idToken = (sub: string, email: string, groups: string[]): string => {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub, iss: ISSUER, token_use: 'id', aud: CLIENT_ID, exp: now + 3600, iat: now, email, 'cognito:groups': groups })
}

type Call = { op: string; input: Record<string, unknown> }

/** A Cognito whose answers the test sets per operation. */
export class FakeCognito implements CognitoPort {
  calls: Call[] = []
  answers = new Map<string, (input: Record<string, unknown>) => unknown>()
  private run<T>(op: string, input: object): Promise<T> {
    this.calls.push({ op, input: input as Record<string, unknown> })
    const a = this.answers.get(op)
    try {
      return Promise.resolve((a ? a(input as Record<string, unknown>) : {}) as T)
    } catch (e) {
      return Promise.reject(e)
    }
  }
  initiateAuth = (i: object) => this.run<never>('InitiateAuth', i)
  respondToAuthChallenge = (i: object) => this.run<never>('RespondToAuthChallenge', i)
  revokeToken = (i: object) => this.run<void>('RevokeToken', i)
  forgotPassword = (i: object) => this.run<void>('ForgotPassword', i)
  confirmForgotPassword = (i: object) => this.run<void>('ConfirmForgotPassword', i)
  startWebAuthnRegistration = (i: object) => this.run<never>('StartWebAuthnRegistration', i)
  completeWebAuthnRegistration = (i: object) => this.run<void>('CompleteWebAuthnRegistration', i)
  listWebAuthnCredentials = (i: object) => this.run<never>('ListWebAuthnCredentials', i)
  deleteWebAuthnCredential = (i: object) => this.run<void>('DeleteWebAuthnCredential', i)
  associateSoftwareToken = (i: object) => this.run<never>('AssociateSoftwareToken', i)
  verifySoftwareToken = (i: object) => this.run<never>('VerifySoftwareToken', i)
  setUserMfaPreference = (i: object) => this.run<void>('SetUserMFAPreference', i)
}

export const awsError = (name: string): Error => Object.assign(new Error(`${name}: details that must not leak`), { name })

/** The API runtime: answers by action, and records each call (action, args, headers). */
export class FakeRuntime {
  calls: { action: string; args: Record<string, unknown>; headers: Record<string, string>; url: string }[] = []
  answers = new Map<string, (args: Record<string, unknown>) => { status?: number; body: unknown }>()
  appsync: { url: string; headers: Record<string, string>; body: string }[] = []
  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url.includes('appsync-api')) {
      this.appsync.push({ url, headers, body })
      return new Response(JSON.stringify({ successful: [], failed: [] }), { status: 200 })
    }
    const { action, ...args } = JSON.parse(body) as { action: string } & Record<string, unknown>
    this.calls.push({ action, args, headers, url })
    const a = this.answers.get(action)
    const r = a ? a(args) : { body: { ok: false, error: `unknown action ${JSON.stringify(action)}` } }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
}

/** Bedrock: each converseStream call plays the next script. */
export class FakeBedrock implements BedrockPort {
  inputs: ConverseStreamCommandInput[] = []
  constructor(public scripts: ConverseStreamOutput[][] = []) {}
  async *converseStream(i: ConverseStreamCommandInput): AsyncIterable<ConverseStreamOutput> {
    this.inputs.push(structuredClone(i))
    const s = this.scripts.shift()
    if (!s) throw new Error('no more scripted turns')
    for (const e of s) yield e
  }
}

/** A model turn that says `text`. */
export const say = (text: string): ConverseStreamOutput[] => [
  { messageStart: { role: 'assistant' } },
  ...text.match(/.{1,6}/g)!.map((t): ConverseStreamOutput => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: t } } })),
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
]

/** A model turn that (optionally says something, then) calls one tool. */
export const use = (id: string, name: string, input: Record<string, unknown>, text?: string): ConverseStreamOutput[] => {
  const json = JSON.stringify(input)
  return [
    { messageStart: { role: 'assistant' } },
    ...(text ? [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } }, { contentBlockStop: { contentBlockIndex: 0 } }] : []),
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: id, name } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: json.slice(0, 5) } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: json.slice(5) } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: 'tool_use' } },
  ] as ConverseStreamOutput[]
}

export class FakePolly implements PollyPort {
  synth: SynthesizeSpeechCommandInput[] = []
  voices: Voice[] = []
  async describeVoices(): Promise<Voice[]> { return this.voices }
  async synthesize(i: SynthesizeSpeechCommandInput): Promise<Uint8Array> {
    this.synth.push(i)
    if (i.OutputFormat === 'json') return Buffer.from('{"time":6,"type":"word","start":0,"end":5,"value":"Hello"}\n{"time":400,"type":"word","start":6,"end":11,"value":"world"}\n')
    return Buffer.from('ID3-mp3-bytes')
  }
}

export class FakeStore implements StorePort {
  objects = new Map<string, { body: string; type: string }>()
  async exists(b: string, k: string): Promise<boolean> { return this.objects.has(`${b}/${k}`) }
  async getText(b: string, k: string): Promise<string> { return this.objects.get(`${b}/${k}`)?.body ?? '' }
  async put(b: string, k: string, body: Uint8Array | string, type: string): Promise<void> { this.objects.set(`${b}/${k}`, { body: typeof body === 'string' ? body : Buffer.from(body).toString('utf8'), type }) }
  async presignGet(b: string, k: string, s: number): Promise<string> { return `https://${b}.s3.amazonaws.com/${k}?X-Amz-Expires=${s}` }
}

export class FakeCloudWatch implements CloudWatchPort {
  dashboards = new Map<string, string>()
  data: (q: MetricDataQuery) => MetricDataResult[] = () => []
  alarms: MetricAlarm[] = []
  queries: MetricDataQuery[] = []
  async getDashboard(name: string): Promise<string> { const d = this.dashboards.get(name); if (!d) throw Object.assign(new Error('nope'), { name: 'ResourceNotFound' }); return d }
  async getMetricData(qs: MetricDataQuery[]): Promise<MetricDataResult[]> { this.queries.push(...qs); return qs.flatMap((q) => this.data(q)) }
  async describeAlarms(): Promise<MetricAlarm[]> { return this.alarms }
}

export class FakePublisher implements Publisher {
  sent: { channel: string; events: LiveEvent[] }[] = []
  fail = false
  async publish(channel: string, events: readonly LiveEvent[]): Promise<void> {
    if (this.fail) throw new Error('AppSync is down')
    this.sent.push({ channel, events: [...events] })
  }
}

export interface World {
  deps: WebDeps
  cognito: FakeCognito
  runtime: FakeRuntime
  bedrock: FakeBedrock
  polly: FakePolly
  store: FakeStore
  cw: FakeCloudWatch
  publisher: FakePublisher
  logs: Record<string, unknown>[]
  serve: (req: Partial<WebRequest> & { method: string; path: string }) => Promise<Recorded>
}

export interface Recorded { status: number; headers: Record<string, string>; cookies: string[]; body: string; json: () => unknown; done: boolean }

export class RecordingSink implements Sink {
  r: Recorded = { status: 0, headers: {}, cookies: [], body: '', json: () => JSON.parse(this.r.body) as unknown, done: false }
  open(status: number, headers: Record<string, string>, cookies?: readonly string[]): void { this.r.status = status; this.r.headers = headers; this.r.cookies = [...(cookies ?? [])] }
  write(c: string): void { this.r.body += c }
  end(): void { this.r.done = true }
}

export const NOW = Date.parse('2026-10-27T00:00:00Z')

export function world(o: { heartbeatMs?: number } = {}): World {
  const cognito = new FakeCognito()
  const runtime = new FakeRuntime()
  const bedrock = new FakeBedrock()
  const polly = new FakePolly()
  const store = new FakeStore()
  const cw = new FakeCloudWatch()
  const publisher = new FakePublisher()
  const logs: Record<string, unknown>[] = []
  const v = verifier()
  const deps: WebDeps = {
    config: async () => CONFIG,
    verifier: () => v,
    cognito: () => cognito,
    bedrock: () => bedrock,
    polly: () => polly,
    store: () => store,
    cloudwatch: () => cw,
    credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-token' }),
    fetch: runtime.fetch,
    agentcoreEndpoint: 'https://agentcore.test',
    log: (l) => { logs.push(l) },
    now: () => NOW,
  }
  const handle = app(deps, { publisher: () => publisher, agui: { heartbeatMs: o.heartbeatMs ?? 60_000 } })
  const serve = async (req: Partial<WebRequest> & { method: string; path: string }): Promise<Recorded> => {
    const sink = new RecordingSink()
    await handle({ query: new URLSearchParams(), headers: {}, cookies: {}, body: '', ...req }, sink)
    return sink.r
  }
  return { deps, cognito, runtime, bedrock, polly, store, cw, publisher, logs, serve }
}

export const bearerOf = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
