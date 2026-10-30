// cloneDefault (src/agents/runtime/job.ts): a fresh clone must not run git in the folder it is about to create. Node
// spawns with that cwd and, the folder not existing yet, fails with `spawn git ENOENT` (seen as "cannot check out
// mteichtahl/trace-sample: git clone failed: spawn git ENOENT" on the web app's requirements page).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Exec, cloneDefault, cloneDir } from '../../src/agents/runtime/job.js'

/** Like execFile: a cwd that does not exist fails as Node's spawn does; `git clone … <dir>` makes the clone. */
function fakeGit(calls: { args: string[]; cwd: string | undefined }[]): Exec {
  return async (_cmd, args, opts = {}) => {
    calls.push({ args: [...args], cwd: opts.cwd })
    if (opts.cwd && !existsSync(opts.cwd)) throw new Error(`git ${args[0] ?? ''} failed: spawn git ENOENT`)
    if (args[0] === 'clone') mkdirSync(join(String(args.at(-1)), '.git'), { recursive: true })
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
