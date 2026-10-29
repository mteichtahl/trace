/**
 * After installing: `tracectl upgrade` and `tracectl uninstall`, both from the answers the installer saved on this machine
 * (~/.trace/client.db) and your AWS credentials. Neither asks for a GitHub token: the installation's own copy is read
 * back from Secrets Manager (`<prefix>/github-token`, and each project's), which those credentials may read.
 *
 *   tracectl upgrade [--ref REF] [--check] [--no-pull] [--runner-auth auto|token|connection] [--connection ARN|auto]
 *       1 pull: `npm install -g github:<source>#<ref>` (trace's main unless --ref), then
 *         run the new version's `tracectl upgrade --no-pull`
 *       2 the installer's steps with the saved answers (src/installer/bootstrap.ts apply): the stack is updated (the
 *         images are copied or rebuilt from their cache only when trace changed), each repository's variables, runner
 *         and trace workflows are refreshed (a held PR when the workflows changed), people stay as they are
 *       --check prints what would change and stops
 *       --runner-auth switches how the CodeBuild runners reach GitHub (answers runners.auth, README "Where builds
 *         run"), saved for later runs: the runner projects are updated in place
 *       --connection chooses the GitHub connection (AWS CodeConnections) the runners use (answers runners.connectionArn),
 *         saved for later runs; `auto` goes back to the installer's choice (an authorized one, else a new one)
 *
 *   tracectl release setup [--repo OWNER/REPO] [--region R] [--profile P] [--publish]
 *       sets this AWS account up to publish trace's images (src/installer/release.ts): TraceRelease in us-east-1,
 *       the registry's default alias, the source repository's TRACE_RELEASE_ROLE and TRACE_IMAGE_REGISTRY, and its
 *       privileged CodeBuild runner; --publish starts the first release. The AWS credentials are the installation's
 *       (or --profile, or the environment's), the GitHub token TRACE_GITHUB_TOKEN / GITHUB_TOKEN or the
 *       installation's own; no console step
 *
 *   tracectl uninstall [--yes] [--delete-data]
 *       deletes the optional integrations' secrets, each repository's trace variables (TRACE_CODEBUILD_PROJECT among
 *       them) and TRACE_TOKEN secret, trace's own repository's self-update variables (TRACE_UPDATE_ROLE, TRACE_STACK,
 *       TRACE_AWS_REGION: README "Staying up to date"), and the stack (with it the CodeBuild runner projects and their webhooks), then
 *       CodeBuild's GitHub credential when trace imported it; then lists what stays (a GitHub connection the stack
 *       created among it): with keep data (retainData) the
 *       central bucket, the image repositories, each project's memory, log groups and knowledge base vectors; always
 *       the Cognito user pool, the API's token secret, the CDK bootstrap, Transaction Search, and the files onboarding
 *       added to each repository (its workflows stop: their variables are gone). --delete-data also deletes what
 *       blocks installing again with the same prefix (the image repositories, the token secret, the user pool) and
 *       prints the commands for the rest.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import type { AwsCredentialIdentity } from '@smithy/types'
import { answers as savedAnswers, forgetInstallation, installation } from '../core/client.js'
import { INTEGRATION_NAMES, IntegrationStore, secretsManagerApi } from '../core/integrations.js'
import { REF, SOURCE } from '../core/onboard.js'
import { githubSecretName, stackName } from '../infra/props.js'
import { EDGE_REGION, edgeStackName } from '../infra/edge.js'
import { REPO_ROOT } from '../infra/stack.js'
import { RUNNER_VARIABLE } from '../core/project.js'
import { type Answers, AnswersSchema, type InstallEvent, RUNNER_AUTH, SecretsSchema } from './answers.js'
import { UPDATE_ROLE_VARIABLE, UPDATE_STACK_VARIABLE, apply, selfUpdateOf } from './bootstrap.js'
import { credentials, removeSourceCredential } from './aws.js'
import { deleteVariable } from './github.js'

/** This trace's version (package.json). */
export function traceVersion(): string {
  try { return String((JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '0.0.0') } catch { return 'unknown' }
}

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

/** The saved answers, or a clear error. */
export function saved(): Answers {
  const raw = savedAnswers().answers
  if (!raw) throw new Error('no installation answers on this machine: run `tracectl install` (upgrade and uninstall use what it saved)')
  return AnswersSchema.parse(raw)
}

/** The GitHub tokens the installation keeps: the API's (shared) one, and each project's own when it differs. */
export async function storedTokens(a: Answers, get: (name: string) => Promise<string | null>): Promise<{ githubToken: string; projectTokens: Record<string, string> }> {
  const githubToken = await get(`${a.agents.prefix}/github-token`)
  if (!githubToken) throw new Error(`the secret ${a.agents.prefix}/github-token has no token: run \`tracectl install\` instead`)
  const projectTokens: Record<string, string> = {}
  for (const p of a.projects) {
    const t = await get(githubSecretName(a.agents.prefix, p.repo, p.generation)).catch(() => null)
    if (t && t !== githubToken) projectTokens[p.repo.toLowerCase()] = t
  }
  return { githubToken, projectTokens }
}

/** Print the installer's progress on the terminal. */
export function consoleEmit(write: (s: string) => void = out): (e: InstallEvent) => void {
  const seen = new Map<string, string>()
  return (e) => {
    if (e.type === 'step') {
      if (seen.get(e.step.id) === e.step.status) return
      seen.set(e.step.id, e.step.status)
      write(`[${e.step.status.padEnd(7)}] ${e.step.title}${e.step.status === 'failed' || e.step.status === 'skipped' ? `: ${e.step.detail}` : ''}`)
    } else if (e.type === 'log' || e.type === 'wait') write(`    ${e.step}: ${e.line}`)
    else if (e.type === 'ready') { write(''); write('trace is ready to use. Still going: the GPU image.') }
    else { write(''); for (const l of e.summary) write(`${e.ok ? '-' : '!'} ${l}`) }
  }
}

async function creds(a: Answers): Promise<AwsCredentialIdentity> {
  if (a.aws.mode === 'keys') {
    // keys were never saved: use what this shell has (AWS_ACCESS_KEY_ID, …)
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers')
    return fromNodeProviderChain()()
  }
  return credentials(a.aws, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '' })
}

export async function cmdUpgrade(argv: string[]): Promise<number> {
  const { values: o } = parseArgs({ args: argv, options: { ref: { type: 'string' }, check: { type: 'boolean' }, 'no-pull': { type: 'boolean' }, 'runner-auth': { type: 'string' }, connection: { type: 'string' } } })
  try {
    let a = saved()
    const auth = o['runner-auth']
    if (auth !== undefined) {
      if (!(RUNNER_AUTH as readonly string[]).includes(auth)) throw new Error(`--runner-auth is one of ${RUNNER_AUTH.join(', ')}, not ${auth}`)
      a = AnswersSchema.parse({ ...a, runners: { ...a.runners, auth, ...(auth === 'token' ? { connectionArn: '' } : {}) } })
    }
    const connection = o.connection
    if (connection !== undefined) {
      if (a.runners.auth === 'token' && connection !== 'auto') throw new Error('--connection is for the runners\' GitHub connection: with --runner-auth token they use the GitHub token (choose auto or connection)')
      a = AnswersSchema.parse({ ...a, runners: { ...a.runners, connectionArn: connection === 'auto' ? '' : connection.trim() } })
    }
    if (!o['no-pull'] && !o.check) {
      const ref = o.ref ?? REF
      out(`pulling trace from github:${SOURCE}#${ref} …`)
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const r = spawnSync(npm, ['install', '-g', `github:${SOURCE}#${ref}`], { stdio: 'inherit' })
      if (r.status !== 0) { err(`trace: npm install exited ${r.status ?? 'abnormally'}`); return 1 }
      // the new version carries on (its stack, its workflows)
      const next = spawnSync(process.platform === 'win32' ? 'tracectl.cmd' : 'tracectl', ['upgrade', '--no-pull', ...(auth !== undefined ? ['--runner-auth', auth] : []), ...(connection !== undefined ? ['--connection', connection] : [])], { stdio: 'inherit' })
      return next.status ?? 1
    }
    const c = await creds(a)
    const sm = await secretsManagerApi({ region: a.aws.region, credentials: c })
    const tokens = await storedTokens(a, sm.get)
    const secrets = SecretsSchema.parse({ ...tokens })
    if (o.check) {
      const [{ plan }, { checkAws }] = await Promise.all([import('./bootstrap.js'), import('./aws.js')])
      const now = await checkAws(c, a.aws.region, stackName(a.agents.prefix))
      const was = savedAnswers().traceVersion
      out(`installed by trace ${typeof was === 'string' ? was : 'an earlier version'}; this is trace ${traceVersion()}`)
      for (const st of plan(a, now.existing, a)) out(`- ${st.title}: ${st.detail}`)
      return 0
    }
    // onboarding refreshes the workflows (a held PR only when they changed); people are as saved
    const answers: Answers = { ...a, projects: a.projects.map((p) => ({ ...p, onboard: true, create: null })) }
    const ok = await apply(answers, secrets, consoleEmit(), {}, { prev: a })
    return ok ? 0 : 1
  } catch (e) {
    err(`trace: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

/** What uninstalling leaves in the account, in words. */
export function keptAfterUninstall(a: Answers, deleteData: boolean): string[] {
  const p = a.agents.prefix
  const kept: string[] = []
  if (a.agents.retainData) {
    kept.push('the central bucket (every project\'s data, datasheets and parts)')
    kept.push('each project\'s AgentCore memory, its log groups, and the knowledge bases\' vector bucket')
    if (!deleteData) kept.push(`the image repositories ${p}-agent and ${p}-gpu`)
  }
  if (!deleteData) {
    kept.push(`the Cognito user pool ${p}-users and its domain (everyone's sign-in)`)
    kept.push(`the API's copy of the GitHub token, ${p}/github-token`)
  }
  kept.push('the CDK bootstrap (CDKToolkit) and CloudWatch Transaction Search (account-wide)')
  kept.push(`a GitHub connection the stack created (${p}-github), which other installations in the account may reuse, and CodeBuild's GitHub credential unless trace imported it`)
  kept.push('the files onboarding added to each repository (.trace/, the trace workflows): their workflows stop, as their variables are gone; delete them, or set TRACE_PRS, TRACE_CI, TRACE_WORKER and TRACE_DEPLOY to false')
  return kept
}

async function confirm(stack: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((r) => rl.question(`Type ${stack} to uninstall it: `, r))
  rl.close()
  return answer.trim() === stack
}

export async function cmdUninstall(argv: string[]): Promise<number> {
  const { values: o } = parseArgs({ args: argv, options: { yes: { type: 'boolean' }, 'delete-data': { type: 'boolean' }, 'keep-data': { type: 'boolean' } } })
  try {
    const a = saved()
    const deleteData = Boolean(o['delete-data']) && !o['keep-data']
    const stack = stackName(a.agents.prefix)
    const region = a.aws.region
    out(`This removes ${stack} from ${a.aws.account} (${region}) with its CodeBuild runners, its integrations, and each repository's trace variables.`)
    out('It keeps:')
    for (const k of keptAfterUninstall(a, deleteData)) out(`  - ${k}`)
    if (!o.yes && !(await confirm(stack))) { err('not uninstalled'); return 1 }
    const c = await creds(a)
    const cfg = { region, credentials: c }
    const sm = await secretsManagerApi(cfg)
    const token = await sm.get(`${a.agents.prefix}/github-token`).catch(() => null)
    // the repositories' variables (the token first, before the stack takes its secret); the stack deletes the runners
    if (token) {
      const { z } = await import('zod')
      const { Github } = await import('./github.js')
      const gh = new Github(token)
      for (const p of a.projects.map((x) => x.repo)) {
        for (const v of ['TRACE_AWS_ROLE', 'TRACE_AGENT_RUNTIME_ARN', 'TRACE_MEMORY_ID', 'TRACE_KB_ID', 'TRACE_KB_DATA_SOURCE_ID', 'TRACE_AWS_REGION', 'TRACE_HOME', 'TRACE_AGENT_LOGIN', RUNNER_VARIABLE]) {
          await deleteVariable(token, p, v).catch(() => false)
        }
        await gh.request('DELETE', `/repos/${p}/actions/secrets/TRACE_TOKEN`, z.unknown()).catch(() => undefined)
        out(`${p}: trace's variables and TRACE_TOKEN removed`)
      }
      // the self-update job's: its role goes with the stack, so trace's own ci workflow must stop trying to use it
      const update = selfUpdateOf(a)
      if (update) {
        for (const v of [UPDATE_ROLE_VARIABLE, UPDATE_STACK_VARIABLE, 'TRACE_AWS_REGION']) await deleteVariable(token, update.repository, v).catch(() => false)
        out(`${update.repository}: ${UPDATE_ROLE_VARIABLE}, ${UPDATE_STACK_VARIABLE} and TRACE_AWS_REGION removed (the installation no longer updates itself)`)
      }
    } else out('(no GitHub token stored: each repository\'s TRACE_* variables and TRACE_TOKEN secret are left; remove them in its Settings)')
    const integrations = new IntegrationStore(a.agents.prefix, sm)
    for (const n of INTEGRATION_NAMES) if (await integrations.remove(n)) out(`removed the ${n} integration`)
    // the stack
    const cfn = await import('@aws-sdk/client-cloudformation')
    const cf = new cfn.CloudFormationClient(cfg)
    out(`deleting ${stack} (10–20 minutes) …`)
    await cf.send(new cfn.DeleteStackCommand({ StackName: stack }))
    for (;;) {
      await new Promise((r) => setTimeout(r, 15_000))
      let status = ''
      try { status = (await cf.send(new cfn.DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.StackStatus ?? '' } catch (e) { if (/does not exist/.test(String(e))) break; throw e }
      if (status === 'DELETE_COMPLETE') break
      if (status === 'DELETE_FAILED') throw new Error(`${stack} is DELETE_FAILED: see its events in the CloudFormation console, fix the resource named there, and run \`tracectl uninstall\` again`)
    }
    out(`${stack} is deleted`)
    // the web app's WAF stack in us-east-1, when there is one (src/infra/edge.ts): nothing points at its web ACL now
    try {
      const edge = new cfn.CloudFormationClient({ region: EDGE_REGION, credentials: c })
      const name = edgeStackName(a.agents.prefix)
      const st = (await edge.send(new cfn.DescribeStacksCommand({ StackName: name })).catch(() => null))?.Stacks?.[0]
      if (st && st.StackStatus !== 'DELETE_COMPLETE') { await edge.send(new cfn.DeleteStackCommand({ StackName: name })); out(`deleting ${name} in ${EDGE_REGION} (the web app's AWS WAF)`) }
    } catch (e) { out(`${edgeStackName(a.agents.prefix)} in ${EDGE_REGION} could not be deleted: ${e instanceof Error ? e.message : String(e)}; delete it in the CloudFormation console`) }
    // after the stack: deleting the runner projects removed their GitHub webhooks with this credential
    if (savedAnswers().runnerCredential === 'imported') {
      const { CodeBuildClient } = await import('@aws-sdk/client-codebuild')
      if (await removeSourceCredential(new CodeBuildClient(cfg))) out('removed CodeBuild\'s GitHub credential (trace had imported it)')
    }
    if (deleteData) {
      const [{ signedCaller, ecr }, cog] = await Promise.all([import('./signed.js'), import('@aws-sdk/client-cognito-identity-provider')])
      const call = signedCaller(c, region)
      for (const name of [`${a.agents.prefix}-agent`, `${a.agents.prefix}-gpu`]) {
        try { await call(ecr(region, 'DeleteRepository', { repositoryName: name, force: true })); out(`deleted the image repository ${name}`) } catch { /* gone */ }
      }
      await sm.remove(`${a.agents.prefix}/github-token`).then((r) => r && out(`deleted ${a.agents.prefix}/github-token`))
      const inst = installation()
      if (inst?.userPoolId) {
        const idp = new cog.CognitoIdentityProviderClient(cfg)
        try { await idp.send(new cog.DeleteUserPoolDomainCommand({ UserPoolId: inst.userPoolId, Domain: `${a.agents.prefix}-${a.aws.account}` })) } catch { /* none */ }
        try { await idp.send(new cog.DeleteUserPoolCommand({ UserPoolId: inst.userPoolId })); out(`deleted the user pool ${inst.userPoolId}`) } catch (e) { out(`the user pool ${inst.userPoolId} stays: ${e instanceof Error ? e.message : String(e)}`) }
      }
      if (a.agents.retainData) {
        out('Still in the account (delete them yourself when you no longer need the data):')
        out(`  aws s3 rb s3://<the central bucket> --force          (versioned: empty its versions first, or use the console's "Empty")`)
        out(`  aws bedrock-agentcore-control list-memories --region ${region}   then delete-memory for each ${a.agents.prefix.replace(/-/g, '_')}_m_… id`)
      }
    }
    forgetInstallation()
    out('Uninstalled. `tracectl install` installs again (the answers are kept on this machine).')
    return 0
  } catch (e) {
    err(`trace: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export async function cmdRelease(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub !== 'setup') { err('usage: tracectl release setup [--repo OWNER/REPO] [--region R] [--profile P] [--publish]'); return 2 }
  const { values: o } = parseArgs({ args: rest, options: { repo: { type: 'string' }, region: { type: 'string' }, profile: { type: 'string' }, publish: { type: 'boolean' } } })
  try {
    const a = savedAnswers().answers ? saved() : null
    const c = o.profile ? await credentials({ mode: 'profile', profile: o.profile }, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '' })
      : a ? await creds(a)
        : await (await import('@aws-sdk/credential-providers')).fromNodeProviderChain()()
    const region = o.region ?? a?.aws.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
    let token = process.env.TRACE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
    if (!token && a) token = (await storedTokens(a, (await secretsManagerApi({ region: a.aws.region, credentials: c })).get)).githubToken
    if (!token) throw new Error('no GitHub token: set TRACE_GITHUB_TOKEN (Variables: read and write on the source repository, and Actions to start the first release)')
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts')
    const account = (await new STSClient({ region, credentials: c }).send(new GetCallerIdentityCommand({}))).Account ?? ''
    const { liveReleaseDeps, releaseSetup } = await import('./release.js')
    const { createRequire } = await import('node:module')
    const cdkBin = createRequire(import.meta.url).resolve('aws-cdk/bin/cdk')
    const cdk = (args: string[], env: Record<string, string>): Promise<number> => Promise.resolve(spawnSync(process.execPath, [cdkBin, ...args], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1)
    // the release workflow runs on the repository's own AWS runner when the installation made it (`tracectl install`, with
    // publishing on, makes it Docker-capable), else on GitHub's runners
    const r = await releaseSetup(await liveReleaseDeps(c, token, { cdk, log: out }), {
      account, ...((o.repo || a?.runners.traceRepository) ? { repository: o.repo || a?.runners.traceRepository || "" } : {}), publish: Boolean(o.publish),
    })
    out(`registry ${r.registry}; images ${r.images.join(', ')}`)
    return 0
  } catch (e) {
    err(`trace: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
