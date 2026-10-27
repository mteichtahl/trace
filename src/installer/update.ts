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
 * What it never does: the installer's GitHub admin steps (secrets, rulesets, onboarding, people, this machine's
 * settings), and anything the self-update role cannot (it reads installation/* only, and deploys only through CDK's
 * bootstrap roles). Adding repositories or people still takes the installer.
 *
 * It exits non-zero only when the installation could not be deployed; everything after the deploy is reported.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentity } from '@smithy/types'
import { RUNNER_VARIABLE } from '../core/project.js'
import {
  CENTRAL_BUCKET_OUTPUT, GPU_IMAGE_BUILD_OUTPUT, INSTALLATION_RECORD_KEY, type InfraInput, InfraPropsSchema, ciRunnerOutput, projectOutputs, projectRefs,
} from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import { ListSourceCredentialsCommand } from '@aws-sdk/client-codebuild'
import type { RUNNER_AUTH } from './answers.js'
import {
  type ConnectionChoice, type RunnerAuthChoice, awsEnv, chooseRunnerAuth, codebuildClient, connectionsClient, connectionsConsoleUrl, resolveConnection, stackOutputs,
} from './aws.js'
import { cdkBin, cdkDeployArgs, runStreaming } from './bootstrap.js'
import { deleteVariable, getVariable, setVariable } from './github.js'
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
  }
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
  github: { get: (t, r, n) => getVariable(t, r, n), set: (t, r, n, v) => setVariable(t, r, n, v), delete: (t, r, n) => deleteVariable(t, r, n) },
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
  try {
    creds = await d.credentials()
    log(`Updating ${stack} in ${region}.`)
    before = await d.outputs(creds, region, stack)
    const bucket = before[CENTRAL_BUCKET_OUTPUT]
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
    say(`The installation was not updated: cdk deploy exited ${code}. CloudFormation rolls a failed update back, so the installation is as it was. The log above says why; fix it and merge again, or re-run this job.`)
    return 1
  }
  say(`${stack} is up to date with this commit.`)

  // 4 — the runners' variables (best effort from here on: the deploy is done)
  let after: Record<string, string> = {}
  try { after = await d.outputs(creds, region, stack) } catch (e) { say(`The deploy is done, but its outputs could not be read (${redact(message(e))}): the repositories' ${RUNNER_VARIABLE} were not checked.`) }
  if (choice && !choice.ready) {
    say(`The build runners are not added yet: the GitHub connection ${choice.name} is not authorized, so the workflows keep running on GitHub's runners. Authorize it at ${connectionsConsoleUrl(region)} (choose ${choice.name}, then "Update pending connection"); the next merge to main, or re-running this job, adds the runners.`)
  }
  if (Object.keys(after).length) {
    const want = runnerOutputs(input).map((r) => ({ repo: r.repo, value: ready ? after[r.output] ?? '' : '' }))
    let token = ''
    const secretArn = after.GithubSecretArn ?? before.GithubSecretArn ?? ''
    try {
      token = await d.sharedToken(creds, region, secretArn)
      if (!token) throw new Error('the secret is empty')
      secrets = [token]
      if (env.GITHUB_ACTIONS === 'true') log(`::add-mask::${token}`)
    } catch (e) {
      log(`Could not read the shared agent token (${redact(message(e))}).`)
    }
    const byHand: string[] = []
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
