/**
 * Onboarding as the installer does it (src/installer/onboard-api.ts): real git against a local bare repository standing
 * in for github.com (git's url.<base>.insteadOf), and a fake GitHub REST API. The first run opens the held PR; a
 * second run on an onboarded repository changes nothing when its workflows are current, and opens a refresh PR when
 * they are not. Also the lifecycle helpers (src/installer/lifecycle.ts).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnswersSchema } from '../../src/installer/answers.js'
import { consoleEmit, keptAfterUninstall, storedTokens } from '../../src/installer/lifecycle.js'
import { REFRESH_BRANCH, gitEnv, gitRunner, onboardViaApi } from '../../src/installer/onboard-api.js'

const hasGit = spawnSync('git', ['--version']).status === 0

function remote(slug: string): { base: string; git: ReturnType<typeof gitRunner>; branches: () => string[]; file: (branch: string, path: string) => string } {
  const base = mkdtempSync(join(tmpdir(), 'trace-remote-'))
  const bare = join(base, `${slug}.git`)
  const run = (args: string[], cwd?: string): string => {
    const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })
    if (p.status !== 0) throw new Error(p.stderr)
    return p.stdout
  }
  run(['init', '-q', '--bare', '-b', 'main', bare])
  const seed = mkdtempSync(join(tmpdir(), 'trace-seed-'))
  run(['init', '-q', '-b', 'main'], seed)
  writeFileSync(join(seed, 'README.md'), '# board\n')
  run(['add', '-A'], seed)
  run(['commit', '-q', '-m', 'first'], seed)
  run(['push', '-q', bare, 'HEAD:refs/heads/main'], seed)
  const env = { ...gitEnv('token-not-sent-anywhere', 'marc'), GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: `url.file://${base}/.insteadOf`, GIT_CONFIG_VALUE_2: 'https://github.com/' }
  return {
    base, git: gitRunner(env),
    branches: () => run(['branch', '--format=%(refname:short)'], bare).trim().split('\n').sort(),
    file: (branch, path) => run(['show', `${branch}:${path}`], bare),
  }
}

function github(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls,
    fetch: (async (url: string, init?: RequestInit) => {
      const path = url.replace('https://api.github.com', '')
      calls.push(`${init?.method ?? 'GET'} ${path.split('?')[0]}`)
      if (path.includes('/pulls?')) return new Response('[]', { status: 200 })
      if (path.endsWith('/pulls')) { n++; return new Response(JSON.stringify({ html_url: `https://github.com/marc/board/pull/${n}`, number: n }), { status: 201 }) }
      if (path.endsWith('/rulesets') && init?.method === 'GET') return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  }
}

describe.skipIf(!hasGit)('onboarding through the API and git', () => {
  it('opens the held PR once, leaves current workflows alone, and refreshes stale ones', async () => {
    const r = remote('marc/board')
    const gh = github()
    const first = await onboardViaApi('marc/board', { token: 't', login: 'marc', apply: true, git: r.git, fetchImpl: gh.fetch })
    expect(first).toMatchObject({ state: 'opened', pr: 'https://github.com/marc/board/pull/1' })
    expect(first.settings.join(' ')).toMatch(/ruleset/)
    expect(r.branches()).toEqual(['main', 'trace/onboard'])
    expect(r.file('trace/onboard', '.github/workflows/trace-ci.yml')).toContain("fromJSON(format('[\"codebuild-{0}-{1}-{2}\",")
    expect(gh.calls).toEqual(expect.arrayContaining(['POST /repos/marc/board/pulls', 'PATCH /repos/marc/board', 'POST /repos/marc/board/rulesets']))
    expect(gh.calls.some((c) => c.includes('/issues/1/labels'))).toBe(true)

    // the PR merged: main is onboarded, its workflows current → nothing to do
    const merge = mkdtempSync(join(tmpdir(), 'trace-merge-'))
    r.git(['git', 'clone', '-q', 'https://github.com/marc/board.git', merge])
    r.git(['git', 'merge', '-q', '--ff-only', 'origin/trace/onboard'], { cwd: merge })
    r.git(['git', 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: merge })
    const again = await onboardViaApi('marc/board', { token: 't', login: 'marc', apply: false, git: r.git, fetchImpl: gh.fetch })
    expect(again).toMatchObject({ state: 'unchanged', pr: null })
    expect(r.branches()).not.toContain(REFRESH_BRANCH)

    // an older trace's workflow on main → a refresh PR with only the workflows
    writeFileSync(join(merge, '.github', 'workflows', 'trace-ci.yml'), readFileSync(join(merge, '.github', 'workflows', 'trace-ci.yml'), 'utf8').replace(/runs-on: .*/, 'runs-on: ubuntu-22.04'))
    r.git(['git', 'commit', '-q', '-am', 'an older workflow'], { cwd: merge })
    r.git(['git', 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: merge })
    const refresh = await onboardViaApi('marc/board', { token: 't', login: 'marc', apply: false, git: r.git, fetchImpl: gh.fetch })
    expect(refresh).toMatchObject({ state: 'refreshed', pr: 'https://github.com/marc/board/pull/2' })
    expect(r.file(REFRESH_BRANCH, '.github/workflows/trace-ci.yml')).toContain('TRACE_CODEBUILD_PROJECT')
    expect(existsSync(join(r.base, 'marc', 'board.git'))).toBe(true)
  })

  it('runs git only, never the gh CLI', () => {
    expect(() => gitRunner({})(['gh', 'pr', 'create'])).toThrow(/runs git only/)
  })
})

describe('upgrading and uninstalling', () => {
  const a = AnswersSchema.parse({ aws: { region: 'us-east-1', account: '123456789012' }, adminEmail: 'm@example.com', projects: [{ repo: 'marc/board' }, { repo: 'marc/fw', generation: 1 }] })

  it('reads the tokens back from the installation\'s own secrets', async () => {
    const store = new Map([['trace/github-token', 'shared-token'], ['trace/github-token/marc/board', 'shared-token'], ['trace/github-token/marc/fw@g1', 'fw-token']])
    expect(await storedTokens(a, async (n) => store.get(n) ?? null)).toEqual({ githubToken: 'shared-token', projectTokens: { 'marc/fw': 'fw-token' } })
    await expect(storedTokens(a, async () => null)).rejects.toThrow(/run `tracectl install` instead/)
  })

  it('says what uninstalling keeps', () => {
    const kept = keptAfterUninstall(a, false).join('\n')
    expect(kept).toMatch(/central bucket/)
    expect(kept).toMatch(/Cognito user pool trace-users/)
    expect(kept).toMatch(/trace\/github-token/)
    const purged = keptAfterUninstall(a, true).join('\n')
    expect(purged).not.toMatch(/user pool|github-token|image repositories/)
    expect(keptAfterUninstall({ ...a, agents: { ...a.agents, retainData: false } }, false).join('\n')).not.toMatch(/central bucket/)
  })

  it('prints the installer\'s progress once per change', () => {
    const lines: string[] = []
    const emit = consoleEmit((l) => lines.push(l))
    const step = { id: 'deploy', title: 'Update TraceStack', detail: 'x', status: 'running' as const }
    emit({ type: 'step', step })
    emit({ type: 'step', step })
    emit({ type: 'ready', summary: [] })
    emit({ type: 'done', ok: true, summary: ['trace is installed'] })
    expect(lines).toEqual(['[running] Update TraceStack', '', 'trace is ready to use. Still going: the GPU image.', '', '- trace is installed'])
  })
})
