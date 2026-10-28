/**
 * Mock answers for connected systems (services.*): two systems, one disabled, and every action the Admin › Connected
 * systems screens call. Registered in handlers.ts with one line; returns null for anything else. Mock mode is
 * development only (main.tsx), so none of this is in a production build.
 *
 * To see the "External access is off" state, run in the browser console:
 *   sessionStorage.setItem('trace.mock.external', 'off'); location.reload()
 */
import type { Service, ServiceHistoryEntry } from '@/lib/services'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const later = <T,>(v: T, ms = 400) => new Promise<T>((r) => setTimeout(() => r(v), ms))

export const OFF_ERROR = 'External access is off for this installation. Turn it on in the installer (External access).'

const ADDRESSES = {
  token_url: 'https://trace-acme.auth.ap-southeast-2.amazoncognito.com/oauth2/token',
  api_url: 'https://bedrock-agentcore.ap-southeast-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aap-southeast-2%3A123456789012%3Aruntime%2Ftrace_external-Ab12Cd34Ef/invocations?qualifier=DEFAULT',
  mcp_url: 'https://bedrock-agentcore.ap-southeast-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aap-southeast-2%3A123456789012%3Aruntime%2Ftrace_mcp-Gh56Ij78Kl/invocations?qualifier=DEFAULT',
  resource_server: 'trace-external',
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

export const SERVICES: Service[] = [
  {
    client_id: '4f8k2m1q9r7t3v5x6z0b2d4h6j', name: 'build-dashboard', description: 'The wall screen in the lab: shows each project\'s stage and its latest runs.',
    scopes: ['read'], disabled: false, created_by: 'marc@example.com', created_at: ago(60 * 24 * 21), last_used: ago(4),
    projects: [{ repo: 'acme/soil-sensor', part: 'reviewer' }, { repo: 'acme/motor-driver', part: 'reviewer' }],
    secrets: [{ id: 'a1b2c3d4', created_at: ago(60 * 24 * 21) }],
  },
  {
    client_id: '7c9e1g3i5k7m9o1q3s5u7w9y1a', name: 'release-bot', description: 'Our release pipeline: starts the release checks and reads the results.',
    scopes: ['read', 'write'], disabled: true, created_by: 'priya.shah@example.com', created_at: ago(60 * 24 * 45), last_used: ago(60 * 24 * 9),
    projects: [{ repo: 'acme/soil-sensor', part: 'contributor' }],
    secrets: [{ id: 'e5f6a7b8', created_at: ago(60 * 24 * 45) }, { id: 'c9d0e1f2', created_at: ago(60 * 24 * 10) }],
  },
]

const HISTORY: Record<string, ServiceHistoryEntry[]> = {
  'build-dashboard': [
    { at: ago(60 * 24 * 21), by: 'marc@example.com', repo: 'acme/soil-sensor', action: 'assign', detail: 'reviewer', text: 'Marc put it on Soil sensor as a reviewer.' },
    { at: ago(60 * 24 * 20), by: 'marc@example.com', repo: 'acme/motor-driver', action: 'assign', detail: 'reviewer', text: 'Marc put it on Motor driver as a reviewer.' },
  ],
  'release-bot': [
    { at: ago(60 * 24 * 45), by: 'priya.shah@example.com', repo: 'acme/soil-sensor', action: 'assign', detail: 'contributor', text: 'Priya put it on Soil sensor as a contributor.' },
    { at: ago(60 * 24 * 10), by: 'priya.shah@example.com', repo: null, action: 'rotate', detail: null, text: 'Priya made a new secret.' },
    { at: ago(60 * 24 * 9), by: 'marc@example.com', repo: null, action: 'disable', detail: null, text: 'Marc disabled it.' },
  ],
}

const services: Service[] = structuredClone(SERVICES)
const history: Record<string, ServiceHistoryEntry[]> = structuredClone(HISTORY)

const off = () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem('trace.mock.external') === 'off'
const rand = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
const log = (name: string, e: Omit<ServiceHistoryEntry, 'at' | 'by'>) => (history[name] ??= []).push({ at: new Date().toISOString(), by: 'marc@example.com', ...e })

export function servicesAction(name: string, a: Record<string, unknown>): Response | Promise<Response> | null {
  if (!name.startsWith('services.')) return null
  if (off()) return fail(OFF_ERROR)
  const find = () => services.find((s) => s.name === a.name)
  switch (name) {
    case 'services.list': return later(ok({ services, ...ADDRESSES }), 250)
    case 'services.create': {
      const n = String(a.name)
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(n)) return fail('name: 2 to 40 lower-case letters, digits and dashes, starting with a letter')
      if (services.some((s) => s.name === n)) return fail(`a connected system called ${n} already exists`)
      const scopes = (a.scopes as Service['scopes']) ?? ['read']
      const write = scopes.includes('write')
      const s: Service = {
        client_id: rand(26), name: n, description: String(a.description ?? ''), scopes, disabled: false, created_by: 'marc@example.com',
        created_at: new Date().toISOString(), last_used: null,
        projects: ((a.projects as Service['projects']) ?? []).map((p) => ({ repo: p.repo, part: write ? p.part : 'reviewer' })),
        secrets: [{ id: rand(8), created_at: new Date().toISOString() }],
      }
      services.push(s)
      for (const p of s.projects) log(n, { repo: p.repo, action: 'assign', detail: p.part, text: `Marc put it on ${p.repo} as a ${p.part}.` })
      return later(ok({ service: s, client_id: s.client_id, secret: `${rand(20)}${rand(20)}${rand(12)}`, ...ADDRESSES }), 700)
    }
    case 'services.update': {
      const s = find()
      if (!s) return fail(`no connected system called ${String(a.name)}`)
      if (typeof a.description === 'string') s.description = a.description
      if (Array.isArray(a.scopes)) {
        s.scopes = a.scopes as Service['scopes']
        if (!s.scopes.includes('write')) s.projects = s.projects.map((p) => ({ ...p, part: 'reviewer' }))
        log(s.name, { repo: null, action: 'scopes', detail: s.scopes.join(' '), text: `Marc changed what it may do to ${s.scopes.includes('write') ? 'read and change' : 'read only'}.` })
      }
      if (typeof a.disabled === 'boolean') {
        s.disabled = a.disabled
        log(s.name, { repo: null, action: a.disabled ? 'disable' : 'enable', detail: null, text: `Marc ${a.disabled ? 'disabled' : 'enabled'} it.` })
      }
      return later(ok({ service: s }), 300)
    }
    case 'services.assign': {
      const s = find()
      if (!s) return fail(`no connected system called ${String(a.name)}`)
      const part = s.scopes.includes('write') ? ((a.part as 'contributor' | 'reviewer') ?? 'contributor') : 'reviewer'
      const repo = String(a.repo)
      s.projects = [...s.projects.filter((p) => p.repo !== repo), { repo, part }]
      log(s.name, { repo, action: 'assign', detail: part, text: `Marc put it on ${repo} as a ${part}.` })
      return later(ok({ name: s.name, repo, part }), 300)
    }
    case 'services.unassign': {
      const s = find()
      if (!s) return fail(`no connected system called ${String(a.name)}`)
      const was = s.projects.some((p) => p.repo === a.repo)
      s.projects = s.projects.filter((p) => p.repo !== a.repo)
      if (was) log(s.name, { repo: String(a.repo), action: 'unassign', detail: null, text: `Marc took it off ${String(a.repo)}.` })
      return later(ok({ removed: was }), 300)
    }
    case 'services.rotate': {
      const s = find()
      if (!s) return fail(`no connected system called ${String(a.name)}`)
      if ((s.secrets ?? []).length >= 2) return fail('it already has two secrets: retire the old one first')
      const id = rand(8)
      s.secrets = [...(s.secrets ?? []), { id, created_at: new Date().toISOString() }]
      log(s.name, { repo: null, action: 'rotate', detail: id, text: 'Marc made a new secret.' })
      return later(ok({ secret: `${rand(20)}${rand(20)}${rand(12)}`, secret_id: id, ...ADDRESSES }), 600)
    }
    case 'services.retire_secret': {
      const s = find()
      if (!s) return fail(`no connected system called ${String(a.name)}`)
      const before = (s.secrets ?? []).length
      s.secrets = (s.secrets ?? []).filter((x) => x.id !== a.secret_id)
      const removed = s.secrets.length < before
      if (removed) log(s.name, { repo: null, action: 'retire_secret', detail: String(a.secret_id), text: 'Marc retired an old secret.' })
      return later(ok({ removed }), 300)
    }
    case 'services.delete': {
      const i = services.findIndex((s) => s.name === a.name)
      if (i < 0) return fail(`no connected system called ${String(a.name)}`)
      services.splice(i, 1)
      return later(ok({ deleted: true }), 500)
    }
    case 'services.history': return ok({ entries: [...(history[String(a.name)] ?? [])].reverse() })
    default: return fail(`mock: no fixture for ${name}`)
  }
}
