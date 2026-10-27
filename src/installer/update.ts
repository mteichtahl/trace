/**
 * `tracectl update-installation`: an installation updates itself when trace's own repository's default branch changes,
 * with nobody running the installer (README "Staying up to date"). Run by the update-installation job of trace's own
 * .github/workflows/ci.yml, after the tests pass on a push to main, with the credentials of the installation's
 * `<prefix>-self-update` role (GitHub OIDC; src/infra/stack.ts). Non-interactive, and it asks nothing:
 *
 *   1 settings    the stack's outputs (TRACE_STACK, in TRACE_AWS_REGION) name the central bucket; the settings the
 *                 installer last deployed with are at installation/props.json there (src/installer/record.ts)
 *   2 github      how the runners reach GitHub, decided from the saved runners.auth exactly as the installer decides
 *                 it (src/installer/aws.ts chooseRunnerAuth): a GitHub connection (the runners are deployed only once
 *                 it is authorized), or the GitHub token the installer imported as CodeBuild's GitHub source
 *                 credential. This job never imports or changes that credential (the self-update role may only see
 *                 whether there is one): when the token is to be used and CodeBuild has none, it does not deploy, and
 *                 says to run the installer again, which imports it
 *   3 deploy      `cdk deploy` of the stack with those settings, from this checkout (so the agent image is built from the
 *                 commit that was merged), as the installer runs it
 *   4 runners     each repository with a build runner gets TRACE_CODEBUILD_PROJECT (and loses it where its runner is
 *                 gone), with the shared agent token from Secrets Manager. When that token may not change a repository's
 *                 variables, the job does not fail: the step summary says which variable to set to what, by hand
 *   5 gpu         the deploy starts the GPU image's build when its source changed; it is reported, not waited for
 *
 * Projects created from the web app (projects.create) wait for their own cloud resources under
 * installation/pending-projects/ (src/installer/pending.ts). Before step 3 the job adds every one recorded there, pending
 * or added by an earlier update, to the saved settings' repositories (the installer's saved settings are never
 * rewritten here: the records carry them until the installer runs again and takes them in). After a deploy that
 * succeeded each pending record is marked added; after one that failed it counts an attempt. A newly added project then
 * gets what the installer would give it: its token secret (a copy of the shared token) and its repository's variables and
 * TRACE_TOKEN, best effort, with the step summary saying what is left to do by hand.
 *
 * What it never does: the installer's GitHub admin steps (rulesets, onboarding, people, this machine's settings), and
 * anything the self-update role cannot (it reads installation/*, lists and marks installation/pending-projects/*, writes
 * only projects' token secrets, and deploys only through CDK's bootstrap roles). Adding a repository from the installer,
 * or people, still takes the installer.
 *
 * It exits non-zero only when the installation could not be deployed; everything after the deploy is reported.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentity } from '@smithy/types'
import { PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { RUNNER_VARIABLE } from '../core/project.js'
import {
  CENTRAL_BUCKET_OUTPUT, GPU_IMAGE_BUILD_OUTPUT, INSTALLATION_RECORD_KEY, type InfraInput, InfraPropsSchema, ciRunnerOutput, kbOutputs, projectOutputs, projectRefs,
} from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import { ListSourceCredentialsCommand } from '@aws-sdk/client-codebuild'
import type { RUNNER_AUTH } from './answers.js'
import {
  type ConnectionChoice, type RunnerAuthChoice, awsEnv, chooseRunnerAuth, codebuildClient, connectionsClient, connectionsConsoleUrl, resolveConnection, stackOutputs,
} from './aws.js'
import { cdkBin, cdkDeployArgs, runStreaming } from './bootstrap.js'
import { checkToken, deleteVariable, getVariable, repositoryDefaultBranch, setSecret, setVariable } from './github.js'
import { type PendingEntry, type PendingIo, type PendingRecord, addPending, markAdded, markAttempt, parsePending, s3PendingIo } from './pending.js'
import { InstallationRecordSchema } from './record.js'

/** What the update talks to (tests replace every one). */
export interface UpdateDeps {
  env: NodeJS.ProcessEnv
  credentials: () => Promise<AwsCredentialIdentity>
  outputs: (creds: AwsCredentialIdentity, region: string, stack: string) => Promise<Record<string, string>>
  /** the installation record's text */
  readRecord: (creds: AwsCredentialIdentity, region: string, bucket: string, key: string) => Promise<string>
  resolveConnection: (creds: AwsCredentialIdentity, region: string, o: { prefix: string; given?: string; deployed: Record<string, string> | null }) => Promise<ConnectionChoice>
  /** whether CodeBuild has a GitHub source credential in this account and region (what runners.auth token uses) */
  hasSourceCredential: (creds: AwsCredentialIdentity, region: string) => Promise<boolean>
  cdk: (args: string[], env: Record<string, string>, onLine: (l: string) => void) => Promise<number>
  /** the shared agent token (the stack's GithubSecretArn) */
  sharedToken: (creds: AwsCredentialIdentity, region: string, secretArn: string) => Promise<string>
  github: {
    get: (token: string, repo: string, name: string) => Promise<string | null>
    set: (token: string, repo: string, name: string, value: string) => Promise<unknown>
    delete: (token: string, repo: string, name: string) => Promise<unknown>
    /** an Actions secret (TRACE_TOKEN of a project added from the web app) */
    setSecret?: (token: string, repo: string, name: string, value: string) => Promise<unknown>
    /** the token's own login (TRACE_AGENT_LOGIN) and a repository's default branch */
    login?: (token: string) => Promise<string>
    branch?: (token: string, repo: string) => Promise<string>
  }
  /** the projects created from the web app that wait for an update (installation/pending-projects/*): list, and write
   * one back (marked); absent, none */
  pending?: Pick<PendingIo, 'list' | 'put'>
  /** write a project's token secret (its value: a copy of the shared token, as the installer writes it) */
  putSecret?: (creds: AwsCredentialIdentity, region: string, secretArn: string, value: string) => Promise<void>
  log: (line: string) => void
  /** a line of the job's step summary ($GITHUB_STEP_SUMMARY) */
  summary: (line: string) => void
}

export const defaultUpdateDeps = (env: NodeJS.ProcessEnv = process.env): UpdateDeps => ({
  env,
  credentials: () => fromNodeProviderChain()(),
  outputs: (creds, region, stack) => stackOutputs(creds, region, stack),
  readRecord: async (creds, region, bucket, key) => {
    const r = await new S3Client({ region, credentials: creds }).send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return (await r.Body?.transformToString('utf8')) ?? ''
  },
  resolveConnection: (creds, region, o) => resolveConnection(connectionsClient(creds, region), o),
  hasSourceCredential: async (creds, region) => ((await codebuildClient(creds, region).send(new ListSourceCredentialsCommand({}))).sourceCredentialsInfos ?? []).some((c) => c.serverType === 'GITHUB'),
  cdk: (args, e, onLine) => runStreaming(process.execPath, [cdkBin(), ...args], e, onLine),
  sharedToken: async (creds, region, secretArn) => (await new SecretsManagerClient({ region, credentials: creds }).send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? '',
  github: {
    get: (t, r, n) => getVariable(t, r, n), set: (t, r, n, v) => setVariable(t, r, n, v), delete: (t, r, n) => deleteVariable(t, r, n),
    setSecret: (t, r, n, v) => setSecret(t, r, n, v), login: async (t) => (await checkToken(t)).login, branch: (t, r) => repositoryDefaultBranch(t, r),
  },
  pending: s3PendingIo,
  putSecret: async (creds, region, secretArn, value) => {
    await new SecretsManagerClient({ region, credentials: creds }).send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: value }))
  },
  log: (l) => process.stdout.write(`${l}\n`),
  summary: (l) => {
    const file = env.GITHUB_STEP_SUMMARY
    if (file) { try { appendFileSync(file, `${l}\n`) } catch { /* the log has it */ } }
  },
})

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The settings to deploy with: the record's, with the runners' way to GitHub as decided now (as bootstrap.ts
 * runnersOf and infraInput): the token, or the connection to pass (if any) and whether it is authorized. */
export function updateProps(props: Record<string, unknown>, choice: RunnerAuthChoice): InfraInput {
  const runners = (props.runners && typeof props.runners === 'object' ? props.runners : {}) as Record<string, unknown>
  const { auth: _auth, connectionArn: _given, connectionReady: _ready, ...rest } = runners
  const how = choice.auth === 'token'
    ? { auth: 'token' as const }
    : { ...(choice.connection.pass ? { connectionArn: choice.connection.pass } : {}), connectionReady: choice.connection.ready }
  return { ...(props as InfraInput), runners: { ...how, ...rest } }
}

/** Each repository with a build runner (the projects and the build-only repositories) and its runner's output. */
export function runnerOutputs(props: InfraInput): { repo: string; output: string }[] {
  const p = InfraPropsSchema.parse(props)
  return [
    ...projectRefs(p.repositories).map((r) => ({ repo: r.repository, output: projectOutputs(r.repository).runnerProject })),
    ...p.ciRepositories.map((r) => ({ repo: r, output: ciRunnerOutput(r) })),
  ]
}

/** Update the installation. Returns the exit code: 1 only when it could not be deployed. */
export async function updateInstallation(d: UpdateDeps = defaultUpdateDeps()): Promise<number> {
  const { env, log } = d
  const say = (line: string): void => { log(line); d.summary(line) }
  const stack = env.TRACE_STACK ?? ''
  const region = env.TRACE_AWS_REGION || env.AWS_REGION || ''
  if (!stack || !region) {
    say(`Could not update the installation: ${!stack ? 'TRACE_STACK' : 'TRACE_AWS_REGION'} is not set. Run the installer again to set this repository's variables.`)
    return 1
  }
  let secrets: string[] = []
  const redact = (line: string): string => secrets.reduce((l, v) => (v.length >= 8 ? l.split(v).join('••••') : l), line).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1••••')

  // 1 — the settings the installer saved
  let creds: AwsCredentialIdentity
  let props: Record<string, unknown>
  let given = ''
  let mode: (typeof RUNNER_AUTH)[number] = 'connection'
  let before: Record<string, string>
  let bucket = ''
  let pending: PendingEntry[] = []
  try {
    creds = await d.credentials()
    log(`Updating ${stack} in ${region}.`)
    before = await d.outputs(creds, region, stack)
    bucket = before[CENTRAL_BUCKET_OUTPUT] ?? ''
    if (!bucket) throw new Error(`the stack has no ${CENTRAL_BUCKET_OUTPUT} output`)
    const record = InstallationRecordSchema.parse(JSON.parse(await d.readRecord(creds, region, bucket, INSTALLATION_RECORD_KEY)) as unknown)
    if (record.stack !== stack) throw new Error(`the saved settings are for ${record.stack}, not ${stack}`)
    props = record.props
    given = record.connectionArn
    mode = record.runnerAuth
    log(`Read the settings the installer saved on ${record.savedAt} (s3://${bucket}/${INSTALLATION_RECORD_KEY}).`)
  } catch (e) {
    say(`Could not update the installation: its saved settings could not be read (${redact(message(e))}). Run the installer again: it saves them.`)
    return 1
  }

  // 1b — projects created from the web app since: added to the repositories for this deploy (src/installer/pending.ts)
  if (d.pending) {
    try { pending = parsePending(await d.pending.list(creds, region, bucket), log) } catch (e) { say(`The projects waiting for this update could not be read (${redact(message(e))}); updating without them.`) }
  }
  let sharedToken = ''
  const readShared = async (arn: string): Promise<string> => {
    if (sharedToken || !arn) return sharedToken
    try {
      sharedToken = await d.sharedToken(creds, region, arn)
      if (sharedToken) { secrets = [sharedToken]; if (env.GITHUB_ACTIONS === 'true') log(`::add-mask::${sharedToken}`) }
    } catch (e) { log(`Could not read the shared agent token (${redact(message(e))}).`) }
    return sharedToken
  }
  const branches = new Map<string, string>()
  const fresh = pending.filter((p) => p.record.status === 'pending')
  if (fresh.length && d.github.branch) {
    const t = await readShared(before.GithubSecretArn ?? '')
    for (const p of fresh) {
      try { if (t) branches.set(p.record.repo.toLowerCase(), await d.github.branch(t, p.record.repo)) } catch (e) { log(`${p.record.repo}: its default branch could not be read (${redact(message(e))}); main is assumed`) }
    }
  }
  // the ones an earlier update added first (they are projects of the stack now), then the new ones
  const carried = pending.filter((p) => p.record.status === 'added').map((p) => ({ ...p, record: { ...p.record, status: 'pending' as const, attempts: 0 } }))
  const kept = addPending(props as InfraInput, carried, (r) => pending.find((p) => p.record.repo.toLowerCase() === r)?.record.branch ?? 'main')
  const grown = addPending(kept.props, fresh, (r) => branches.get(r) ?? 'main')
  props = grown.props as Record<string, unknown>
  for (const k of kept.skipped) say(`${k.repo}, added by an earlier update, is no longer deployed by it: ${k.why}.`)
  for (const k of grown.skipped) say(`${k.repo} (created in the web app) is not added by this update: ${k.why}.`)
  if (grown.added.length) say(`Adding ${grown.added.map((x) => x.repo).join(', ')} (created in the web app): ${grown.added.length === 1 ? 'its' : 'their'} agent, memory, knowledge base and build runner.`)
  const mark = async (key: string, rec: PendingRecord): Promise<void> => {
    try { await d.pending?.put(creds, region, bucket, key, JSON.stringify(rec, null, 2)) } catch (e) { log(`Could not update ${key} (${redact(message(e))}).`) }
  }

  // 2 — how the runners reach GitHub, decided as the installer decides it
  let auth: RunnerAuthChoice
  let input: InfraInput
  try {
    const prefix = InfraPropsSchema.parse(props).prefix
    auth = await chooseRunnerAuth(mode, { prefix, ...(given ? { given } : {}), deployed: before }, (o) => d.resolveConnection(creds, region, o))
    log(auth.auth === 'connection' ? auth.connection.message : auth.message)
    input = updateProps(props, auth)
    InfraPropsSchema.parse(input)
  } catch (e) {
    say(`Could not update the installation: ${redact(message(e))}`)
    return 1
  }
  // the token as CodeBuild's source credential: the installer imports it before its deploy; this job may not
  if (auth.auth === 'token') {
    let has = false
    try { has = await d.hasSourceCredential(creds, region) } catch (e) { log(`Could not check CodeBuild's GitHub source credential (${redact(message(e))}).`) }
    if (!has) {
      say(`The installation was not updated: its build runners reach GitHub with the GitHub token as CodeBuild's GitHub source credential, and CodeBuild has none in ${region}. This job does not import tokens: run the installer again (it imports the token), or authorize a GitHub connection, then merge again or re-run this job.`)
      return 1
    }
  }
  const choice = auth.auth === 'connection' ? auth.connection : null
  const ready = choice ? choice.ready : true

  // 3 — the deploy
  log(`Deploying ${stack} from this commit${ready ? '' : ', without the build runners (the GitHub connection is not authorized yet)'}. When the agent image changed, CodeBuild builds it again: allow 20–40 minutes.`)
  const app = ['--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`]
  const code = await d.cdk(cdkDeployArgs(stack, app), {
    ...awsEnv(creds, region), TRACE_INFRA: JSON.stringify(input), CDK_DISABLE_VERSION_CHECK: '1', CI: '1',
  }, (l) => log(redact(l)))
  if (code !== 0) {
    for (const x of grown.added) {
      const e = pending.find((p) => p.key === x.key)
      if (e) await mark(x.key, markAttempt(e.record, `cdk deploy exited ${code}`))
    }
    say(`The installation was not updated: cdk deploy exited ${code}. CloudFormation rolls a failed update back, so the installation is as it was. The log above says why; fix it and merge again, or re-run this job.`)
    return 1
  }
  say(`${stack} is up to date with this commit.`)
  for (const x of grown.added) {
    const e = pending.find((p) => p.key === x.key)
    if (e) await mark(x.key, markAdded(e.record, { branch: x.branch }))
  }
  // already a project (the installer took it in): nothing was deployed for it, but it waits no longer
  for (const x of grown.already) {
    const e = pending.find((p) => p.key === x.key)
    if (e) await mark(x.key, markAdded(e.record, { branch: typeof e.record.branch === 'string' ? e.record.branch : 'main' }))
  }

  // 4 — the runners' variables (best effort from here on: the deploy is done)
  let after: Record<string, string> = {}
  try { after = await d.outputs(creds, region, stack) } catch (e) { say(`The deploy is done, but its outputs could not be read (${redact(message(e))}): the repositories' ${RUNNER_VARIABLE} were not checked.`) }
  if (choice && !choice.ready) {
    say(`The build runners are not added yet: the GitHub connection ${choice.name} is not authorized, so the workflows keep running on GitHub's runners. Authorize it at ${connectionsConsoleUrl(region)} (choose ${choice.name}, then "Update pending connection"); the next merge to main, or re-running this job, adds the runners.`)
  }
  if (Object.keys(after).length) {
    const want = runnerOutputs(input).map((r) => ({ repo: r.repo, value: ready ? after[r.output] ?? '' : '' }))
    const secretArn = after.GithubSecretArn ?? before.GithubSecretArn ?? ''
    const token = await readShared(secretArn)
    if (!token) log('The shared agent token is empty or could not be read.')
    const byHand: string[] = []
    // projects added now: their token secret and their repository's variables, as the installer sets them
    for (const x of grown.added) {
      const o = projectOutputs(x.repo)
      const kb = kbOutputs(x.repo)
      try {
        if (!token) throw new Error('no shared token')
        if (!after[o.secretArn]) throw new Error(`the stack has no output ${o.secretArn}`)
        await d.putSecret?.(creds, region, after[o.secretArn] ?? '', token)
        log(`${x.repo}: the shared token stored in its secret`)
      } catch (e) {
        log(`${x.repo}: its token secret could not be written (${redact(message(e))})`)
        byHand.push(`- ${x.repo}: its agent has no GitHub token yet: run the installer again (it writes the project's token secret)`)
      }
      const vars: Record<string, string> = {
        TRACE_AWS_ROLE: after[o.roleArn] ?? '', TRACE_AWS_REGION: region, TRACE_HOME: after.TraceHome ?? '', TRACE_AGENT_RUNTIME_ARN: after[o.runtimeArn] ?? '',
        ...(after[o.memoryId] ? { TRACE_MEMORY_ID: after[o.memoryId] ?? '' } : {}),
        ...(after[kb.knowledgeBaseId] ? { TRACE_KB_ID: after[kb.knowledgeBaseId] ?? '', TRACE_KB_DATA_SOURCE_ID: after[kb.dataSourceId] ?? '' } : {}),
      }
      try {
        if (!token) throw new Error('no shared token')
        if (d.github.login) vars.TRACE_AGENT_LOGIN = await d.github.login(token)
        for (const [k, v] of Object.entries(vars)) {
          if (!v) throw new Error(`the stack has no value for ${k}`)
          await d.github.set(token, x.repo, k, v)
        }
        if (d.github.setSecret) await d.github.setSecret(token, x.repo, 'TRACE_TOKEN', token)
        log(`${x.repo}: ${Object.keys(vars).join(', ')} and TRACE_TOKEN set`)
      } catch (e) {
        log(`${x.repo}: its variables could not be set (${redact(message(e))})`)
        byHand.push(`- ${x.repo}: run the installer again to set its repository variables (${Object.keys(vars).join(', ')}) and TRACE_TOKEN`)
      }
    }
    for (const w of want) {
      try {
        if (!token) throw new Error('no token')
        const now = await d.github.get(token, w.repo, RUNNER_VARIABLE)
        if ((now ?? '') === w.value) continue
        if (w.value) await d.github.set(token, w.repo, RUNNER_VARIABLE, w.value)
        else await d.github.delete(token, w.repo, RUNNER_VARIABLE)
        log(`${w.repo}: ${RUNNER_VARIABLE} ${w.value ? `set to ${w.value} (its jobs now run on AWS)` : 'removed (no build runner: its jobs run on GitHub\'s runners)'}`)
      } catch (e) {
        log(`${w.repo}: could not ${w.value ? 'set' : 'remove'} ${RUNNER_VARIABLE} (${redact(message(e))})`)
        byHand.push(w.value ? `- ${w.repo}: set the Actions variable ${RUNNER_VARIABLE} to \`${w.value}\`` : `- ${w.repo}: remove the Actions variable ${RUNNER_VARIABLE}`)
      }
    }
    if (byHand.length) {
      d.summary(`The shared agent token could not change these repositories' variables. Do it by hand (Settings > Secrets and variables > Actions > Variables), or run the installer again:`)
      for (const l of byHand) d.summary(l)
    }
    // 5 — the GPU image: started by the deploy when its source changed; not waited for here
    const gpu = after[GPU_IMAGE_BUILD_OUTPUT]
    if (gpu && gpu !== before[GPU_IMAGE_BUILD_OUTPUT]) say(`The deploy started the GPU image build ${gpu}; it carries on in CodeBuild (GPU and CPU jobs use the new image once it is built).`)
  }
  return 0
}
