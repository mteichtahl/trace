/**
 * CI on AWS: CodeBuild-hosted runners (src/installer/runners.ts) against a fake CodeBuild, the trace workflows'
 * `runs-on` (templates, and trace's own ci.yml), and the image builds' caching and published images
 * (src/infra/images.ts), with the lock file an installed trace bundles from (src/infra/lockfile.ts).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CreateProjectCommand, CreateWebhookCommand, ImportSourceCredentialsCommand, ListSourceCredentialsCommand, UpdateProjectCommand, UpdateWebhookCommand,
} from '@aws-sdk/client-codebuild'
import { describe, expect, it } from 'vitest'
import { RUNS_ON, RUNS_ON_BENCH, TEMPLATES, render } from '../../src/core/onboard.js'
import { imageBuildEnv, imageBuildSpec, imageContentTag, prebuiltImage } from '../../src/infra/images.js'
import { lockFile } from '../../src/infra/lockfile.js'
import { RUNNER_IMAGE, ensureRunner, ensureSourceCredential, runnerProject, runnerRepos } from '../../src/installer/runners.js'
import { gitEnv } from '../../src/installer/onboard-api.js'

const ROOT = join(import.meta.dirname, '..', '..')

function codebuild(o: { credentials?: { serverType: string; authType: string }[]; projectExists?: boolean; webhookExists?: boolean; webhookError?: Error } = {}) {
  const sent: string[] = []
  return {
    sent,
    send: async (c: unknown): Promise<never> => {
      const name = (c as { constructor: { name: string } }).constructor.name
      sent.push(name)
      const exists = (what: boolean): void => { if (what) throw Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' }) }
      if (c instanceof ListSourceCredentialsCommand) return { sourceCredentialsInfos: o.credentials ?? [] } as never
      if (c instanceof CreateProjectCommand) exists(Boolean(o.projectExists))
      if (c instanceof CreateWebhookCommand) { if (o.webhookError) throw o.webhookError; exists(Boolean(o.webhookExists)) }
      return {} as never
    },
  }
}

describe('CodeBuild runners', () => {
  const spec = { prefix: 'trace', repo: 'marc/board', roleArn: 'arn:aws:iam::123456789012:role/trace-ci-runner-us-east-1', computeType: 'BUILD_GENERAL1_MEDIUM' }

  it('makes a runner project on Ubuntu 24.04 with a workflow-job webhook, and updates both on a second run', async () => {
    const p = runnerProject(spec)
    expect(p).toMatchObject({ source: { type: 'GITHUB', location: 'https://github.com/marc/board' }, environment: { image: RUNNER_IMAGE, computeType: 'BUILD_GENERAL1_MEDIUM', privilegedMode: false }, serviceRole: spec.roleArn })
    expect(RUNNER_IMAGE).toBe('aws/codebuild/standard:8.0')
    expect(p.name).toMatch(/^trace-ci-[0-9a-f]{8}$/)
    const first = codebuild()
    expect(await ensureRunner(first, spec)).toBe(p.name)
    expect(first.sent).toEqual([CreateProjectCommand.name, CreateWebhookCommand.name])
    const again = codebuild({ projectExists: true, webhookExists: true })
    await ensureRunner(again, spec)
    expect(again.sent).toEqual([CreateProjectCommand.name, UpdateProjectCommand.name, CreateWebhookCommand.name, UpdateWebhookCommand.name])
    // a repository the token cannot administer: said plainly
    await expect(ensureRunner(codebuild({ webhookError: Object.assign(new Error('Access token does not have permission'), { name: 'OAuthProviderException' }) }), spec)).rejects.toThrow(/the webhook on marc\/board: .*needs Administration and Webhooks read and write/)
  })

  it('imports the token as CodeBuild\'s GitHub credential, but never overwrites someone else\'s', async () => {
    const fresh = codebuild()
    expect((await ensureSourceCredential(fresh, 'tok', false)).state).toBe('imported')
    expect(fresh.sent).toContain(ImportSourceCredentialsCommand.name)
    const theirs = codebuild({ credentials: [{ serverType: 'GITHUB', authType: 'CODECONNECTIONS' }] })
    expect(await ensureSourceCredential(theirs, 'tok', false)).toMatchObject({ state: 'existing', detail: expect.stringMatching(/codeconnections.*leaves it alone/) })
    expect(theirs.sent).not.toContain(ImportSourceCredentialsCommand.name)
    const ours = codebuild({ credentials: [{ serverType: 'GITHUB', authType: 'PERSONAL_ACCESS_TOKEN' }] })
    expect((await ensureSourceCredential(ours, 'tok', true)).state).toBe('refreshed')
    expect(runnerRepos(['marc/board', 'Marc/Board'], ['mteichtahl/trace'])).toEqual(['marc/board', 'mteichtahl/trace'])
  })
})

describe('the trace workflows run on AWS when the repository has a runner', () => {
  const EXPR = "codebuild-{0}-{1}-{2}', vars.TRACE_CODEBUILD_PROJECT, github.run_id, github.run_attempt"

  it('uses CodeBuild\'s label, codebuild-<project>-<run_id>-<run_attempt>, else GitHub\'s ubuntu-24.04', () => {
    expect(RUNS_ON).toBe("${{ vars.TRACE_CODEBUILD_PROJECT && format('codebuild-{0}-{1}-{2}', vars.TRACE_CODEBUILD_PROJECT, github.run_id, github.run_attempt) || 'ubuntu-24.04' }}")
    // a bench (self-hosted) runner comes first where a job may need one
    expect(RUNS_ON_BENCH.indexOf('TRACE_RUNNER')).toBeLessThan(RUNS_ON_BENCH.indexOf('TRACE_CODEBUILD_PROJECT'))
    const values = { SOURCE: 'mteichtahl/trace', REF: 'v1', BRANCH: 'main', BUILD_NAME: 'ci', HOLD: 'hold', CI_RED: 'ci-red', AGENT_FIX: 'agent-fix', DEPLOY: 'deploy', DEPLOY_HELD: 'deploy-held', ENVIRONMENT: 'production', RUNS_ON, RUNS_ON_BENCH }
    const files = [...readdirSync(join(TEMPLATES, 'workflows')).map((f) => `workflows/${f}`), ...readdirSync(join(TEMPLATES, 'build')).map((f) => `build/${f}`)]
    let jobs = 0
    for (const f of files) {
      const text = render(readFileSync(join(TEMPLATES, f), 'utf8'), values)
      for (const line of text.split('\n').filter((l) => /^\s+runs-on:/.test(l))) {
        jobs++
        expect(line, `${f}: ${line}`).toContain(EXPR)
      }
    }
    expect(jobs).toBeGreaterThanOrEqual(20)
  })

  it('does the same in trace\'s own ci.yml', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const lines = ci.split('\n').filter((l) => /^\s+runs-on:/.test(l))
    expect(lines.length).toBe(3)
    for (const l of lines) expect(l.trim()).toBe(`runs-on: ${RUNS_ON}`)
    // CodeBuild runs as root, possibly without sudo
    expect(ci).toContain('SUDO="$(command -v sudo || true)"')
  })
})

describe('the images', () => {
  it('are copied from trace\'s published image for this exact source when there is one, else built from the cache', () => {
    const spec = JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64' }))
    expect(spec).toContain('docker pull --platform linux/arm64 \\"$PREBUILT_IMAGE\\"')
    expect(spec).toContain('--build-arg BUILDKIT_INLINE_CACHE=1 --cache-from \\"$REPOSITORY_URI:cache\\"')
    expect(spec).toContain('docker push \\"$REPOSITORY_URI:cache\\"')
    expect(imageBuildEnv({ source: 'prebuilt', registry: 'public.ecr.aws/x/trace' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: 'public.ecr.aws/x/trace-gpu:v1-abc' } })
    expect(imageBuildEnv({ source: 'build', registry: 'public.ecr.aws/x/trace' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: '' } })
    expect(prebuiltImage('r', 'agent', 't')).toBe('r-agent:t')
  })

  it('tag the published images by a hash of what goes into them, the same in a clone and an installed copy', () => {
    const tag = imageContentTag(ROOT)
    expect(tag).toMatch(/^v\d+\.\d+\.\d+-[0-9a-f]{16}$/)
    expect(imageContentTag(ROOT)).toBe(tag)
    // a copy with only what npm packs (no tests, no docs) has the same tag; a changed source file changes it
    const copy = mkdtempSync(join(tmpdir(), 'trace-pack-'))
    try {
      for (const f of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, f), join(copy, f))
      for (const d of ['agent', 'python', 'scripts', 'harness', 'templates']) cpSync(join(ROOT, d), join(copy, d), { recursive: true, filter: (p) => !/node_modules|__pycache__|\/dist(\/|$)/.test(p) })
      mkdirSync(join(copy, 'src'))
      cpSync(join(ROOT, 'src'), join(copy, 'src'), { recursive: true })
      writeFileSync(join(copy, 'README.md'), 'not an image input')
      expect(imageContentTag(copy)).toBe(tag)
      writeFileSync(join(copy, 'src', 'cli.ts'), `${readFileSync(join(copy, 'src', 'cli.ts'), 'utf8')}\n// changed`)
      expect(imageContentTag(copy)).not.toBe(tag)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('build from the lock file npm leaves out of an installed trace', () => {
    // scripts/stage-image.mjs (npm run build) copies it, and .npmrc, into agent/, which npm does pack
    expect(existsSync(join(ROOT, 'agent', 'package-lock.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'agent', 'npmrc'))).toBe(true)
    for (const f of ['Dockerfile', 'Dockerfile.gpu']) expect(readFileSync(join(ROOT, 'agent', f), 'utf8')).toContain('COPY package.json agent/package-lock.json agent/npmrc ./')
    const installed = mkdtempSync(join(tmpdir(), 'trace-installed-'))
    try {
      mkdirSync(join(installed, 'agent'))
      expect(() => lockFile(installed)).toThrow(/no package-lock.json/)
      writeFileSync(join(installed, 'agent', 'package-lock.json'), '{}')
      expect(lockFile(installed)).toBe(join(installed, 'agent', 'package-lock.json'))
      writeFileSync(join(installed, 'package-lock.json'), '{}')
      expect(lockFile(installed)).toBe(join(installed, 'package-lock.json'))
    } finally {
      rmSync(installed, { recursive: true, force: true })
    }
  })
})

describe('onboarding without the gh CLI', () => {
  it('gives git the token in its environment only, and no credential helper', () => {
    const env = gitEnv('secret-token-value', 'marc')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from((env.GIT_CONFIG_VALUE_0 ?? '').replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:secret-token-value')
    expect(env).toMatchObject({ GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_EMAIL: 'marc@users.noreply.github.com' })
  })
})
