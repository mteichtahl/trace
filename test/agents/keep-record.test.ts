// keepRecord (src/agents/runtime/job.ts): a finished specialist's record (.trace/project.db) is committed on its
// branch and pushed. job-mvw37v84 (testyyyu) wrote R1-R10 and its test plan into the record, but only the worker's
// markdown was committed, so after the merge the project's Requirements page was still empty.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RECORD_PATH, execReal, keepRecord } from '../../src/agents/runtime/job.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function repo(branch: string): Promise<{ dir: string; remote: string; git: (a: string[], cwd?: string) => Promise<string> }> {
  const root = mkdtempSync(join(tmpdir(), 'trace-record-'))
  dirs.push(root)
  const git = async (a: string[], cwd = join(root, 'clone')): Promise<string> => (await execReal('git', a, { cwd, env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).stdout.trim()
  await execReal('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'remote.git')])
  await execReal('git', ['clone', '-q', join(root, 'remote.git'), join(root, 'clone')])
  mkdirSync(join(root, 'clone', '.trace'))
  writeFileSync(join(root, 'clone', RECORD_PATH), 'v1')
  await git(['add', '-A']); await git(['commit', '-qm', 'start']); await git(['push', '-q', 'origin', 'HEAD:main'])
  if (branch !== 'main') await git(['checkout', '-qb', branch])
  return { dir: join(root, 'clone'), remote: join(root, 'remote.git'), git }
}
const gopts = (dir: string) => ({ exec: execReal, dir, auth: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, log: () => undefined })

describe('a finished specialist\'s record', () => {
  it('is committed on the job\'s branch and pushed, alone, when its tools changed it', async () => {
    const r = await repo('claude/task-requirements')
    writeFileSync(join(r.dir, RECORD_PATH), 'v2: R1-R10')
    writeFileSync(join(r.dir, 'scratch.txt'), 'not the record')
    const said = await keepRecord({ g: gopts(r.dir), branch: 'claude/task-requirements', defaultBranch: 'main', jobId: 'job-1', agent: 'verify', log: () => undefined })
    expect(said).toMatchObject({ lost: false, text: expect.stringMatching(/^committed the project's record on claude\/task-requirements \([0-9a-f]+\) and pushed it$/) })
    expect(await r.git(['show', 'claude/task-requirements:.trace/project.db'], r.remote)).toBe('v2: R1-R10')
    expect(await r.git(['log', '-1', '--format=%s', 'claude/task-requirements'], r.remote)).toBe("trace: the verify specialist's record (job-1)")
    // only the record: other files are left as they were
    expect(await r.git(['status', '--porcelain'])).toBe('?? scratch.txt')
  })

  it('nothing to keep: null; on the default branch: never pushed, and said', async () => {
    const r = await repo('claude/x')
    expect(await keepRecord({ g: gopts(r.dir), branch: 'claude/x', defaultBranch: 'main', jobId: 'j', agent: 'verify', log: () => undefined })).toBeNull()
    const m = await repo('main')
    writeFileSync(join(m.dir, RECORD_PATH), 'v2')
    expect(await keepRecord({ g: gopts(m.dir), branch: 'main', defaultBranch: 'main', jobId: 'j', agent: 'verify', log: () => undefined })).toMatchObject({ lost: false, text: expect.stringMatching(/stays uncommitted: the job ran on the default branch/) })
    expect(await m.git(['show', 'main:.trace/project.db'], m.remote)).toBe('v1')
  })

  it('a push the remote refuses (a file over GitHub\'s limit, say): lost, and said why', async () => {
    const r = await repo('claude/big')
    writeFileSync(join(r.dir, RECORD_PATH), 'v2: 18 SPICE runs')
    // the remote refuses every update, as GitHub refuses a push with a file over 100 MB
    writeFileSync(join(r.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "remote: error: GH001: Large files detected" >&2\nexit 1\n', { mode: 0o755 })
    const said = await keepRecord({ g: gopts(r.dir), branch: 'claude/big', defaultBranch: 'main', jobId: 'j', agent: 'verify', log: () => undefined })
    expect(said).toMatchObject({ lost: true, text: expect.stringMatching(/^could not commit the project's record on claude\/big: /) })
    expect(said?.text).toMatch(/GH001|pre-receive|rejected/)
  })
})
