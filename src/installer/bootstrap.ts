/**
 * Installing trace into an AWS account, step by step. Every step is safe to run again: a second installation
 * updates what the first made.
 *
 *   1 check      the credentials still resolve to the confirmed account
 *   2 cdk        bootstrap CDK in the account/region if it isn't
 *   3 deploy     `cdk deploy` the trace stack (the agent image builds in CodeBuild: the first deploy takes a while)
 *   4 token      write the GitHub token into the stack's Secrets Manager secret
 *   5 repos      each repository's Actions variables (role, region, TRACE_HOME, runtime) and its TRACE_TOKEN secret
 *   6 onboard    the onboarding PR in each repository that asked for it, and its repository settings
 *   7 people     invite each person to Cognito, admins into trace-admins, and record their per-project grants
 *   8 local      save the installation on this machine so `trace login` and `trace remote …` work
 *
 * Secrets never leave memory except to their destination (Secrets Manager, GitHub's sealed-box API).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider'
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { AwsCredentialIdentity } from '@smithy/types'
import { type Principal, ADMIN_GROUP, grant } from '../core/access.js'
import { saveAnswers, saveInstallation } from '../core/client.js'
import { onboard, register } from '../core/onboard.js'
import { type InfraInput, InfraPropsSchema, stackName } from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import type { Answers, InstallEvent, Secrets, Step } from './answers.js'
import { awsEnv, checkAws, credentials, stackOutputs } from './aws.js'
import { setSecret, setVariable } from './github.js'

export function infraInput(a: Answers): InfraInput {
  return {
    prefix: a.agents.prefix,
    account: a.aws.account,
    region: a.aws.region,
    repositories: a.projects.map((p) => p.repo),
    createOidcProvider: a.agents.createOidcProvider,
    model: a.agents.model,
    ...(a.agents.centralBucketName ? { centralBucketName: a.agents.centralBucketName } : {}),
    maxLifetimeSeconds: Math.round(a.agents.maxLifetimeHours * 3600),
    idleTimeoutSeconds: Math.round(a.agents.idleMinutes * 60),
    retainData: a.agents.retainData,
    adminEmail: a.adminEmail,
  }
}

/** What will happen, before anything does. */
export function plan(a: Answers): Step[] {
  const props = InfraPropsSchema.parse(infraInput(a))
  const stack = stackName(props.prefix)
  const onboarding = a.projects.filter((p) => p.onboard).map((p) => p.repo)
  const steps: [string, string, string][] = [
    ['check', 'Check the AWS account', `${a.aws.account} in ${a.aws.region}`],
    ['cdk', 'Bootstrap CDK', `aws://${a.aws.account}/${a.aws.region} (only if it isn't already)`],
    ['deploy', `Deploy ${stack}`, `central bucket, GitHub secret, agent image (CodeBuild, arm64), two AgentCore runtimes (worker and API), Cognito, GitHub OIDC role for ${props.repositories.length} repositories`],
    ['token', 'Store the GitHub token', 'in the stack\'s Secrets Manager secret'],
    ['repos', 'Configure the repositories', `variables TRACE_AWS_ROLE, TRACE_AWS_REGION, TRACE_HOME, TRACE_AGENT_RUNTIME_ARN and secret TRACE_TOKEN in ${a.projects.map((p) => p.repo).join(', ')}`],
    ['onboard', 'Onboard the repositories', onboarding.length ? `open the onboarding PR in ${onboarding.join(', ')}` : 'none chosen'],
    ['people', 'Invite people and grant access', `${a.adminEmail} (first admin)${a.people.length ? `, ${a.people.map((p) => p.email).join(', ')}` : ''}`],
    ['local', 'Save this installation locally', '~/.trace/client.db, so `trace login` works here'],
  ]
  return steps.map(([id, title, detail]) => ({ id, title, detail, status: 'pending' as const }))
}

type Emit = (e: InstallEvent) => void

const cdkBin = (): string => createRequire(import.meta.url).resolve('aws-cdk/bin/cdk')

function runStreaming(cmd: string, args: string[], env: Record<string, string>, onLine: (l: string) => void): Promise<number> {
  return new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const feed = (d: Buffer): void => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    }
    p.stdout.on('data', feed)
    p.stderr.on('data', feed)
    p.on('error', reject)
    p.on('close', (code) => { if (buf.trim()) onLine(buf); resolveP(code ?? 1) })
  })
}

/** Redact anything that looks like a credential before it reaches the page. */
export function redact(line: string, secrets: Secrets): string {
  let out = line
  for (const s of [secrets.githubToken, secrets.githubAdminToken, secrets.awsSecretAccessKey, secrets.awsSessionToken, secrets.awsAccessKeyId]) {
    if (s && s.length >= 8) out = out.split(s).join('••••')
  }
  return out.replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1••••')
}

export interface Hooks {
  cdk?: (args: string[], env: Record<string, string>, onLine: (l: string) => void) => Promise<number>
  outputs?: (creds: AwsCredentialIdentity, region: string, stack: string) => Promise<Record<string, string>>
}

export async function apply(a: Answers, s: Secrets, emit: Emit, hooks: Hooks = {}): Promise<boolean> {
  const steps = plan(a)
  const byId = new Map(steps.map((st) => [st.id, st]))
  const set = (id: string, status: Step['status'], detail?: string): void => {
    const st = byId.get(id)
    if (!st) return
    st.status = status
    if (detail) st.detail = detail
    emit({ type: 'step', step: { ...st } })
  }
  const log = (id: string, line: string): void => emit({ type: 'log', step: id, line: redact(line, s) })
  for (const st of steps) emit({ type: 'step', step: { ...st } })
  const props = InfraPropsSchema.parse(infraInput(a))
  const stack = stackName(props.prefix)
  const summary: string[] = []
  const cdk = hooks.cdk ?? ((args, env, onLine) => runStreaming(process.execPath, [cdkBin(), ...args], env, onLine))
  let current = 'check'
  try {
    // 1 — the account
    const creds = await credentials(a.aws, s)
    const check = await checkAws(creds, a.aws.region, stack)
    if (check.account !== a.aws.account) throw new Error(`these credentials are for account ${check.account}, not the confirmed ${a.aws.account}`)
    if (!check.agentCore.ok) throw new Error(`Bedrock AgentCore is not available to these credentials in ${a.aws.region}: ${check.agentCore.reason}`)
    set('check', 'done', `${check.arn}`)
    const env = { ...awsEnv(creds, a.aws.region), TRACE_INFRA: JSON.stringify(infraInput(a)), CDK_DISABLE_VERSION_CHECK: '1', CI: '1' }

    // 2 — CDK bootstrap
    current = 'cdk'
    if (check.cdkBootstrapped) set('cdk', 'skipped', 'already bootstrapped')
    else {
      set('cdk', 'running')
      const code = await cdk(['bootstrap', `aws://${a.aws.account}/${a.aws.region}`, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`], env, (l) => log('cdk', l))
      if (code !== 0) throw new Error(`cdk bootstrap exited ${code}`)
      set('cdk', 'done')
    }

    // 3 — deploy
    current = 'deploy'
    set('deploy', 'running', 'the first deploy builds the agent image: expect 20–40 minutes')
    const code = await cdk(['deploy', stack, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`, '--require-approval', 'never', '--progress', 'events'], env, (l) => log('deploy', l))
    if (code !== 0) throw new Error(`cdk deploy exited ${code}`)
    const out = await (hooks.outputs ?? stackOutputs)(creds, a.aws.region, stack)
    const need = (k: string): string => {
      const v = out[k]
      if (!v) throw new Error(`the stack has no output ${k}`)
      return v
    }
    set('deploy', 'done', `${stack} is up`)

    // 4 — the token
    current = 'token'
    set('token', 'running')
    await new SecretsManagerClient({ region: a.aws.region, credentials: creds }).send(new PutSecretValueCommand({ SecretId: need('GithubSecretArn'), SecretString: s.githubToken }))
    set('token', 'done')

    // 5 — repositories
    current = 'repos'
    set('repos', 'running')
    const adminToken = s.githubAdminToken || s.githubToken
    for (const p of a.projects) {
      const vars: Record<string, string> = {
        TRACE_AWS_ROLE: need('ActionsRoleArn'), TRACE_AWS_REGION: a.aws.region, TRACE_HOME: need('TraceHome'), TRACE_AGENT_RUNTIME_ARN: need('AgentRuntimeArn'),
      }
      for (const [k, v] of Object.entries(vars)) log('repos', `${p.repo}: ${k} ${await setVariable(adminToken, p.repo, k, v)}`)
      await setSecret(adminToken, p.repo, 'TRACE_TOKEN', s.githubToken)
      log('repos', `${p.repo}: TRACE_TOKEN set`)
    }
    set('repos', 'done')

    // 6 — onboarding PRs (gh CLI, with the admin token in this process's environment only for the duration)
    current = 'onboard'
    const toOnboard = a.projects.filter((p) => p.onboard)
    if (!toOnboard.length) set('onboard', 'skipped')
    else {
      set('onboard', 'running')
      const prior = process.env.GH_TOKEN
      process.env.GH_TOKEN = adminToken
      try {
        for (const p of toOnboard) {
          const r = await onboard(p.repo, { apply: p.applySettings, ...(a.escalateTo ? { escalateTo: a.escalateTo } : {}) })
          log('onboard', `${p.repo}: ${r.pr ?? 'no PR'}${r.settings.length ? ` (${r.settings.join('; ')})` : ''}`)
          if (r.pr) summary.push(`Merge the onboarding PR: ${r.pr}`)
        }
      } finally {
        if (prior === undefined) delete process.env.GH_TOKEN
        else process.env.GH_TOKEN = prior
      }
      set('onboard', 'done')
    }

    // 7 — people and grants (central database on S3: credentials in this process's environment for the duration)
    current = 'people'
    set('people', 'running')
    const saved = { ...process.env }
    Object.assign(process.env, awsEnv(creds, a.aws.region), { TRACE_HOME: need('TraceHome') })
    try {
      const idp = new CognitoIdentityProviderClient({ region: a.aws.region, credentials: creds })
      const pool = need('UserPoolId')
      const subOf = async (email: string): Promise<string> => {
        try {
          const u = await idp.send(new AdminGetUserCommand({ UserPoolId: pool, Username: email }))
          return u.UserAttributes?.find((x) => x.Name === 'sub')?.Value ?? ''
        } catch (e) {
          if (!(e instanceof UserNotFoundException)) throw e
          const c = await idp.send(new AdminCreateUserCommand({
            UserPoolId: pool, Username: email, DesiredDeliveryMediums: ['EMAIL'],
            UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
          }))
          log('people', `${email}: invited (Cognito emails a temporary password)`)
          return c.User?.Attributes?.find((x) => x.Name === 'sub')?.Value ?? ''
        }
      }
      const installer: Principal = { sub: `installer:${check.arn}`, email: a.adminEmail, groups: [ADMIN_GROUP] }
      for (const p of a.people) {
        const sub = await subOf(p.email)
        if (!sub) throw new Error(`no Cognito id for ${p.email}`)
        if (p.admin) {
          await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: p.email, GroupName: ADMIN_GROUP }))
          log('people', `${p.email}: admin`)
        }
        for (const g of p.grants) {
          await grant(installer, { sub, email: p.email }, g.repo, g.role)
          log('people', `${p.email}: ${g.role} on ${g.repo}`)
        }
      }
      for (const p of a.projects) await register(p.repo, null)
    } finally {
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'TRACE_HOME']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    summary.push(`${a.adminEmail} receives a temporary password from Cognito; sign in with \`trace login\`.`)
    set('people', 'done')

    // 8 — this machine
    current = 'local'
    saveInstallation({
      name: 'default', region: a.aws.region, account: a.aws.account, stack, traceHome: need('TraceHome'),
      userPoolId: need('UserPoolId'), clientId: need('UserPoolClientId'), cognitoDomain: need('CognitoDomain'),
      apiRuntimeArn: need('ApiRuntimeArn'), workerRuntimeArn: need('AgentRuntimeArn'), actionsRoleArn: need('ActionsRoleArn'),
      githubSecretArn: need('GithubSecretArn'), callbackPorts: props.callbackPorts,
    })
    saveAnswers({ answers: a })
    set('local', 'done')
    summary.unshift(`trace is installed in ${a.aws.account} (${a.aws.region}) as ${stack}.`)
    summary.push('Write each project\'s rules in .trace/rules.md (they start empty).')
    emit({ type: 'done', ok: true, summary })
    return true
  } catch (e) {
    const m = redact(e instanceof Error ? e.message : String(e), s)
    set(current, 'failed', m)
    emit({ type: 'done', ok: false, summary: [`Stopped at "${byId.get(current)?.title}": ${m}`, 'Fix the cause and run the installer again: every step is safe to repeat.'] })
    return false
  }
}
