/**
 * The installer page's behaviour (bundled to /ui.js by scripts/bundle-ui.mjs). Five steps — GitHub, AWS, agents,
 * people, review — each checked against the local installer server before moving on, then the installation's
 * progress streamed live. The answers are validated with the same zod schemas the server uses.
 */
import { type AnswersInput, AnswersSchema, type InstallEvent, RUNNER_COMPUTE_TYPES, type Step } from '../answers.js'

// ------------------------------------------------------------------ the server's answers (shapes the page relies on)

interface TokenInfo {
  login: string; name: string | null; kind: string; scopes: string[]; warnings: string[]
  repos: { fullName: string; private: boolean; admin: boolean; push: boolean; defaultBranch: string }[]
  access: { repo: string; ok: boolean; reason: string }[]
}
interface AwsCheck {
  account: string; arn: string; region: string; agentCore: { ok: boolean; reason: string }
  models: { id: string; name: string }[]; oidcProvider: boolean; cdkBootstrapped: boolean
  existing: { stack: string; status: string; outputs: Record<string, string> } | null; warnings: string[]
}
interface Env { profiles: { names: string[]; regions: Record<string, string> }; saved: AnswersInput | null; installed: { stack: string; region: string } | null; node: string }

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

type Tab = 'github' | 'aws' | 'agents' | 'people' | 'review' | 'install'
const TABS: { id: Tab; title: string }[] = [
  { id: 'github', title: '1 GitHub' }, { id: 'aws', title: '2 AWS' }, { id: 'agents', title: '3 Agents' },
  { id: 'people', title: '4 People' }, { id: 'review', title: '5 Review' }, { id: 'install', title: 'Install' },
]

type PersonClass = 'admin' | 'user' | 'guest'
interface Person { email: string; class: PersonClass; projects: Set<string> }

const s = {
  tab: 'github' as Tab,
  done: new Set<Tab>(),
  env: null as Env | null,
  github: { token: '', adminToken: '', info: null as TokenInfo | null, filter: '', busy: false, error: '' },
  /** a project's own agent token (OWNER/REPO → token): memory only, like every other secret */
  projectTokens: new Map<string, string>(),
  /** distributor keys for the library gateway (memory only, like every other secret; empty keeps the stored one) */
  libraryKeys: { MOUSER_API_KEY: '', DIGIKEY_CLIENT_ID: '', DIGIKEY_CLIENT_SECRET: '', NEXAR_CLIENT_ID: '', NEXAR_CLIENT_SECRET: '' },
  /** memoryDays: the field's text ('' = the installation's default); generation: kept from the saved answers (the
   * installer raises it when a removed project is added again; never set here) */
  projects: new Map<string, { branch: string; onboard: boolean; applySettings: boolean; memoryDays: string; generation: number }>(),
  aws: { mode: 'profile' as 'profile' | 'keys', profile: 'default', region: 'us-east-1', keyId: '', secret: '', session: '', check: null as AwsCheck | null, confirmed: false, busy: false, error: '' },
  /** where the GitHub Actions jobs run (AWS CodeBuild): connectionArn '' = reuse an authorized connection, else the stack creates `<prefix>-github`; computeType
   * '' and privileged 'default' = the stack's defaults */
  runners: { connectionArn: '', computeType: '' as '' | (typeof RUNNER_COMPUTE_TYPES)[number], privileged: 'default' as 'default' | 'on' | 'off' },
  agents: { prefix: 'trace', model: '', maxLifetimeHours: 8, idleMinutes: 15, centralBucketName: '', retainData: true, escalateTo: '', gpuEnabled: true, gpuMaxVcpus: 16, gpuSpot: false,
    cpuEnabled: true, cpuMaxVcpus: 64, cpuSpot: false, cpuVcpus: 16, cpuMemoryMiB: 32_768, knowledgeBase: true, libraryGateway: false,
    observability: true, transactionSearch: true, samplingPercent: '', dashboard: true, migrateLayout: false },
  adminEmail: '',
  people: [] as Person[],
  plan: null as Step[] | null,
  planError: '',
  steps: [] as Step[],
  log: [] as string[],
  result: null as { ok: boolean; summary: string[] } | null,
}

// ------------------------------------------------------------------ DOM helper

type Child = Node | string | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) el.value = String(v)
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
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => on((e.target as HTMLInputElement).checked) }), label)

function select(options: { value: string; label: string }[], value: string, on: (v: string) => void): HTMLSelectElement {
  const el = h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...options.map((o) => h('option', { value: o.value }, o.label)))
  el.value = value
  return el
}

// ------------------------------------------------------------------ the answers

/** The stack already here keeps every project in itself (layout flat: no Layout output, or Layout=flat): bootstrap.ts layoutOf. */
function flatInstall(): boolean {
  const o = s.aws.check?.existing?.outputs ?? {}
  return o.Layout ? o.Layout === 'flat' : Object.keys(o).length > 0
}

function answers(): AnswersInput {
  return {
    github: { login: s.github.info?.login ?? '' },
    aws: { mode: s.aws.mode, profile: s.aws.profile, region: s.aws.region, account: s.aws.check?.account ?? '' },
    agents: {
      prefix: s.agents.prefix, model: s.agents.model, maxLifetimeHours: s.agents.maxLifetimeHours, idleMinutes: s.agents.idleMinutes,
      createOidcProvider: !(s.aws.check?.oidcProvider ?? false), centralBucketName: s.agents.centralBucketName, retainData: s.agents.retainData,
      gpuEnabled: s.agents.gpuEnabled, gpuMaxVcpus: s.agents.gpuMaxVcpus, gpuSpot: s.agents.gpuSpot,
      cpuEnabled: s.agents.cpuEnabled, cpuMaxVcpus: s.agents.cpuMaxVcpus, cpuSpot: s.agents.cpuSpot, cpuVcpus: s.agents.cpuVcpus, cpuMemoryMiB: s.agents.cpuMemoryMiB,
      knowledgeBase: s.agents.knowledgeBase, libraryGateway: s.agents.libraryGateway,
      observability: s.agents.observability, transactionSearch: s.agents.transactionSearch, dashboard: s.agents.dashboard,
      samplingPercent: s.agents.samplingPercent.trim() === '' ? null : Number(s.agents.samplingPercent),
      migrateLayout: s.agents.migrateLayout,
    },
    runners: {
      connectionArn: s.runners.connectionArn, computeType: s.runners.computeType || null,
      privileged: s.runners.privileged === 'default' ? null : s.runners.privileged === 'on',
    },
    projects: [...s.projects].map(([repo, { memoryDays, ...p }]) => ({ repo, ...p, memoryEventExpiryDays: memoryDays.trim() === '' ? null : Number(memoryDays) })),
    adminEmail: s.adminEmail,
    people: s.people.filter((p) => p.email.trim()).map((p) => ({
      email: p.email.trim(), class: p.class,
      projects: p.class === 'admin' ? [] : [...p.projects].filter((r) => s.projects.has(r)),
    })),
    escalateTo: s.agents.escalateTo,
  }
}

const secrets = (): Record<string, unknown> => ({
  githubToken: s.github.token, githubAdminToken: s.github.adminToken,
  projectTokens: Object.fromEntries([...s.projectTokens].filter(([r, t]) => s.projects.has(r) && t.trim())),
  awsAccessKeyId: s.aws.mode === 'keys' ? s.aws.keyId : '', awsSecretAccessKey: s.aws.mode === 'keys' ? s.aws.secret : '',
  awsSessionToken: s.aws.mode === 'keys' ? s.aws.session : '',
  libraryKeys: s.agents.libraryGateway ? { ...s.libraryKeys } : {},
})

function problems(tab: Tab): string[] {
  const out: string[] = []
  if (tab === 'github') {
    if (!s.github.info) out.push('Check the GitHub token.')
    if (!s.projects.size) out.push('Choose at least one repository.')
    for (const a of s.github.info?.access ?? []) if (!a.ok && s.projects.has(a.repo) && !s.github.adminToken) out.push(`The token can't manage ${a.repo}'s Actions secrets: add an admin token under "Installing with a different token".`)
  }
  if (tab === 'aws') {
    if (!s.aws.check) out.push('Check the AWS credentials.')
    else {
      if (!s.aws.confirmed) out.push(`Confirm that ${s.aws.check.account} is the right account.`)
      if (!s.aws.check.agentCore.ok) out.push('Bedrock AgentCore is not available here.')
    }
    if (s.runners.connectionArn && !CONNECTION_ARN.test(s.runners.connectionArn)) out.push('The GitHub connection must be an AWS CodeConnections connection ARN, or empty.')
  }
  if (tab === 'agents' && !s.agents.model) out.push('Choose the model the agents use.')
  if (tab === 'people' && !/^\S+@\S+\.\S+$/.test(s.adminEmail)) out.push("Enter the first administrator's email.")
  return out
}

// ------------------------------------------------------------------ rendering

function render(): void {
  const root = document.getElementById('app')
  if (!root) return
  const nav = h('nav', { class: 'steps' }, ...TABS.map((t) => h('button', {
    class: `${s.tab === t.id ? 'on' : ''} ${s.done.has(t.id) ? 'ok' : ''}`,
    disabled: t.id === 'install' && !s.steps.length,
    onclick: () => { s.tab = t.id; render() },
  }, t.title)))
  const body = { github: github, aws: aws, agents: agents, people: people, review: review, install: install }[s.tab]()
  root.replaceChildren(nav, body)
}

function next(from: Tab, to: Tab): HTMLElement {
  const blockers = problems(from)
  return h('div', { class: 'actions' },
    blockers.length ? h('span', { class: 'muted' }, blockers[0] ?? '') : null,
    h('button', { class: 'primary', disabled: blockers.length > 0, onclick: () => { s.done.add(from); s.tab = to; if (to === 'review') void loadPlan(); render() } }, 'Continue'))
}

function github(): HTMLElement {
  const g = s.github
  const info = g.info
  const repos = (info?.repos ?? []).filter((r) => !g.filter || r.fullName.toLowerCase().includes(g.filter.toLowerCase()))
  return h('section', { class: 'card' },
    h('h2', {}, 'GitHub'),
    h('p', { class: 'lead' }, 'The token the agents and workflows use to clone, push, open PRs and comment. Use a fine-grained token limited to the repositories below, with only Contents, Pull requests, Issues, Workflows and Actions read/write: the agents never need Secrets, Variables or Administration. Make it on a separate machine account if you can, so the agents\' approvals are never yours. It is stored in AWS Secrets Manager and as each repository\'s TRACE_TOKEN secret. Setting up the repositories (variables, secrets, the ruleset) needs more: give a second, admin token below; it is used only during this installation and never stored.'),
    field('Token', input('password', g.token, (v) => { g.token = v.trim(); g.info = null }, { placeholder: 'github_pat_…' })),
    h('details', {}, h('summary', { class: 'muted' }, 'Installing with a different token'),
      field('Admin token', input('password', g.adminToken, (v) => { g.adminToken = v.trim() }), 'used only now, to set repository secrets, variables and settings; never stored')),
    h('div', { class: 'actions' }, h('button', { class: 'secondary', disabled: g.busy, onclick: () => void checkGithub() }, g.busy ? 'Checking…' : 'Check token')),
    g.error ? note('bad', g.error) : null,
    info ? note('ok', `Signed in as ${info.login}${info.name ? ` (${info.name})` : ''}: a ${info.kind} token with access to ${info.repos.length} repositories.`) : null,
    ...(info?.warnings ?? []).map((w) => note('warn', w)),
    ...(info?.access ?? []).filter((a) => !a.ok).map((a) => note('warn', `${a.repo}: ${a.reason}`)),
    info ? h('div', {},
      h('label', {}, 'Projects ', h('small', {}, '— the repositories trace runs')),
      input('text', g.filter, (v) => { g.filter = v; render() }, { placeholder: 'Filter…' }),
      h('div', { class: 'repos' }, ...repos.slice(0, 300).map((r) => {
        const p = s.projects.get(r.fullName)
        return h('div', { class: 'item' },
          h('input', { type: 'checkbox', checked: Boolean(p), onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) s.projects.set(r.fullName, { branch: r.defaultBranch, onboard: true, applySettings: r.admin, memoryDays: '', generation: 0 })
            else s.projects.delete(r.fullName)
            void checkAccess(); render()
          } }),
          h('span', {}, r.fullName, ' ', r.private ? h('span', { class: 'tag' }, 'private') : null, r.admin ? null : h('span', { class: 'tag' }, 'not admin')),
          p ? h('span', { class: 'opt' }, checkbox('onboarding PR', p.onboard, (v) => { p.onboard = v })) : h('span', {}),
          p ? h('span', { class: 'opt' }, checkbox('repo settings', p.applySettings, (v) => { p.applySettings = v })) : h('span', {}),
          p ? h('span', { class: 'opt', title: 'Days this project\'s agent memory keeps short-term events (3–365). Empty: 30.' },
            h('label', { class: 'check' }, 'memory days ', input('number', p.memoryDays, (v) => { p.memoryDays = v.trim() }, { min: 3, max: 365, step: 1, placeholder: '30', style: 'width:5em' }))) : h('span', {}))
      }))) : null,
    s.projects.size ? h('details', {}, h('summary', { class: 'muted' }, 'Each project\'s own agent token (optional)'),
      h('p', { class: 'muted' }, 'Every project gets its own AWS resources and roles, so one project\'s agent cannot reach another\'s in AWS. On GitHub it can reach whatever its token can: give a project a fine-grained token limited to that repository alone to isolate it there too. Projects without one use the token above.'),
      ...[...s.projects.keys()].map((r) => field(r, input('password', s.projectTokens.get(r) ?? '', (v) => { s.projectTokens.set(r, v.trim()) }, { placeholder: 'the token above' }), 'checked when installing: it must reach this repository, and should reach no other project'))) : null,
    next('github', 'aws'))
}

async function checkGithub(): Promise<void> {
  if (s.github.token.length < 20) { s.github.error = 'Paste a GitHub token first.'; render(); return }
  s.github.busy = true; s.github.error = ''; render()
  try {
    s.github.info = await api<TokenInfo>('POST', '/api/github/check', { token: s.github.token, repos: [...s.projects.keys()] })
  } catch (e) {
    s.github.error = e instanceof Error ? e.message : String(e)
  } finally {
    s.github.busy = false; render()
  }
}

async function checkAccess(): Promise<void> {
  if (!s.github.info) return
  try {
    const r = await api<TokenInfo>('POST', '/api/github/check', { token: s.github.adminToken || s.github.token, repos: [...s.projects.keys()] })
    s.github.info = { ...s.github.info, access: r.access }
    render()
  } catch { /* shown on the next check */ }
}

function aws(): HTMLElement {
  const a = s.aws
  const profiles = s.env?.profiles.names ?? []
  const c = a.check
  return h('section', { class: 'card' },
    h('h2', {}, 'AWS'),
    h('p', { class: 'lead' }, 'The account and region trace is installed into. The credentials need to create IAM roles, S3, ECR, CodeBuild, Cognito, Secrets Manager and Bedrock AgentCore resources (an administrator profile is simplest). They are used only by this installer and by the CDK deploy it runs.'),
    h('div', { class: 'row' },
      field('Credentials', select([{ value: 'profile', label: 'A profile on this machine' }, { value: 'keys', label: 'Access keys' }], a.mode, (v) => { a.mode = v === 'keys' ? 'keys' : 'profile'; a.check = null; render() })),
      field('Region', select(REGIONS.map((r) => ({ value: r, label: r })), a.region, (v) => { a.region = v; a.check = null; render() }))),
    a.mode === 'profile'
      ? field('Profile', profiles.length
        ? select(profiles.map((p) => ({ value: p, label: p })), a.profile, (v) => { a.profile = v; const r = s.env?.profiles.regions[v]; if (r) a.region = r; a.check = null; render() })
        : input('text', a.profile, (v) => { a.profile = v; a.check = null }), 'SSO profiles work: run `aws sso login` first')
      : h('div', {},
        h('div', { class: 'row' },
          field('Access key id', input('text', a.keyId, (v) => { a.keyId = v.trim(); a.check = null })),
          field('Secret access key', input('password', a.secret, (v) => { a.secret = v.trim(); a.check = null }))),
        field('Session token', input('password', a.session, (v) => { a.session = v.trim(); a.check = null }), 'only for temporary credentials')),
    h('div', { class: 'actions' }, h('button', { class: 'secondary', disabled: a.busy, onclick: () => void checkAws() }, a.busy ? 'Checking…' : 'Check credentials')),
    a.error ? note('bad', a.error) : null,
    c ? h('div', {},
      note('ok', `${c.arn}`),
      checkbox(`Install into account ${c.account} in ${c.region}`, a.confirmed, (v) => { a.confirmed = v; render() }),
      c.agentCore.ok ? note('ok', 'Bedrock AgentCore is available.') : note('bad', `Bedrock AgentCore is not available: ${c.agentCore.reason}`),
      note(c.models.length ? 'ok' : 'warn', c.models.length ? `${c.models.length} Anthropic models are available.` : 'No Anthropic model is enabled in this region yet.'),
      note('ok', c.oidcProvider ? "GitHub's OIDC provider already exists in this account: trace will use it." : "GitHub's OIDC provider will be created."),
      note('ok', c.cdkBootstrapped ? 'CDK is already bootstrapped here.' : 'CDK will be bootstrapped here first.'),
      c.existing ? note('warn', `trace is already installed here (${c.existing.stack}, ${c.existing.status}): installing again updates it.`) : null,
      ...c.warnings.map((w) => note('warn', w))) : null,
    runners(),
    next('aws', 'agents'))
}

const CONNECTION_ARN = /^arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36}$/
const COMPUTE_LABEL: Record<(typeof RUNNER_COMPUTE_TYPES)[number], string> = {
  BUILD_GENERAL1_MEDIUM: 'Medium (4 vCPUs, 7 GB)', BUILD_GENERAL1_LARGE: 'Large (8 vCPUs, 15 GB)',
  BUILD_GENERAL1_XLARGE: 'X-large (36 vCPUs, 72 GB)', BUILD_GENERAL1_2XLARGE: '2X-large (72 vCPUs, 144 GB)',
}

/** Where the repositories' GitHub Actions jobs run: AWS CodeBuild, reached through a CodeConnections connection. */
function runners(): HTMLElement {
  const r = s.runners
  const name = `${s.agents.prefix || 'trace'}-github`
  const url = `https://${s.aws.region}.console.aws.amazon.com/codesuite/settings/connections?region=${s.aws.region}`
  return h('div', {},
    h('h3', {}, 'Where the workflows run'),
    h('p', { class: 'lead' }, `Every GitHub Actions job of the repositories runs on AWS CodeBuild in this account, never on GitHub's own runners: each repository gets its own CodeBuild runner project. CodeBuild reaches GitHub through an AWS CodeConnections connection, so no GitHub token is stored for it. You need nothing here: the installer reuses a connection already authorized in this account and region (${name} first), and if there is none the stack creates ${name}.`),
    note('warn', 'A new connection is authorized once per AWS account and region, by you, in the AWS console. After the first deploy the installer shows the link (', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Connections'), `) and waits: you choose ${r.connectionArn ? 'the connection' : name} and "Update pending connection", which installs the AWS Connector for GitHub app, and the installer adds the build runners by itself. Give that app access to every repository chosen in step 1${s.projects.size ? ` (${[...s.projects.keys()].join(', ')})` : ''}: a repository it cannot reach gets no runner.`),
    field('Use an existing connection (optional)', input('text', r.connectionArn, (v) => { r.connectionArn = v.trim() }, { placeholder: `empty: reuse an authorized one, or create ${name}` }), 'an existing GitHub connection\'s ARN, only if you want that one'),
    h('div', { class: 'row' },
      field('Job size', select([{ value: '', label: 'Default (Large)' }, ...RUNNER_COMPUTE_TYPES.map((t) => ({ value: t, label: COMPUTE_LABEL[t] }))], r.computeType,
        (v) => { r.computeType = (RUNNER_COMPUTE_TYPES as readonly string[]).includes(v) ? v as (typeof RUNNER_COMPUTE_TYPES)[number] : '' }), 'a job can ask for another with an instance-size label'),
      field('Docker in jobs', select([{ value: 'default', label: 'Default (off)' }, { value: 'on', label: 'On (privileged, for jobs that build containers)' }, { value: 'off', label: 'Off' }], r.privileged,
        (v) => { r.privileged = v === 'on' || v === 'off' ? v : 'default' }))))
}

async function checkAws(): Promise<void> {
  const a = s.aws
  a.busy = true; a.error = ''; render()
  try {
    a.check = await api<AwsCheck>('POST', '/api/aws/check', {
      aws: { mode: a.mode, profile: a.profile, region: a.region }, prefix: s.agents.prefix,
      secrets: a.mode === 'keys' ? { awsAccessKeyId: a.keyId, awsSecretAccessKey: a.secret, awsSessionToken: a.session } : {},
    })
    a.confirmed = false
    if (!s.agents.model && a.check.models[0]) s.agents.model = a.check.models[0].id
  } catch (e) {
    a.error = e instanceof Error ? e.message : String(e)
  } finally {
    a.busy = false; render()
  }
}

function agents(): HTMLElement {
  const g = s.agents
  const models = s.aws.check?.models ?? []
  return h('section', { class: 'card' },
    h('h2', {}, 'Agents'),
    h('p', { class: 'lead' }, 'How the agents run on AgentCore. Two runtimes are created from one image: the worker, which the repositories\' workflows call to fix and build; and the API, which people reach after signing in.'),
    h('div', { class: 'row' },
      field('Name', input('text', g.prefix, (v) => { g.prefix = v.trim() }), 'prefixed to every resource'),
      field('Model', models.length
        ? select(models.map((m) => ({ value: m.id, label: m.name })), g.model, (v) => { g.model = v })
        : input('text', g.model, (v) => { g.model = v.trim() }, { placeholder: 'us.anthropic.claude-sonnet-4-6' }))),
    h('div', { class: 'row' },
      field('Longest task (hours)', input('number', String(g.maxLifetimeHours), (v) => { g.maxLifetimeHours = Number(v) }, { min: 0.25, max: 8, step: 0.25 }), 'AgentCore allows up to 8'),
      field('Idle session ends after (minutes)', input('number', String(g.idleMinutes), (v) => { g.idleMinutes = Number(v) }, { min: 1, max: 480 }))),
    h('div', { class: 'row' },
      field('Central bucket name', input('text', g.centralBucketName, (v) => { g.centralBucketName = v.trim() }, { placeholder: 'leave empty to name it automatically' }), 'datasheets and parts, shared by every project'),
      field('Who the agents ask', input('text', g.escalateTo, (v) => { g.escalateTo = v.trim() }, { placeholder: '@your-login' }), 'mentioned when a project needs a person')),
    checkbox('Keep the central bucket and images if trace is uninstalled', g.retainData, (v) => { g.retainData = v }),
    ...(flatInstall() ? [
      h('p', { class: 'lead' }, 'This installation keeps every project in one CloudFormation stack, which holds about 20 projects. New installations give each project its own nested stack, which holds 60. Moving takes three deploys and DELETES every project\'s memory records (AgentCore cannot copy them); the projects are offline while it runs.'),
      checkbox('Move to one nested stack per project (deletes every project\'s memory records)', g.migrateLayout, (v) => { g.migrateLayout = v }),
    ] : []),
    h('h3', {}, 'GPU jobs'),
    h('p', { class: 'lead' }, 'AgentCore has no GPU, so Blender renders and the PCB autorouters run as AWS Batch jobs on GPU instances (g6, g5 or g4dn). The queue scales to zero: nothing runs, and nothing is billed, while there is no job.'),
    checkbox('Run GPU jobs on AWS Batch', g.gpuEnabled, (v) => { g.gpuEnabled = v }),
    h('div', { class: 'row' },
      field('Most vCPUs at once', input('number', String(g.gpuMaxVcpus), (v) => { g.gpuMaxVcpus = Number(v) }, { min: 4, max: 4096, step: 4 }), '4 per job: 16 runs four jobs side by side'),
      field('Instances', checkbox('Use Spot (cheaper; a job can be interrupted)', g.gpuSpot, (v) => { g.gpuSpot = v }))),
    h('h3', {}, 'CPU jobs'),
    h('p', { class: 'lead' }, 'CPU-heavy jobs sent off the runtime (openEMS field solves, Verilator, formal checks and nextpnr runs) go to a second AWS Batch queue of CPU instances (c7i, c6i or m7i), running the same image as the GPU jobs. It also scales to zero. It needs the GPU jobs turned on, and an installation with one nested stack per project.'),
    checkbox('Run CPU-heavy jobs on AWS Batch', g.cpuEnabled, (v) => { g.cpuEnabled = v; render() }),
    g.cpuEnabled && h('div', { class: 'row' },
      field('Most vCPUs at once', input('number', String(g.cpuMaxVcpus), (v) => { g.cpuMaxVcpus = Number(v) }, { min: 1, max: 4096, step: 1 }), `${g.cpuVcpus} per job`),
      field('vCPUs per job', input('number', String(g.cpuVcpus), (v) => { g.cpuVcpus = Number(v) }, { min: 1, max: 192, step: 1 })),
      field('Memory per job (MiB)', input('number', String(g.cpuMemoryMiB), (v) => { g.cpuMemoryMiB = Number(v) }, { min: 1024, step: 1024 }), '32768 needs an 8xlarge on c7i/c6i; 30720 fits a 4xlarge'),
      field('Instances', checkbox('Use Spot (cheaper; a job can be interrupted)', g.cpuSpot, (v) => { g.cpuSpot = v }))),
    h('h3', {}, 'Knowledge bases'),
    h('p', { class: 'lead' }, 'Each project gets an Amazon Bedrock knowledge base over its docs, markdown, rules, KiCad summaries and the datasheets of its BOM parts, with its vectors in Amazon S3 Vectors. Every push to the default branch syncs it. The agents search it before asking. It needs an installation with one nested stack per project.'),
    checkbox('Give each project a knowledge base', g.knowledgeBase, (v) => { g.knowledgeBase = v }),
    h('h3', {}, 'Library gateway'),
    h('p', { class: 'lead' }, 'The shared datasheets and parts tools can run behind one Amazon Bedrock AgentCore Gateway instead of inside every worker. Only those tools move: everything that works on a project stays in its own worker, under its own role. The distributor keys below are then held by the gateway alone, so no agent can read them.'),
    checkbox('Serve the datasheets and parts tools through AgentCore Gateway', g.libraryGateway, (v) => { g.libraryGateway = v; render() }),
    g.libraryGateway && h('div', {},
      h('div', { class: 'row' },
        field('Mouser API key', input('password', s.libraryKeys.MOUSER_API_KEY, (v) => { s.libraryKeys.MOUSER_API_KEY = v.trim() }, { placeholder: 'leave empty to keep the stored one' })),
        field('DigiKey client id', input('password', s.libraryKeys.DIGIKEY_CLIENT_ID, (v) => { s.libraryKeys.DIGIKEY_CLIENT_ID = v.trim() })),
        field('DigiKey client secret', input('password', s.libraryKeys.DIGIKEY_CLIENT_SECRET, (v) => { s.libraryKeys.DIGIKEY_CLIENT_SECRET = v.trim() }))),
      h('div', { class: 'row' },
        field('Nexar client id', input('password', s.libraryKeys.NEXAR_CLIENT_ID, (v) => { s.libraryKeys.NEXAR_CLIENT_ID = v.trim() })),
        field('Nexar client secret', input('password', s.libraryKeys.NEXAR_CLIENT_SECRET, (v) => { s.libraryKeys.NEXAR_CLIENT_SECRET = v.trim() }), 'optional, all of them: LCSC needs no key'))),
    h('h3', {}, 'Observability'),
    h('p', { class: 'lead' }, 'Both runtimes and the GPU jobs send OpenTelemetry traces and metrics to CloudWatch: each session, job, Claude turn and tool call appears in CloudWatch GenAI Observability. Only names, sizes, counts, tokens and outcomes are recorded, never prompts, tool arguments or file contents.'),
    checkbox('Send traces and metrics to CloudWatch (AgentCore observability)', g.observability, (v) => { g.observability = v; render() }),
    g.observability && h('div', {},
      checkbox('Turn on CloudWatch Transaction Search if it is off (once per account and region; uninstalling leaves it on)', g.transactionSearch, (v) => { g.transactionSearch = v }),
      checkbox('Create a CloudWatch dashboard for the agents', g.dashboard, (v) => { g.dashboard = v }),
      h('div', { class: 'row' },
        field('X-Ray trace indexing (%)', input('number', g.samplingPercent, (v) => { g.samplingPercent = v }, { min: 0, max: 100, step: 1, placeholder: 'leave as it is' }),
          'account-wide; empty keeps the account\'s setting (1% by default). Every span is kept in aws/spans whatever this says'))),
    next('agents', 'people'))
}

const CLASS_HELP: Record<PersonClass, string> = {
  admin: 'everything, on every project, including managing people',
  user: 'read and write on the projects ticked',
  guest: 'read only, on the projects ticked',
}

function people(): HTMLElement {
  const repos = [...s.projects.keys()]
  return h('section', { class: 'card' },
    h('h2', {}, 'People'),
    h('p', { class: 'lead' }, 'Everyone signs in with Amazon Cognito, which emails each person a temporary password. There are three classes: admins can do everything on every project; users can read and change the projects they are assigned to; guests can only read the projects they are assigned to. Nobody can see a project they are not assigned to.'),
    field('First administrator', input('email', s.adminEmail, (v) => { s.adminEmail = v.trim() }, { placeholder: 'you@example.com' })),
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, 'Class'), ...repos.map((r) => h('th', {}, r)), h('th', {}, ''))),
      h('tbody', {}, ...s.people.map((p, i) => h('tr', {},
        h('td', {}, input('email', p.email, (v) => { p.email = v }, { placeholder: 'name@example.com' })),
        h('td', { title: CLASS_HELP[p.class] }, select(
          [{ value: 'user', label: 'user' }, { value: 'guest', label: 'guest' }, { value: 'admin', label: 'admin' }],
          p.class, (v) => { p.class = v === 'admin' || v === 'guest' ? v : 'user'; render() })),
        ...repos.map((r) => h('td', {}, p.class === 'admin'
          ? h('span', { class: 'muted' }, 'all')
          : h('input', { type: 'checkbox', checked: p.projects.has(r), title: `${p.class === 'guest' ? 'read' : 'read and write'} on ${r}`,
            onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) p.projects.add(r); else p.projects.delete(r) } }))),
        h('td', {}, h('button', { class: 'secondary', onclick: () => { s.people.splice(i, 1); render() } }, 'Remove')))))),
    s.people.length ? h('p', { class: 'muted' }, s.people.map((p) => `${p.email || 'new person'}: ${CLASS_HELP[p.class]}`).join(' · ')) : null,
    h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: () => { s.people.push({ email: '', class: 'user', projects: new Set() }); render() } }, 'Add a person')),
    next('people', 'review'))
}

async function loadPlan(): Promise<void> {
  s.plan = null; s.planError = ''
  const parsed = AnswersSchema.safeParse(answers())
  if (!parsed.success) { s.planError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '); render(); return }
  try {
    // the stack already there, if the AWS check found one: the plan says what happens to its old memory
    s.plan = (await api<{ steps: Step[] }>('POST', '/api/plan', { answers: answers(), existing: s.aws.check?.existing ?? null })).steps
  } catch (e) {
    s.planError = e instanceof Error ? e.message : String(e)
  }
  render()
}

function review(): HTMLElement {
  return h('section', { class: 'card' },
    h('h2', {}, 'Review'),
    h('p', { class: 'lead' }, 'What installing will do. Every step can be run again safely: if one fails, fix the cause and install again.'),
    s.planError ? note('bad', s.planError) : null,
    s.plan ? h('ol', { class: 'plan' }, ...s.plan.map((st) => h('li', {}, h('strong', {}, st.title), h('div', { class: 'muted' }, st.detail)))) : h('p', { class: 'muted' }, 'Working out the plan…'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', disabled: !s.plan, onclick: () => void startInstall() }, 'Install')))
}

async function startInstall(): Promise<void> {
  s.steps = s.plan ? s.plan.map((st) => ({ ...st })) : []
  s.log = []; s.result = null; s.tab = 'install'; render()
  try {
    await api('POST', '/api/apply', { answers: answers(), secrets: secrets() })
  } catch (e) {
    s.result = { ok: false, summary: [e instanceof Error ? e.message : String(e)] }; render(); return
  }
  const es = new EventSource(`/api/events?k=${encodeURIComponent(KEY)}`)
  es.onmessage = (m: MessageEvent<string>) => {
    const e = JSON.parse(m.data) as InstallEvent
    if (e.type === 'step') s.steps = s.steps.map((st) => (st.id === e.step.id ? e.step : st))
    else if (e.type === 'log') s.log = [...s.log.slice(-800), `[${e.step}] ${e.line}`]
    else { s.result = { ok: e.ok, summary: e.summary }; es.close() }
    render()
    const pre = document.querySelector('pre.log')
    if (pre) pre.scrollTop = pre.scrollHeight
  }
}

const ICON: Record<Step['status'], string> = { pending: '·', running: '…', done: '✓', skipped: '–', failed: '✕' }

function install(): HTMLElement {
  return h('section', { class: 'card' },
    h('h2', {}, s.result ? (s.result.ok ? 'Installed' : 'Stopped') : 'Installing'),
    s.result ? note(s.result.ok ? 'ok' : 'bad', h('ul', {}, ...s.result.summary.map((l) => h('li', {}, l)))) : h('p', { class: 'lead' }, 'Keep this page open. The first deploy builds the agent image and takes a while.'),
    h('ul', { class: 'progress' }, ...s.steps.map((st) => h('li', { class: `status-${st.status}` },
      h('span', { class: 'icon' }, ICON[st.status]), h('div', {}, h('strong', {}, st.title), h('div', { class: 'detail' }, st.detail))))),
    s.log.length ? h('details', { open: !s.result?.ok }, h('summary', { class: 'muted' }, 'Log'), h('pre', { class: 'log' }, s.log.join('\n'))) : null)
}

// ------------------------------------------------------------------ start

async function boot(): Promise<void> {
  try {
    s.env = await api<Env>('GET', '/api/env')
    const saved = s.env.saved
    if (saved) {
      s.aws.mode = saved.aws.mode ?? 'profile'
      s.aws.profile = saved.aws.profile ?? 'default'
      s.aws.region = saved.aws.region
      Object.assign(s.agents, {
        ...saved.agents, escalateTo: saved.escalateTo ?? '',
        // the page keeps the percentage as the field's text ('' = leave the account's setting)
        samplingPercent: saved.agents.samplingPercent === null || saved.agents.samplingPercent === undefined ? '' : String(saved.agents.samplingPercent),
      })
      for (const p of saved.projects) {
        s.projects.set(p.repo, {
          branch: p.branch ?? 'main', onboard: p.onboard ?? true, applySettings: p.applySettings ?? true,
          memoryDays: p.memoryEventExpiryDays === null || p.memoryEventExpiryDays === undefined ? '' : String(p.memoryEventExpiryDays),
          generation: p.generation ?? 0,
        })
      }
      if (saved.runners) {
        s.runners.connectionArn = saved.runners.connectionArn ?? ''
        s.runners.computeType = saved.runners.computeType ?? ''
        s.runners.privileged = saved.runners.privileged === true ? 'on' : saved.runners.privileged === false ? 'off' : 'default'
      }
      s.adminEmail = saved.adminEmail
      s.people = (saved.people ?? []).map((p) => ({ email: p.email, class: p.class ?? 'user', projects: new Set(p.projects ?? []) }))
    } else if (s.env.profiles.regions.default) {
      s.aws.region = s.env.profiles.regions.default
    }
  } catch (e) {
    document.getElementById('app')?.replaceChildren(note('bad', `The installer can't be reached: ${e instanceof Error ? e.message : String(e)}`))
    return
  }
  render()
}

void boot()
