import { describe, expect, it } from 'vitest'
import type { MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { dashboardBody } from '../../src/infra/observability.js'
import { projectHash } from '../../src/core/project.js'
import { attribute, parseDashboard, periodFor, toMetricDataQuery } from '../../src/web/ops.js'
import { MAX_TEXT, parseMarks, speechKey, splitText, transcribeUrl } from '../../src/web/voice.js'
import { accessToken } from '../api/fixtures.js'
import { NOW, bearerOf, world } from './fakes.js'

const A = 'acme/board'
const B = 'acme/sensor'
const C = 'other/secret'
const ha = projectHash(A)
const hb = projectHash(B)
const hc = projectHash(C)

const body = JSON.stringify(dashboardBody({ region: 'us-east-1', runtimes: [`trace_w_${ha}`, `trace_w_${hb}`, `trace_w_${hc}`, 'trace_api'], memories: [ha, hb, hc], gpu: false }))

/** One series per runtime for runtime metrics; one unattributable series for trace's own metrics, cost included. */
function data(q: MetricDataQuery): MetricDataResult[] {
  const t = [new Date(NOW - 600_000), new Date(NOW - 300_000)]
  const expr = q.Expression ?? ''
  if (expr.includes('AWS/Bedrock-AgentCore') && !expr.includes('memory') && !expr.includes(`trace_m_`) && !/\(\w{8} OR/.test(expr)) {
    return [ha, hb, hc].map((h) => ({ Id: q.Id, Label: `trace_w_${h}-AbCdEf DEFAULT`, Timestamps: t, Values: [1, 2] }))
      .concat([{ Id: q.Id, Label: 'trace_api-XyZ DEFAULT', Timestamps: t, Values: [5, 5] }])
  }
  if (expr.includes('trace.claude.cost')) return [{ Id: q.Id, Label: 'specialist verify', Timestamps: t, Values: [0.5, 0.25] }]
  if (expr.includes('Invocations') || expr.includes('Latency') || expr.includes('Errors') || expr.includes('Throttles')) {
    return [{ Id: q.Id, Label: `trace_m_${ha}-mem1 ListEvents`, Timestamps: t, Values: [3, 4] }, { Id: q.Id, Label: `trace_m_${hc}-mem2 ListEvents`, Timestamps: t, Values: [9, 9] }]
  }
  return [{ Id: q.Id, Label: 'task ok', Timestamps: t, Values: [1, 1] }]
}

function opsWorld(cls: 'admin' | 'user' | 'guest', projects: { repo: string; part?: string; role?: string }[]) {
  const w = world()
  w.cw.dashboards.set('trace-agents', body)
  w.cw.data = data
  w.cw.alarms = [
    { AlarmName: `trace-${ha}-runtime-errors`, StateValue: 'ALARM', AlarmDescription: 'The board agent is failing', MetricName: 'SystemErrors', Dimensions: [{ Name: 'Resource', Value: `trace_w_${ha}` }] },
    { AlarmName: 'trace-api-5xx', StateValue: 'ALARM', MetricName: 'SystemErrors' },
    { AlarmName: 'trace-cost-budget', StateValue: 'INSUFFICIENT_DATA', MetricName: 'trace.claude.cost', Dimensions: [{ Name: 'Resource', Value: `trace_w_${hb}` }] },
  ]
  w.runtime.answers.set('whoami', () => ({ body: { ok: true, result: { sub: 's', class: cls } } }))
  w.runtime.answers.set('projects', () => ({ body: { ok: true, result: projects } }))
  const groups = { admin: ['trace-admins'], user: ['trace-users'], guest: ['trace-guests'] }[cls]
  const get = (q = '') => w.serve({ method: 'GET', path: '/api/ops', query: new URLSearchParams(q), headers: bearerOf(accessToken('s', groups)) })
  return { w, get }
}

type Ops = { status: { level: string; text: string }; tiles: { id: string }[]; alarms: { name: string; repo?: string }[]; sections: { widgets: { title: string; series: { label: string; repo?: string }[] }[] }[]; updatedAt: string; nextAt: string }
const labels = (o: Ops): string[] => o.sections.flatMap((s) => s.widgets.flatMap((w) => w.series.map((x) => `${w.title}|${x.repo ?? '-'}`)))

describe('Operations', () => {
  it('reads the dashboard trace makes: its SEARCH widgets, with periods sized to the range', () => {
    const ws = parseDashboard(body)
    expect(ws.map((w) => w.title)).toContain('Runtime invocations')
    expect(ws.every((w) => w.queries.every((q) => q.expression?.startsWith('SEARCH(')))).toBe(true)
    expect(periodFor(30 * 86_400, 300)).toBe(3600)
    expect(periodFor(3600, 300)).toBe(300)
    const q = toMetricDataQuery(ws[0]!.queries[0]!, 30 * 86_400)
    expect(q.Expression).toMatch(/, 'Sum', 3600\)$/)
    expect(q.Period).toBe(3600)
  })

  it('reads explicit metric rows with the "." shorthand', () => {
    const ws = parseDashboard(JSON.stringify({ widgets: [{ type: 'metric', properties: { title: 'Lambda', stat: 'Sum', period: 60, metrics: [['AWS/Lambda', 'Errors', 'FunctionName', 'trace-ci-abc'], ['.', 'Invocations', '.', '.', { label: 'Calls' }]] } }, { type: 'text', properties: { markdown: 'x' } }] }))
    expect(ws).toHaveLength(1)
    expect(ws[0]!.queries.map((q) => [q.namespace, q.metric, q.dimensions, q.label])).toEqual([
      ['AWS/Lambda', 'Errors', [{ Name: 'FunctionName', Value: 'trace-ci-abc' }], undefined],
      ['AWS/Lambda', 'Invocations', [{ Name: 'FunctionName', Value: 'trace-ci-abc' }], 'Calls'],
    ])
  })

  it('attributes series by the project hash in trace\'s resource names', () => {
    expect(attribute(`trace_w_${ha}-AbC DEFAULT`, 'trace', [A, B])).toBe(A)
    expect(attribute(`trace_m_${hb}-x`, 'trace', [A, B])).toBe(B)
    expect(attribute(`trace-ci-${ha}`, 'trace', [A])).toBe(A)
    expect(attribute('trace_api-XyZ', 'trace', [A, B])).toBeNull()
    expect(attribute(`trace_w_${hc}`, 'trace', [A, B])).toBeNull()
  })

  it('an admin sees every series, unattributed and cost included, and every alarm', async () => {
    const { get } = opsWorld('admin', [{ repo: A }, { repo: B }, { repo: C }])
    const r = await get('range=24h')
    expect(r.status).toBe(200)
    const o = r.json() as Ops
    const l = labels(o)
    expect(l).toContain('Runtime invocations|-')
    expect(l).toContain(`Runtime invocations|${C}`)
    expect(l).toContain('Claude cost (estimate, USD)|-')
    expect(o.alarms.map((a) => a.name).sort()).toEqual(['trace-api-5xx', 'trace-cost-budget', `trace-${ha}-runtime-errors`].sort())
    expect(o.tiles.map((t) => t.id)).toContain('cost')
    expect(o.status.level).toBe('alarm')
    expect(o.nextAt).toBe(new Date(NOW + 60_000).toISOString())
  })

  it('a contributor sees only their projects\' series, split per project, and no unattributed ones', async () => {
    const { get, w } = opsWorld('user', [{ repo: A, part: 'contributor' }, { repo: B, part: 'contributor' }])
    const o = (await get()).json() as Ops
    const l = labels(o)
    expect(l.filter((x) => x.startsWith('Runtime invocations|')).sort()).toEqual([`Runtime invocations|${A}`, `Runtime invocations|${B}`])
    expect(l.some((x) => x.endsWith('|-'))).toBe(false)
    expect(l.some((x) => x.includes(C))).toBe(false)
    expect(l.some((x) => x.startsWith('Claude cost'))).toBe(false)
    expect(o.alarms.map((a) => a.name).sort()).toEqual(['trace-cost-budget', `trace-${ha}-runtime-errors`].sort())
    expect(o.tiles.map((t) => t.id)).not.toContain('cost')
    // access was asked of the API runtime, as the person
    expect(w.runtime.calls.map((c) => c.action).sort()).toEqual(['projects', 'whoami'])
    // the project filter
    const only = (await get(`repo=${encodeURIComponent(A)}`)).json() as Ops
    expect(labels(only).every((x) => x.endsWith(`|${A}`))).toBe(true)
    expect((await get(`repo=${encodeURIComponent(C)}`)).status).toBe(403)
  })

  it('a reviewer sees no cost: not the cost alarm on their project', async () => {
    const { get } = opsWorld('guest', [{ repo: A, part: 'reviewer' }, { repo: B, role: 'read' }])
    const o = (await get()).json() as Ops
    expect(o.alarms.map((a) => a.name)).toEqual([`trace-${ha}-runtime-errors`])
    expect(labels(o).some((x) => /cost/i.test(x))).toBe(false)
    expect(labels(o).filter((x) => x.startsWith('Runtime invocations|')).sort()).toEqual([`Runtime invocations|${A}`, `Runtime invocations|${B}`])
  })

  it('a contributor learns a shared alarm fires without seeing it', async () => {
    const { get, w } = opsWorld('user', [{ repo: B, part: 'contributor' }])
    w.cw.alarms = w.cw.alarms.filter((a) => !a.AlarmName?.includes(ha))
    const o = (await get()).json() as Ops
    expect(o.alarms.map((a) => a.name)).toEqual(['trace-cost-budget'])
    expect(o.status.level).toBe('warn')
  })

  it('refuses a bad range', async () => {
    const { get } = opsWorld('admin', [])
    expect((await get('range=2w')).status).toBe(400)
  })
})

describe('voice', () => {
  const tok = accessToken('s', ['trace-users'])

  it('caches speech under sha256(voice|engine|rate|text) and answers presigned URLs with word marks', async () => {
    const w = world()
    const speak = () => w.serve({ method: 'POST', path: '/api/voice/speak', headers: bearerOf(tok), body: JSON.stringify({ text: 'Hello world', voice: 'Olivia' }) })
    const r = await speak()
    expect(r.status).toBe(200)
    const key = speechKey('web/voice', 'Olivia', 'neural', 1, 'Hello world')
    expect(key).toMatch(/^web\/voice\/[0-9a-f]{64}$/)
    expect(r.json()).toEqual({
      url: `https://voice-bucket.s3.amazonaws.com/${key}.mp3?X-Amz-Expires=300`,
      marks: [{ time: 6, type: 'word', start: 0, end: 5, value: 'Hello' }, { time: 400, type: 'word', start: 6, end: 11, value: 'world' }],
    })
    expect([...w.store.objects.keys()].sort()).toEqual([`voice-bucket/${key}.json`, `voice-bucket/${key}.mp3`])
    expect(w.polly.synth.map((s) => [s.OutputFormat, s.SpeechMarkTypes, s.TextType])).toEqual([['mp3', undefined, 'text'], ['json', ['word'], 'text']])
    // a replay costs nothing
    const again = await speak()
    expect(again.json()).toEqual(r.json())
    expect(w.polly.synth).toHaveLength(2)
  })

  it('keys differ by voice, engine, rate and text; a rate is SSML; generative voices make no marks', async () => {
    const k = (v: string, e: string, r: number, t: string) => speechKey('p', v, e, r, t)
    expect(new Set([k('A', 'neural', 1, 'x'), k('B', 'neural', 1, 'x'), k('A', 'generative', 1, 'x'), k('A', 'neural', 1.25, 'x'), k('A', 'neural', 1, 'y')]).size).toBe(5)
    const w = world()
    const r = await w.serve({ method: 'POST', path: '/api/voice/speak', headers: bearerOf(tok), body: JSON.stringify({ text: 'R1 & R2 < 5', voice: 'Ruth', engine: 'generative', rate: 1.25 }) })
    expect((r.json() as { marks: unknown[] }).marks).toEqual([])
    expect(w.polly.synth).toHaveLength(1)
    expect(w.polly.synth[0]).toMatchObject({ Engine: 'generative', TextType: 'ssml', Text: '<speak><prosody rate="125%">R1 &amp; R2 &lt; 5</prosody></speak>' })
  })

  it('splits text over 3,000 characters at sentence ends and answers the parts in order', async () => {
    const sentence = 'The regulator holds three point three volts under load. '
    const text = sentence.repeat(130)
    const pieces = splitText(text)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.length <= MAX_TEXT && p.endsWith('.'))).toBe(true)
    expect(pieces.join(' ')).toBe(text.trim())
    const w = world()
    const r = await w.serve({ method: 'POST', path: '/api/voice/speak', headers: bearerOf(tok), body: JSON.stringify({ text, voice: 'Olivia' }) })
    const b = r.json() as { url: string; parts: { url: string }[] }
    expect(b.parts).toHaveLength(pieces.length)
    expect(b.url).toBe(b.parts[0]!.url)
  })

  it('lists neural and generative voices only', async () => {
    const w = world()
    w.polly.voices = [
      { Id: 'Olivia', Name: 'Olivia', Gender: 'Female', SupportedEngines: ['neural', 'generative'] },
      { Id: 'Nicole', Name: 'Nicole', Gender: 'Female', SupportedEngines: ['standard'] },
      { Id: 'Russell', Name: 'Russell', Gender: 'Male', SupportedEngines: ['standard', 'neural'] },
    ]
    const r = await w.serve({ method: 'GET', path: '/api/voice/voices', query: new URLSearchParams('language=en-AU'), headers: bearerOf(tok) })
    expect(r.json()).toEqual({ voices: [
      { id: 'Olivia', name: 'Olivia', gender: 'Female', engines: ['neural', 'generative'] },
      { id: 'Russell', name: 'Russell', gender: 'Male', engines: ['neural'] },
    ] })
    expect((await w.serve({ method: 'GET', path: '/api/voice/voices', query: new URLSearchParams('language=english'), headers: bearerOf(tok) })).status).toBe(400)
  })

  it('signs a Transcribe streaming WebSocket URL: wss, port 8443, PCM 16 kHz, 300 s, SigV4 for transcribe', async () => {
    const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session/token+x' })
    const u = new URL(await transcribeUrl('ap-southeast-2', 'en-AU', creds, new Date(NOW)))
    expect(u.protocol).toBe('wss:')
    expect(u.host).toBe('transcribestreaming.ap-southeast-2.amazonaws.com:8443')
    expect(u.pathname).toBe('/stream-transcription-websocket')
    const q = u.searchParams
    expect(q.get('language-code')).toBe('en-AU')
    expect(q.get('media-encoding')).toBe('pcm')
    expect(q.get('sample-rate')).toBe('16000')
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(q.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20261027/ap-southeast-2/transcribe/aws4_request')
    expect(q.get('X-Amz-Date')).toBe('20261027T000000Z')
    expect(q.get('X-Amz-Expires')).toBe('300')
    expect(q.get('X-Amz-Security-Token')).toBe('session/token+x')
    expect(q.get('X-Amz-SignedHeaders')).toBe('host')
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    const w = world()
    const r = await w.serve({ method: 'POST', path: '/api/voice/listen', headers: bearerOf(tok), body: JSON.stringify({ language: 'en-AU', repo: 'acme/board' }) })
    expect((r.json() as { url: string }).url).toMatch(/^wss:\/\/transcribestreaming\.us-east-1\.amazonaws\.com:8443\/stream-transcription-websocket\?/)
  })

  it('reads speech marks leniently', () => {
    expect(parseMarks('{"time":1,"type":"word","value":"a"}\nnot json\n\n')).toEqual([{ time: 1, type: 'word', value: 'a' }])
  })
})
