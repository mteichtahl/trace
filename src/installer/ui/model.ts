/**
 * The installer page's model: its state, the answers and secrets built from it, and every check of what the person
 * typed. Pure (no DOM, no fetch), so it is unit tested (test/installer/ui-model.test.ts) and the screens only draw it.
 *
 * Validation happens in three layers, each said next to the field it is about:
 *   1. the shape of what was typed, as it is typed (a token that cannot be one, an access key id of the wrong form,
 *      a number out of range, an email that is not one)
 *   2. the same zod schemas the server uses (answers.ts), so nothing the page accepts is refused at install time
 *   3. what only AWS and GitHub can say (the preflight's findings), shown on the step they belong to
 * A step's Continue stays off while it has a blocker, and the blocker is named beside it.
 */
import { INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName } from '../../core/integrations-catalog.js'
import { type AnswersInput, AnswersSchema, type Check, RUNNER_AUTH, RUNNER_COMPUTE_TYPES, type Step, type WaitNoticeView } from '../answers.js'

// ------------------------------------------------------------------ the server's answers (shapes the page relies on)

export interface RepoAccess { repo: string; visible: boolean; configure: boolean; administer: boolean; webhooks: boolean; missing: string[] }
export interface TokenRepo { fullName: string; private: boolean; admin: boolean; push: boolean; defaultBranch: string }
export interface TokenInfo { login: string; name: string | null; kind: string; scopes: string[]; warnings: string[]; repos: TokenRepo[] }
export interface GithubCheck extends TokenInfo {
  access: (RepoAccess | { repo: string; ok: boolean; reason: string })[]
  self: { repo: string; ok: boolean; reason: string } | null
}
export interface Preflight {
  checks: Check[]; ok: boolean; token: TokenInfo | null; repos: RepoAccess[]; region: string; profileRegion: string
  /** trace's own repository, and whether the token can set its variables (null: the installer could not tell which) */
  self: { repo: string; ok: boolean; reason: string } | null
  facts: {
    account?: string; arn?: string; login?: string; email?: string | null; models?: { id: string; name: string }[]
    gpuQuota?: number | null; cpuQuota?: number | null; s3vectors?: boolean | null; sourceAdmin?: boolean | null
    publishedRegistry?: string | null; oidcProvider?: boolean; cdkBootstrapped?: boolean
    existing?: { status: string; outputs: Record<string, string> } | null
    runnerConnection?: string | null
    githubConnections?: { name: string; status: string; arn: string }[]
  }
}
export interface Progress { id: string; label: string; state: 'running' | 'done' | 'failed'; detail?: string }
export interface Env {
  profiles: { names: string[]; regions: Record<string, string> }
  saved: AnswersInput | null
  installed: { stack: string; region: string } | null
  node: string
  defaultRegion: string
}

// ------------------------------------------------------------------ steps

export const STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'github', title: 'GitHub' },
  { id: 'aws', title: 'AWS' },
  { id: 'projects', title: 'Projects' },
  { id: 'people', title: 'People' },
  { id: 'optional', title: 'Optional' },
  { id: 'review', title: 'Review' },
] as const
export type StepId = (typeof STEPS)[number]['id'] | 'install'

export const REGIONS = [
  { id: 'us-east-1', name: 'US East (N. Virginia)' }, { id: 'us-east-2', name: 'US East (Ohio)' }, { id: 'us-west-2', name: 'US West (Oregon)' },
  { id: 'ca-central-1', name: 'Canada (Central)' }, { id: 'sa-east-1', name: 'South America (São Paulo)' },
  { id: 'eu-central-1', name: 'Europe (Frankfurt)' }, { id: 'eu-west-1', name: 'Europe (Ireland)' }, { id: 'eu-west-2', name: 'Europe (London)' },
  { id: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' }, { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' }, { id: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
] as const

export type PersonClass = 'admin' | 'user' | 'guest'
export interface Person { id: number; email: string; class: PersonClass; projects: Set<string> }
export type Template = 'empty' | 'python' | 'kicad' | 'rust' | 'sample'
export interface Project { branch: string; onboard: boolean; applySettings: boolean; memoryDays: string; generation: number; create: { template: Template; private: boolean } | null }

/** The numbers under Advanced, kept as the text typed (so a half-typed value is shown, and checked, as it is). */
export const NUMBERS = {
  maxLifetimeHours: { label: 'Longest task', unit: 'hours', min: 0.25, max: 8, int: false, def: 8 },
  idleMinutes: { label: 'Idle session ends after', unit: 'minutes', min: 1, max: 480, int: true, def: 15 },
  gpuMaxVcpus: { label: 'GPU vCPUs at once', unit: 'vCPUs', min: 4, max: 4096, int: true, def: 16 },
  cpuMaxVcpus: { label: 'CPU vCPUs at once', unit: 'vCPUs', min: 1, max: 4096, int: true, def: 64 },
  cpuVcpus: { label: 'vCPUs per CPU job', unit: 'vCPUs', min: 1, max: 192, int: true, def: 16 },
  cpuMemoryMiB: { label: 'Memory per CPU job', unit: 'MiB', min: 1024, max: 1_572_864, int: true, def: 32_768 },
} as const
export type NumberField = keyof typeof NUMBERS

export function initialState() {
  return {
    step: 'welcome' as StepId,
    /** the steps the person has continued from */
    visited: new Set<StepId>(['welcome']),
    /** fields the person has left (their problems show from then on), and steps they tried to continue from (all show) */
    touched: new Set<string>(),
    tried: new Set<StepId>(),
    env: null as Env | null,
    bootError: '',
    aws: { mode: 'profile' as 'profile' | 'keys', profile: 'default', region: '', keyId: '', secret: '', session: '' },
    github: { token: '', adminToken: '' },
    /** the GitHub step's check, and the token it was for */
    gh: null as GithubCheck | null, ghFor: '', ghBusy: false, ghError: '',
    /** the preflight's result, and the inputs it was for (preflightKey): stale once they change */
    pre: null as Preflight | null, preKey: '', preBusy: false, preError: '',
    preProgress: [] as Progress[],
    fixBusy: '', fixNote: new Map<string, string>(),
    useCase: { open: false, companyName: '', companyWebsite: '', intendedUsers: '0' as '0' | '1' | '2', industryOption: 'Technology', otherIndustryOption: '', useCases: 'Autonomous coding agents that maintain our own electronics and firmware repositories (fixing CI failures, reviewing designs) on Amazon Bedrock AgentCore.' },
    projects: new Map<string, Project>(),
    filter: '',
    newRepo: { name: '', template: 'kicad' as Exclude<Template, 'sample'>, private: true },
    sample: { name: '', private: true, tour: true, repo: '' },
    projectTokens: new Map<string, string>(),
    integrations: Object.fromEntries(INTEGRATION_NAMES.map((n) => [n, Object.fromEntries(INTEGRATIONS[n].keys.map((k) => [k, '']))])) as Record<IntegrationName, Record<string, string>>,
    integrationCheck: new Map<IntegrationName, { ok: boolean; detail: string } | 'busy'>(),
    agents: {
      prefix: 'trace', model: '', centralBucketName: '', retainData: true, escalateTo: '',
      maxLifetimeHours: '8', idleMinutes: '15',
      gpuEnabled: null as boolean | null, gpuMaxVcpus: '16', gpuSpot: false,
      cpuEnabled: null as boolean | null, cpuMaxVcpus: '64', cpuSpot: false, cpuVcpus: '16', cpuMemoryMiB: '32768',
      knowledgeBase: null as boolean | null, libraryGateway: false,
      webEnabled: true, webDomain: '', webCertificateArn: '', webEmailFrom: '', webWaf: true,
      observability: true, transactionSearch: true, samplingPercent: '', dashboard: true, migrateLayout: false,
      imageSource: 'prebuilt' as 'prebuilt' | 'build', imageRegistry: '', publishImages: null as boolean | null,
    },
    runners: {
      auth: 'auto' as (typeof RUNNER_AUTH)[number], token: 'agent' as 'agent' | 'admin', connectionArn: '', connectionOther: false,
      computeType: '' as '' | (typeof RUNNER_COMPUTE_TYPES)[number], privileged: 'default' as 'default' | 'on' | 'off',
      buildTrace: null as boolean | null, selfUpdate: true,
    },
    adminEmail: '',
    people: [] as Person[],
    nextPersonId: 1,
    plan: null as Step[] | null, planKey: '', timeline: [] as string[], changes: [] as string[], planError: '', planBusy: false,
    /** the installation, once started */
    steps: [] as Step[],
    log: [] as string[],
    ready: null as string[] | null,
    result: null as { ok: boolean; summary: string[] } | null,
    appUrl: '',
    waits: new Map<string, { wait: WaitNoticeView; asked: boolean; error: string }>(),
  }
}
export type State = ReturnType<typeof initialState>

// ------------------------------------------------------------------ field checks (layer 1)

/** The kinds of GitHub token, by prefix (https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/). */
export function tokenKind(t: string): 'fine-grained' | 'classic' | 'oauth' | 'app' | 'unknown' {
  if (t.startsWith('github_pat_')) return 'fine-grained'
  if (t.startsWith('ghp_')) return 'classic'
  if (t.startsWith('gho_') || t.startsWith('ghu_')) return 'oauth'
  if (t.startsWith('ghs_')) return 'app'
  return 'unknown'
}

/** What is wrong with a GitHub token as typed ('' when nothing is), before GitHub is asked. */
export function githubTokenError(raw: string, required = true): string {
  const t = raw.trim()
  if (!t) return required ? 'Paste a GitHub token.' : ''
  if (/\s/.test(t)) return 'A token has no spaces or line breaks: copy it again.'
  if (t.length < 20) return 'That is too short to be a GitHub token.'
  const kind = tokenKind(t)
  if (kind === 'fine-grained' && !/^github_pat_[A-Za-z0-9_]{22,}$/.test(t)) return 'A fine-grained token is github_pat_ followed by letters, digits and underscores: copy it again.'
  if (kind === 'classic' && !/^ghp_[A-Za-z0-9]{36,}$/.test(t)) return 'A classic token is ghp_ followed by 36 letters and digits: copy it again.'
  if (kind === 'app') return 'That is a GitHub App installation token (ghs_), which expires within an hour: use a personal access token.'
  if (kind === 'oauth') return 'That is an OAuth token: use a personal access token (fine-grained or classic).'
  return ''
}
/** A note about a token that is valid but not ideal ('' when none). */
export function githubTokenNote(raw: string): string {
  const t = raw.trim()
  if (tokenKind(t) === 'unknown' && t.length >= 20 && !/\s/.test(t)) return 'This does not look like a GitHub personal access token (github_pat_… or ghp_…); it will be tried anyway.'
  if (tokenKind(t) === 'classic') return 'Works. A fine-grained token limited to trace\'s repositories is safer.'
  return ''
}

export const ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/
/** known: the profiles on this computer (empty: none were found, so any name typed is tried) */
export function awsErrors(a: State['aws'], known: readonly string[] = []): Partial<Record<'profile' | 'keyId' | 'secret' | 'session' | 'region', string>> {
  const e: Partial<Record<'profile' | 'keyId' | 'secret' | 'session' | 'region', string>> = {}
  if (a.mode === 'profile') {
    if (!a.profile.trim()) e.profile = 'Choose or type a profile name.'
    else if (!/^[A-Za-z0-9_.@+-]+$/.test(a.profile.trim())) e.profile = 'A profile name has letters, digits and . _ @ + - only.'
    else if (known.length && !known.includes(a.profile.trim())) e.profile = `There is no profile "${a.profile.trim()}" on this computer: choose one of those listed.`
  } else {
    const id = a.keyId.trim()
    if (!id) e.keyId = 'Paste the access key ID.'
    else if (!ACCESS_KEY_ID.test(id)) e.keyId = 'An access key ID is 20 characters starting AKIA (long-term) or ASIA (temporary).'
    const sec = a.secret.trim()
    if (!sec) e.secret = 'Paste the secret access key.'
    else if (!/^[A-Za-z0-9/+=]{40}$/.test(sec)) e.secret = 'A secret access key is 40 characters of letters, digits, / and +.'
    if (id.startsWith('ASIA') && !a.session.trim()) e.session = 'Temporary keys (ASIA…) need their session token.'
    else if (id.startsWith('AKIA') && a.session.trim()) e.session = 'Long-term keys (AKIA…) have no session token: leave this empty.'
  }
  if (a.region && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(a.region)) e.region = 'An AWS region such as us-east-1.'
  return e
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export const isEmail = (v: string): boolean => EMAIL.test(v.trim())
export const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/** What is wrong with a new repository's name ('' when nothing): OWNER/NAME, or NAME under the token's owner. */
export function newRepoError(name: string, owner: string, taken: (repo: string) => boolean): string {
  const v = name.trim()
  if (!v) return ''
  const slug = v.includes('/') ? v : `${owner}/${v}`
  if (!v.includes('/') && !owner) return 'Write it as OWNER/NAME.'
  const repo = slug.split('/')[1] ?? ''
  if (!REPO.test(slug)) return 'A repository name has letters, digits, and . _ - only (OWNER/NAME).'
  if (repo === '.' || repo === '..' || repo.endsWith('.git')) return 'GitHub does not allow that repository name.'
  if (repo.length > 100) return 'GitHub repository names are at most 100 characters.'
  if (taken(slug)) return `${slug} exists already: tick it in the list instead.`
  return ''
}
export const repoSlug = (name: string, owner: string): string => { const v = name.trim(); return v.includes('/') ? v : `${owner}/${v}` }

export function numberError(k: NumberField, raw: string): string {
  const f = NUMBERS[k]
  const v = raw.trim()
  if (!v) return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return 'A number.'
  if (f.int && !Number.isInteger(n)) return 'A whole number.'
  if (n < f.min || n > f.max) return `Between ${f.min.toLocaleString()} and ${f.max.toLocaleString()} ${f.unit}.`
  if (k === 'gpuMaxVcpus' && n % 4) return 'A multiple of 4 (each GPU job takes 4 vCPUs).'
  return ''
}
const num = (k: NumberField, raw: string): number => (raw.trim() === '' ? NUMBERS[k].def : Number(raw))

// ------------------------------------------------------------------ derived facts

export const region = (s: State): string => s.aws.region || s.pre?.region || (s.aws.mode === 'profile' ? s.env?.profiles.regions[s.aws.profile] : '') || s.env?.defaultRegion || 'us-east-1'
export const owner = (s: State): string => s.gh?.login ?? s.pre?.facts.login ?? ''
export const repoList = (s: State): TokenRepo[] => s.gh?.repos ?? s.pre?.token?.repos ?? []

/** The stack already here keeps every project in itself (layout flat): bootstrap.ts layoutOf. */
export function flatInstall(s: State): boolean {
  const o = s.pre?.facts.existing?.outputs ?? {}
  return o.Layout ? o.Layout === 'flat' : Object.keys(o).length > 0
}
export function sampleRepo(s: State): string | null {
  const creating = [...s.projects].find(([, p]) => p.create?.template === 'sample')?.[0]
  return creating ?? (s.sample.repo && s.projects.has(s.sample.repo) ? s.sample.repo : null)
}
export function selfRepo(s: State): { repo: string; ok: boolean; reason: string } | null {
  const own = s.pre?.self ?? s.gh?.self ?? null
  if (!own || !own.ok || s.projects.has(own.repo)) return null
  return own
}
export const buildTrace = (s: State): boolean => (selfRepo(s) ? s.runners.buildTrace ?? true : false)

// ------------------------------------------------------------------ what is sent

export function answers(s: State): AnswersInput {
  const g = s.agents
  return {
    github: { login: owner(s) },
    aws: { mode: s.aws.mode, profile: s.aws.profile.trim(), region: s.aws.region || s.pre?.region || '', account: s.pre?.facts.account ?? '' },
    agents: {
      prefix: g.prefix, model: g.model,
      maxLifetimeHours: num('maxLifetimeHours', g.maxLifetimeHours), idleMinutes: num('idleMinutes', g.idleMinutes),
      createOidcProvider: !(s.pre?.facts.oidcProvider ?? false), centralBucketName: g.centralBucketName, retainData: g.retainData,
      gpuEnabled: g.gpuEnabled, gpuMaxVcpus: num('gpuMaxVcpus', g.gpuMaxVcpus), gpuSpot: g.gpuSpot,
      cpuEnabled: g.cpuEnabled, cpuMaxVcpus: num('cpuMaxVcpus', g.cpuMaxVcpus), cpuSpot: g.cpuSpot,
      cpuVcpus: num('cpuVcpus', g.cpuVcpus), cpuMemoryMiB: num('cpuMemoryMiB', g.cpuMemoryMiB),
      knowledgeBase: g.knowledgeBase, libraryGateway: g.libraryGateway,
      webEnabled: g.webEnabled, webDomain: g.webEnabled ? g.webDomain : '', webCertificateArn: g.webEnabled ? g.webCertificateArn : '',
      webEmailFrom: g.webEnabled ? g.webEmailFrom : '', webWaf: g.webWaf,
      observability: g.observability, transactionSearch: g.transactionSearch, dashboard: g.dashboard,
      samplingPercent: g.samplingPercent.trim() === '' ? null : Number(g.samplingPercent),
      migrateLayout: g.migrateLayout,
      imageSource: g.imageSource, imageRegistry: g.imageRegistry, publishImages: g.publishImages,
    },
    runners: {
      auth: s.runners.auth, token: s.runners.token,
      connectionArn: s.runners.auth === 'token' ? '' : s.runners.connectionArn, computeType: s.runners.computeType || null,
      privileged: s.runners.privileged === 'default' ? null : s.runners.privileged === 'on',
      buildTrace: buildTrace(s), traceRepository: buildTrace(s) ? selfRepo(s)?.repo ?? '' : '', selfUpdate: s.runners.selfUpdate,
    },
    projects: [...s.projects].map(([repo, { memoryDays, ...p }]) => ({ repo, ...p, memoryEventExpiryDays: memoryDays.trim() === '' ? null : Number(memoryDays) })),
    sample: { enabled: Boolean(sampleRepo(s)), repo: sampleRepo(s) ?? '', private: s.sample.private, tour: s.sample.tour },
    adminEmail: s.adminEmail.trim() || s.pre?.facts.email || '',
    people: s.people.filter((p) => p.email.trim()).map((p) => ({
      email: p.email.trim(), class: p.class,
      projects: p.class === 'admin' ? [] : [...p.projects].filter((r) => s.projects.has(r)),
    })),
    escalateTo: g.escalateTo,
  }
}

export function secrets(s: State): Record<string, unknown> {
  return {
    githubToken: s.github.token.trim(), githubAdminToken: s.github.adminToken.trim(),
    projectTokens: Object.fromEntries([...s.projectTokens].filter(([r, t]) => s.projects.has(r) && t.trim()).map(([r, t]) => [r, t.trim()])),
    awsAccessKeyId: s.aws.mode === 'keys' ? s.aws.keyId.trim() : '', awsSecretAccessKey: s.aws.mode === 'keys' ? s.aws.secret.trim() : '',
    awsSessionToken: s.aws.mode === 'keys' ? s.aws.session.trim() : '',
    integrations: Object.fromEntries(INTEGRATION_NAMES.flatMap((n) => {
      const v = Object.fromEntries(Object.entries(s.integrations[n]).filter(([, x]) => x.trim()).map(([k, x]) => [k, x.trim()]))
      return Object.keys(v).length ? [[n, v]] : []
    })),
  }
}

export const awsBody = (s: State): Record<string, unknown> => ({
  aws: { mode: s.aws.mode, profile: s.aws.profile.trim(), region: s.aws.region },
  secrets: s.aws.mode === 'keys' ? { awsAccessKeyId: s.aws.keyId.trim(), awsSecretAccessKey: s.aws.secret.trim(), awsSessionToken: s.aws.session.trim() } : {},
})

export function preflightBody(s: State): Record<string, unknown> {
  const g = s.agents
  return {
    ...awsBody(s), token: s.github.token.trim(), adminToken: s.github.adminToken.trim(), prefix: g.prefix, model: g.model,
    gpuEnabled: g.gpuEnabled, gpuSpot: g.gpuSpot, cpuSpot: g.cpuSpot, cpuVcpus: num('cpuVcpus', g.cpuVcpus), runnerAuth: s.runners.auth,
    repos: [...s.projects].filter(([, p]) => !p.create).map(([r]) => r), create: [...s.projects].filter(([, p]) => p.create).map(([r]) => r),
  }
}
/** The preflight's result holds while what it was asked about is unchanged. */
export const preflightKey = (s: State): string => JSON.stringify(preflightBody(s))
export const preCurrent = (s: State): boolean => Boolean(s.pre) && s.preKey === preflightKey(s)
/** The plan holds while the answers and the preflight are unchanged. */
export const planKey = (s: State): string => JSON.stringify([answers(s), s.preKey])
export const ghCurrent = (s: State): boolean => Boolean(s.gh) && s.ghFor === s.github.token.trim()

// ------------------------------------------------------------------ the schema's own checks (layer 2), by field

/** Every problem with what was typed, keyed by the field it is about ('agents.prefix', 'people.3.email',
 * 'projects.owner/repo.memoryDays', 'integrations.nexar', ...), worded for the person. */
export function fieldErrors(s: State): Map<string, string> {
  const out = new Map<string, string>()
  const set = (k: string, m: string): void => { if (m && !out.has(k)) out.set(k, m) }
  // layer 1: as typed
  const g = s.agents
  for (const k of Object.keys(NUMBERS) as NumberField[]) set(`agents.${k}`, numberError(k, g[k]))
  if (!g.prefix) set('agents.prefix', 'A prefix is needed: it names every resource.')
  else if (!/^[a-z][a-z0-9-]{1,20}$/.test(g.prefix)) set('agents.prefix', '2 to 21 lower-case letters, digits and dashes, starting with a letter.')
  else if (/aws|amazon|cognito/.test(g.prefix)) set('agents.prefix', 'Sign-in domains may not contain "aws", "amazon" or "cognito".')
  if (g.samplingPercent.trim() !== '') {
    const n = Number(g.samplingPercent)
    if (!Number.isFinite(n) || n < 0 || n > 100) set('agents.samplingPercent', 'A percentage from 0 to 100, or empty.')
  }
  if (g.webEnabled && g.webEmailFrom && !isEmail(g.webEmailFrom)) set('agents.webEmailFrom', 'An email address (a verified Amazon SES sender), or empty.')
  if (s.adminEmail.trim() && !isEmail(s.adminEmail)) set('adminEmail', 'An email address such as you@example.com.')
  if (!s.adminEmail.trim() && s.pre && !s.pre.facts.email) set('adminEmail', 'Enter the first administrator\'s email: the token can\'t see its account\'s.')
  if (githubTokenError(s.github.adminToken, false)) set('github.adminToken', githubTokenError(s.github.adminToken, false))
  for (const [r, t] of s.projectTokens) if (s.projects.has(r)) set(`projectTokens.${r}`, githubTokenError(t, false))
  for (const [r, p] of s.projects) {
    const v = p.memoryDays.trim()
    if (v && !(Number.isInteger(Number(v)) && Number(v) >= 3 && Number(v) <= 365)) set(`projects.${r}.memoryDays`, 'A whole number of days from 3 to 365, or empty for 30.')
  }
  const emails = new Map<string, number>()
  const admin = (s.adminEmail.trim() || s.pre?.facts.email || '').toLowerCase()
  for (const p of s.people) {
    const e = p.email.trim().toLowerCase()
    if (!e) set(`people.${p.id}.email`, 'Enter their email, or remove the row.')
    else if (!isEmail(e)) set(`people.${p.id}.email`, 'An email address such as name@example.com.')
    else if (e === admin) set(`people.${p.id}.email`, 'This is the first administrator already: remove the row.')
    else if (emails.has(e)) set(`people.${p.id}.email`, 'Listed twice: remove one row.')
    emails.set(e, p.id)
  }
  for (const n of INTEGRATION_NAMES) {
    const v = s.integrations[n]
    const filled = INTEGRATIONS[n].keys.filter((k) => (v[k] ?? '').trim())
    if (filled.length && filled.length < INTEGRATIONS[n].keys.length) set(`integrations.${n}`, `${INTEGRATIONS[n].title} needs all of ${INTEGRATIONS[n].keys.join(' and ')}, or none.`)
  }
  if (s.runners.auth !== 'token' && (s.runners.connectionOther || s.runners.connectionArn) && s.runners.connectionArn && !CONNECTION_ARN.test(s.runners.connectionArn)) {
    set('runners.connectionArn', 'An AWS CodeConnections connection ARN: arn:aws:codeconnections:<region>:<account>:connection/<id>.')
  }
  if (s.runners.connectionOther && !s.runners.connectionArn) set('runners.connectionArn', 'Paste the connection\'s ARN, or choose Automatic.')
  // layer 2: the schema (its messages are written for people; the numbers above have friendlier ones)
  const parsed = AnswersSchema.safeParse(answers(s))
  if (!parsed.success) {
    const projects = [...s.projects.keys()]
    const people = s.people.filter((p) => p.email.trim())
    for (const i of parsed.error.issues) {
      const [a, b, c] = i.path.map(String)
      let key = i.path.join('.')
      if (a === 'projects' && b !== undefined) key = `projects.${projects[Number(b)] ?? b}.${c === 'memoryEventExpiryDays' ? 'memoryDays' : c ?? ''}`
      else if (a === 'people' && b !== undefined && c !== undefined) key = `people.${people[Number(b)]?.id ?? b}.${c}`
      if (/^agents\.(maxLifetimeHours|idleMinutes|gpuMaxVcpus|cpuMaxVcpus|cpuMemoryMiB)$/.test(key) && out.has(key)) continue
      set(key, i.message)
    }
  }
  return out
}

export const CONNECTION_ARN = /^arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36}$/

// ------------------------------------------------------------------ what stops each step (layer 3 included)

export interface Blocker { step: StepId; text: string }

const fails = (s: State, pred: (c: Check) => boolean): Check[] => (s.pre?.checks ?? []).filter((c) => c.status === 'fail' && pred(c))
export const isRepoCheck = (c: Check): boolean => c.id.startsWith('github.repo:') || c.id.startsWith('github.create:')

/** Why a step's Continue is off, first reason first. Empty: the person may go on. */
export function blockers(s: State, step: StepId, errors = fieldErrors(s)): Blocker[] {
  const out: Blocker[] = []
  const add = (text: string): void => { out.push({ step, text }) }
  const under = (prefix: string): string[] => [...errors].filter(([k]) => k.startsWith(prefix)).map(([, m]) => m)
  switch (step) {
    case 'github': {
      const e = githubTokenError(s.github.token)
      if (e) add(e)
      else if (s.ghBusy) add('Checking the token with GitHub…')
      else if (!ghCurrent(s)) add('Check the token with GitHub.')
      break
    }
    case 'aws': {
      const e = Object.values(awsErrors(s.aws, s.env?.profiles.names))
      if (e.length) e.forEach(add)
      else if (s.preBusy) add('Checking the account…')
      else if (!preCurrent(s)) add('Check the AWS account.')
      else for (const c of fails(s, (x) => !isRepoCheck(x))) add(`${c.title}: ${c.fix ?? c.detail}`)
      break
    }
    case 'projects':
      if (s.preBusy) add('Checking access…')
      else if (s.pre && !preCurrent(s)) add('The projects changed: check access to them.')
      for (const c of fails(s, (x) => isRepoCheck(x) && s.projects.has(x.title))) add(`${c.title}: ${c.fix ?? c.detail}`)
      if (errors.get('projects')) add(errors.get('projects') ?? '')
      break
    case 'people':
      under('adminEmail').forEach(add)
      under('escalateTo').forEach(add)
      under('people').forEach(add)
      break
    case 'optional':
      for (const [k, m] of errors) if (/^(agents|runners|integrations|projectTokens|github\.adminToken|projects\.)/.test(k)) add(m)
      break
    case 'review':
      for (const st of ['github', 'aws', 'projects', 'people', 'optional'] as const) out.push(...blockers(s, st, errors))
      break
    default:
  }
  return out
}

// ------------------------------------------------------------------ the saved answers of an earlier run

export function loadSaved(s: State, env: Env): void {
  s.env = env
  const saved = env.saved
  if (!saved) return
  s.aws.mode = saved.aws?.mode ?? 'profile'
  s.aws.profile = saved.aws?.profile ?? 'default'
  s.aws.region = saved.aws?.region ?? ''
  const sa = saved.agents ?? {}
  const text = (v: number | null | undefined, d: string): string => (v === null || v === undefined ? d : String(v))
  Object.assign(s.agents, {
    prefix: sa.prefix ?? s.agents.prefix, model: sa.model ?? '', centralBucketName: sa.centralBucketName ?? '', retainData: sa.retainData ?? true,
    maxLifetimeHours: text(sa.maxLifetimeHours, '8'), idleMinutes: text(sa.idleMinutes, '15'),
    gpuEnabled: sa.gpuEnabled ?? null, gpuMaxVcpus: text(sa.gpuMaxVcpus, '16'), gpuSpot: sa.gpuSpot ?? false,
    cpuEnabled: sa.cpuEnabled ?? null, cpuMaxVcpus: text(sa.cpuMaxVcpus, '64'), cpuSpot: sa.cpuSpot ?? false,
    cpuVcpus: text(sa.cpuVcpus, '16'), cpuMemoryMiB: text(sa.cpuMemoryMiB, '32768'),
    knowledgeBase: sa.knowledgeBase ?? null, libraryGateway: sa.libraryGateway ?? false,
    webEnabled: sa.webEnabled ?? true, webDomain: sa.webDomain ?? '', webCertificateArn: sa.webCertificateArn ?? '', webEmailFrom: sa.webEmailFrom ?? '', webWaf: sa.webWaf ?? true,
    observability: sa.observability ?? true, transactionSearch: sa.transactionSearch ?? true, dashboard: sa.dashboard ?? true,
    samplingPercent: text(sa.samplingPercent, ''), migrateLayout: false,
    imageSource: sa.imageSource ?? 'prebuilt', imageRegistry: sa.imageRegistry ?? '', publishImages: sa.publishImages ?? null,
    escalateTo: saved.escalateTo ?? '',
  })
  const sr = saved.runners
  if (sr) {
    s.runners.auth = sr.auth ?? 'auto'
    s.runners.token = sr.token ?? 'agent'
    s.runners.connectionArn = sr.connectionArn ?? ''
    s.runners.computeType = sr.computeType ?? ''
    s.runners.privileged = sr.privileged === true ? 'on' : sr.privileged === false ? 'off' : 'default'
    s.runners.buildTrace = sr.buildTrace ?? null
    s.runners.selfUpdate = sr.selfUpdate ?? true
  }
  for (const p of saved.projects ?? []) {
    s.projects.set(p.repo, {
      branch: p.branch ?? 'main', onboard: p.onboard ?? true, applySettings: p.applySettings ?? true,
      memoryDays: text(p.memoryEventExpiryDays, ''), generation: p.generation ?? 0, create: null,
    })
  }
  if (saved.sample?.enabled && saved.sample.repo) Object.assign(s.sample, { repo: saved.sample.repo, private: saved.sample.private ?? true, tour: saved.sample.tour ?? true })
  s.adminEmail = saved.adminEmail ?? ''
  s.people = (saved.people ?? []).map((p) => ({ id: s.nextPersonId++, email: p.email, class: p.class ?? 'user', projects: new Set(p.projects ?? []) }))
}

// ------------------------------------------------------------------ words

/** "just now", "40 seconds", "2 minutes", "1 hour 5 minutes" (core/wait.ts duration, which the page cannot import) */
export function duration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec} seconds`
  const m = Math.round(sec / 60)
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`
  const hr = Math.floor(m / 60)
  const rest = m % 60
  return `${hr === 1 ? '1 hour' : `${hr} hours`}${rest ? ` ${rest === 1 ? '1 minute' : `${rest} minutes`}` : ''}`
}
/** The countdown to the next check, to the second: "2 minutes 5 seconds", "8 seconds", "now". */
export function countdown(ms: number): string {
  const sec = Math.ceil(ms / 1000)
  if (sec <= 0) return 'now'
  const m = Math.floor(sec / 60)
  const r = sec % 60
  const part = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  return m ? `${part(m, 'minute')}${r ? ` ${part(r, 'second')}` : ''}` : part(r, 'second')
}
export function waitLine(w: WaitNoticeView, now: number): string {
  const head = `Waiting for ${w.what}${w.state ? ` (${w.state.toLowerCase().replace(/_/g, ' ')})` : ''}.`
  const last = w.lastCheckedAt ? `Checked ${((d) => (d === 'just now' ? d : `${d} ago`))(duration(now - Date.parse(w.lastCheckedAt)))}` : 'Not checked yet'
  const next = w.nextCheckAt ? `next check in ${countdown(Date.parse(w.nextCheckAt) - now)}` : 'no further check is planned'
  return `${head} ${last}; ${next}.`
}
/** 123456789012 → "1234 5678 9012", easier to read back */
export const account = (id: string): string => id.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1 $2 $3')
