/**
 * The installer page's behaviour (bundled to /ui.js by scripts/bundle-ui.mjs). Four steps, and only the first asks
 * for anything:
 *
 *   1 Connect        AWS credentials (a profile, or keys) and one GitHub token; "Check" runs the preflight
 *                    (src/installer/preflight.ts) and shows what was derived and every finding, with its fix
 *   2 Projects       the repositories the token sees (or a new one to create); none is fine
 *   3 Integrations   optional service keys (Nexar, Mouser, Digi-Key); skippable, and `tracectl integrations set` later
 *   4 Review         the plan, how long it takes, and an "Advanced" disclosure with every other setting
 *
 * then the installation's progress, streamed. The answers are validated with the same zod schemas the server uses.
 *
 * Nothing here polls: the page asks the server only when the person acts, and hears the installation over one event
 * stream (/api/events). The waits the installer itself does on a timer (the GPU image build, a GitHub connection
 * being authorized: AWS cannot send this computer their events) arrive as `wait` events after every check; the page
 * shows each with a countdown to the next check, worked out here from nextCheckAt and redrawn each second (a display
 * tick: it asks the server nothing), and a Check now button (POST /api/check-now).
 */
import { INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName } from '../../core/integrations-catalog.js'
import { type AnswersInput, AnswersSchema, type Check, type InstallEvent, RUNNER_AUTH, RUNNER_COMPUTE_TYPES, type Step, type WaitNoticeView } from '../answers.js'

// ------------------------------------------------------------------ the server's answers (shapes the page relies on)

interface RepoAccess { repo: string; visible: boolean; configure: boolean; administer: boolean; webhooks: boolean; missing: string[] }
interface TokenInfo {
  login: string; name: string | null; kind: string; scopes: string[]; warnings: string[]
  repos: { fullName: string; private: boolean; admin: boolean; push: boolean; defaultBranch: string }[]
}
interface Preflight {
  checks: Check[]; ok: boolean; token: TokenInfo | null; repos: RepoAccess[]; region: string; profileRegion: string
  /** trace's own repository, and whether the token can set its variables (null: the installer could not tell which) */
  self: { repo: string; ok: boolean; reason: string } | null
  facts: {
    account?: string; arn?: string; login?: string; email?: string | null; models?: { id: string; name: string }[]
    gpuQuota?: number | null; cpuQuota?: number | null; s3vectors?: boolean | null; sourceAdmin?: boolean | null; publishedRegistry?: string | null; oidcProvider?: boolean; cdkBootstrapped?: boolean
    existing?: { status: string; outputs: Record<string, string> } | null
    runnerConnection?: string | null
  }
}
interface Progress { id: string; label: string; state: 'running' | 'done' | 'failed'; detail?: string }
interface Env { profiles: { names: string[]; regions: Record<string, string> }; saved: AnswersInput | null; installed: { stack: string; region: string } | null; node: string; defaultRegion: string }

const KEY = document.querySelector<HTMLMetaElement>('meta[name="trace-key"]')?.content ?? ''

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'x-trace-key': KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await r.json()) as T & { error?: string }
  if (!r.ok) throw new Error(data.error ?? `${r.status}`)
  return data
}

// ------------------------------------------------------------------ state

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'ap-southeast-2', 'ap-southeast-1', 'ap-northeast-1', 'ap-south-1', 'ca-central-1', 'sa-east-1']

type Tab = 'connect' | 'projects' | 'integrations' | 'review' | 'install'
const TABS: { id: Tab; title: string }[] = [
  { id: 'connect', title: '1 Connect' }, { id: 'projects', title: '2 Projects' }, { id: 'integrations', title: '3 Integrations (optional)' },
  { id: 'review', title: '4 Review' }, { id: 'install', title: 'Install' },
]

type PersonClass = 'admin' | 'user' | 'guest'
interface Person { email: string; class: PersonClass; projects: Set<string> }
type Template = 'empty' | 'python' | 'kicad' | 'rust' | 'sample'
interface Project { branch: string; onboard: boolean; applySettings: boolean; memoryDays: string; generation: number; create: { template: Template; private: boolean } | null }

const s = {
  tab: 'connect' as Tab,
  done: new Set<Tab>(),
  env: null as Env | null,
  aws: { mode: 'profile' as 'profile' | 'keys', profile: 'default', region: '', keyId: '', secret: '', session: '' },
  github: { token: '', adminToken: '' },
  pre: null as Preflight | null, preBusy: false, preError: '',
  /** each check of the running (or last) preflight, as the installer reports it */
  preProgress: [] as Progress[],
  fixBusy: '', fixNote: new Map<string, string>(),
  useCase: { open: false, companyName: '', companyWebsite: '', intendedUsers: '0' as '0' | '1' | '2', industryOption: 'Technology', otherIndustryOption: '', useCases: 'Autonomous coding agents that maintain our own electronics and firmware repositories (fixing CI failures, reviewing designs) on Amazon Bedrock AgentCore.' },
  /** memoryDays: the field's text ('' = the installation's default); generation: kept from the saved answers */
  projects: new Map<string, Project>(),
  filter: '',
  newRepo: { name: '', template: 'kicad' as Exclude<Template, 'sample'>, private: true },
  /** the sample project (installer/sample.ts): a new repository among s.projects (template 'sample'), and its tour */
  sample: { name: '', private: true, tour: true, repo: '' },
  projectTokens: new Map<string, string>(),
  integrations: Object.fromEntries(INTEGRATION_NAMES.map((n) => [n, Object.fromEntries(INTEGRATIONS[n].keys.map((k) => [k, '']))])) as Record<IntegrationName, Record<string, string>>,
  integrationCheck: new Map<IntegrationName, { ok: boolean; detail: string } | 'busy'>(),
  agents: {
    prefix: 'trace', model: '', maxLifetimeHours: 8, idleMinutes: 15, centralBucketName: '', retainData: true, escalateTo: '',
    gpuEnabled: null as boolean | null, gpuMaxVcpus: 16, gpuSpot: false,
    cpuEnabled: null as boolean | null, cpuMaxVcpus: 64, cpuSpot: false, cpuVcpus: 16, cpuMemoryMiB: 32_768,
    knowledgeBase: null as boolean | null, libraryGateway: false,
    webEnabled: true, webDomain: '', webCertificateArn: '', webEmailFrom: '',
    observability: true, transactionSearch: true, samplingPercent: '', dashboard: true, migrateLayout: false,
    imageSource: 'prebuilt' as 'prebuilt' | 'build', imageRegistry: '', publishImages: null as boolean | null,
  },
  /** how the build runners reach GitHub (answers runners): auth 'auto' = an authorized connection when there is one,
   * else the token; connectionArn '' = none named; computeType '' and privileged 'default' = the stack's defaults */
  runners: {
    auth: 'auto' as (typeof RUNNER_AUTH)[number], token: 'agent' as 'agent' | 'admin', connectionArn: '',
    computeType: '' as '' | (typeof RUNNER_COMPUTE_TYPES)[number], privileged: 'default' as 'default' | 'on' | 'off',
    /** build trace's own repository on AWS too; null: not chosen (on when the token can configure it) */
    buildTrace: null as boolean | null,
    /** keep this installation up to date from trace's own repository's ci workflow (on by default while it is built) */
    selfUpdate: true,
  },
  adminEmail: '',
  people: [] as Person[],
  plan: null as Step[] | null, timeline: [] as string[], changes: [] as string[], planError: '', planBusy: false,
  steps: [] as Step[],
  log: [] as string[],
  ready: null as string[] | null,
  result: null as { ok: boolean; summary: string[] } | null,
  /** the web app's address, once the installer knows it (Open trace) */
  appUrl: '',
  /** the timer waits open now, by step: the latest notice, and whether a Check now is on its way */
  waits: new Map<string, { wait: WaitNoticeView; asked: boolean; error: string }>(),
}

// ------------------------------------------------------------------ DOM helper

type Child = Node | string | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) el.value = String(v)
    else if (k === 'checked' && el instanceof HTMLInputElement) el.checked = Boolean(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return el
}
const note = (kind: 'ok' | 'warn' | 'bad', ...children: Child[]): HTMLElement => h('div', { class: `note ${kind}` }, ...children)
const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => h('div', {}, h('label', {}, label, hint ? h('small', {}, ` — ${hint}`) : null), input)
const input = (type: string, value: string, on: (v: string) => void, extra: Record<string, unknown> = {}): HTMLInputElement =>
  // Typing updates the state; leaving the field (change) re-renders, so buttons and checks that depend on it update
  // without stealing focus mid-word.
  h('input', { type, value, autocomplete: 'off', spellcheck: 'false', oninput: (e: Event) => on((e.target as HTMLInputElement).value), onchange: () => render(), ...extra })
const checkbox = (label: string, checked: boolean, on: (v: boolean) => void): HTMLElement =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => { on((e.target as HTMLInputElement).checked); render() } }), label)
/** on / off / decided by the preflight (null) */
const tri = (label: string, value: boolean | null, auto: string, on: (v: boolean | null) => void): HTMLElement =>
  field(label, select([{ value: 'auto', label: `Decide for me (${auto})` }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], value === null ? 'auto' : value ? 'on' : 'off', (v) => { on(v === 'auto' ? null : v === 'on'); render() }))

function select(options: { value: string; label: string }[], value: string, on: (v: string) => void): HTMLSelectElement {
  const el = h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...options.map((o) => h('option', { value: o.value }, o.label)))
  el.value = value
  return el
}

// ------------------------------------------------------------------ the answers

/** The stack already here keeps every project in itself (layout flat: no Layout output, or Layout=flat): bootstrap.ts layoutOf. */
function flatInstall(): boolean {
  const o = s.pre?.facts.existing?.outputs ?? {}
  return o.Layout ? o.Layout === 'flat' : Object.keys(o).length > 0
}

const region = (): string => s.aws.region || s.pre?.region || ''

function answers(): AnswersInput {
  const g = s.agents
  return {
    github: { login: s.pre?.facts.login ?? '' },
    aws: { mode: s.aws.mode, profile: s.aws.profile, region: region(), account: s.pre?.facts.account ?? '' },
    agents: {
      prefix: g.prefix, model: g.model, maxLifetimeHours: g.maxLifetimeHours, idleMinutes: g.idleMinutes,
      createOidcProvider: !(s.pre?.facts.oidcProvider ?? false), centralBucketName: g.centralBucketName, retainData: g.retainData,
      gpuEnabled: g.gpuEnabled, gpuMaxVcpus: g.gpuMaxVcpus, gpuSpot: g.gpuSpot,
      cpuEnabled: g.cpuEnabled, cpuMaxVcpus: g.cpuMaxVcpus, cpuSpot: g.cpuSpot, cpuVcpus: g.cpuVcpus, cpuMemoryMiB: g.cpuMemoryMiB,
      knowledgeBase: g.knowledgeBase, libraryGateway: g.libraryGateway,
      webEnabled: g.webEnabled, webDomain: g.webEnabled ? g.webDomain : '', webCertificateArn: g.webEnabled ? g.webCertificateArn : '', webEmailFrom: g.webEnabled ? g.webEmailFrom : '',
      observability: g.observability, transactionSearch: g.transactionSearch, dashboard: g.dashboard,
      samplingPercent: g.samplingPercent.trim() === '' ? null : Number(g.samplingPercent),
      migrateLayout: g.migrateLayout,
      imageSource: g.imageSource, imageRegistry: g.imageRegistry, publishImages: g.publishImages,
    },
    runners: {
      auth: s.runners.auth, token: s.runners.token,
      connectionArn: s.runners.auth === 'token' ? '' : s.runners.connectionArn, computeType: s.runners.computeType || null,
      privileged: s.runners.privileged === 'default' ? null : s.runners.privileged === 'on',
      buildTrace: buildTrace(), traceRepository: buildTrace() ? selfRepo()?.repo ?? '' : '', selfUpdate: s.runners.selfUpdate,
    },
    projects: [...s.projects].map(([repo, { memoryDays, ...p }]) => ({ repo, ...p, memoryEventExpiryDays: memoryDays.trim() === '' ? null : Number(memoryDays) })),
    sample: { enabled: Boolean(sampleRepo()), repo: sampleRepo() ?? '', private: s.sample.private, tour: s.sample.tour },
    adminEmail: s.adminEmail || s.pre?.facts.email || '',
    people: s.people.filter((p) => p.email.trim()).map((p) => ({
      email: p.email.trim(), class: p.class,
      projects: p.class === 'admin' ? [] : [...p.projects].filter((r) => s.projects.has(r)),
    })),
    escalateTo: g.escalateTo,
  }
}

/** The sample project's repository: the one being created, else the one an earlier run created. */
function sampleRepo(): string | null {
  const creating = [...s.projects].find(([, p]) => p.create?.template === 'sample')?.[0]
  return creating ?? (s.sample.repo && s.projects.has(s.sample.repo) ? s.sample.repo : null)
}

/** trace's own repository as the GitHub check found it, when the token can configure it and it is not a project. */
function selfRepo(): { repo: string; ok: boolean; reason: string } | null {
  const own = s.pre?.self ?? null
  if (!own || !own.ok || s.projects.has(own.repo)) return null
  return own
}
/** Whether trace's own repository is built on AWS too: the person's choice, else on when it can be. */
const buildTrace = (): boolean => (selfRepo() ? s.runners.buildTrace ?? true : false)

const secrets = (): Record<string, unknown> => ({
  githubToken: s.github.token, githubAdminToken: s.github.adminToken,
  projectTokens: Object.fromEntries([...s.projectTokens].filter(([r, t]) => s.projects.has(r) && t.trim())),
  awsAccessKeyId: s.aws.mode === 'keys' ? s.aws.keyId : '', awsSecretAccessKey: s.aws.mode === 'keys' ? s.aws.secret : '',
  awsSessionToken: s.aws.mode === 'keys' ? s.aws.session : '',
  integrations: Object.fromEntries(INTEGRATION_NAMES.flatMap((n) => {
    const v = Object.fromEntries(Object.entries(s.integrations[n]).filter(([, x]) => x.trim()))
    return Object.keys(v).length ? [[n, v]] : []
  })),
})

const awsBody = (): Record<string, unknown> => ({
  aws: { mode: s.aws.mode, profile: s.aws.profile, region: s.aws.region },
  secrets: s.aws.mode === 'keys' ? { awsAccessKeyId: s.aws.keyId, awsSecretAccessKey: s.aws.secret, awsSessionToken: s.aws.session } : {},
})

const fails = (pred: (c: Check) => boolean = () => true): Check[] => (s.pre?.checks ?? []).filter((c) => c.status === 'fail' && pred(c))

function problems(tab: Tab): string[] {
  const out: string[] = []
  if (tab === 'connect') {
    if (!s.pre) out.push('Check the AWS credentials and the GitHub token.')
    else for (const c of fails((x) => !x.id.startsWith('github.repo:') && !x.id.startsWith('github.create:'))) out.push(`${c.title}: ${c.fix ?? c.detail}`)
  }
  if (tab === 'projects') for (const c of fails((x) => x.id.startsWith('github.repo:') || x.id.startsWith('github.create:'))) out.push(`${c.title}: ${c.fix ?? c.detail}`)
  if (tab === 'review') {
    if (fails().length) out.push('A check failed: see Connect and Projects.')
    if (!s.adminEmail && !s.pre?.facts.email) out.push("Enter the first administrator's email under Advanced (the token cannot see its account's).")
    if (s.agents.webEnabled && Boolean(s.agents.webDomain) !== Boolean(s.agents.webCertificateArn)) out.push('The web app\'s custom domain under Advanced needs its certificate (ACM, us-east-1), and the certificate its domain.')
    if (s.runners.auth !== 'token' && s.runners.connectionArn && !CONNECTION_ARN.test(s.runners.connectionArn)) out.push('The GitHub connection under Advanced must be an AWS CodeConnections connection ARN, or empty.')
  }
  return out
}

// ------------------------------------------------------------------ rendering

function render(): void {
  const root = document.getElementById('app')
  if (!root) return
  const nav = h('nav', { class: 'steps' }, ...TABS.map((t) => h('button', {
    class: `${s.tab === t.id ? 'on' : ''} ${s.done.has(t.id) ? 'ok' : ''}`,
    disabled: (t.id === 'install' && !s.steps.length) || (t.id !== 'connect' && t.id !== 'install' && !s.pre),
    onclick: () => { s.tab = t.id; if (t.id === 'review') void loadPlan(); render() },
  }, t.title)))
  const body = { connect, projects, integrations, review, install }[s.tab]()
  root.replaceChildren(nav, body)
}

function next(from: Tab, to: Tab, label = 'Continue'): HTMLElement {
  const blockers = problems(from)
  return h('div', { class: 'actions' },
    blockers.length ? h('span', { class: 'muted' }, blockers[0] ?? '') : null,
    h('button', { class: 'primary', disabled: blockers.length > 0, onclick: () => { s.done.add(from); s.tab = to; if (to === 'review') void loadPlan(); render() } }, label))
}

const ICON: Record<Check['status'], string> = { ok: '✓', info: 'i', warn: '!', fail: '✕' }
const KIND: Record<Check['status'], 'ok' | 'warn' | 'bad'> = { ok: 'ok', info: 'ok', warn: 'warn', fail: 'bad' }

function checkView(c: Check): HTMLElement {
  const busy = s.fixBusy === `${c.id}:${c.action?.id ?? ''}`
  const done = s.fixNote.get(c.id)
  return note(KIND[c.status],
    h('strong', {}, `${ICON[c.status]} ${c.title}: `), c.detail,
    c.fix ? h('div', { class: 'muted' }, c.fix) : null,
    c.link ? h('div', {}, h('a', { href: c.link, target: '_blank', rel: 'noreferrer' }, 'Open in the console')) : null,
    c.action ? h('div', { class: 'actions left' }, h('button', { class: 'secondary', disabled: busy, onclick: () => void runFix(c) }, busy ? 'Working…' : c.action.label)) : null,
    c.action?.id === 'bedrock-use-case' && s.useCase.open ? useCaseForm(c) : null,
    done ? h('div', { class: 'muted' }, done) : null)
}

function useCaseForm(c: Check): HTMLElement {
  const u = s.useCase
  return h('div', { class: 'sub' },
    h('p', { class: 'muted' }, 'Anthropic\'s first-time-use form, sent from here with PutUseCaseForModelAccess. Once per account (or for the whole organisation from its management account).'),
    h('div', { class: 'row' },
      field('Company or your name', input('text', u.companyName, (v) => { u.companyName = v })),
      field('Website', input('text', u.companyWebsite, (v) => { u.companyWebsite = v }, { placeholder: 'a GitHub profile or project page is fine' }))),
    h('div', { class: 'row' },
      field('Who uses it', select([{ value: '0', label: 'Internal users' }, { value: '1', label: 'External users' }, { value: '2', label: 'Both' }], u.intendedUsers, (v) => { u.intendedUsers = v === '1' || v === '2' ? v : '0' })),
      field('Industry', input('text', u.industryOption, (v) => { u.industryOption = v }))),
    field('Use case', h('textarea', { rows: 3, oninput: (e: Event) => { u.useCases = (e.target as HTMLTextAreaElement).value }, value: u.useCases })),
    h('div', { class: 'actions left' }, h('button', { class: 'primary', disabled: s.fixBusy !== '', onclick: () => void submitUseCase(c) }, 'Submit the form')))
}

function connect(): HTMLElement {
  const a = s.aws
  const profiles = s.env?.profiles.names ?? []
  const profRegion = a.mode === 'profile' ? s.env?.profiles.regions[a.profile] ?? '' : ''
  const f = s.pre?.facts
  return h('section', { class: 'card' },
    h('h2', {}, 'Connect'),
    h('p', { class: 'lead' }, 'Two things: AWS credentials that may create IAM roles and the rest (an administrator profile is simplest; they are used only by this installer and its CDK deploy), and one GitHub token. Everything else is worked out from them.'),
    h('div', { class: 'row' },
      field('AWS credentials', select([{ value: 'profile', label: 'A profile on this machine' }, { value: 'keys', label: 'Access keys' }], a.mode, (v) => { a.mode = v === 'keys' ? 'keys' : 'profile'; s.pre = null; render() })),
      a.mode === 'profile'
        ? field('Profile', profiles.length
          ? select(profiles.map((p) => ({ value: p, label: p })), a.profile, (v) => { a.profile = v; s.pre = null; render() })
          : input('text', a.profile, (v) => { a.profile = v; s.pre = null }), 'SSO profiles work: run `aws sso login` first')
        : h('span', {})),
    a.mode === 'keys' ? h('div', {},
      h('div', { class: 'row' },
        field('Access key id', input('text', a.keyId, (v) => { a.keyId = v.trim(); s.pre = null })),
        field('Secret access key', input('password', a.secret, (v) => { a.secret = v.trim(); s.pre = null }))),
      field('Session token', input('password', a.session, (v) => { a.session = v.trim(); s.pre = null }), 'only for temporary credentials')) : null,
    field('GitHub token', input('password', s.github.token, (v) => { s.github.token = v.trim(); s.pre = null }, { placeholder: 'github_pat_… or ghp_…' }),
      'fine-grained: Contents, Pull requests, Issues, Workflows, Actions, Secrets, Variables, Administration and Webhooks read and write on the repositories, and "Email addresses: read"; classic: repo, workflow, user:email'),
    h('details', {}, h('summary', { class: 'muted' }, `Region: ${a.region || profRegion || s.env?.defaultRegion || 'us-east-1'}${a.region ? '' : profRegion ? ' (the profile\'s)' : ' (the default)'}`),
      field('Region', select([{ value: '', label: `The profile's, else ${s.env?.defaultRegion ?? 'us-east-1'}` }, ...REGIONS.map((r) => ({ value: r, label: r }))], a.region, (v) => { a.region = v; s.pre = null; render() }), 'trace needs Bedrock AgentCore there')),
    h('div', { class: 'actions' }, h('button', { class: 'secondary', disabled: s.preBusy, onclick: () => void runPreflight() }, s.preBusy ? 'Checking everything…' : s.pre ? 'Check again' : 'Check')),
    progressView(),
    s.preError ? note('bad', h('strong', {}, 'The checks could not run: '), s.preError) : null,
    f?.account ? note('ok', h('strong', {}, `Installing into ${f.account} in ${s.pre?.region}`), ` as ${f.arn ?? ''}${f.login ? `; GitHub: ${f.login}` : ''}${f.email ? `; first administrator: ${f.email}` : ''}.`) : null,
    ...(s.pre?.checks ?? []).filter((c) => !c.id.startsWith('github.repo:') && !c.id.startsWith('github.create:')).map(checkView),
    next('connect', 'projects'))
}

function projects(): HTMLElement {
  const info = s.pre?.token
  const repos = (info?.repos ?? []).filter((r) => !s.filter || r.fullName.toLowerCase().includes(s.filter.toLowerCase()))
  const access = new Map((s.pre?.repos ?? []).map((r) => [r.repo.toLowerCase(), r]))
  const n = s.newRepo
  const owner = s.pre?.facts.login ?? ''
  return h('section', { class: 'card' },
    h('h2', {}, 'Projects'),
    h('p', { class: 'lead' }, 'The repositories trace runs. Each gets its own agent, roles, memory and AWS CodeBuild runner (every one of its GitHub Actions jobs runs there), and an onboarding pull request you merge. None is fine: install now and add them by running the installer again.'),
    input('text', s.filter, (v) => { s.filter = v; render() }, { placeholder: `Filter the ${info?.repos.length ?? 0} repositories…` }),
    h('div', { class: 'repos' }, ...repos.slice(0, 300).map((r) => {
      const p = s.projects.get(r.fullName)
      const acc = access.get(r.fullName.toLowerCase())
      return h('div', { class: 'item' },
        h('input', { type: 'checkbox', checked: Boolean(p), onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) s.projects.set(r.fullName, { branch: r.defaultBranch, onboard: true, applySettings: r.admin, memoryDays: '', generation: 0, create: null })
          else s.projects.delete(r.fullName)
          render()
        } }),
        h('span', {}, r.fullName, ' ', r.private ? h('span', { class: 'tag' }, 'private') : null, r.admin ? null : h('span', { class: 'tag' }, 'not admin'),
          acc && acc.missing.length ? h('div', { class: 'muted small' }, `missing: ${acc.missing.join(', ')}`) : null),
        p ? h('span', { class: 'opt' }, checkbox('onboarding PR', p.onboard, (v) => { p.onboard = v })) : h('span', {}),
        p ? h('span', { class: 'opt' }, checkbox('repo settings', p.applySettings, (v) => { p.applySettings = v })) : h('span', {}))
    })),
    sampleCard(owner),
    h('details', {}, h('summary', {}, 'Create a new project'),
      h('div', { class: 'row' },
        field('Repository', input('text', n.name, (v) => { n.name = v.trim() }, { placeholder: `${owner || 'owner'}/new-board` })),
        field('Starts from', select([{ value: 'kicad', label: 'KiCad board' }, { value: 'rust', label: 'Rust firmware' }, { value: 'python', label: 'Python' }, { value: 'empty', label: 'Empty' }], n.template, (v) => { n.template = (['kicad', 'rust', 'python', 'empty'] as const).find((t) => t === v) ?? 'empty' })),
        field('Visibility', checkbox('Private', n.private, (v) => { n.private = v }))),
      h('div', { class: 'actions left' }, h('button', { class: 'secondary', disabled: !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(n.name.includes('/') ? n.name : `${owner}/${n.name}`), onclick: () => {
        const slug = n.name.includes('/') ? n.name : `${owner}/${n.name}`
        s.projects.set(slug, { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: { template: n.template, private: n.private } })
        n.name = ''
        void runPreflight()
      } }, 'Add it'))),
    ...[...s.projects].filter(([, p]) => p.create && p.create.template !== 'sample').map(([r, p]) => note('ok', `${r}: created from the ${p.create?.template} template when installing.`, ' ', h('button', { class: 'link', onclick: () => { s.projects.delete(r); render() } }, 'remove'))),
    h('div', { class: 'actions' }, h('button', { class: 'secondary', disabled: s.preBusy || !s.projects.size, onclick: () => void runPreflight() }, s.preBusy ? 'Checking…' : 'Check access to these')),
    s.tab === 'projects' ? progressView() : null,
    ...(s.pre?.checks ?? []).filter((c) => (c.id.startsWith('github.repo:') || c.id.startsWith('github.create:')) && s.projects.has(c.title)).map(checkView),
    next('projects', 'integrations'))
}

/** The sample project: one small board that exercises every agent and every simulation, in a new repository. */
function sampleCard(owner: string): HTMLElement {
  const x = s.sample
  const repo = sampleRepo()
  const name = x.name.includes('/') ? x.name : `${owner || 'owner'}/${x.name || 'trace-sample'}`
  const add = (): void => {
    for (const [r, p] of s.projects) if (p.create?.template === 'sample') s.projects.delete(r)
    s.projects.set(name, { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: { template: 'sample', private: x.private } })
    x.repo = name
    void runPreflight()
  }
  return h('div', { class: 'sub' },
    h('h3', {}, 'Sample project (recommended for a first installation)'),
    h('p', { class: 'muted' }, 'A small, finished sensor board in a new repository, from intent to fabrication files. Once trace is installed it starts a tour: one task for every agent and every simulation (circuit, mixed-signal, logic and formal, FPGA, protocols, thermal, electromagnetic, autorouting, rendering, firmware, and hardware in the loop on an emulated bench), so you see the whole system work before you bring your own design.'),
    repo
      ? h('div', {},
        note('ok', `${repo}: ${s.projects.get(repo)?.create ? 'created and filled with the sample when installing' : 'installed by an earlier run'}.`, ' ',
          s.projects.get(repo)?.create ? h('button', { class: 'link', onclick: () => { s.projects.delete(repo); x.repo = ''; render() } }, 'remove') : null),
        checkbox('Start the tour once installed', x.tour, (v) => { x.tour = v }),
        x.tour ? h('p', { class: 'muted small' }, 'The tour runs every agent and every simulation once, on AWS like any other work, so it costs what that work costs (the GPU and CPU jobs most of all). Running the installer again opens only the tasks that are missing.') : null)
      : h('div', {},
        h('div', { class: 'row' },
          field('Repository', input('text', x.name, (v) => { x.name = v.trim() }, { placeholder: `${owner || 'owner'}/trace-sample` }), 'a new repository: the installer creates it'),
          field('Visibility', checkbox('Private', x.private, (v) => { x.private = v }))),
        h('div', { class: 'actions left' }, h('button', { class: 'secondary', disabled: !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(name) || !owner && !x.name.includes('/'), onclick: add }, 'Install the sample project'))))
}

function integrations(): HTMLElement {
  return h('section', { class: 'card' },
    h('h2', {}, 'Integrations (optional)'),
    h('p', { class: 'lead' }, 'Keys for services some tools use. None is needed to install or deploy: without them the parts tools ask LCSC (no key) and say which key would add more. Add or change one any time with `tracectl integrations set <name>`. Each key is checked with its service and stored in AWS Secrets Manager (<prefix>/integrations/<name>).'),
    ...INTEGRATION_NAMES.map((n) => {
      const i = INTEGRATIONS[n]
      const c = s.integrationCheck.get(n)
      const values = s.integrations[n]
      const complete = i.keys.every((k) => (values[k] ?? '').trim())
      return h('div', { class: 'sub' },
        h('h3', {}, i.title), h('p', { class: 'muted' }, i.enables, ' ', h('a', { href: i.url, target: '_blank', rel: 'noreferrer' }, 'Get a key')),
        h('div', { class: 'row' }, ...i.keys.map((k) => field(k, input('password', values[k] ?? '', (v) => { values[k] = v.trim(); s.integrationCheck.delete(n) })))),
        h('div', { class: 'actions left' }, h('button', { class: 'secondary', disabled: !complete || c === 'busy', onclick: () => void checkKey(n) }, c === 'busy' ? 'Checking…' : 'Check')),
        c && c !== 'busy' ? note(c.ok ? 'ok' : 'warn', c.detail, c.ok ? '' : ' (it is stored anyway; installing never waits on it)') : null)
    }),
    next('integrations', 'review', Object.values(s.integrations).some((v) => Object.values(v).some(Boolean)) ? 'Continue' : 'Skip'))
}

const CLASS_HELP: Record<PersonClass, string> = {
  admin: 'everything, on every project, including managing people',
  user: 'read and write on the projects ticked',
  guest: 'read only, on the projects ticked',
}

function advanced(): HTMLElement {
  const g = s.agents
  const f = s.pre?.facts
  const models = f?.models ?? []
  const repos = [...s.projects.keys()]
  const gpuAuto = f?.gpuQuota === undefined || f?.gpuQuota === null ? 'on' : f.gpuQuota >= 4 ? `on: ${f.gpuQuota} vCPUs allowed` : `off: the quota is ${f.gpuQuota}`
  return h('details', { class: 'advanced' }, h('summary', {}, 'Advanced (every setting has a default)'),
    h('h3', {}, 'Agents'),
    h('div', { class: 'row' },
      field('Prefix', input('text', g.prefix, (v) => { g.prefix = v.trim() }), 'on every resource; two installations in one account need two'),
      field('Model', models.length
        ? select([{ value: '', label: 'The newest Claude Sonnet here' }, ...models.map((m) => ({ value: m.id, label: m.name }))], g.model, (v) => { g.model = v })
        : input('text', g.model, (v) => { g.model = v.trim() }, { placeholder: 'the newest Claude Sonnet here' }))),
    h('div', { class: 'row' },
      field('Longest task (hours)', input('number', String(g.maxLifetimeHours), (v) => { g.maxLifetimeHours = Number(v) }, { min: 0.25, max: 8, step: 0.25 }), 'AgentCore allows up to 8'),
      field('Idle session ends after (minutes)', input('number', String(g.idleMinutes), (v) => { g.idleMinutes = Number(v) }, { min: 1, max: 480 }))),
    h('div', { class: 'row' },
      field('First administrator', input('email', s.adminEmail, (v) => { s.adminEmail = v.trim() }, { placeholder: f?.email ?? 'you@example.com' }), f?.email ? 'empty: the token\'s email' : 'required: the token cannot see its email'),
      field('Who the agents ask', input('text', g.escalateTo, (v) => { g.escalateTo = v.trim() }, { placeholder: '@your-login' }), 'mentioned when a project needs a person')),
    field('Central bucket name', input('text', g.centralBucketName, (v) => { g.centralBucketName = v.trim() }, { placeholder: 'empty: named automatically' })),
    checkbox('Keep the data (central bucket, images, memories) if trace or a project is removed', g.retainData, (v) => { g.retainData = v }),
    ...(flatInstall() ? [
      h('p', { class: 'muted' }, 'This installation keeps every project in one CloudFormation stack (about 20 fit). Moving to a nested stack per project (60 fit) takes three deploys and DELETES every project\'s memory records.'),
      checkbox('Move to one nested stack per project (deletes every project\'s memory records)', g.migrateLayout, (v) => { g.migrateLayout = v }),
    ] : []),
    h('h3', {}, 'GPU and CPU jobs'),
    h('p', { class: 'muted' }, 'Blender renders and PCB autorouting on GPU instances, and CPU-heavy jobs (openEMS, Verilator, formal, CFD) on a CPU queue, both AWS Batch scaling to zero. They share one large image (CUDA, Blender, KiCad, OpenFOAM) that is made after trace is ready.'),
    h('div', { class: 'row' },
      tri('GPU jobs', g.gpuEnabled, gpuAuto, (v) => { g.gpuEnabled = v }),
      tri('CPU jobs', g.cpuEnabled, 'on with GPU jobs when the quota allows', (v) => { g.cpuEnabled = v })),
    h('div', { class: 'row' },
      field('GPU vCPUs at once', input('number', String(g.gpuMaxVcpus), (v) => { g.gpuMaxVcpus = Number(v) }, { min: 4, max: 4096, step: 4 }), '4 per job'),
      field('CPU vCPUs at once', input('number', String(g.cpuMaxVcpus), (v) => { g.cpuMaxVcpus = Number(v) }, { min: 1, max: 4096 })),
      field('vCPUs per CPU job', input('number', String(g.cpuVcpus), (v) => { g.cpuVcpus = Number(v) }, { min: 1, max: 192 })),
      field('Memory per CPU job (MiB)', input('number', String(g.cpuMemoryMiB), (v) => { g.cpuMemoryMiB = Number(v) }, { min: 1024, step: 1024 }))),
    checkbox('GPU: Spot instances (cheaper; a job can be interrupted)', g.gpuSpot, (v) => { g.gpuSpot = v }),
    checkbox('CPU: Spot instances', g.cpuSpot, (v) => { g.cpuSpot = v }),
    h('h3', {}, 'Images'),
    field('Agent and GPU images', select([{ value: 'prebuilt', label: 'trace\'s published images for this version, else built here' }, { value: 'build', label: 'Always build them here (CodeBuild)' }], g.imageSource, (v) => { g.imageSource = v === 'build' ? 'build' : 'prebuilt'; render() })),
    g.imageSource === 'prebuilt' ? field('Published images registry', input('text', g.imageRegistry, (v) => { g.imageRegistry = v.trim() }, { placeholder: f?.publishedRegistry ? `empty: ${f.publishedRegistry} (trace's)` : 'empty: wherever trace publishes them (none yet: built here)' }), 'copied by digest into this account\'s private ECR; built when this version is not there') : null,
    tri('Publish trace\'s images from this account', g.publishImages, f?.sourceAdmin ? 'on: your token administers trace\'s repository' : 'off: only trace\'s owner publishes', (v) => { g.publishImages = v }),
    g.publishImages === false ? null : h('p', { class: 'muted' }, 'Publishing is part of the install, all by API: ECR Public repositories in us-east-1, a release role for trace\'s main branch and v* tags, the repository variables and release that tell every installation where the images are, and the first release run.'),
    ...buildRunners(),
    h('h3', {}, 'Web app'),
    h('p', { class: 'muted' }, 'The address people sign in at, with passkeys or a password: CloudFront\'s own address unless you give a domain. `tracectl login` works either way.'),
    checkbox('The web app (S3 and CloudFront, a small Lambda, live updates)', g.webEnabled, (v) => { g.webEnabled = v }),
    g.webEnabled ? h('div', {},
      h('div', { class: 'row' },
        field('Custom domain', input('text', g.webDomain, (v) => { g.webDomain = v.trim().toLowerCase() }, { placeholder: 'empty: CloudFront\'s address' }), 'you point its DNS at the distribution afterwards'),
        field('Its certificate (ACM, us-east-1)', input('text', g.webCertificateArn, (v) => { g.webCertificateArn = v.trim() }, { placeholder: 'arn:aws:acm:us-east-1:…' }))),
      field('Email sign-in codes from', input('email', g.webEmailFrom, (v) => { g.webEmailFrom = v.trim() }, { placeholder: 'empty: passkeys and passwords only' }), 'a verified Amazon SES sender: Cognito sends codes only through SES'),
      h('p', { class: 'muted' }, 'Passkeys belong to the app\'s address: moving to a custom domain later means people add their passkeys again.')) : null,
    h('h3', {}, 'Knowledge bases, gateway, observability'),
    tri('Knowledge bases', g.knowledgeBase, f?.s3vectors === false ? 'off: no S3 Vectors here' : 'on where S3 Vectors is', (v) => { g.knowledgeBase = v }),
    checkbox('Serve the datasheets and parts tools through AgentCore Gateway (then only its Lambda can read the integration keys)', g.libraryGateway, (v) => { g.libraryGateway = v }),
    checkbox('Traces and metrics to CloudWatch (AgentCore observability)', g.observability, (v) => { g.observability = v }),
    g.observability ? h('div', {},
      checkbox('Turn on CloudWatch Transaction Search if it is off (account-wide; uninstalling leaves it on)', g.transactionSearch, (v) => { g.transactionSearch = v }),
      checkbox('A CloudWatch dashboard for the agents', g.dashboard, (v) => { g.dashboard = v }),
      field('X-Ray trace indexing (%)', input('number', g.samplingPercent, (v) => { g.samplingPercent = v }, { min: 0, max: 100, placeholder: 'leave as it is' }))) : null,
    h('h3', {}, 'Tokens'),
    field('Admin token', input('password', s.github.adminToken, (v) => { s.github.adminToken = v.trim() }), 'only when the token above cannot set a repository\'s secrets, variables or settings: used during this installation, never stored (unless chosen as CodeBuild\'s credential)'),
    ...(repos.length ? [h('p', { class: 'muted' }, 'Each project gets its own AWS resources and roles. On GitHub its agent reaches whatever its token can: a fine-grained token limited to that repository isolates it there too.'),
      ...repos.map((r) => field(`${r}'s own agent token`, input('password', s.projectTokens.get(r) ?? '', (v) => { s.projectTokens.set(r, v.trim()) }, { placeholder: 'the token above' })))] : []),
    ...repos.map((r) => {
      const p = s.projects.get(r)
      return p ? field(`${r}: memory days`, input('number', p.memoryDays, (v) => { p.memoryDays = v.trim() }, { min: 3, max: 365, placeholder: '30' })) : null
    }),
    h('h3', {}, 'People'),
    h('p', { class: 'muted' }, 'Everyone signs in with Amazon Cognito, which emails a temporary password. Admins can do everything; users read and change their projects; guests only read theirs. Admins can invite more later with `tracectl users invite`.'),
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, 'Class'), ...repos.map((r) => h('th', {}, r)), h('th', {}, ''))),
      h('tbody', {}, ...s.people.map((p, i) => h('tr', {},
        h('td', {}, input('email', p.email, (v) => { p.email = v }, { placeholder: 'name@example.com' })),
        h('td', { title: CLASS_HELP[p.class] }, select([{ value: 'user', label: 'user' }, { value: 'guest', label: 'guest' }, { value: 'admin', label: 'admin' }], p.class, (v) => { p.class = v === 'admin' || v === 'guest' ? v : 'user'; render() })),
        ...repos.map((r) => h('td', {}, p.class === 'admin' ? h('span', { class: 'muted' }, 'all')
          : h('input', { type: 'checkbox', checked: p.projects.has(r), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) p.projects.add(r); else p.projects.delete(r) } }))),
        h('td', {}, h('button', { class: 'secondary', onclick: () => { s.people.splice(i, 1); render() } }, 'Remove')))))),
    h('div', { class: 'actions left' },
      h('button', { class: 'secondary', onclick: () => { s.people.push({ email: '', class: 'user', projects: new Set() }); render() } }, 'Add a person'),
      h('button', { class: 'secondary', onclick: () => void loadPlan() }, 'Update the plan')))
}

async function loadPlan(): Promise<void> {
  s.plan = null; s.planError = ''; s.planBusy = true; render()
  try {
    // the plan needs the account the checks found: run them first when they have not (or no longer) passed
    if (!s.pre?.facts.account) await runPreflight()
    if (!s.pre?.facts.account) { s.planError = s.preError ? `The checks could not run, so there is no plan yet: ${s.preError}` : 'The AWS account is not known yet: run the checks on Connect.'; return }
    const parsed = AnswersSchema.safeParse(answers())
    if (!parsed.success) { s.planError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '); return }
    const r = await api<{ steps: Step[]; timeline: string[]; changes: string[] }>('POST', '/api/plan', { answers: answers(), existing: s.pre.facts.existing ?? null, cdkBootstrapped: s.pre.facts.cdkBootstrapped ?? false })
    s.plan = r.steps; s.timeline = r.timeline; s.changes = r.changes
  } catch (e) {
    s.planError = e instanceof Error ? e.message : String(e)
  } finally {
    s.planBusy = false; render()
  }
}

function review(): HTMLElement {
  const f = s.pre?.facts
  const blockers = problems('review')
  return h('section', { class: 'card' },
    h('h2', {}, 'Review'),
    h('p', { class: 'lead' }, f?.existing ? 'trace is installed here: this updates it, and changes only what the plan says. Every step can be run again safely.' : 'What installing will do. Every step can be run again safely: if one fails, fix the cause and install again.'),
    s.changes.length ? note('ok', h('strong', {}, 'Changes since the last run: '), s.changes.join('; ')) : null,
    s.timeline.length ? note('ok', h('strong', {}, 'How long: '), h('ul', {}, ...s.timeline.map((l) => h('li', {}, l)))) : null,
    s.preBusy ? progressView() : null,
    s.planError ? note('bad', s.planError, h('div', { class: 'actions left' }, h('button', { class: 'secondary', disabled: s.planBusy, onclick: () => void loadPlan() }, 'Try again'))) : null,
    s.plan ? h('ol', { class: 'plan' }, ...s.plan.map((st) => h('li', {}, h('strong', {}, st.title), h('div', { class: 'muted' }, st.detail))))
      : s.planBusy && !s.preBusy ? h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' Working out the plan…') : null,
    advanced(),
    h('div', { class: 'actions' },
      blockers.length ? h('span', { class: 'muted' }, blockers[0] ?? '') : null,
      h('button', { class: 'primary', disabled: !s.plan || blockers.length > 0, onclick: () => void startInstall() }, `Install into ${f?.account ?? 'the account'} (${s.pre?.region ?? ''})`)))
}

const CONNECTION_ARN = /^arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36}$/
const COMPUTE_LABEL: Record<(typeof RUNNER_COMPUTE_TYPES)[number], string> = {
  BUILD_GENERAL1_MEDIUM: 'Medium (4 vCPUs, 7 GB)', BUILD_GENERAL1_LARGE: 'Large (8 vCPUs, 15 GB)',
  BUILD_GENERAL1_XLARGE: 'X-large (36 vCPUs, 72 GB)', BUILD_GENERAL1_2XLARGE: '2X-large (72 vCPUs, 144 GB)',
}

/** Advanced: where the repositories' GitHub Actions jobs run (AWS CodeBuild, never GitHub's runners) and how
 * CodeBuild reaches GitHub (README "Where builds run"). */
function buildRunners(): (HTMLElement | null)[] {
  const r = s.runners
  const name = `${s.agents.prefix || 'trace'}-github`
  const reg = region() || s.env?.defaultRegion || 'us-east-1'
  const url = `https://${reg}.console.aws.amazon.com/codesuite/settings/connections?region=${reg}`
  const found = s.pre?.facts.runnerConnection
  return [
    h('h3', {}, 'Build runners'),
    h('p', { class: 'muted' }, 'Every GitHub Actions job of the repositories runs on AWS CodeBuild in this account, each repository on its own runner project, once that exists; until then its jobs run on GitHub\'s runners, and move to AWS by themselves.'),
    ownRepository(),
    field('How CodeBuild reaches GitHub', select([
      { value: 'auto', label: `Automatic: an authorized GitHub connection when there is one${found ? ` (${found})` : ''}, else the GitHub token` },
      { value: 'token', label: 'The GitHub token (no console step; the token is stored with CodeBuild)' },
      { value: 'connection', label: 'An AWS CodeConnections connection instead of the token (no token stored; needs one console authorization)' },
    ], r.auth, (v) => { r.auth = (RUNNER_AUTH as readonly string[]).includes(v) ? v as (typeof RUNNER_AUTH)[number] : 'auto'; render(); void runPreflight().then(() => loadPlan()) }), 'change it later with `tracectl upgrade --runner-auth auto|token|connection`'),
    r.auth === 'connection' ? note('warn', 'A new connection is authorized once per AWS account and region, in the AWS console. After the first deploy the installer shows the link (', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Connections'), `) and waits: choose ${r.connectionArn ? 'the connection' : name} and "Update pending connection", which installs the AWS Connector for GitHub app, and give that app access to every chosen repository. The installer then adds the build runners by itself.`) : null,
    r.auth !== 'token' ? field('Use this connection (optional)', input('text', r.connectionArn, (v) => { r.connectionArn = v.trim() }, { placeholder: `empty: reuse an authorized one${r.auth === 'connection' ? `, else create ${name}` : ''}` }), 'an existing GitHub connection\'s ARN') : null,
    r.auth !== 'connection' ? field('The token CodeBuild keeps', select([{ value: 'agent', label: 'The GitHub token above' }, { value: 'admin', label: 'The admin token' }], r.token, (v) => { r.token = v === 'admin' ? 'admin' : 'agent' }),
      'it needs Administration, Webhooks and Commit statuses (read and write) and Contents (read) on each repository; an account that has a GitHub credential already keeps it') : null,
    h('div', { class: 'row' },
      field('Job size', select([{ value: '', label: 'Default (Large)' }, ...RUNNER_COMPUTE_TYPES.map((t) => ({ value: t, label: COMPUTE_LABEL[t] }))], r.computeType,
        (v) => { r.computeType = (RUNNER_COMPUTE_TYPES as readonly string[]).includes(v) ? v as (typeof RUNNER_COMPUTE_TYPES)[number] : '' }), 'a job can ask for another with an instance-size label'),
      field('Docker in jobs', select([{ value: 'default', label: 'Default (off)' }, { value: 'on', label: 'On (privileged, for jobs that build containers)' }, { value: 'off', label: 'Off' }], r.privileged,
        (v) => { r.privileged = v === 'on' || v === 'off' ? v : 'default' }))),
  ]
}

/** The "build trace's own repository on AWS too" checkbox, or why there is none; while it is built, the "keep this
 * installation up to date" one (README "Staying up to date"). */
function ownRepository(): HTMLElement | null {
  const own = s.pre?.self ?? null
  if (!own) return null
  if (s.projects.has(own.repo)) return h('p', { class: 'muted' }, `trace's own repository (${own.repo}) is one of the projects, so it gets its build runner with them.`)
  if (!own.ok) return h('p', { class: 'muted' }, `trace's own repository (${own.repo}) stays on GitHub's runners: the token can't set its variables.`)
  return h('div', {},
    checkbox(`Build trace's own repository on AWS too (${own.repo}): a build runner for it alone, no agents`, buildTrace(), (v) => { s.runners.buildTrace = v; render() }),
    buildTrace() ? checkbox('Keep this installation up to date when trace\'s main branch changes', s.runners.selfUpdate, (v) => { s.runners.selfUpdate = v; render() }) : null,
    buildTrace() ? h('p', { class: 'muted' }, `When ${own.repo}'s default branch changes and its tests pass, its ci workflow deploys this installation again with the settings this installer saves, so you don't have to run the installer for every update. Only that workflow on that branch can do it, which means anyone who can merge there can change this installation. The installer is still needed to add repositories or people.`) : null)
}

async function runPreflight(): Promise<void> {
  if (s.github.token.length < 20) { s.preError = 'Paste a GitHub token first.'; render(); return }
  if (s.preBusy) return
  s.preBusy = true; s.preError = ''; s.preProgress = []; render()
  try {
    const g = s.agents
    s.pre = await streamPreflight({
      ...awsBody(), token: s.github.token, adminToken: s.github.adminToken, prefix: g.prefix, model: g.model,
      gpuEnabled: g.gpuEnabled, gpuSpot: g.gpuSpot, cpuSpot: g.cpuSpot, cpuVcpus: g.cpuVcpus, runnerAuth: s.runners.auth,
      repos: [...s.projects].filter(([, p]) => !p.create).map(([r]) => r), create: [...s.projects].filter(([, p]) => p.create).map(([r]) => r),
    })
  } catch (e) {
    s.pre = null
    s.preError = e instanceof Error ? e.message : String(e)
  } finally {
    s.preBusy = false; render()
  }
}

/** POST /api/preflight, reading each check's progress as the installer reports it, then the result. */
async function streamPreflight(body: unknown): Promise<Preflight> {
  const r = await fetch('/api/preflight', {
    method: 'POST',
    headers: { 'x-trace-key': KEY, 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  })
  if (!r.ok || !r.body) {
    const data = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `The installer did not answer the checks (${r.status}).`)
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      const m = JSON.parse(line) as ({ type: 'progress' } & Progress) | { type: 'result'; result: Preflight } | { type: 'error'; error: string }
      if (m.type === 'result') return m.result
      if (m.type === 'error') throw new Error(m.error)
      const { type: _t, ...p } = m
      const i = s.preProgress.findIndex((x) => x.id === p.id)
      if (i >= 0) s.preProgress[i] = p
      else s.preProgress.push(p)
      render()
    }
  }
  throw new Error('The installer stopped before the checks finished: is `tracectl install` still running?')
}

/** What the checks are doing right now (while they run), or which ones could not be done (after). */
function progressView(): HTMLElement | null {
  const list = s.preProgress
  if (s.preBusy) {
    const doneN = list.filter((p) => p.state !== 'running').length
    const running = list.filter((p) => p.state === 'running')
    return note('ok',
      h('strong', {}, list.length ? `Checking… ${doneN} of ${list.length} done` : 'Starting the checks…'),
      running.length ? h('ul', { class: 'progress' }, ...running.map((p) => h('li', {}, h('span', { class: 'spin' }), ` ${p.label}`))) : null,
      list.length ? h('details', {}, h('summary', { class: 'muted' }, 'Every check'),
        h('ul', { class: 'progress' }, ...list.map((p) => h('li', {}, `${p.state === 'done' ? '✓' : p.state === 'failed' ? '✕' : '…'} ${p.label}`)))) : null)
  }
  return null
}

async function runFix(c: Check): Promise<void> {
  if (!c.action) return
  if (c.action.id === 'bedrock-use-case') { s.useCase.open = !s.useCase.open; render(); return }
  if (['delete-failed-stack', 'clear-leftovers'].includes(c.action.id) && !window.confirm(`${c.action.label}? This deletes it from the account.`)) return
  s.fixBusy = `${c.id}:${c.action.id}`; render()
  try {
    const p = c.action.params ?? {}
    const fixBody = c.action.id === 'quota-increase' ? { action: c.action.id, service: p.service, code: p.code, value: Number(p.value) }
      : c.action.id === 'bedrock-agreement' ? { action: c.action.id, model: p.model }
      : c.action.id === 'delete-failed-stack' || c.action.id === 'continue-rollback' ? { action: c.action.id, stack: p.stack }
      : c.action.id === 'delete-cognito-domain' ? { action: c.action.id, domain: p.domain, userPoolId: p.userPoolId }
      : c.action.id === 'clear-leftovers' ? { action: c.action.id, prefix: p.prefix }
      : { action: c.action.id }
    const r = await api<{ detail: string }>('POST', '/api/fix', { ...awsBody(), token: s.github.token, fix: fixBody })
    s.fixNote.set(c.id, r.detail)
  } catch (e) {
    s.fixNote.set(c.id, `Could not: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    s.fixBusy = ''; render()
  }
}

async function submitUseCase(c: Check): Promise<void> {
  const { open: _o, ...form } = s.useCase
  s.fixBusy = `${c.id}:bedrock-use-case`; render()
  try {
    const r = await api<{ detail: string }>('POST', '/api/fix', { ...awsBody(), token: s.github.token, fix: { action: 'bedrock-use-case', form } })
    s.fixNote.set(c.id, r.detail); s.useCase.open = false
  } catch (e) {
    s.fixNote.set(c.id, `Could not submit it: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    s.fixBusy = ''; render()
  }
}

async function checkKey(n: IntegrationName): Promise<void> {
  s.integrationCheck.set(n, 'busy'); render()
  try {
    s.integrationCheck.set(n, await api<{ ok: boolean; detail: string }>('POST', '/api/integrations/check', { name: n, values: s.integrations[n] }))
  } catch (e) {
    s.integrationCheck.set(n, { ok: false, detail: e instanceof Error ? e.message : String(e) })
  }
  render()
}

async function startInstall(): Promise<void> {
  s.steps = s.plan ? s.plan.map((st) => ({ ...st })) : []
  s.log = []; s.result = null; s.ready = null; s.appUrl = ''; s.waits.clear(); s.tab = 'install'; render()
  try {
    await api('POST', '/api/apply', { answers: answers(), secrets: secrets() })
  } catch (e) {
    s.result = { ok: false, summary: [e instanceof Error ? e.message : String(e)] }; render(); return
  }
  const es = new EventSource(`/api/events?k=${encodeURIComponent(KEY)}`)
  es.onmessage = (m: MessageEvent<string>) => {
    const e = JSON.parse(m.data) as InstallEvent
    if (e.type === 'step') {
      s.steps = s.steps.some((st) => st.id === e.step.id) ? s.steps.map((st) => (st.id === e.step.id ? e.step : st)) : [...s.steps, e.step]
      // a step that is no longer running has no open wait, even if its last check failed before saying so
      if (e.step.status !== 'running') s.waits.delete(e.step.id)
    }
    else if (e.type === 'log') s.log = [...s.log.slice(-800), `[${e.step}] ${e.line}`]
    else if (e.type === 'ready') { s.ready = e.summary; s.appUrl = e.url ?? s.appUrl }
    else if (e.type === 'wait') {
      // a check of a timer wait: keep the latest; a wait with no next check has ended
      if (e.wait.nextCheckAt) s.waits.set(e.step, { wait: e.wait, asked: false, error: '' })
      else s.waits.delete(e.step)
      s.log = [...s.log.slice(-800), `[${e.step}] ${e.line}`]
    } else { s.result = { ok: e.ok, summary: e.summary }; s.appUrl = e.url ?? s.appUrl; s.waits.clear(); es.close() }
    render()
    const pre = document.querySelector('pre.log')
    if (pre) pre.scrollTop = pre.scrollHeight
  }
}

// ------------------------------------------------------------------ timer waits: the line, the countdown, Check now

/** "just now", "40 seconds", "2 minutes", "1 hour 5 minutes" (core/wait.ts duration, which the page cannot import) */
function duration(ms: number): string {
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
function countdown(ms: number): string {
  const sec = Math.ceil(ms / 1000)
  if (sec <= 0) return 'now'
  const m = Math.floor(sec / 60)
  const r = sec % 60
  const part = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  return m ? `${part(m, 'minute')}${r ? ` ${part(r, 'second')}` : ''}` : part(r, 'second')
}

/** The line about one wait, as of now (describeWait's words, with the next check to the second). */
function waitLine(w: WaitNoticeView, now: number): string {
  const head = `Waiting for ${w.what}${w.state ? ` (${w.state.toLowerCase().replace(/_/g, ' ')})` : ''}.`
  const last = w.lastCheckedAt ? `Checked ${((d) => (d === 'just now' ? d : `${d} ago`))(duration(now - Date.parse(w.lastCheckedAt)))}` : 'Not checked yet'
  const next = w.nextCheckAt ? `next check in ${countdown(Date.parse(w.nextCheckAt) - now)}` : 'no further check is planned'
  return `${head} ${last}; ${next}.`
}

async function checkWaitNow(step: string): Promise<void> {
  const o = s.waits.get(step)
  if (!o) return
  o.asked = true; o.error = ''; render()
  try {
    const r = await api<{ ok: boolean }>('POST', '/api/check-now', { waitId: o.wait.id })
    // false: that wait has just ended (its last event is on its way) or a check is already running
    if (!r.ok && s.waits.get(step) === o) o.asked = false
  } catch (e) {
    o.asked = false; o.error = e instanceof Error ? e.message : String(e)
  }
  render()
}

// one display tick a second while a wait is open: it redraws the countdown and asks the server nothing
let ticking: number | undefined
function tick(): void {
  const now = Date.now()
  for (const el of document.querySelectorAll<HTMLElement>('[data-wait-step]')) {
    const o = s.waits.get(el.dataset.waitStep ?? '')
    if (o) el.textContent = waitLine(o.wait, now)
  }
  if (!s.waits.size && ticking !== undefined) { clearInterval(ticking); ticking = undefined }
}

function waits(): HTMLElement | null {
  if (!s.waits.size) return null
  if (ticking === undefined) ticking = window.setInterval(tick, 1000)
  const now = Date.now()
  return h('div', {}, ...[...s.waits].map(([step, o]) => note('warn',
    h('div', { 'data-wait-step': step, 'aria-live': 'off' }, waitLine(o.wait, now)),
    o.wait.why ? h('div', { class: 'muted' }, `Checked on a timer because ${o.wait.why}.`) : null,
    o.error ? h('div', { class: 'muted' }, `Check now did not go through: ${o.error}`) : null,
    h('div', { class: 'actions' }, h('button', { class: 'secondary', disabled: o.asked, onclick: () => void checkWaitNow(step) }, o.asked ? 'Checking…' : 'Check now')))))
}

const STEP_ICON: Record<Step['status'], string> = { pending: '·', running: '…', done: '✓', skipped: '–', failed: '✕' }

function install(): HTMLElement {
  return h('section', { class: 'card' },
    h('h2', {}, s.result ? (s.result.ok ? 'Installed' : 'Stopped') : s.ready ? 'Ready to use' : 'Installing'),
    s.appUrl && (s.ready || s.result?.ok) ? h('div', { class: 'actions' }, h('a', { class: 'button primary', href: s.appUrl, target: '_blank', rel: 'noopener' }, 'Open trace'), h('span', { class: 'muted' }, ` ${s.appUrl}`)) : null,
    s.result ? note(s.result.ok ? 'ok' : 'bad', h('ul', {}, ...s.result.summary.map((l) => h('li', {}, l))))
      : s.ready ? note('ok', h('strong', {}, s.appUrl ? `trace is ready: sign in at ${s.appUrl} or with \`tracectl login\`. ` : 'trace is ready: sign in with `tracectl login`. '), 'Only the GPU image is still being made.', h('ul', {}, ...s.ready.map((l) => h('li', {}, l))))
      : h('p', { class: 'lead' }, 'Keep this page open until it says trace is ready.'),
    h('ul', { class: 'progress' }, ...s.steps.map((st) => h('li', { class: `status-${st.status}` },
      h('span', { class: 'icon' }, STEP_ICON[st.status]), h('div', {}, h('strong', {}, st.title), h('div', { class: 'detail' }, st.detail))))),
    waits(),
    s.log.length ? h('details', { open: s.result ? !s.result.ok : false }, h('summary', { class: 'muted' }, 'Log'), h('pre', { class: 'log' }, s.log.join('\n'))) : null)
}

// ------------------------------------------------------------------ start

async function boot(): Promise<void> {
  try {
    s.env = await api<Env>('GET', '/api/env')
    const saved = s.env.saved
    if (saved) {
      s.aws.mode = saved.aws?.mode ?? 'profile'
      s.aws.profile = saved.aws?.profile ?? 'default'
      s.aws.region = saved.aws?.region ?? ''
      const sa = saved.agents ?? {}
      Object.assign(s.agents, {
        ...sa, escalateTo: saved.escalateTo ?? '',
        // the page keeps these as the fields' text
        samplingPercent: sa.samplingPercent === null || sa.samplingPercent === undefined ? '' : String(sa.samplingPercent),
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
          memoryDays: p.memoryEventExpiryDays === null || p.memoryEventExpiryDays === undefined ? '' : String(p.memoryEventExpiryDays),
          generation: p.generation ?? 0, create: null,
        })
      }
      if (saved.sample?.enabled && saved.sample.repo) Object.assign(s.sample, { repo: saved.sample.repo, private: saved.sample.private ?? true, tour: saved.sample.tour ?? true })
      s.adminEmail = saved.adminEmail ?? ''
      s.people = (saved.people ?? []).map((p) => ({ email: p.email, class: p.class ?? 'user', projects: new Set(p.projects ?? []) }))
    }
  } catch (e) {
    document.getElementById('app')?.replaceChildren(note('bad', `The installer can't be reached: ${e instanceof Error ? e.message : String(e)}`))
    return
  }
  render()
}

void boot()
