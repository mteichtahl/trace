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
import { s1Action } from './s1'
import { filesAction, withFileThread } from './files'
import { jobsAction, jobsOf } from './jobs'

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
  const files = filesAction(name, a); if (files) return files
  const k = knowledgeAction(name, a); if (k !== undefined) return k && typeof k === 'object' && '__error' in k ? json({ ok: false, error: (k as { __error: string }).__error }, 403) : ok(k)
  const jobs = jobsAction(name, a); if (jobs) return jobs.ok ? ok(jobs.result) : json({ ok: false, error: jobs.error })
  const s1 = s1Action(name, a); if (s1) return s1
  switch (name) {
    case 'whoami': return ok({ sub: ME.sub, email: ME.email, groups: ['trace-admins'], class: ME.class })
    case 'projects': return ok(PROJECTS)
    case 'inbox': return ok(inbox)
    case 'journey.get': return JOURNEYS[repo] ? ok({ ...JOURNEYS[repo], jobs: jobsOf(repo) }) : json({ ok: false, error: 'no access' }, 403)
    case 'project.members': return ok(MEMBERS[repo] ?? MEMBERS['acme/soil-sensor'])
    case 'tools.waits': return ok({ repo, version: 1, waits: WAITS[repo] ?? [] })
    case 'tools.check_now': case 'job.check_now': return new Promise<Response>((r) => setTimeout(() => r(ok({ ok: true })), 900)) as unknown as Response
    case 'question.answer': inbox = inbox.filter((i) => i.questionId !== a.question); return ok({ ok: true })
    case 'me.get': return ok(me)
    case 'me.set': me = setPath(me, String(a.key), a.value); return ok({ ok: true })
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
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        await new Promise((r) => setTimeout(r, 40))
      }
      c.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function agui(body: { threadId: string; runId: string; messages: { role: string; content?: unknown }[] }): Response {
  const last = [...body.messages].reverse().find((m) => m.role === 'user')
  const q = typeof last?.content === 'string' ? last.content : ''
  const reply = `**Here is what I found** about “${q.slice(0, 60)}”.\n\nThis is mock mode: no agent ran. In a real installation trace answers from the project record, with cards for runs, plots and parts.\n\n- One\n- Two`
  const id = crypto.randomUUID()
  const words = reply.split(/(?<=\s)/)
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
  const mine = await adminHandle(url.pathname + url.search, body, init, me); if (mine) return mine
  switch (url.pathname) {
    case '/api/config':
      return json({ region: 'ap-southeast-2', prefix: 'trace', userPoolId: 'mock', clientId: 'mock', events: { http: '', realtime: '' }, features: { passkeys: true, email: true, voice: true, ops: true } })
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
