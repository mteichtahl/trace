/** `tracectl services …`: what it asks the API (a fake one) and what it prints. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cmdServices, keysText, parseProject, plain, since } from '../../src/login/services.js'
import { ApiError } from '../../src/login/invoke.js'

const NOW = Date.parse('2026-10-28T10:00:00Z')
const SERVICES = [
  { client_id: 'c-ci', name: 'ci-dashboard', description: 'Shows build status on the wall', scopes: ['read'], disabled: false, created_by: 'marc@example.com', created_at: '2026-10-01T09:00:00Z', last_used: '2026-10-28T09:57:00Z', projects: [{ repo: 'acme/soil-sensor', part: 'reviewer' }], secrets: [{ id: 's1', created_at: '2026-10-01T09:00:00Z' }, { id: 's2', created_at: '2026-10-20T09:00:00Z' }] },
  { client_id: 'c-bot', name: 'review-bot', description: '', scopes: ['read', 'write'], disabled: true, created_by: 'marc@example.com', created_at: '2026-10-02T09:00:00Z', last_used: null, projects: [] },
]

let calls: { action: string; args: unknown }[] = []
let answer: (action: string, args: Record<string, unknown>) => unknown
const invoke = async (action: string, args: Record<string, unknown> = {}) => { calls.push({ action, args }); return answer(action, args) }
const run = (argv: string[], o: { confirm?: (n: string) => Promise<boolean> } = {}) => cmdServices(argv, { invoke, now: () => NOW, ...o })

let printed: string[] = []
const text = () => printed.join('')
beforeEach(() => {
  calls = []
  printed = []
  answer = (action) => {
    switch (action) {
      case 'services.list': return { services: SERVICES }
      case 'services.create': return { service: SERVICES[0], client_id: 'c-new', secret: 'TOP-SECRET-VALUE', token_url: 'https://t.auth.example.com/oauth2/token', api_url: 'https://api.example.com/invocations', mcp_url: 'https://mcp.example.com/invocations', resource_server: 'trace-external' }
      case 'services.rotate': return { secret: 'NEW-SECRET', secret_id: 's3' }
      case 'services.assign': return { name: 'ci-dashboard', repo: 'acme/motor-driver', part: 'reviewer' }
      case 'services.unassign': case 'services.retire_secret': return { removed: true }
      case 'services.delete': return { deleted: true }
      case 'services.history': return { entries: [{ at: '2026-10-01T09:00:00Z', by: 'marc@example.com', repo: 'acme/soil-sensor', action: 'assign', detail: 'reviewer', text: 'marc@example.com put ci-dashboard on acme/soil-sensor as a reviewer' }] }
      default: return { service: SERVICES[0] }
    }
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

describe('parsing', () => {
  it('reads OWNER/REPO[:part], defaulting by what the system may do; a read-only system is only ever a reviewer', () => {
    expect(parseProject('acme/board', 'read')).toEqual({ repo: 'acme/board', part: 'reviewer' })
    expect(parseProject('acme/board', 'write')).toEqual({ repo: 'acme/board', part: 'contributor' })
    expect(parseProject('acme/board:reviewer', 'write')).toEqual({ repo: 'acme/board', part: 'reviewer' })
    expect(() => parseProject('acme/board:contributor', 'read')).toThrow(/only be a reviewer/)
    expect(() => parseProject('board', 'read')).toThrow(/OWNER\/REPO/)
  })
  it('says how long ago in words', () => {
    expect(since(null, NOW)).toBe('never')
    expect(since('2026-10-28T09:57:00Z', NOW)).toBe('3 minutes ago')
    expect(since('2026-10-26T10:00:00Z', NOW)).toBe('2 days ago')
  })
})

describe('tracectl services', () => {
  it('lists every system with what it can do, its status and when it was last used', async () => {
    expect(await run(['list'])).toBe(0)
    expect(calls).toEqual([{ action: 'services.list', args: {} }])
    expect(text()).toMatch(/ci-dashboard\s+read only\s+active\s+1 project\s+last used 3 minutes ago/)
    expect(text()).toMatch(/review-bot\s+read and change\s+disabled\s+0 projects\s+last used never/)
  })

  it('--json prints the answer as it came', async () => {
    expect(await run(['list', '--json'])).toBe(0)
    expect(JSON.parse(text())).toEqual({ services: SERVICES })
  })

  it('shows one system: projects, secret ids (never values) and the retire recommendation', async () => {
    expect(await run(['show', 'ci-dashboard'])).toBe(0)
    expect(text()).toMatch(/acme\/soil-sensor\s+reviewer/)
    expect(text()).toMatch(/s1 {2}created 2026-10-01 09:00/)
    expect(text()).toMatch(/retire the older one/)
    printed = []
    expect(await run(['show', 'nobody'])).toBe(1)
    expect(text()).toMatch(/no connected system called nobody/)
  })

  it('creates with scopes and projects, printing the secret once with the addresses and a curl line', async () => {
    expect(await run(['create', 'ci-dashboard', '--scope', 'write', '--description', 'Builds', '--project', 'acme/a', '--project', 'acme/b:reviewer'])).toBe(0)
    expect(calls[0]).toEqual({ action: 'services.create', args: { name: 'ci-dashboard', description: 'Builds', scopes: ['read', 'write'], projects: [{ repo: 'acme/a', part: 'contributor' }, { repo: 'acme/b', part: 'reviewer' }] } })
    const t = text()
    expect(t).toContain('Client id:  c-new')
    expect(t).toContain('Secret:     TOP-SECRET-VALUE')
    expect(t.match(/TOP-SECRET-VALUE/g)).toHaveLength(1)
    expect(t).toMatch(/shown once — store it now/)
    expect(t).toContain('https://t.auth.example.com/oauth2/token')
    expect(t).toContain('https://api.example.com/invocations')
    expect(t).toContain('https://mcp.example.com/invocations')
    expect(t).toContain('curl -s -u "c-new:$TRACE_CLIENT_SECRET" -d grant_type=client_credentials --data-urlencode "scope=trace-external/read trace-external/write"')
    expect(t).toMatch(/Amazon Cognito charges/)
  })

  it('refuses a bad name, a missing scope and a read-only contributor before asking the API', async () => {
    expect(await run(['create', 'CI', '--scope', 'read'])).toBe(2)
    expect(await run(['create', 'ci', '--scope', 'everything'])).toBe(2)
    expect(await run(['create', 'ci'])).toBe(2)
    expect(await run(['create', 'ci', '--scope', 'read', '--project', 'acme/a:contributor'])).toBe(2)
    expect(await run(['create', 'ci', '--scope', 'read', '--nope'])).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('disables, enables and changes scopes through services.update', async () => {
    expect(await run(['disable', 'ci-dashboard'])).toBe(0)
    expect(await run(['enable', 'ci-dashboard'])).toBe(0)
    expect(await run(['scopes', 'ci-dashboard', 'read'])).toBe(0)
    expect(calls.map((c) => c.args)).toEqual([{ name: 'ci-dashboard', disabled: true }, { name: 'ci-dashboard', disabled: false }, { name: 'ci-dashboard', scopes: ['read'] }])
    expect(text()).toMatch(/stop working within 30 seconds/)
  })

  it('assigns, unassigns, retires a secret and reads the history', async () => {
    expect(await run(['assign', 'ci-dashboard', 'acme/motor-driver', '--part', 'contributor'])).toBe(0)
    expect(calls[0]).toEqual({ action: 'services.assign', args: { name: 'ci-dashboard', repo: 'acme/motor-driver', part: 'contributor' } })
    expect(text()).toMatch(/as a reviewer\. \(A read-only system is always a reviewer\.\)/)
    expect(await run(['unassign', 'ci-dashboard', 'acme/motor-driver'])).toBe(0)
    expect(await run(['retire-secret', 'ci-dashboard', 's1'])).toBe(0)
    expect(calls[2]).toEqual({ action: 'services.retire_secret', args: { name: 'ci-dashboard', secret_id: 's1' } })
    expect(await run(['history', 'ci-dashboard'])).toBe(0)
    expect(text()).toMatch(/2026-10-01 09:00 {2}marc@example.com put ci-dashboard on acme\/soil-sensor/)
  })

  it('rotates: the new secret once, the client id looked up when the answer lacks it', async () => {
    expect(await run(['rotate', 'ci-dashboard'])).toBe(0)
    expect(calls.map((c) => c.action)).toEqual(['services.rotate', 'services.list'])
    expect(text()).toContain('Client id:  c-ci')
    expect(text()).toContain('Secret:     NEW-SECRET')
    expect(text()).toMatch(/shown once/)
    expect(text()).toMatch(/scope=trace-external\/read"/)
    // what to do when the old secret leaked
    expect(text()).toMatch(/If the old secret leaked: disable ci-dashboard first .*then rotate, retire the old secret, and enable it again/)
  })

  it('prints a description without its control characters or escape sequences', async () => {
    const evil = 'Wall screen\u001b[2J\u001b[1;1H\u001b]0;pwned\u0007\rFAKE\u0000\u009b31m line'
    answer = (action) => (action === 'services.list' ? { services: [{ ...SERVICES[0], description: evil, created_by: 'x\u001b[31m@y' }] } : {})
    expect(await run(['show', 'ci-dashboard'])).toBe(0)
    expect(text()).toContain('Wall screen FAKE line')
    expect(text()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(plain('a\u001b[0mb\u001bPc\td\ne')).toBe('abc d e')
  })

  it('asks before deleting unless --yes', async () => {
    expect(await run(['delete', 'ci-dashboard'], { confirm: async () => false })).toBe(1)
    expect(calls).toHaveLength(0)
    expect(await run(['delete', 'ci-dashboard'], { confirm: async (n) => n === 'ci-dashboard' })).toBe(0)
    expect(await run(['delete', 'ci-dashboard', '--yes'], { confirm: async () => { throw new Error('should not ask') } })).toBe(0)
    expect(calls.map((c) => c.action)).toEqual(['services.delete', 'services.delete'])
  })

  it('prints the API\'s words when external access is off, and usage for an unknown command', async () => {
    answer = () => { throw new ApiError(200, 'External access is off for this installation. Turn it on in the installer (External access).') }
    expect(await run(['list'])).toBe(1)
    expect(text()).toMatch(/External access is off.*installer/)
    printed = []
    expect(await run(['frobnicate'])).toBe(2)
    expect(text()).toMatch(/usage: tracectl services list/)
  })

  it('keysText leaves out the API line when there is no API address', () => {
    const t = keysText({ name: 'x', client_id: 'c', secret: 's', scopes: ['read'] })
    expect(t).not.toMatch(/Bearer/)
    expect(t).toMatch(/<token address>/)
  })
})
