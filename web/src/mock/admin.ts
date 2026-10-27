/**
 * Mock answers for Operations, Admin and Preferences: /api/ops, the users.*, assign, integrations.* and prompts.*
 * actions, passkeys and the voice preview. Registered in handlers.ts with one line; returns null for anything else.
 */
import type { MeDoc } from '@/lib/types'
import type { PromptHistoryEntry, PromptView } from '@/lib/admin-types'
import { checkTemplate } from '@/lib/prompts'
import { INSTALLATION_OVERRIDES, INTEGRATIONS, OPS_RUNS, PASSKEYS, PROJECT_OVERRIDES, PROMPT_DEFS, PROMPT_HISTORY, USERS, type MockOverride, opsFixture } from './fixtures-admin'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const later = <T,>(v: T, ms = 500) => new Promise<T>((r) => setTimeout(() => r(v), ms))

const users = structuredClone(USERS)
const integrations = structuredClone(INTEGRATIONS)
const passkeys = structuredClone(PASSKEYS)
const inst: Record<string, MockOverride> = structuredClone(INSTALLATION_OVERRIDES)
const proj: Record<string, Record<string, MockOverride>> = structuredClone(PROJECT_OVERRIDES)
const history: Record<string, PromptHistoryEntry[]> = structuredClone(PROMPT_HISTORY)

/** What an installation's policy fixes for everyone (assumed: me.get answers it as `locks`). */
const LOCKS = { 'security.passkeys': 'Your team requires a passkey, so you cannot remove your last one.' }

const usable = (id: string, o: MockOverride | undefined): boolean => {
  if (!o || o.text === null) return false
  const d = PROMPT_DEFS[id]
  if (!d || d.mode === 'locked') return false
  return checkTemplate(o.text, Object.keys(d.vars ?? {})).ok
}

function effective(id: string, repo?: string) {
  const p = repo ? proj[repo]?.[id] : undefined
  const i = inst[id]
  const d = PROMPT_DEFS[id]!
  const skipped: { layer: string; version: number; reason: string }[] = []
  for (const [layer, o] of [['project', p], ['installation', i]] as const) {
    if (!o || o.text === null) continue
    if (usable(id, o)) return { layer, version: o.version, sha: 'a1b2c3d4e5f6', text: o.text!, ...(skipped.length ? { skipped } : {}) }
    skipped.push({ layer, version: o.version, reason: problem(id, o.text) ?? 'not usable' })
  }
  return { layer: 'default' as const, version: null, sha: '0f9e8d7c6b5a', text: d.default, ...(skipped.length ? { skipped } : {}) }
}

function problem(id: string, text: string): string | null {
  const d = PROMPT_DEFS[id]
  if (!d) return 'no such prompt in the catalog'
  if (d.mode === 'locked') return 'the prompt is locked'
  const c = checkTemplate(text, Object.keys(d.vars ?? {}))
  if (c.unknown.length) return `uses {{${c.unknown[0]}}}, which this entry no longer has`
  if (c.malformed) return c.malformed
  if (c.tooLong) return `${c.length} characters; at most 16000`
  return null
}

const view = (o: MockOverride | undefined) => (o ? { text: o.text, version: o.version, updated: o.updated, by: o.by } : null)

function getView(id: string, repo?: string): PromptView {
  const d = PROMPT_DEFS[id]!
  const eff = effective(id, repo)
  return {
    ...(repo ? { repo } : {}), id, mode: d.mode, prompt: d.prompt, description: d.description, vars: d.vars ?? {}, default: d.default,
    installation: view(inst[id]), project: repo ? view(proj[repo]?.[id]) : null,
    effective: eff, followed_by_locked: d.then ?? [], composed: '',
  }
}

const KIND_ORDER = ['role', 'unattended', 'route', 'rules', 'workflow', 'tools', 'knowledge', 'knowledge.data', 'done', 'evidence', 'escalate', 'report', 'guardrails']

function previewIds(target: string): string[] {
  const kinds = ['verify', 'impl', 'ams', 'emc', 'render', 'thermal']
  let kind = kinds.find((k) => target === k || target.startsWith(`specialist.${k}.`))
  let prompt = PROMPT_DEFS[target]?.prompt ?? target
  if (kinds.includes(target)) prompt = 'specialist'
  if (prompt === 'specialist') {
    kind ??= 'ams'
    return KIND_ORDER.flatMap((p) => [`specialist.${kind}.${p}`, `specialist.${p}`]).filter((id) => PROMPT_DEFS[id])
  }
  return Object.values(PROMPT_DEFS).filter((d) => d.prompt === prompt || (prompt === 'worker.item' && d.prompt === 'worker.task')).map((d) => d.id)
}

const fill = (t: string, repo: string) => t.replace(/\{\{\s*repository\s*\}\}/g, repo).replace(/\{\{\s*where\s*\}\}/g, 'on Amazon Bedrock AgentCore Runtime').replace(/\{\{\s*(\w+)\s*\}\}/g, '($1)')

function preview(repo: string, target: string) {
  const parts = previewIds(target).map((id) => {
    const e = effective(id, repo)
    return { id, layer: e.layer, version: e.version, sha: e.sha, locked: PROMPT_DEFS[id]!.mode === 'locked', text: fill(e.text, repo) }
  })
  const marked = parts.map((p) => `[${p.locked ? 'locked' : 'editable'} ${p.id} · ${p.layer}${p.version === null ? '' : ` v${p.version}`} · ${p.sha}]\n${p.text}`).join('\n\n')
  return { repo, prompt: PROMPT_DEFS[target]?.prompt ?? 'specialist', text: parts.map((p) => p.text).join('\n\n'), marked, parts: parts.map(({ text: _t, ...p }) => p) }
}

function write(op: 'set' | 'reset' | 'revert', a: Record<string, unknown>) {
  const id = String(a.id)
  const scope = a.scope as 'installation' | 'project'
  const repo = a.repo as string | undefined
  const store = scope === 'installation' ? inst : (proj[repo!] ??= {})
  const key = scope === 'installation' ? `installation:${id}` : `project:${repo}:${id}`
  const prev = store[id]
  const version = (prev?.version ?? 0) + 1
  let text: string | null = null
  if (op === 'set') {
    const p = problem(id, String(a.text))
    if (p) return fail(`${id}: ${p}`)
    text = String(a.text)
  } else if (op === 'revert') {
    const h = (history[key] ?? []).find((x) => x.version === Number(a.version) || x.uid === a.version)
    if (!h) return fail(`no version ${a.version} of ${id}`)
    text = h.text
  }
  const entry: PromptHistoryEntry = { uid: `h${Math.random().toString(36).slice(2, 8)}`, id, version, action: op, text, by: 'marc', at: new Date().toISOString(), reason: (a.reason as string) ?? null }
  if (scope === 'installation') {
    store[id] = { text, version, updated: entry.at, by: 'marc' }
    ;(history[key] ??= []).push(entry)
    return ok({ scope, id, version, uid: entry.uid, action: op })
  }
  // project scope: a branch and a pull request; the default branch (what agents read) is unchanged until merged
  const branch = `trace/prompts-${id.replace(/\./g, '-')}-${Date.now().toString(36)}`
  return ok({ scope, repo, id, version, uid: entry.uid, action: op, branch, commit: 'c0ffee1', note: '.trace/** is a protected path: the pull request waits for a person to merge it.' })
}

function silentWav(): string {
  const n = 1600
  const buf = new Uint8Array(44 + n)
  const dv = new DataView(buf.buffer)
  const str = (o: number, s: string) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)))
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true)
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, n, true)
  buf.fill(128, 44)
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return `data:audio/wav;base64,${btoa(s)}`
}

function action(name: string, a: Record<string, unknown>, me: MeDoc): Response | Promise<Response> | null {
  switch (name) {
    case 'me.get': return ok({ ...me, locks: LOCKS })
    case 'users.list': return ok(users)
    case 'users.invite': {
      const email = String(a.email)
      if (users.some((u) => u.email === email)) return fail(`${email} already has an account; use users.class to change their class`)
      const u = { email, sub: `sub-${email}`, status: 'FORCE_CHANGE_PASSWORD', enabled: true, class: (a.class as 'user') ?? 'user', projects: [], parts: [], lastSeen: null }
      users.push(u)
      return later(ok({ sub: u.sub, email, class: u.class }))
    }
    case 'users.class': {
      const u = users.find((x) => x.sub === a.who || x.email === a.who)
      if (!u) return fail('no such person')
      u.class = a.class as 'admin' | 'user' | 'guest'
      if (u.class === 'guest') u.parts = (u.parts ?? []).map((p) => ({ ...p, part: 'reviewer' as const }))
      return later(ok({ sub: u.sub, email: u.email, class: u.class }), 300)
    }
    case 'assign': {
      const u = users.find((x) => x.sub === a.who || x.email === a.who)
      if (!u) return fail('no such person')
      const part = u.class === 'guest' ? 'reviewer' : ((a.part as 'contributor') ?? 'contributor')
      u.parts = [...(u.parts ?? []).filter((p) => p.repo !== a.repo), { repo: String(a.repo), part }]
      u.projects = u.parts.map((p) => p.repo)
      return ok({ ok: true })
    }
    case 'unassign': {
      const u = users.find((x) => x.sub === a.who || x.email === a.who)
      if (!u) return fail('no such person')
      u.parts = (u.parts ?? []).filter((p) => p.repo !== a.repo)
      u.projects = u.parts.map((p) => p.repo)
      return ok({ removed: true })
    }
    case 'assignments': return ok(users.flatMap((u) => (u.parts ?? []).map((p) => ({ sub: u.sub, email: u.email, repo: p.repo, part: p.part }))))
    case 'integrations.list': return ok(integrations)
    case 'integrations.set': {
      const i = integrations.find((x) => x.name === a.name)
      if (!i) return fail('no such integration')
      i.configured = true
      i.changed = new Date().toISOString()
      return later(ok({ name: i.name, secret: `trace/integrations/${i.name}`, check: { ok: true, detail: `${i.title} answered a test search.` } }), 800)
    }
    case 'integrations.remove': {
      const i = integrations.find((x) => x.name === a.name)
      if (i) { i.configured = false; i.changed = null }
      return ok({ name: a.name, removed: !!i })
    }
    case 'prompts.list': {
      const repo = a.repo as string | undefined
      const prompts = Object.values(PROMPT_DEFS).map((d) => {
        const e = effective(d.id, repo)
        return { id: d.id, mode: d.mode, prompt: d.prompt, description: d.description, layer: e.layer, version: e.version }
      })
      const problems = [
        ...Object.entries(inst).filter(([id, o]) => o.text && !usable(id, o)).map(([id, o]) => ({ id, layer: 'installation' as const, version: o.version, reason: problem(id, o.text!) ?? '' })),
        ...Object.entries(repo ? proj[repo] ?? {} : {}).filter(([id, o]) => o.text && !usable(id, o)).map(([id, o]) => ({ id, layer: 'project' as const, version: o.version, reason: problem(id, o.text!) ?? '' })),
      ]
      return ok({ ...(repo ? { repo } : {}), prompts, problems })
    }
    case 'prompts.get': return PROMPT_DEFS[String(a.id)] ? ok(getView(String(a.id), a.repo as string | undefined)) : fail(`no prompt "${a.id}" in the catalog`)
    case 'prompts.preview': return later(ok(preview(String(a.repo), String(a.target))), 250)
    case 'prompts.set': return later(write('set', a), 600)
    case 'prompts.reset': return later(write('reset', a), 400)
    case 'prompts.revert': return later(write('revert', a), 400)
    case 'prompts.history': {
      const key = a.scope === 'installation' ? `installation:${a.id}` : `project:${a.repo}:${a.id}`
      return ok({ id: a.id, scope: a.scope, history: history[key] ?? [] })
    }
    case 'runs': return ok(OPS_RUNS[String(a.repo)] ?? [])
    case 'status': return ok({ repo: a.repo, default_branch: 'main', pulls: [{}], agent_fix_issues: [], runs: [], last_deploy: { conclusion: 'success' } })
    default: return null
  }
}

/** One line in handlers.ts: `const mine = await adminHandle(url.pathname, body, init, me); if (mine) return mine`. */
export async function adminHandle(path: string, body: Record<string, unknown>, init: RequestInit, me: MeDoc): Promise<Response | null> {
  const url = new URL(path, 'http://mock')
  const method = (init.method ?? 'GET').toUpperCase()
  if (url.pathname === '/api/call') return action(String(body.action), body, me)
  if (url.pathname === '/api/ops') {
    const admin = true
    return later(json(opsFixture(url.searchParams.get('range') ?? '24h', url.searchParams.get('repo'), admin)), 300)
  }
  if (url.pathname === '/api/auth/passkeys' && method === 'GET') return json({ passkeys })
  if (url.pathname === '/api/auth/passkeys/start') return json({ options: { challenge: 'Y2hhbGxlbmdl', rp: { name: 'trace' }, user: { id: 'dXNlcg', name: 'marc@example.com', displayName: 'Marc' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
  if (url.pathname.startsWith('/api/auth/passkeys/') && method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    const i = passkeys.findIndex((p) => p.id === id)
    if (i >= 0) passkeys.splice(i, 1)
    return json({ ok: true })
  }
  if (url.pathname === '/api/voice/speak') return json({ url: silentWav(), marks: [] })
  if (url.pathname === '/api/voice/voices')
    return json({ voices: [
      { id: 'Olivia', name: 'Olivia', gender: 'Female', engines: ['neural'] },
      { id: 'Matthew', name: 'Matthew', gender: 'Male', engines: ['neural', 'generative'] },
      { id: 'Amy', name: 'Amy', gender: 'Female', engines: ['generative'] },
      { id: 'Ruth', name: 'Ruth', gender: 'Female', engines: ['generative'] },
    ] })
  return null
}
