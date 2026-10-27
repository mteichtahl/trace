/**
 * `tracectl update-installation` (src/installer/update.ts): the self-update job of trace's own ci workflow, with fakes for
 * AWS, CDK and GitHub. It deploys with the saved settings and the runners' way to GitHub decided now (runners.auth, as
 * the installer decides it), sets the runners' variables when it can and writes them to the step summary when it
 * cannot, and fails only when the deploy does (or would deploy runners with a credential CodeBuild does not have).
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionChoice } from '../../src/installer/aws.js'
import { type InfraInput, InfraPropsSchema, ciRunnerOutput, projectHash, projectOutputs } from '../../src/infra/props.js'
import { installationRecord } from '../../src/installer/record.js'
import { type UpdateDeps, updateInstallation, updateProps } from '../../src/installer/update.js'
import { FLAT_UPDATE_MAX, MAX_ATTEMPTS, absorb, addPending, parsePending } from '../../src/installer/pending.js'

const BOARD = 'mteichtahl/board'
const TRACE = 'mteichtahl/trace'
const CONN = 'arn:aws:codeconnections:us-east-1:123456789012:connection/11111111-2222-3333-4444-555555555555'
const TOKEN = ['github', 'pat', '11FAKEFAKEFAKE0123456789'].join('_')
const PROPS: InfraInput = {
  prefix: 'trace', layout: 'nested', account: '123456789012', region: 'us-east-1', repositories: [`${BOARD}@main`], ciRepositories: [TRACE],
  selfUpdate: { repository: TRACE, branch: 'main' }, model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com',
  runners: { connectionReady: false, computeType: 'BUILD_GENERAL1_XLARGE' },
}
const RECORD = JSON.stringify(installationRecord({ stack: 'TraceStack', region: 'us-east-1', props: PROPS, runnerAuth: 'connection', connectionArn: '', traceRepository: TRACE, traceBranch: 'main', now: new Date('2026-10-01T00:00:00Z') }))
const BASE_OUTPUTS = { CentralBucket: 'trace-central', GithubSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token', GithubConnectionArn: CONN }
const WITH_RUNNERS = { ...BASE_OUTPUTS, [projectOutputs(BOARD).runnerProject]: `trace-ci-${projectHash(BOARD)}`, [ciRunnerOutput(TRACE)]: `trace-ci-${projectHash(TRACE)}` }

const ready: ConnectionChoice = { arn: CONN, name: 'trace-github', ready: true, message: 'Using the GitHub connection trace-github, which this stack created, already authorized.' }
const pending: ConnectionChoice = { arn: CONN, name: 'trace-github', ready: false, message: 'The GitHub connection this stack created, trace-github is not authorized yet (PENDING)' }

interface World {
  deps: UpdateDeps
  infra: Record<string, unknown>[]
  cdkArgs: string[][]
  vars: Map<string, string>
  log: string[]
  summary: string[]
  asked: { prefix: string; given?: string; deployed: Record<string, string> | null }[]
  /** installation/pending-projects/* (key → text), and the project secrets written */
  records: Map<string, string>
  secrets: Map<string, string>
}

function world(o: { choice?: ConnectionChoice; cdk?: number; githubFails?: boolean; record?: string; env?: Record<string, string>; vars?: Record<string, string>; sourceCredential?: boolean; pending?: Record<string, unknown>[] } = {}): World {
  const w: World = { deps: undefined as unknown as UpdateDeps, infra: [], cdkArgs: [], vars: new Map(Object.entries(o.vars ?? {})), log: [], summary: [], asked: [], records: new Map(), secrets: new Map() }
  for (const r of o.pending ?? []) w.records.set(`installation/pending-projects/${String(r.repo).toLowerCase()}.json`, JSON.stringify(r))
  let deployed = false
  w.deps = {
    env: { TRACE_STACK: 'TraceStack', TRACE_AWS_REGION: 'us-east-1', ...(o.env ?? {}) },
    credentials: async () => ({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret-from-oidc-0123', sessionToken: 'session' }),
    outputs: async () => {
      const base = deployed && ((o.choice ?? ready).ready || w.infra.some((i) => (i.runners as Record<string, unknown>).auth === 'token')) ? WITH_RUNNERS : BASE_OUTPUTS
      const withNew = deployed && w.infra.some((i) => (i.repositories as string[]).some((r) => r.startsWith(`${NEW}@`)))
      if (!withNew) return base
      const p = projectOutputs(NEW)
      return { ...base, TraceHome: 's3://trace-central/central', [p.roleArn]: 'arn:aws:iam::123456789012:role/fresh', [p.runtimeArn]: 'arn:runtime/fresh', [p.secretArn]: 'arn:secret/fresh', [p.memoryId]: 'mem-fresh', [p.runnerProject]: `trace-ci-${projectHash(NEW)}` }
    },
    readRecord: async (_c, _r, bucket, key) => { expect([bucket, key]).toEqual(['trace-central', 'installation/props.json']); return o.record ?? RECORD },
    resolveConnection: async (_c, _r, q) => { w.asked.push(q); return o.choice ?? ready },
    hasSourceCredential: async () => o.sourceCredential ?? true,
    cdk: async (args, env, onLine) => {
      w.cdkArgs.push(args)
      w.infra.push(JSON.parse(env.TRACE_INFRA ?? '{}') as Record<string, unknown>)
      onLine(`deploying with ${TOKEN}`)
      deployed = (o.cdk ?? 0) === 0
      return o.cdk ?? 0
    },
    sharedToken: async (_c, _r, arn) => { expect(arn).toBe(BASE_OUTPUTS.GithubSecretArn); return TOKEN },
    github: {
      get: async (_t, repo, name) => w.vars.get(`${repo}:${name}`) ?? null,
      set: async (_t, repo, name, value) => { if (o.githubFails) throw new Error('PATCH: 403 Resource not accessible by personal access token'); w.vars.set(`${repo}:${name}`, value) },
      delete: async (_t, repo, name) => { if (o.githubFails) throw new Error('DELETE: 403'); w.vars.delete(`${repo}:${name}`) },
    },
    pending: {
      list: async (_c, _r, bucket) => { expect(bucket).toBe('trace-central'); return [...w.records].map(([key, text]) => ({ key, text })) },
      put: async (_c, _r, _b, key, text) => { w.records.set(key, text) },
    },
    putSecret: async (_c, _r, arn, value) => { w.secrets.set(arn, value) },
    log: (l) => w.log.push(l),
    summary: (l) => w.summary.push(l),
  }
  w.deps.github.setSecret = async (_t, repo, name, value) => { w.vars.set(`${repo}:secret:${name}`, value) }
  w.deps.github.login = async () => 'trace-bot'
  w.deps.github.branch = async (_t, repo) => (repo === NEW ? 'trunk' : 'main')
  return w
}

const NEW = 'acme/fresh'

describe('tracectl update-installation', () => {
  it('deploys the saved settings with the connection decided now, and sets each runner\'s variable that is missing or different', async () => {
    const w = world({ vars: { [`${TRACE}:TRACE_CODEBUILD_PROJECT`]: 'old-name' } })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.asked).toEqual([{ prefix: 'trace', deployed: BASE_OUTPUTS }])
    expect(w.cdkArgs[0]?.slice(0, 2)).toEqual(['deploy', 'TraceStack'])
    expect(w.cdkArgs[0]).toContain('--require-approval')
    // the record's settings, with only the connection's readiness changed (the stack keeps its own connection: no ARN passed)
    expect(w.infra[0]).toEqual({ ...PROPS, runners: { computeType: 'BUILD_GENERAL1_XLARGE', connectionReady: true } })
    expect(w.vars.get(`${BOARD}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(BOARD)}`)
    expect(w.vars.get(`${TRACE}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(TRACE)}`)
    expect(w.summary).toEqual(['TraceStack is up to date with this commit.'])
    // the token never reaches the log
    expect(w.log.join('\n')).not.toContain(TOKEN)
    expect(w.log).toContain(`${BOARD}: TRACE_CODEBUILD_PROJECT set to trace-ci-${projectHash(BOARD)} (its jobs now run on AWS)`)
  })

  it('leaves a variable that is right alone', async () => {
    const w = world({ vars: { [`${BOARD}:TRACE_CODEBUILD_PROJECT`]: `trace-ci-${projectHash(BOARD)}`, [`${TRACE}:TRACE_CODEBUILD_PROJECT`]: `trace-ci-${projectHash(TRACE)}` } })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.log.filter((l) => /TRACE_CODEBUILD_PROJECT set/.test(l))).toEqual([])
  })

  it('passes the connection the installer was given, and the one it reuses', async () => {
    const given = world({ record: JSON.stringify({ ...JSON.parse(RECORD), connectionArn: CONN }), choice: { ...ready, pass: CONN } })
    expect(await updateInstallation(given.deps)).toBe(0)
    expect(given.asked[0]?.given).toBe(CONN)
    expect((given.infra[0]?.runners as Record<string, unknown>).connectionArn).toBe(CONN)
    expect(updateProps({ ...PROPS, runners: { connectionArn: 'arn:old', connectionReady: true } }, { auth: 'connection', connection: pending }).runners).toEqual({ connectionReady: false })
    expect(updateProps({ ...PROPS, runners: { auth: 'token', computeType: 'BUILD_GENERAL1_XLARGE' } }, { auth: 'connection', connection: { ...ready, pass: CONN } }).runners)
      .toEqual({ connectionArn: CONN, connectionReady: true, computeType: 'BUILD_GENERAL1_XLARGE' })
    expect(updateProps({ ...PROPS, runners: { connectionArn: CONN, connectionReady: true } }, { auth: 'token', message: '' }).runners).toEqual({ auth: 'token' })
  })

  it('with the connection not authorized: deploys without the runners, removes their variables, and says where to authorize it', async () => {
    const w = world({ choice: pending, vars: { [`${BOARD}:TRACE_CODEBUILD_PROJECT`]: 'stale' } })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect((w.infra[0]?.runners as Record<string, unknown>).connectionReady).toBe(false)
    expect(w.vars.has(`${BOARD}:TRACE_CODEBUILD_PROJECT`)).toBe(false)
    expect(w.vars.has(`${TRACE}:TRACE_CODEBUILD_PROJECT`)).toBe(false)
    const summary = w.summary.join('\n')
    expect(summary).toMatch(/The build runners are not added yet: the GitHub connection trace-github is not authorized, so the workflows keep running on GitHub's runners\. Authorize it at https:\/\/us-east-1\.console\.aws\.amazon\.com\/codesuite\/settings\/connections\?region=us-east-1 \(choose trace-github, then "Update pending connection"\); the next merge to main, or re-running this job, adds the runners\./)
  })

  it('when the token may not change a variable: still succeeds, and the step summary lists repository, variable and value', async () => {
    const w = world({ githubFails: true })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.summary).toContain(`- ${BOARD}: set the Actions variable TRACE_CODEBUILD_PROJECT to \`trace-ci-${projectHash(BOARD)}\``)
    expect(w.summary).toContain(`- ${TRACE}: set the Actions variable TRACE_CODEBUILD_PROJECT to \`trace-ci-${projectHash(TRACE)}\``)
    expect(w.summary.join('\n')).toMatch(/could not change these repositories' variables\. Do it by hand/)
  })

  it('fails the job only when the deploy fails, or there is nothing to deploy', async () => {
    const failed = world({ cdk: 1 })
    expect(await updateInstallation(failed.deps)).toBe(1)
    expect(failed.summary.join('\n')).toMatch(/The installation was not updated: cdk deploy exited 1\. CloudFormation rolls a failed update back/)
    expect([...failed.vars.keys()]).toEqual([])

    const noRecord = world({ record: 'not json' })
    expect(await updateInstallation(noRecord.deps)).toBe(1)
    expect(noRecord.cdkArgs).toEqual([])
    expect(noRecord.summary.join('\n')).toMatch(/its saved settings could not be read .* Run the installer again: it saves them\./)

    const other = world({ record: JSON.stringify({ ...JSON.parse(RECORD), stack: 'LabStack' }) })
    expect(await updateInstallation(other.deps)).toBe(1)

    const unset = world({ env: { TRACE_STACK: '' } })
    expect(await updateInstallation(unset.deps)).toBe(1)
    expect(unset.summary[0]).toMatch(/TRACE_STACK is not set/)
  })

  it('reads settings that are valid stack settings', () => {
    expect(InfraPropsSchema.parse(updateProps(PROPS, { auth: 'connection', connection: ready })).selfUpdate).toEqual({ repository: TRACE, branch: 'main' })
  })

  it('runners.auth auto: an authorized connection when there is one, else the token CodeBuild already has, as the installer decides', async () => {
    const auto = (choice: ConnectionChoice, sourceCredential = true): World => world({
      choice, sourceCredential, record: JSON.stringify({ ...JSON.parse(RECORD), runnerAuth: 'auto', props: { ...PROPS, runners: { auth: 'token', computeType: 'BUILD_GENERAL1_XLARGE' } } }),
    })
    const conn = auto(ready)
    expect(await updateInstallation(conn.deps)).toBe(0)
    expect(conn.infra[0]?.runners).toEqual({ connectionReady: true, computeType: 'BUILD_GENERAL1_XLARGE' })

    // no authorized connection: the token (CodeBuild's source credential, imported by the installer), runners and all
    const token = auto(pending)
    expect(await updateInstallation(token.deps)).toBe(0)
    expect(token.infra[0]?.runners).toEqual({ auth: 'token', computeType: 'BUILD_GENERAL1_XLARGE' })
    expect(token.vars.get(`${BOARD}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(BOARD)}`)
    expect(token.summary.join('\n')).not.toMatch(/not authorized/)
    expect(token.log.join('\n')).toMatch(/CodeBuild reaches GitHub with the GitHub token/)
  })

  it('runners.auth token: never asks for a connection, and does not deploy when CodeBuild has no GitHub credential (it imports none)', async () => {
    const record = JSON.stringify({ ...JSON.parse(RECORD), runnerAuth: 'token', props: { ...PROPS, runners: { auth: 'token' } } })
    const w = world({ record })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.asked).toEqual([])
    expect(w.infra[0]?.runners).toEqual({ auth: 'token' })

    const none = world({ record, sourceCredential: false })
    expect(await updateInstallation(none.deps)).toBe(1)
    expect(none.cdkArgs).toEqual([])
    expect(none.summary.join('\n')).toMatch(/CodeBuild has none in us-east-1\. This job does not import tokens: run the installer again/)
  })

  it('a record from before runners.auth deploys with a connection, as it was made', async () => {
    const { runnerAuth: _a, ...old } = JSON.parse(RECORD) as Record<string, unknown>
    const w = world({ record: JSON.stringify(old), choice: pending })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.asked).toHaveLength(1)
    expect((w.infra[0]?.runners as Record<string, unknown>).connectionReady).toBe(false)
  })

  it('adds the projects created in the web app, gives each its secret and variables, and marks the records added', async () => {
    const w = world({ pending: [{ repo: NEW, name: 'Fresh', requested_by: 'marc@example.com', requested_at: '2026-10-20T00:00:00Z' }] })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.infra[0]?.repositories).toEqual([`${BOARD}@main`, `${NEW}@trunk`])
    const rec = JSON.parse(w.records.get(`installation/pending-projects/${NEW}.json`) ?? '{}') as Record<string, unknown>
    expect(rec).toMatchObject({ repo: NEW, status: 'added', branch: 'trunk', requested_by: 'marc@example.com' })
    expect(w.secrets.get('arn:secret/fresh')).toBe(TOKEN)
    expect(w.vars.get(`${NEW}:TRACE_AWS_ROLE`)).toBe('arn:aws:iam::123456789012:role/fresh')
    expect(w.vars.get(`${NEW}:TRACE_AGENT_RUNTIME_ARN`)).toBe('arn:runtime/fresh')
    expect(w.vars.get(`${NEW}:TRACE_MEMORY_ID`)).toBe('mem-fresh')
    expect(w.vars.get(`${NEW}:TRACE_AGENT_LOGIN`)).toBe('trace-bot')
    expect(w.vars.get(`${NEW}:secret:TRACE_TOKEN`)).toBe(TOKEN)
    expect(w.vars.get(`${NEW}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(NEW)}`)
    expect(w.summary.join('\n')).toMatch(/Adding acme\/fresh \(created in the web app\)/)
    expect(w.log.join('\n')).not.toContain(TOKEN)

    // the next update keeps it (the installer's saved settings do not have it yet), and does not set it up again
    const next = world({ pending: [JSON.parse(w.records.get(`installation/pending-projects/${NEW}.json`) ?? '{}') as Record<string, unknown>] })
    expect(await updateInstallation(next.deps)).toBe(0)
    expect(next.infra[0]?.repositories).toEqual([`${BOARD}@main`, `${NEW}@trunk`])
    expect(next.secrets.size).toBe(0)
  })

  it('a failed deploy counts an attempt; after the last one the update stops adding it, and says to run the installer', async () => {
    const w = world({ cdk: 1, pending: [{ repo: NEW }] })
    expect(await updateInstallation(w.deps)).toBe(1)
    const once = JSON.parse(w.records.get(`installation/pending-projects/${NEW}.json`) ?? '{}') as { status: string; attempts: number }
    expect(once).toMatchObject({ status: 'pending', attempts: 1 })
    const again = world({ cdk: 1, pending: [once as unknown as Record<string, unknown>] })
    await updateInstallation(again.deps)
    expect(JSON.parse(again.records.get(`installation/pending-projects/${NEW}.json`) ?? '{}')).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    const stop = world({ pending: [{ repo: NEW, attempts: MAX_ATTEMPTS }] })
    expect(await updateInstallation(stop.deps)).toBe(0)
    expect(stop.infra[0]?.repositories).toEqual([`${BOARD}@main`])
    expect(stop.summary.join('\n')).toMatch(/acme\/fresh \(created in the web app\) is not added by this update: 2 updates with it failed; run the installer/)
  })

  it('pending projects: an existing project is only marked; a build-only repository, the flat layout, or too many are refused', () => {
    const entry = (repo: string, extra: Record<string, unknown> = {}) => parsePending([{ key: `k/${repo}`, text: JSON.stringify({ repo, ...extra }) }])
    expect(addPending(PROPS, entry(BOARD.toUpperCase()))).toMatchObject({ added: [], already: [{ repo: BOARD }] })
    expect(addPending(PROPS, entry(TRACE)).skipped[0]?.why).toMatch(/build-only/)
    // the flat layout: added while it holds fewer than FLAT_UPDATE_MAX projects, then left for the installer and its move
    expect(addPending({ ...PROPS, layout: 'flat' }, entry(NEW)).added).toEqual([{ key: `k/${NEW}`, repo: NEW, branch: 'main' }])
    const flatFull = { ...PROPS, layout: 'flat' as const, repositories: Array.from({ length: FLAT_UPDATE_MAX }, (_, i) => `acme/p${i}@main`) }
    expect(addPending(flatFull, entry(NEW)).skipped[0]?.why).toMatch(/flat layout.*only up to 15.*Move to one nested stack per project/)
    // one an earlier update added is in the stack: never dropped for the cap
    expect(addPending(flatFull, entry(NEW), () => 'main', { deployed: true }).added).toHaveLength(1)
    const full = { ...PROPS, repositories: Array.from({ length: 60 }, (_, i) => `acme/p${i}@main`) }
    expect(addPending(full, entry(NEW)).skipped[0]?.why).toMatch(/60/)
    expect(parsePending([{ key: 'bad', text: '{' }])).toEqual([])
    // the installer takes every record in as an existing, onboarded repository
    const taken = absorb([{ repo: BOARD }], [...entry(NEW, { status: 'added', branch: 'trunk' }), ...entry(BOARD)], (repo, branch) => ({ repo: `${repo}@${branch}` }))
    expect(taken).toEqual({ projects: [{ repo: BOARD }, { repo: `${NEW}@trunk` }], absorbed: [NEW] })
  })
})

describe('a flat installation', () => {
  const flatRecord = JSON.stringify(installationRecord({ stack: 'TraceStack', region: 'us-east-1', props: { ...PROPS, layout: 'flat' }, runnerAuth: 'connection', connectionArn: '', traceRepository: TRACE, traceBranch: 'main', now: new Date('2026-10-01T00:00:00Z') }))

  it('adds a project created in the web app (no knowledge base), and says what the layout lacks and how to move', async () => {
    const w = world({ record: flatRecord, pending: [{ repo: NEW, name: 'Fresh', status: 'pending' }] })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect((w.infra.at(-1)?.repositories as string[])).toContain(`${NEW}@trunk`)
    expect(w.infra.at(-1)?.layout).toBe('flat')
    const said = w.summary.join('\n')
    expect(said).toMatch(/Adding acme\/fresh \(created in the web app\): its agent, memory and build runner \(this installation keeps every project in one stack, the flat layout: no knowledge base\)/)
    expect(said).toMatch(/flat layout.*Move to one nested stack per project.*memory records are deleted\. This job never makes it\./)
    expect(JSON.parse(w.records.get(`installation/pending-projects/${NEW}.json`) ?? '{}')).toMatchObject({ status: 'added' })
  })

  it('never moves the layout itself', async () => {
    const w = world({ record: flatRecord })
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.infra.every((i) => i.layout === 'flat' && i.layoutMigration === undefined)).toBe(true)
  })
})

describe('the web app\'s WAF outside us-east-1', () => {
  const ACL = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/trace-web/22222222-2222-2222-2222-222222222222'
  const record = (region: string) => JSON.stringify(installationRecord({ stack: 'TraceStack', region, props: { ...PROPS, region }, runnerAuth: 'connection', connectionArn: '', traceRepository: TRACE, traceBranch: 'main', now: new Date('2026-10-01T00:00:00Z') }))

  it('deploys <prefix>-edge in us-east-1 first, then the stack with its web ACL', async () => {
    const w = world({ record: record('eu-west-1'), env: { TRACE_AWS_REGION: 'eu-west-1' } })
    const outputs = w.deps.outputs
    w.deps.outputs = async (c, region, stack) => (stack === 'CDKToolkit' ? ({ BootstrapVersion: '27' } as Record<string, string>) : stack === 'trace-edge' ? ({ WebAclArn: ACL } as Record<string, string>) : outputs(c, region, stack))
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.cdkArgs.map((a) => a.slice(0, 2).join(' '))).toEqual(['deploy trace-edge', 'deploy TraceStack'])
    expect((w.infra[1]?.web as { waf?: { aclArn?: string } } | undefined)?.waf?.aclArn).toBe(ACL)
  })

  it('never bootstraps us-east-1: without CDK there it deploys the stack as it was, and says why', async () => {
    const w = world({ record: record('eu-west-1'), env: { TRACE_AWS_REGION: 'eu-west-1' } })
    const outputs = w.deps.outputs
    w.deps.outputs = async (c, region, stack) => { if (stack === 'CDKToolkit' || stack === 'trace-edge') throw new Error(`Stack with id ${stack} does not exist`); return outputs(c, region, stack) }
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.cdkArgs.map((a) => a.slice(0, 2).join(' '))).toEqual(['deploy TraceStack'])
    expect(w.summary.join('\n')).toMatch(/AWS WAF was not set up: CDK is not bootstrapped in us-east-1, and this job may not bootstrap it/)
  })

  it('in us-east-1 the web ACL is in the stack: no edge deploy', async () => {
    const w = world()
    expect(await updateInstallation(w.deps)).toBe(0)
    expect(w.cdkArgs.map((a) => a[1])).toEqual(['TraceStack'])
  })
})
