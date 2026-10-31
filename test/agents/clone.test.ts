// cloneDefault (src/agents/runtime/job.ts): a fresh clone must not run git in the folder it is about to create. Node
// spawns with that cwd and, the folder not existing yet, fails with `spawn git ENOENT` (seen as "cannot check out
// mteichtahl/trace-sample: git clone failed: spawn git ENOENT" on the web app's requirements page).
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Exec, cloneDefault, cloneDir, execReal, gitAuthEnv, removeDir } from '../../src/agents/runtime/job.js'
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
