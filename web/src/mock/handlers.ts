/**
 * Mock mode: answers every /api request the app makes from fixtures, so screens render without a backend. Installed
 * by main.tsx only when VITE_MOCK=1 (`npm run dev:mock`); production builds never include it (the import sits behind
 * a build-time constant and is removed). Tests use `handle()` directly.
 */
import type { ChatMessage, InboxItem } from '@/lib/types'
import { knowledgeAction } from './knowledge'
import { INBOX, JOURNEYS, ME, ME_DOC, MEMBERS, PROJECTS, RECALL, THREADS, THREAD_MESSAGES, WAITS } from './fixtures'
import { setPath } from '@/lib/prefs'
import { adminHandle } from './admin'
import { servicesAction } from './services'
import { s1Action } from './s1'
import { designAction } from './design'
import { smallAction } from './small'
import { lifecycleAction, withLifecycle } from './lifecycle'
import { filesAction, withFileThread } from './files'
import { buildCostAction } from './build-cost'
import { handoffsOf, jobsAction, jobsOf } from './jobs'
import { changesAction } from './changes'
import { deploysAction } from './deploys'
import { healthAction } from './health'
import { progressAction } from './progress'

let signedIn = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('trace.mock.signedOut') !== '1'
let inbox: InboxItem[] = [...INBOX]
let me = structuredClone(ME_DOC)
const threads = structuredClone(THREADS)
const messages: Record<string, ChatMessage[]> = structuredClone(THREAD_MESSAGES)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const tokens = () => ({ accessToken: 'mock-access', idToken: 'mock-id', expiresIn: 3600, user: ME })

function action(name: string, a: Record<string, unknown>): Response {
  const repo = a.repo as string
  const ch = changesAction(name, a, (r, n) => { inbox = inbox.filter((i) => !(i.change?.repo === r && i.change.number === n)) }); if (ch) return ch
  const dep = deploysAction(name, a); if (dep) return dep
  const hl = healthAction(name, a); if (hl) return hl
  const pr = progressAction(name, a); if (pr) return pr
  const files = filesAction(name, a); if (files) return files
  const k = knowledgeAction(name, a); if (k !== undefined) return k && typeof k === 'object' && '__error' in k ? json({ ok: false, error: (k as { __error: string }).__error }, 403) : ok(k)
  const des = designAction(name, a); if (des) return des
  const bc = buildCostAction(name, a); if (bc) return bc
  const jobs = jobsAction(name, a); if (jobs) return jobs.ok ? ok(jobs.result) : json({ ok: false, error: jobs.error })
  const s1 = s1Action(name, a); if (s1) return s1
  const small = smallAction(name, a); if (small) return small
  const life = lifecycleAction(name, a); if (life) return life
  switch (name) {
    case 'whoami': return ok({ sub: ME.sub, email: ME.email, groups: ['trace-admins'], class: ME.class })
    case 'projects': return ok(withLifecycle(PROJECTS))
    case 'inbox': return ok(inbox)
    case 'journey.get': return JOURNEYS[repo] ? ok({ ...JOURNEYS[repo], jobs: jobsOf(repo), handoffs: handoffsOf(repo) }) : json({ ok: false, error: 'no access' }, 403)
    case 'project.update': {
      // the mock journeys are already in the app's shape (lib/readers.ts passes them through), so patch that shape
      const j = JOURNEYS[repo] as (typeof JOURNEYS)[string] & Record<string, unknown> | undefined
      if (!j) return json({ ok: false, error: 'no access' }, 403)
      if (typeof a.name === 'string') j.name = a.name
      if (typeof a.description === 'string') j.description = a.description
      if (typeof a.icon === 'string') j.icon = JSON.parse(a.icon) as unknown
      if (a.build && typeof a.build === 'object') j.build = { quantity: 10, unit_cost: null, budget: null, currency: 'USD', fab: 'JLCPCB', ...(j.build as object | undefined), ...(a.build as object) }
      if (Array.isArray(a.later)) j.later = a.later
      return ok({ repo, version: 1 })
    }
    case 'project.members': return ok(MEMBERS[repo] ?? MEMBERS['acme/soil-sensor'])
    case 'tools.waits': return ok({ repo, version: 1, waits: WAITS[repo] ?? [] })
    case 'tools.check_now': case 'job.check_now': return new Promise<Response>((r) => setTimeout(() => r(ok({ ok: true })), 900)) as unknown as Response
    case 'question.answer': inbox = inbox.filter((i) => i.questionId !== a.question); return ok({ ok: true })
    case 'me.get': return ok(me)
    case 'me.set': me = setPath(me, String(a.key), a.value); return ok({ ok: true })
    case 'push.subscribe': return ok({ subscribed: true, devices: 1 })
    case 'push.unsubscribe': return ok({ removed: true })
    case 'push.devices': return ok({ devices: [] })
    case 'chats.list': return ok(withFileThread(repo, threads.filter((t) => t.repo === repo)))
    case 'chats.get': return ok({ thread: threads.find((t) => t.id === (a.thread ?? a.id)), messages: messages[String(a.thread ?? a.id)] ?? [] })
    case 'chats.recall': return ok(RECALL)
    case 'chats.append': {
      // the person's own words only, as the API keeps them
      let id = (a.thread ?? a.id) as string | undefined
      if (!id) {
        id = `t${threads.length + 1}`
        threads.unshift({ id, repo, title: String(a.title ?? 'New conversation'), updatedAt: new Date().toISOString() })
        messages[id] = []
      }
      const mid = crypto.randomUUID()
      for (const m of (a.messages as { text: string }[] | undefined) ?? []) messages[id]!.push({ id: mid, role: 'user', content: m.text, at: new Date().toISOString() })
      return ok({ id, messageId: mid, created: !(a.thread ?? a.id) })
    }
    case 'runs': return ok([])
    default: return json({ ok: false, error: `mock: no fixture for ${name}` })
  }
}

function sse(events: unknown[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(c) {
      for (const e of events) {
        // { __pause: ms } holds the stream (a tool that takes a while)
        if (e && typeof e === 'object' && '__pause' in e) { await new Promise((r) => setTimeout(r, (e as { __pause: number }).__pause)); continue }
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        await new Promise((r) => setTimeout(r, 40))
      }
      c.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

/** What mock mode answers when asked to show, draw, plot or diagram something: one of each picture the chat draws. */
export const PICTURES_REPLY = [
  'Here is the soil sensor at a glance: how power and data flow, the I2C timing, and the 3.3 V rail at power-on.',
  '',
  '```mermaid',
  '%% title: Power and data path',
  'flowchart LR',
  '  USB["USB-C 5 V"] --> LDO["3.3 V regulator"]',
  '  LDO --> MCU["ESP32-C3"]',
  '  LDO --> OLED["OLED display"]',
  '  MCU -- "I2C" --> OLED',
  '  MCU -- "ADC" --> PROBE["Soil probe"]',
  '```',
  '',
  '```wavedrom',
  '{ signal: [',
  '  { name: "SCL", wave: "1.0101010101010101.1" },',
  '  { name: "SDA", wave: "1.0.3.......4.....01", data: ["address 0x3C, write", "data"] },',
  '], head: { text: "I2C write to the display" } }',
  '```',
  '',
  '```plot',
  '{ title: "3.3 V rail at power-on", kind: "line",',
  '  x: { label: "Time", unit: "s" }, y: { label: "Voltage", unit: "V" },',
  '  series: [{ name: "3V3", points: [[0,0],[0.0005,1.1],[0.001,2.4],[0.0015,3.1],[0.002,3.28],[0.003,3.3],[0.005,3.3]] }],',
  '  limit: { value: 2.97, label: "min 2.97 V", kind: "min" }, verdict: "Settles in 3.1 ms, inside the 5 ms needed.", ok: true }',
  '```',
  '',
  '```plot',
  '{ title: "Cost per board at 10 boards", x: { label: "Item" }, y: { label: "Cost", unit: "US$" },',
  '  series: [{ name: "Cost", points: [["PCB", 2.1], ["Parts", 6.8], ["Assembly", 3.4], ["Case", 4.2]] }] }',
  '```',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 90"><title>Display connector pinout</title>',
  '<rect x="20" y="20" width="200" height="40" rx="4" fill="#f4f4f5" stroke="#52525b"/>',
  '<g font-family="sans-serif" font-size="11" text-anchor="middle" fill="#18181b">',
  '<circle cx="50" cy="40" r="7" fill="#a1a1aa"/><text x="50" y="78">GND</text>',
  '<circle cx="97" cy="40" r="7" fill="#ef4444"/><text x="97" y="78">3V3</text>',
  '<circle cx="144" cy="40" r="7" fill="#3b82f6"/><text x="144" y="78">SCL</text>',
  '<circle cx="191" cy="40" r="7" fill="#22c55e"/><text x="191" y="78">SDA</text>',
  '</g></svg>',
  '```',
  '',
  'Tap any picture to open it full screen.',
].join('\n')

function agui(body: { threadId: string; runId: string; messages: { role: string; content?: unknown }[] }): Response {
  const last = [...body.messages].reverse().find((m) => m.role === 'user')
  const q = typeof last?.content === 'string' ? last.content : ''
  const reply = /\b(show|draw|diagram|plot|chart|picture|timing)\b/i.test(q) ? PICTURES_REPLY : `**Here is what I found** about “${q.slice(0, 60)}”.\n\nThis is mock mode: no agent ran. In a real installation trace answers from the project record, with cards for runs, plots and parts.\n\n- One\n- Two`
  const id = crypto.randomUUID()
  const words = reply.split(/(?<=\s)/)
  // a question about a simulation runs a tool for a while, with its run named (docs/progress-and-logs.md, "Chat")
  if (/simulat|settle/i.test(q)) {
    const call = `call_${id.slice(0, 8)}`
    const say = crypto.randomUUID()
    return sse([
      { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
      { type: 'TEXT_MESSAGE_START', messageId: say, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: say, delta: "I'm running a transient simulation of the probe circuit from power-on to 10 ms." },
      { type: 'TEXT_MESSAGE_END', messageId: say },
      { type: 'TOOL_CALL_START', toolCallId: call, toolCallName: 'transient_simulation', parentMessageId: say },
      { type: 'TOOL_CALL_ARGS', toolCallId: call, delta: JSON.stringify({ circuit: 'probe', stop: '10ms' }) },
      { type: 'TOOL_CALL_END', toolCallId: call },
      { type: 'CUSTOM', name: 'trace.tool_run', value: { toolCallId: call, repo: 'acme/soil-sensor', run: 'tool:t_sim' } },
      { __pause: 45_000 },
      { type: 'TOOL_CALL_RESULT', messageId: crypto.randomUUID(), toolCallId: call, content: JSON.stringify({ summary: 'Ran the transient simulation: settles in 3.1 ms' }) },
      { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: 'It settles in **3.1 ms**, inside the 5 ms you need.' },
      { type: 'TEXT_MESSAGE_END', messageId: id },
      { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId },
    ])
  }
  return sse([
    { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
    { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
    ...words.map((w) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: w })),
    { type: 'TEXT_MESSAGE_END', messageId: id },
    { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId },
  ])
}

export async function handle(path: string, init: RequestInit = {}): Promise<Response> {
  const body = init.body ? JSON.parse(String(init.body)) : {}
  const url = new URL(path, 'http://mock')
  if (url.pathname === '/api/call') { const svc = await servicesAction(String(body.action), body); if (svc) return svc }
  const mine = await adminHandle(url.pathname + url.search, body, init, me); if (mine) return mine
  switch (url.pathname) {
    case '/api/config':
      return json({ region: 'ap-southeast-2', prefix: 'trace', userPoolId: 'mock', clientId: 'mock', events: { http: '', realtime: '' }, features: { passkeys: true, email: true, voice: true, ops: true }, waf: { enabled: true, own: false, apiRequestsPer10Minutes: 1000, authRequestsPer10Minutes: 100 } })
    case '/api/auth/refresh':
      return signedIn ? json(tokens()) : json({ ok: false, error: 'not signed in' }, 401)
    case '/api/auth/start':
      return json({ session: 'mock-session', choices: ['passkey', 'email_code', 'password'] })
    case '/api/auth/respond':
      if (body.kind === 'email_code' && body.answer === 'request') return json({ signedIn: false, next: 'email_code', session: 'mock-session' })
      if (body.kind === 'password') return json({ signedIn: false, next: 'totp', session: 'mock-session' })
      signedIn = true
      sessionStorage.removeItem('trace.mock.signedOut')
      return json({ signedIn: true, ...tokens() })
    case '/api/auth/sign-out':
      signedIn = false
      sessionStorage.setItem('trace.mock.signedOut', '1')
      return json({ ok: true })
    case '/api/auth/forgot':
      return json({ sent: true })
    case '/api/auth/reset':
      return json({ ok: true })
    case '/api/auth/totp/start':
      return json({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/trace:marc@example.com?secret=JBSWY3DPEHPK3PXP&issuer=trace' })
    case '/api/auth/totp/verify':
    case '/api/auth/passkeys/finish':
      return json({ ok: true })
    // a demo key (a valid P-256 point): the browser subscribes with it; nothing is ever pushed in mock mode
    case '/api/push/key':
      return json({ publicKey: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4' })
    case '/api/call':
      return action(String(body.action), body)
    case '/api/agui':
      return agui(body)
    case '/api/voice/voices':
      return json({ voices: [{ id: 'Olivia', name: 'Olivia', gender: 'Female', engines: ['neural'] }, { id: 'Matthew', name: 'Matthew', gender: 'Male', engines: ['neural', 'generative'] }] })
    default:
      return json({ ok: false, error: `mock: no handler for ${url.pathname}` }, 404)
  }
}

/** Route the browser's fetch for /api/* through the fixtures. */
export function installMock(): void {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(location.origin, '')
    if (path.startsWith('/api/')) {
      await new Promise((r) => setTimeout(r, 60))
      return handle(path, init)
    }
    return real(input, init)
  }
  console.info('[trace] mock mode: /api answered from src/mock/fixtures.ts')
}
