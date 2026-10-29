/**
 * What the page asks the installer (src/installer/server.ts), always because the person acted: nothing here polls.
 * The installation is heard over one event stream (/api/events); a timer wait the installer does itself arrives as a
 * `wait` event, and the page counts down to its next check on its own (a display tick, asking nothing).
 */
import type { IntegrationName } from '../../core/integrations-catalog.js'
import type { Check, InstallEvent, Step } from '../answers.js'
import { type Env, type GithubCheck, type Preflight, type Progress, type StepId, answers, awsBody, blockers, ghCurrent, loadSaved, planKey, preCurrent, preflightBody, preflightKey, secrets, githubTokenError, awsErrors, reconcileProjects } from './model.js'
import { get, update } from './store.js'

const KEY = document.querySelector<HTMLMetaElement>('meta[name="trace-key"]')?.content ?? ''
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(path, {
      method,
      headers: { 'x-trace-key': KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Error('The installer is not answering: is `tracectl install` still running in your terminal?')
  }
  const data = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(data.error ?? `The installer answered ${r.status}.`)
  return data
}

export async function boot(): Promise<void> {
  try {
    const env = await api<Env>('GET', '/api/env')
    update((s) => loadSaved(s, env))
  } catch (e) {
    update((s) => { s.bootError = message(e) })
  }
}

export function go(step: StepId): void {
  update((s) => { s.step = step; s.visited.add(step) })
  window.scrollTo({ top: 0 })
  if (step === 'review') void loadPlan()
}

/** Continue: checks the step first when it has not been, then moves on if nothing stops it. */
export async function next(from: StepId, to: StepId): Promise<void> {
  update((x) => { x.tried.add(from) })
  const s = get()
  if (from === 'github' && !githubTokenError(s.github.token) && !ghCurrent(s)) await checkGithub()
  if (from === 'aws' && !Object.keys(awsErrors(s.aws, s.env?.profiles.names)).length && !preCurrent(s)) await runPreflight()
  if (from === 'projects' && s.pre && !preCurrent(s)) await runPreflight()
  if (blockers(get(), from).length) return
  go(to)
}

// ------------------------------------------------------------------ GitHub

export async function checkGithub(): Promise<void> {
  const token = get().github.token.trim()
  if (githubTokenError(token) || get().ghBusy) return
  update((s) => { s.ghBusy = true; s.ghError = '' })
  try {
    // asked about each project an earlier run installed, so one deleted since is told apart from one merely unlisted
    const saved = [...get().projects].filter(([, p]) => !p.create).map(([repo]) => repo).slice(0, 200)
    const r = await api<GithubCheck>('POST', '/api/github/check', { token, repos: saved })
    update((s) => { s.gh = r; s.ghFor = token; reconcileProjects(s, r) })
  } catch (e) {
    update((s) => { s.gh = null; s.ghFor = ''; s.ghError = humanGithub(message(e)) })
  } finally {
    update((s) => { s.ghBusy = false })
  }
}

function humanGithub(m: string): string {
  if (/401|Bad credentials/i.test(m)) return 'GitHub did not accept the token (Bad credentials): it may have expired, been revoked, or been copied incompletely.'
  if (/403/.test(m) && /SSO|SAML/i.test(m)) return 'GitHub refused the token: its organisation uses single sign-on. Authorise the token for that organisation (Settings › Personal access tokens › Configure SSO).'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m)) return 'GitHub could not be reached from this computer: check its internet connection.'
  return m
}

// ------------------------------------------------------------------ the preflight (everything at once, before anything is created)

export async function runPreflight(): Promise<void> {
  const s0 = get()
  if (s0.preBusy || githubTokenError(s0.github.token) || Object.keys(awsErrors(s0.aws, s0.env?.profiles.names)).length) return
  const body = preflightBody(s0)
  const key = preflightKey(s0)
  update((s) => { s.preBusy = true; s.preError = ''; s.preProgress = [] })
  try {
    const pre = await streamPreflight(body)
    update((s) => { s.pre = pre; s.preKey = key; s.fixNote.clear() })
  } catch (e) {
    update((s) => { s.pre = null; s.preKey = ''; s.preError = message(e) })
  } finally {
    update((s) => { s.preBusy = false })
  }
}

async function streamPreflight(body: unknown): Promise<Preflight> {
  let r: Response
  try {
    r = await fetch('/api/preflight', {
      method: 'POST',
      headers: { 'x-trace-key': KEY, 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('The installer is not answering: is `tracectl install` still running in your terminal?')
  }
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
      update((s) => {
        const i = s.preProgress.findIndex((x) => x.id === p.id)
        if (i >= 0) s.preProgress[i] = p
        else s.preProgress.push(p)
      })
    }
  }
  throw new Error('The installer stopped before the checks finished: is `tracectl install` still running?')
}

/** What the preflight offered to fix, done when the person asks (deletes are confirmed first, by the caller). */
export async function runFix(c: Check): Promise<void> {
  if (!c.action) return
  if (c.action.id === 'bedrock-use-case') { update((s) => { s.useCase.open = !s.useCase.open }); return }
  const id = `${c.id}:${c.action.id}`
  update((s) => { s.fixBusy = id })
  try {
    const p = c.action.params ?? {}
    const a = c.action.id
    const fix = a === 'quota-increase' ? { action: a, service: p.service, code: p.code, value: Number(p.value) }
      : a === 'bedrock-agreement' ? { action: a, model: p.model }
      : a === 'delete-failed-stack' || a === 'continue-rollback' ? { action: a, stack: p.stack }
      : a === 'delete-cognito-domain' ? { action: a, domain: p.domain, userPoolId: p.userPoolId }
      : a === 'clear-leftovers' ? { action: a, prefix: p.prefix }
      : { action: a }
    const r = await api<{ detail: string }>('POST', '/api/fix', { ...awsBody(get()), token: get().github.token.trim(), fix })
    update((s) => { s.fixNote.set(c.id, `${r.detail} Check again to confirm.`) })
  } catch (e) {
    update((s) => { s.fixNote.set(c.id, `Could not: ${message(e)}`) })
  } finally {
    update((s) => { s.fixBusy = '' })
  }
}

export async function submitUseCase(c: Check): Promise<void> {
  const { open: _o, ...form } = get().useCase
  update((s) => { s.fixBusy = `${c.id}:bedrock-use-case` })
  try {
    const r = await api<{ detail: string }>('POST', '/api/fix', { ...awsBody(get()), token: get().github.token.trim(), fix: { action: 'bedrock-use-case', form } })
    update((s) => { s.fixNote.set(c.id, r.detail); s.useCase.open = false })
  } catch (e) {
    update((s) => { s.fixNote.set(c.id, `Could not submit it: ${message(e)}`) })
  } finally {
    update((s) => { s.fixBusy = '' })
  }
}

// ------------------------------------------------------------------ integrations

export async function checkKey(n: IntegrationName): Promise<void> {
  update((s) => { s.integrationCheck.set(n, 'busy') })
  try {
    const r = await api<{ ok: boolean; detail: string }>('POST', '/api/integrations/check', { name: n, values: get().integrations[n] })
    update((s) => { s.integrationCheck.set(n, r) })
  } catch (e) {
    update((s) => { s.integrationCheck.set(n, { ok: false, detail: message(e) }) })
  }
}

// ------------------------------------------------------------------ the plan, and the installation

export async function loadPlan(): Promise<void> {
  if (get().planBusy) return
  update((s) => { s.planError = ''; s.planBusy = true })
  try {
    // the plan needs the account the checks found: run them again when what they were asked about has changed
    if (!preCurrent(get())) await runPreflight()
    const s = get()
    if (!s.pre?.facts.account) {
      update((x) => { x.plan = null; x.planError = x.preError ? `The checks could not run, so there is no plan yet: ${x.preError}` : 'The AWS account is not known yet: check it on the AWS step.' })
      return
    }
    const key = planKey(s)
    if (s.plan && s.planKey === key) return
    const r = await api<{ steps: Step[]; timeline: string[]; changes: string[] }>('POST', '/api/plan', { answers: answers(s), existing: s.pre.facts.existing ?? null, cdkBootstrapped: s.pre.facts.cdkBootstrapped ?? false })
    update((x) => { x.plan = r.steps; x.planKey = key; x.timeline = r.timeline; x.changes = r.changes })
  } catch (e) {
    update((s) => { s.plan = null; s.planError = message(e) })
  } finally {
    update((s) => { s.planBusy = false })
  }
}

let stream: EventSource | null = null

export async function startInstall(): Promise<void> {
  const s0 = get()
  if (blockers(s0, 'review').length || !s0.plan) return
  update((s) => {
    s.steps = s.plan ? s.plan.map((st) => ({ ...st })) : []
    s.log = []; s.result = null; s.ready = null; s.appUrl = ''; s.waits.clear(); s.step = 'install'; s.visited.add('install')
  })
  window.scrollTo({ top: 0 })
  try {
    await api('POST', '/api/apply', { answers: answers(get()), secrets: secrets(get()) })
  } catch (e) {
    update((s) => { s.result = { ok: false, summary: [message(e)] } })
    return
  }
  stream?.close()
  stream = new EventSource(`/api/events?k=${encodeURIComponent(KEY)}`)
  stream.onmessage = (m: MessageEvent<string>) => {
    const e = JSON.parse(m.data) as InstallEvent
    update((s) => {
      if (e.type === 'step') {
        s.steps = s.steps.some((st) => st.id === e.step.id) ? s.steps.map((st) => (st.id === e.step.id ? e.step : st)) : [...s.steps, e.step]
        if (e.step.status !== 'running') s.waits.delete(e.step.id)
      } else if (e.type === 'log') s.log = [...s.log.slice(-800), `[${e.step}] ${e.line}`]
      else if (e.type === 'ready') { s.ready = e.summary; s.appUrl = e.url ?? s.appUrl }
      else if (e.type === 'wait') {
        if (e.wait.nextCheckAt) s.waits.set(e.step, { wait: e.wait, asked: false, error: '' })
        else s.waits.delete(e.step)
        s.log = [...s.log.slice(-800), `[${e.step}] ${e.line}`]
      } else {
        s.result = { ok: e.ok, summary: e.summary }; s.appUrl = e.url ?? s.appUrl; s.waits.clear()
        stream?.close(); stream = null
      }
    })
  }
  stream.onerror = () => {
    // the stream ends when the installation does; before then, a dropped stream means the installer itself stopped
    if (!get().result && stream?.readyState === EventSource.CLOSED) {
      update((s) => { s.result = { ok: false, summary: ['The connection to the installer was lost: is `tracectl install` still running? Running it again picks up where this stopped.'] } })
    }
  }
}

export async function checkWaitNow(step: string): Promise<void> {
  const o = get().waits.get(step)
  if (!o) return
  update(() => { o.asked = true; o.error = '' })
  try {
    const r = await api<{ ok: boolean }>('POST', '/api/check-now', { waitId: o.wait.id })
    if (!r.ok) update((s) => { if (s.waits.get(step) === o) o.asked = false })
  } catch (e) {
    update(() => { o.asked = false; o.error = message(e) })
  }
}
