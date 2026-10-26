/**
 * The people-facing CLI commands (wired in src/cli.ts, one case each):
 *
 *   trace connect --region R --pool ID --client ID --domain URL --api ARN [--name N] [--ports 47821,47822]
 *   trace login | trace logout | trace whoami
 *   trace remote projects
 *   trace remote status OWNER/REPO
 *   trace remote settings OWNER/REPO [KEY [VALUE]]      (VALUE "--unset" removes the setting)
 *   trace remote runs OWNER/REPO [--kind K] [--limit N]
 *   trace remote task OWNER/REPO "request…"
 *   trace remote job ID
 *   trace remote memory list OWNER/REPO [--all] | deactivate OWNER/REPO RECORD_ID --reason "…" | reactivate OWNER/REPO RECORD_ID
 *                                                       (src/login/memory.ts)
 *   trace remote kb search OWNER/REPO "query" [--top N] [--source S] [--kind K] [--path P] | sync OWNER/REPO [--force]
 *                                                       (src/login/kb.ts)
 *   trace users list | invite EMAIL [--class user|guest|admin] | class EMAIL CLASS
 *              | assign EMAIL OWNER/REPO | unassign EMAIL OWNER/REPO | assignments [OWNER/REPO]
 *
 * Each returns the exit code; problems are printed, never thrown to the caller.
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { SpecialistKindSchema } from '../agents/kinds.js'
import { CLASSES } from '../core/access.js'
import { installation, saveInstallation, session } from '../core/client.js'
import { parseCliValue } from '../core/config.js'
import { ApiError, invokeApi } from './invoke.js'
import { remoteKb } from './kb.js'
import { remoteMemory } from './memory.js'
import { LoginError, NO_INSTALLATION, login, logout } from './oauth.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

function show(v: unknown): void {
  out(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

async function guarded(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof LoginError || e instanceof ApiError) { err(`trace: ${e.message}`); return 1 }
    if (e instanceof z.ZodError) { err(`trace: ${e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`); return 2 }
    if (e instanceof TypeError && /parseArgs|Unknown option|ERR_PARSE_ARGS/.test(`${e.message} ${(e as { code?: string }).code ?? ''}`)) { err(`trace: ${e.message}`); return 2 }
    throw e
  }
}

const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')

// ------------------------------------------------------------------ connect / login / logout / whoami

const ConnectArgs = z.object({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  pool: z.string().min(1),
  client: z.string().min(1),
  domain: z.string().url(),
  api: z.string().startsWith('arn:aws', 'the API runtime ARN'),
  name: z.string().min(1).default('default'),
  ports: z.string().regex(/^\d+(,\d+)*$/).default('47821,47822'),
  worker: z.string().default(''),
  home: z.string().default(''),
})

export async function cmdConnect(argv: string[]): Promise<number> {
  return guarded(async () => {
    const { values } = parseArgs({ args: argv, options: {
      region: { type: 'string' }, pool: { type: 'string' }, client: { type: 'string' }, domain: { type: 'string' }, api: { type: 'string' },
      name: { type: 'string' }, ports: { type: 'string' }, worker: { type: 'string' }, home: { type: 'string' },
    } })
    const parsed = ConnectArgs.safeParse(values)
    if (!parsed.success) {
      err(`trace connect: ${parsed.error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('; ')}`)
      err('usage: trace connect --region R --pool POOL_ID --client CLIENT_ID --domain https://….amazoncognito.com --api API_RUNTIME_ARN')
      return 2
    }
    const a = parsed.data
    const account = /^arn:aws[^:]*:bedrock-agentcore:[^:]+:(\d{12}):/.exec(a.api)?.[1] ?? ''
    saveInstallation({
      name: a.name, region: a.region, account, stack: '', traceHome: a.home, userPoolId: a.pool, clientId: a.client,
      cognitoDomain: a.domain, apiRuntimeArn: a.api, workerRuntimeArn: a.worker, actionsRoleArn: '', githubSecretArn: '',
      callbackPorts: a.ports.split(',').map(Number),
    })
    out(`Connected to the trace installation "${a.name}" (${a.region}). Next: trace login`)
    return 0
  })
}

export async function cmdLogin(_argv: string[]): Promise<number> {
  return guarded(async () => {
    const i = installation()
    if (!i) { err(NO_INSTALLATION); return 1 }
    const s = await login(i)
    out(`Signed in as ${s.email ?? s.sub}${s.groups.length ? ` (${s.groups.join(', ')})` : ''}.`)
    return 0
  })
}

export async function cmdLogout(_argv: string[]): Promise<number> {
  return guarded(async () => {
    out((await logout()) ? 'Signed out.' : 'Not signed in.')
    return 0
  })
}

export async function cmdWhoami(_argv: string[]): Promise<number> {
  return guarded(async () => {
    if (!installation()) { err(NO_INSTALLATION); return 1 }
    if (!session()) { err('Not signed in: run `trace login`.'); return 1 }
    const r = z.object({ sub: z.string(), email: z.string().nullable(), class: z.string().nullable(), groups: z.array(z.string()) }).loose().parse(await invokeApi('whoami'))
    out(`${r.email ?? r.sub}  class: ${r.class ?? 'none (no access)'}  sub: ${r.sub}`)
    return 0
  })
}

// ------------------------------------------------------------------ remote

const REMOTE_USAGE = 'usage: trace remote projects | status OWNER/REPO | settings OWNER/REPO [KEY [VALUE|--unset]] | runs OWNER/REPO [--kind K] [--limit N] | task OWNER/REPO [--agent verify|impl|ams|emc|render] "request" | job ID | memory list|deactivate|reactivate OWNER/REPO … | kb search|sync OWNER/REPO …'

export async function cmdRemote(argv: string[]): Promise<number> {
  return guarded(async () => {
    const [sub, ...rest] = argv
    switch (sub) {
      case 'projects': {
        const list = z.array(z.object({ repo: z.string(), role: z.string() })).parse(await invokeApi('projects'))
        if (!list.length) out('No projects: ask an admin to assign you to one.')
        for (const p of list) out(`${p.repo.padEnd(40)} ${p.role}`)
        return 0
      }
      case 'status': {
        if (!rest[0]) break
        show(await invokeApi('status', { repo: Repo.parse(rest[0]) }))
        return 0
      }
      case 'settings': {
        const [repo, key, value] = rest
        if (!repo) break
        const r = Repo.parse(repo)
        if (key === undefined) {
          const s = z.object({ set: z.record(z.string(), z.unknown()), errors: z.array(z.string()) }).loose().parse(await invokeApi('settings.get', { repo: r }))
          for (const [k, v] of Object.entries(s.set)) out(`${k} = ${JSON.stringify(v)}`)
          if (!Object.keys(s.set).length) out('(every setting at its default)')
          for (const e of s.errors) err(`error: ${e}`)
          return 0
        }
        if (value === undefined) {
          const s = z.object({ config: z.record(z.string(), z.unknown()) }).loose().parse(await invokeApi('settings.get', { repo: r }))
          let node: unknown = s.config
          for (const part of key.split('.')) node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
          if (node === undefined) { err(`no setting ${key}`); return 1 }
          out(JSON.stringify(node, null, 1))
          return 0
        }
        const res = z.object({ branch: z.string(), commit: z.string() }).loose().parse(await invokeApi('settings.set',
          value === '--unset' ? { repo: r, key, unset: true } : { repo: r, key, value: parseCliValue(value) }))
        out(`Committed to ${res.branch} (${res.commit.slice(0, 12)}); the pull request opens itself.`)
        return 0
      }
      case 'runs': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { kind: { type: 'string' }, limit: { type: 'string' } } })
        if (!positionals[0]) break
        const runs = z.array(z.object({ id: z.string(), kind: z.string(), subject: z.string().nullable(), started: z.number(), status: z.string(), summary: z.string().nullable() }).loose())
          .parse(await invokeApi('runs', { repo: Repo.parse(positionals[0]), ...(values.kind ? { kind: values.kind } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) }))
        for (const r of runs) out(`${r.id}  ${new Date(r.started * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${r.status.padEnd(7)} ${r.kind.padEnd(22)} ${r.subject ?? ''}  ${r.summary ?? ''}`)
        return 0
      }
      case 'task': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { agent: { type: 'string' } } })
        const [repo, ...words] = positionals
        if (!repo || !words.length) break
        // without --agent the runtime routes it to a specialist (trace agent route "<request>" shows where)
        const agent = values.agent === undefined ? undefined : SpecialistKindSchema.parse(values.agent)
        const r = z.object({ accepted: z.boolean(), jobId: z.string(), reason: z.string().optional() }).loose()
          .parse(await invokeApi('task', { repo: Repo.parse(repo), request: words.join(' '), ...(agent ? { agent } : {}) }))
        out(r.accepted ? `Started ${r.jobId}. Follow it with: trace remote job ${r.jobId}` : `Not started (${r.reason ?? 'refused'}); the running job is ${r.jobId}.`)
        return 0
      }
      case 'memory': return remoteMemory(rest)
      case 'kb': return remoteKb(rest)
      case 'job': {
        if (!rest[0]) break
        show(await invokeApi('job', { id: rest[0] }))
        return 0
      }
    }
    err(REMOTE_USAGE)
    return 2
  })
}

// ------------------------------------------------------------------ users (admins)

const USERS_USAGE = 'usage: trace users list | invite EMAIL [--class user|guest|admin] | class EMAIL user|guest|admin | assign EMAIL OWNER/REPO | unassign EMAIL OWNER/REPO | assignments [OWNER/REPO]'
const Cls = z.enum(CLASSES)

export async function cmdUsers(argv: string[]): Promise<number> {
  return guarded(async () => {
    const [sub, ...rest] = argv
    switch (sub) {
      case 'list': {
        const users = z.array(z.object({ email: z.string().nullable(), sub: z.string(), status: z.string().nullable(), class: z.string().nullable(), projects: z.array(z.string()) }).loose())
          .parse(await invokeApi('users.list'))
        for (const u of users) out(`${(u.email ?? u.sub).padEnd(36)} ${(u.class ?? 'none').padEnd(6)} ${(u.status ?? '').padEnd(22)} ${u.projects.join(', ')}`)
        return 0
      }
      case 'invite': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { class: { type: 'string' } } })
        if (!positionals[0]) break
        const r = z.object({ sub: z.string(), class: z.string() }).loose().parse(await invokeApi('users.invite', { email: positionals[0], class: Cls.parse(values.class ?? 'user') }))
        out(`Invited ${positionals[0]} as ${r.class} (sub ${r.sub}); Cognito emails them a temporary password.`)
        return 0
      }
      case 'class': {
        const [who, cls] = rest
        if (!who || !cls) break
        await invokeApi('users.class', { who, class: Cls.parse(cls) })
        out(`${who} is now ${cls}. It takes effect when their token next refreshes (within an hour).`)
        return 0
      }
      case 'assign': case 'unassign': {
        const [who, repo] = rest
        if (!who || !repo) break
        const r = await invokeApi(sub, { who, repo: Repo.parse(repo) })
        if (sub === 'assign') out(`${who} is assigned to ${repo.toLowerCase()}.`)
        else out(z.object({ removed: z.boolean() }).loose().parse(r).removed ? `${who} is no longer assigned to ${repo.toLowerCase()}.` : `${who} was not assigned to ${repo.toLowerCase()}.`)
        return 0
      }
      case 'assignments': {
        const list = z.array(z.object({ repo: z.string(), email: z.string().nullable(), sub: z.string(), class: z.string().nullable() }).loose())
          .parse(await invokeApi('assignments', rest[0] ? { repo: Repo.parse(rest[0]) } : {}))
        for (const a of list) out(`${a.repo.padEnd(40)} ${(a.email ?? a.sub).padEnd(36)} ${a.class ?? 'none'}`)
        return 0
      }
    }
    err(USERS_USAGE)
    return 2
  })
}
