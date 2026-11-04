// cloneDefault (src/agents/runtime/job.ts): a fresh clone must not run git in the folder it is about to create. Node
// spawns with that cwd and, the folder not existing yet, fails with `spawn git ENOENT` (seen as "cannot check out
// mteichtahl/trace-sample: git clone failed: spawn git ENOENT" on the web app's requirements page).
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Exec, RUNTIME_WORKSPACE, checkoutBranch, cloneDefault, cloneDir, execReal, gitAuthEnv, removeDir, workspaceDir } from '../../src/agents/runtime/job.js'
import { TOOL_WORKSPACE } from '../../src/agents/runtime/tool.js'

/** Like execFile: a cwd that does not exist fails as Node's spawn does; `git clone … <dir>` makes the clone. */
function fakeGit(calls: { args: string[]; cwd: string | undefined }[]): Exec {
  return async (_cmd, args, opts = {}) => {
    calls.push({ args: [...args], cwd: opts.cwd })
    if (opts.cwd && !existsSync(opts.cwd)) throw new Error(`git ${args[0] ?? ''} failed: spawn git ENOENT`)
    if (args[0] === 'clone') {
      const into = String(args.at(-1))
      // as git: a destination that exists and is not empty is refused
      if (existsSync(into) && readdirSync(into).length > 0) throw new Error(`git clone failed: fatal: destination path '${into}' already exists and is not an empty directory.`)
      mkdirSync(join(into, '.git'), { recursive: true })
    }
    return { stdout: '', stderr: '' }
  }
}

describe('cloneDefault', () => {
  it('clones into a fresh folder from its parent, then works in the clone', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'trace-ws-'))
    try {
      const dir = cloneDir(ws, 'mteichtahl/trace-sample', 'api-tool')
      const calls: { args: string[]; cwd: string | undefined }[] = []
      const co = await cloneDefault({ exec: fakeGit(calls), dir, auth: {}, log: () => undefined, repository: 'mteichtahl/trace-sample', defaultBranch: 'main', cli: '/app/dist/cli.js' })
      expect(co.dir).toBe(dir)
      const clone = calls.find((c) => c.args[0] === 'clone')
      expect(clone?.cwd).toBe(join(dir, '..'))
      for (const c of calls.filter((x) => x.args[0] !== 'clone')) expect(c.cwd).toBe(dir)
      // a second checkout reuses the clone: fetched and reset in place
      const again: { args: string[]; cwd: string | undefined }[] = []
      await cloneDefault({ exec: fakeGit(again), dir, auth: {}, log: () => undefined, repository: 'mteichtahl/trace-sample', defaultBranch: 'main', cli: '/app/dist/cli.js' })
      expect(again.some((c) => c.args[0] === 'clone')).toBe(false)
      expect(again.every((c) => c.cwd === dir)).toBe(true)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

// On AgentCore's session storage the clone belongs to another uid than the runtime's user, and git refuses such a
// repository: `git config` reports only "fatal: not in a git directory" ("cannot check out mteichtahl/trace-sample:
// git config failed: …"). Reproduced with a real git on a repository chowned away from us (needs root to chown).
describe('git in a clone owned by another user', () => {
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  it.skipIf(!root)('is refused without gitAuthEnv, and works with it (safe.directory)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'trace-own-'))
    try {
      const dir = join(ws, 'repo')
      await execReal('git', ['init', '-q', dir])
      const chownAll = (p: string): void => {
        chownSync(p, 65534, 65534)
        for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) chownAll(join(p, e.name)); else chownSync(join(p, e.name), 65534, 65534)
      }
      chownAll(dir)
      const set = ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']
      await expect(execReal('git', set, { cwd: dir })).rejects.toThrow(/not in a git directory/)
      await execReal('git', set, { cwd: dir, env: gitAuthEnv('token-not-sent-anywhere') })
      expect((await execReal('git', ['config', 'remote.origin.fetch'], { cwd: dir, env: gitAuthEnv('t') })).stdout.trim()).toBe('+refs/heads/*:refs/remotes/origin/*')
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

describe('what a failed checkout leaves', () => {
  it('a folder without .git in the clone\'s place is cleared before the clone', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'trace-left-'))
    try {
      const dir = cloneDir(ws, 'mteichtahl/trace-sample', 'api-tool')
      mkdirSync(join(dir, 'hw'), { recursive: true })
      writeFileSync(join(dir, 'hw', 'half-written.kicad_sch'), '(')
      const calls: { args: string[]; cwd: string | undefined }[] = []
      const co = await cloneDefault({ exec: fakeGit(calls), dir, auth: {}, log: () => undefined, repository: 'mteichtahl/trace-sample', defaultBranch: 'main', cli: '/app/dist/cli.js' })
      expect(co.reused).toBe(false)
      expect(existsSync(join(dir, 'hw'))).toBe(false)
      expect(existsSync(join(dir, '.git'))).toBe(true)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('removeDir removes a tree, and a path that is not there is fine', () => {
    const ws = mkdtempSync(join(tmpdir(), 'trace-rm-'))
    mkdirSync(join(ws, 'a', 'b'), { recursive: true })
    writeFileSync(join(ws, 'a', 'b', 'f'), 'x')
    expect(removeDir(join(ws, 'a'))).toBe(true)
    expect(existsSync(join(ws, 'a'))).toBe(false)
    expect(removeDir(join(ws, 'nothing'))).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })

  it('tool calls keep their clone on the container\'s own disk, not session storage (SQLite\'s locks)', () => {
    expect(TOOL_WORKSPACE.startsWith('/tmp/')).toBe(true)
    expect(TOOL_WORKSPACE.startsWith('/mnt/workspace')).toBe(false)
  })
})

describe('where jobs clone', () => {
  it('on AgentCore, the container\'s own disk for the session\'s life, never session storage (SQLite\'s locks)', () => {
    expect(workspaceDir({ TRACE_WORKSPACE: '/mnt/workspace' })).toEqual({ dir: RUNTIME_WORKSPACE, persistent: true })
    expect(RUNTIME_WORKSPACE.startsWith('/mnt/')).toBe(false)
    expect(workspaceDir({ TRACE_WORKSPACE: '/srv/work' })).toEqual({ dir: '/srv/work', persistent: false })
  })
})

// Stacked changes (docs/stacked-changes.md): a new branch starts from the open change it depends on, when that branch
// is on GitHub, and from the default branch otherwise. With a real git and a local "origin".
describe('checkoutBranch with a stacked base', () => {
  const git = (args: string[], cwd: string) => execReal('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const setup = async (): Promise<{ ws: string; work: string }> => {
    const ws = mkdtempSync(join(tmpdir(), 'trace-stack-'))
    const origin = join(ws, 'origin.git')
    const seed = join(ws, 'seed')
    await git(['init', '-q', '--bare', '-b', 'main', origin], ws)
    await git(['init', '-q', '-b', 'main', seed], ws)
    writeFileSync(join(seed, 'a.txt'), 'main\n')
    await git(['add', '.'], seed); await git(['commit', '-qm', 'main'], seed)
    await git(['checkout', '-qb', 'claude/parent'], seed)
    writeFileSync(join(seed, 'p.txt'), 'parent\n')
    await git(['add', '.'], seed); await git(['commit', '-qm', 'parent work'], seed)
    await git(['push', '-q', origin, 'main', 'claude/parent'], seed)
    const work = join(ws, 'work')
    await git(['clone', '-q', '--branch', 'main', origin, work], ws)
    return { ws, work }
  }
  const opts = (dir: string, log: string[] = []) => ({ exec: execReal, dir, auth: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, log: (l: string) => { log.push(l) } })

  it('starts a new branch from an open change on GitHub, and says so', async () => {
    const { ws, work } = await setup()
    try {
      const log: string[] = []
      let started = ''
      await checkoutBranch({ ...opts(work, log), defaultBranch: 'main', branch: 'claude/child', from: 'maybe', base: 'claude/parent', isOpenChange: async (b) => b === 'claude/parent', started: (f) => { started = f } })
      expect(existsSync(join(work, 'p.txt'))).toBe(true)
      expect(started).toBe('claude/parent')
      expect(log.join()).toMatch(/stacked on that open change/)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('starts from the default branch when the base has no open pull request, is the default branch, or is not a branch name', async () => {
    // claude/parent is on GitHub but has no open pull request (pushed early, or merged): its commits must not ride along
    for (const [base, open] of [['claude/parent', false], ['claude/gone', true], ['main', true], ['../etc', true]] as const) {
      const { ws, work } = await setup()
      try {
        let started = ''
        await checkoutBranch({ ...opts(work), defaultBranch: 'main', branch: 'claude/child', from: 'maybe', base, isOpenChange: async () => open, started: (f) => { started = f } })
        expect(existsSync(join(work, 'p.txt')), base).toBe(false)
        expect(started).toBe('main')
      } finally { rmSync(ws, { recursive: true, force: true }) }
    }
  })

  it('starts from the default branch when it cannot tell whether the base is an open change', async () => {
    const { ws, work } = await setup()
    try {
      await checkoutBranch({ ...opts(work), defaultBranch: 'main', branch: 'claude/child', from: 'maybe', base: 'claude/parent', isOpenChange: async () => { throw new Error('GitHub 502') } })
      expect(existsSync(join(work, 'p.txt'))).toBe(false)
      const { ws: ws2, work: work2 } = await setup()
      try {
        // and with no way to ask at all
        await checkoutBranch({ ...opts(work2), defaultBranch: 'main', branch: 'claude/child', from: 'maybe', base: 'claude/parent' })
        expect(existsSync(join(work2, 'p.txt'))).toBe(false)
      } finally { rmSync(ws2, { recursive: true, force: true }) }
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('checks out an existing branch as it is, whatever the base', async () => {
    const { ws, work } = await setup()
    try {
      await checkoutBranch({ ...opts(work), defaultBranch: 'main', branch: 'claude/parent', from: 'maybe', base: 'claude/other' })
      expect(existsSync(join(work, 'p.txt'))).toBe(true)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})
