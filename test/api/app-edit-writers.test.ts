/**
 * The actions that commit a person's change on a branch of trace's own and record it as an app edit
 * (docs/stay-in-trace.md "1. App edits", "4. Getting and handing in design files", "6. Small links and words"):
 * design.handin's path, size and protected-path rules and "same as the design"; files.edit's rules; and that
 * design.handin, files.edit, settings.set, prompts.set (project) and journey.snapshot each open the pull request,
 * record the edit and answer its number as `change`. Over the shared fake GitHub (with openPull and commitFiles) and a
 * central bucket in a temporary folder.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, ActionError, type Context, perform, promptTitle, settingTitle } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { editRefusal, isText } from '../../src/api/actions-files.js'
import { MAX_HANDIN_FILE, MAX_HANDIN_FILES, handinBranch, handinTitle, isKiCadPath, pathRefusal, sizeRefusal } from '../../src/api/actions-handin.js'
import { editStore } from '../../src/api/edits.js'
import { SERVICE_ACTIONS } from '../../src/api/service-policy.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { setValue } from '../../src/core/config.js'
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const REPO = 'acme/edits'
const ADMIN = { sub: 'e-admin', email: 'e-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'e-user', email: 'e-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'e-rev', email: 'e-rev@example.com', groups: ['trace-users'] }

/** The shared fake, with the calls an edit needs: one commit of several files, and opening the pull request. */
class EditsGitHub extends FakeGitHub {
  pulls: { head: string; base: string; title: string; body: string }[] = []
  committed: { branch: string; base: string; message: string; files: string[] }[] = []
  async openPull(_repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }> {
    this.pulls.push(o)
    return { number: 100 + this.pulls.length, existed: false }
  }
  async commitFiles(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array }[] }): Promise<{ commit: string }> {
    if (this.branches.has(`${repo}:${o.branch}`)) throw new Error('the branch exists')
    this.committed.push({ branch: o.branch, base: o.base, message: o.message, files: o.files.map((f) => f.path) })
    for (const f of o.files) this.files.set(`${repo}:${o.branch}:${f.path}`, f.content)
    this.branches.set(`${repo}:${o.branch}`, 'b'.repeat(40))
    return { commit: 'b'.repeat(40) }
  }
}

const github = new EditsGitHub([REPO])
const cognito = new FakeCognito()
cognito.add(USER.email, USER.sub, 'trace-users', 'Alex Lee')
const scratch = mkdtempSync(join(tmpdir(), 'trace-edits-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-edits-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, tools: () => new Registry([]), scratch,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  store: (p) => backendFor(join(bucket, p)),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => (await perform(action, args, ctx(who))).result as Record<string, unknown>
const b64 = (s: string): string => Buffer.from(s).toString('base64')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { class: 'user', part: 'reviewer' })
  // the default branch: a KiCad project in hardware/, CLAUDE.md, and settings protecting docs/rules/**
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  openProject(dir).close()
  setValue('prs.protected_paths', ['.github/**', '.trace/**', 'docs/rules/**'], dir, 'seed')
  setValue('worker.max_attempts', 3, dir, 'seed')
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  github.files.set(`${REPO}:main:hardware/board.kicad_sch`, enc('(kicad_sch (version 1))'))
  github.files.set(`${REPO}:main:hardware/power.kicad_sch`, enc('(kicad_sch (power))'))
  github.files.set(`${REPO}:main:hardware/board.kicad_pcb`, enc('(kicad_pcb)'))
  github.files.set(`${REPO}:main:CLAUDE.md`, enc('# Notes\n'))
  github.files.set(`${REPO}:main:docs/logo.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))
})

describe('design.handin: the rules, pure', () => {
  const o = { existing: new Set(['hardware/board.kicad_sch', 'README.md']), kicadFolders: new Set(['hardware']), protectedPaths: ['docs/rules/**'] }

  it('KiCad files only, by extension or the two library tables by name', () => {
    for (const p of ['a.kicad_sch', 'x/a.kicad_pcb', 'a.kicad_pro', 'lib.kicad_sym', 'fp.pretty/R.kicad_mod', 'a.kicad_dru', 'fp-lib-table', 'hw/sym-lib-table']) expect(isKiCadPath(p), p).toBe(true)
    for (const p of ['a.sch', 'README.md', 'my-fp-lib-table.txt', 'a.kicad_sch.bak']) expect(isKiCadPath(p), p).toBe(false)
  })

  it('inside the repository, never protected, existing or new beside the design\'s files', () => {
    expect(pathRefusal('hardware/board.kicad_sch', o)).toBeNull()
    expect(pathRefusal('hardware/usb.kicad_sch', o)).toBeNull()
    expect(pathRefusal('elsewhere/usb.kicad_sch', o)).toMatch(/not beside the design's KiCad files: put it in hardware/)
    expect(pathRefusal('../x.kicad_sch', o)).toMatch(/not a path inside the repository/)
    expect(pathRefusal('/etc/x.kicad_sch', o)).toMatch(/not a path inside the repository/)
    expect(pathRefusal('hardware/./x.kicad_sch', o)).toMatch(/not a path inside the repository/)
    expect(pathRefusal('.trace/x.kicad_sch', o)).toMatch(/steers trace itself/)
    expect(pathRefusal('.github/workflows/x.kicad_sch', o)).toMatch(/steers trace itself/)
    expect(pathRefusal('docs/rules/x.kicad_sch', o)).toMatch(/steers trace itself/)
    expect(pathRefusal('README.md', o)).toMatch(/not a KiCad file/)
    // a repository with no KiCad files yet takes them anywhere
    expect(pathRefusal('pcb/new.kicad_pcb', { ...o, kicadFolders: new Set() })).toBeNull()
  })

  it('at most 20 files, 3 MB each, 3.5 MB together, each named once', () => {
    const f = (path: string, n: number) => ({ path, bytes: new Uint8Array(n) })
    expect(sizeRefusal([f('a.kicad_sch', 10)])).toBeNull()
    expect(sizeRefusal(Array.from({ length: MAX_HANDIN_FILES + 1 }, (_, i) => f(`${i}.kicad_sch`, 1)))).toMatch(/At most 20 files/)
    expect(sizeRefusal([f('big.kicad_pcb', MAX_HANDIN_FILE + 1)])).toMatch(/big\.kicad_pcb is 3\.0 MB; a file handed in is at most 3\.0 MB/)
    expect(sizeRefusal([f('a.kicad_pcb', 2 * 1024 * 1024), f('b.kicad_pcb', 2 * 1024 * 1024)])).toMatch(/4\.0 MB together; at most 3\.5 MB/)
    expect(sizeRefusal([f('a.kicad_sch', 1), f('a.kicad_sch', 2)])).toMatch(/named twice/)
  })

  it('its title and branch', () => {
    expect(handinTitle(['hardware/power.kicad_sch'])).toBe('Hand in: power.kicad_sch')
    expect(handinTitle(['a', 'b', 'c'])).toBe('Hand in: 3 files')
    expect(handinBranch('acme/edits', ['hardware/power.kicad_sch'], 36)).toBe('trace/handin-power-10')
    expect(handinBranch('acme/edits', ['a', 'b'], 35)).toBe('trace/handin-edits-z')
  })
})

describe('design.handin', () => {
  it('commits the changed files once, leaves the same ones out, opens the change and records the edit', async () => {
    github.pulls = []
    const r = await run(USER, 'design.handin', {
      repo: REPO, note: 'Moved the regulator @someone',
      files: [
        { path: 'hardware/power.kicad_sch', base64: b64('(kicad_sch (power v2))') },
        { path: 'hardware/board.kicad_sch', base64: b64('(kicad_sch (version 1))') },
        { path: 'hardware/usb.kicad_sch', base64: b64('(kicad_sch (usb))') },
      ],
    })
    expect(r).toMatchObject({ change: 101, changed: ['hardware/power.kicad_sch', 'hardware/usb.kicad_sch'], same: ['hardware/board.kicad_sch'] })
    expect(String(r.branch)).toMatch(/^trace\/handin-edits-[0-9a-z]+$/)
    expect(github.committed.at(-1)).toMatchObject({ base: 'main', files: ['hardware/power.kicad_sch', 'hardware/usb.kicad_sch'] })
    expect(github.pulls[0]).toMatchObject({ head: r.branch, base: 'main', title: 'Hand in: 2 files' })
    // the person's note is quoted and mentions nobody; their name, never their email
    expect(github.pulls[0]!.body).toMatch(/> Moved the regulator @‍someone/)
    expect(github.pulls[0]!.body).toMatch(/by Alex Lee/)
    expect(github.pulls[0]!.body).not.toMatch(/e-user@example\.com/)
    const edit = await editStore(ctx(USER)).get(REPO, String(r.branch))
    expect(edit).toMatchObject({ kind: 'handin', title: 'Hand in: 2 files', applies: 'auto', number: 101, by_name: 'Alex Lee', by_sub: USER.sub, commit: 'b'.repeat(40), redo: null })
    expect(github.files.get(`${REPO}:main:hardware/power.kicad_sch`)).toEqual(enc('(kicad_sch (power))'))
  })

  it('one file changed: titled by its name', async () => {
    github.pulls = []
    const r = await run(ADMIN, 'design.handin', { repo: REPO, files: [{ path: 'hardware/board.kicad_pcb', base64: b64('(kicad_pcb (moved))') }] })
    expect(github.pulls[0]?.title).toBe('Hand in: board.kicad_pcb')
    expect(String(r.branch)).toMatch(/^trace\/handin-board-/)
  })

  it('refuses plainly: nothing changed, a protected path, not KiCad, too large', async () => {
    await expect(run(USER, 'design.handin', { repo: REPO, files: [{ path: 'hardware/board.kicad_sch', base64: b64('(kicad_sch (version 1))') }] })).rejects.toThrow(/the same as the design: there is nothing to hand in/)
    await expect(run(USER, 'design.handin', { repo: REPO, files: [{ path: 'docs/rules/a.kicad_sch', base64: b64('x') }] })).rejects.toThrow(/steers trace itself/)
    await expect(run(USER, 'design.handin', { repo: REPO, files: [{ path: '.trace/project.kicad_pro', base64: b64('x') }] })).rejects.toThrow(/steers trace itself/)
    await expect(run(USER, 'design.handin', { repo: REPO, files: [{ path: 'hardware/notes.md', base64: b64('x') }] })).rejects.toThrow(/not a KiCad file/)
    const big = Buffer.alloc(MAX_HANDIN_FILE + 1, 65).toString('base64')
    await expect(run(USER, 'design.handin', { repo: REPO, files: [{ path: 'hardware/big.kicad_pcb', base64: big }] })).rejects.toThrow(ActionError)
  })

  it('needs write on the project (a reviewer cannot), and no connected system may call it', async () => {
    await expect(run(REVIEWER, 'design.handin', { repo: REPO, files: [{ path: 'hardware/x.kicad_sch', base64: b64('x') }] })).rejects.toThrow(AccessDenied)
    expect(SERVICE_ACTIONS).not.toHaveProperty('design.handin')
    expect(SERVICE_ACTIONS).not.toHaveProperty('files.edit')
  })
})

describe('files.edit', () => {
  it('the rules, pure: text files, protected paths refused except CLAUDE.md', () => {
    expect(editRefusal('CLAUDE.md', ['.trace/**', 'CLAUDE.md'])).toBeNull()
    expect(editRefusal('docs/guide.md', [])).toBeNull()
    expect(editRefusal('.github/workflows/ci.yml', [])).toMatch(/steers trace itself/)
    expect(editRefusal('docs/rules/a.md', ['docs/rules/**'])).toMatch(/steers trace itself/)
    expect(editRefusal('.trace/project.db', [])).toMatch(/not a file people edit/)
    expect(editRefusal('docs/logo.png', [])).toMatch(/not a text file/)
    expect(isText(enc('héllo'))).toBe(true)
    expect(isText(new Uint8Array([0x68, 0]))).toBe(false)
    expect(isText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false)
  })

  it('CLAUDE.md: one commit on trace/edit-…, the change opened and recorded as a prompt edit', async () => {
    github.pulls = []
    const r = await run(USER, 'files.edit', { repo: REPO, path: 'CLAUDE.md', text: '# Notes\n\nCeramic capacitors only.\n', note: 'house rule' })
    expect(String(r.branch)).toMatch(/^trace\/edit-claude-md-[0-9a-z]+$/)
    expect(r.change).toBe(101)
    expect(new TextDecoder().decode(github.files.get(`${REPO}:${String(r.branch)}:CLAUDE.md`))).toMatch(/Ceramic capacitors only/)
    expect(new TextDecoder().decode(github.files.get(`${REPO}:main:CLAUDE.md`))).toBe('# Notes\n')
    expect(github.pulls[0]).toMatchObject({ title: 'Edit CLAUDE.md', head: r.branch })
    expect(await editStore(ctx(USER)).get(REPO, String(r.branch))).toMatchObject({ kind: 'prompt', title: 'Edit CLAUDE.md', applies: 'review', number: 101 })
  })

  it('refuses the same text, a binary file, a protected path, more than 1 MB; needs write', async () => {
    await expect(run(USER, 'files.edit', { repo: REPO, path: 'CLAUDE.md', text: '# Notes\n' })).rejects.toThrow(/nothing to change/)
    await expect(run(USER, 'files.edit', { repo: REPO, path: 'docs/logo.png', text: 'x' })).rejects.toThrow(/not a text file/)
    await expect(run(USER, 'files.edit', { repo: REPO, path: '.github/workflows/ci.yml', text: 'x' })).rejects.toThrow(/steers trace itself/)
    await expect(run(USER, 'files.edit', { repo: REPO, path: 'docs/rules/r.md', text: 'x' })).rejects.toThrow(/steers trace itself/)
    await expect(run(USER, 'files.edit', { repo: REPO, path: 'notes.md', text: 'é'.repeat(600 * 1024) })).rejects.toThrow(/at most 1 MB/)
    await expect(run(USER, 'files.edit', { repo: REPO, path: '../x.md', text: 'x' })).rejects.toThrow()
    await expect(run(REVIEWER, 'files.edit', { repo: REPO, path: 'CLAUDE.md', text: 'x' })).rejects.toThrow(AccessDenied)
  })
})

describe('settings.set, prompts.set and journey.snapshot record their edit', () => {
  it('titles, pure', () => {
    expect(settingTitle('worker.max_attempts', { value: 3 }, 5)).toBe('worker.max_attempts: 3 → 5')
    expect(settingTitle('worker.max_attempts', null, 5)).toBe('worker.max_attempts set to 5')
    expect(settingTitle('worker.max_attempts', { value: 5 }, undefined)).toBe('worker.max_attempts: 5 → the default')
    expect(promptTitle({ op: 'set', id: 'specialist.report' }, 4)).toBe('Instruction specialist.report: version 4')
  })

  it('settings.set: a contributor\'s edit waits for an admin; an admin\'s applies itself', async () => {
    github.pulls = []
    const r = await run(USER, 'settings.set', { repo: REPO, key: 'worker.max_attempts', value: 5 })
    expect(r).toMatchObject({ key: 'worker.max_attempts', value: 5, change: 101 })
    expect(github.pulls[0]?.title).toBe('worker.max_attempts: 3 → 5')
    expect(await editStore(ctx(USER)).get(REPO, String(r.branch))).toMatchObject({
      kind: 'setting', applies: 'review', redo: { op: 'setting', key: 'worker.max_attempts', value: 5 }, commit: 'c0ffee0000000000000000000000000000000000',
    })
    const u = await run(ADMIN, 'settings.set', { repo: REPO, key: 'worker.max_attempts', unset: true })
    expect(u).toMatchObject({ unset: true, change: 102 })
    expect(await editStore(ctx(ADMIN)).get(REPO, String(u.branch))).toMatchObject({ applies: 'auto', title: 'worker.max_attempts: 3 → the default', redo: { op: 'setting', key: 'worker.max_attempts', unset: true } })
  })

  it('prompts.set (project): answers the change; prompts.get answers it as pending', async () => {
    github.pulls = []
    const r = await run(USER, 'prompts.set', { id: 'specialist.verify.workflow', scope: 'project', repo: REPO, text: 'WORKFLOW: read {{repository}}.', reason: 'our order' })
    expect(r).toMatchObject({ scope: 'project', version: 1, change: 101 })
    const edit = await editStore(ctx(USER)).get(REPO, String(r.branch))
    expect(edit).toMatchObject({ kind: 'prompt', applies: 'review', title: 'Instruction specialist.verify.workflow: version 1', redo: { op: 'prompt', write: { op: 'set', id: 'specialist.verify.workflow', text: 'WORKFLOW: read {{repository}}.', reason: 'our order' } } })
    const g = await run(REVIEWER, 'prompts.get', { repo: REPO, id: 'specialist.verify.workflow' })
    expect(g.pending).toMatchObject({ change: 101, branch: r.branch, version: 1, by_name: 'Alex Lee' })
    expect((await run(REVIEWER, 'prompts.get', { repo: REPO, id: 'specialist.report' })).pending).toBeUndefined()
  })

  it('journey.snapshot: the release copy is an edit of its own, made again on a newer default branch from its reason', async () => {
    await journeyStore(ctx(ADMIN), REPO).update((db) => { startJourney(db, { template: 'board', by: 'seed', name: 'Edits' }); return { result: null } })
    github.pulls = []
    const r = await run(ADMIN, 'journey.snapshot', { repo: REPO, reason: 'for the record' })
    expect(r).toMatchObject({ change: 101, branch: expect.stringMatching(/^trace\/release-a-/) })
    expect(github.pulls[0]?.title).toBe('The record of revision A')
    expect(await editStore(ctx(ADMIN)).get(REPO, String(r.branch))).toMatchObject({ kind: 'release', applies: 'auto', redo: { op: 'release', why: 'for the record' } })
  })
})
