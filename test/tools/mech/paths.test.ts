/**
 * The mech tools' files stay in the repository (src/tools/mech/paths.ts): no symbolic link is read or written through,
 * nothing outside the repository or under .git/ is touched, and case.json's paths are relative. The symlink cases are
 * the reviewer's sl/ reproduction: a handed-in file linked to a file outside, a mechanical/case.py linked outside, and a
 * STEP linked to /proc/self/environ.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ToolError } from '../../../src/core/registry.js'
import { isRepoRelative, repoFile, writeRepoFile } from '../../../src/tools/mech/paths.js'
import { CaseSettingsSchema, defaults, readSettings, writeSettings } from '../../../src/tools/mech/settings.js'
import { allTools } from '../../../src/tools/index.js'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SAMPLE = join(ROOT, 'templates', 'sample', 'hardware', 'trace-sample.kicad_pcb')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mech-paths-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** sl/: repo/ beside outside/, with links from the one into the other. */
function slRepro(): { repo: string; outside: string } {
  const base = mkdtempSync(join(dir, 'sl-'))
  const repo = join(base, 'repo')
  const outside = join(base, 'outside')
  mkdirSync(join(repo, 'mechanical'), { recursive: true })
  mkdirSync(join(repo, 'hardware'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'creds'), 'SECRET=abc\n')
  writeFileSync(join(outside, 'target'), "print('pwn')\n")
  writeFileSync(join(repo, 'payload.py'), "print('pwn')\n")
  symlinkSync('../outside/creds', join(repo, 'evil.py'))
  symlinkSync('/proc/self/environ', join(repo, 'env.step'))
  for (const ext of ['kicad_pcb', 'kicad_pro', 'kicad_sch']) copyFileSync(SAMPLE.replace('kicad_pcb', ext), join(repo, 'hardware', `trace-sample.${ext}`))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeSettings(repo, defaults('hardware/trace-sample.kicad_pcb'))
  return { repo, outside }
}

describe('repository paths', () => {
  it('are relative, with no ".." or "." segment, no backslash and nothing absolute', () => {
    for (const ok of ['hardware/x.kicad_pcb', 'mechanical/my-case.step', 'a']) expect(isRepoRelative(ok), ok).toBe(true)
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'C:/x', './a', 'a//b', '']) expect(isRepoRelative(bad), bad).toBe(false)
  })

  it('refuse a symbolic link, a path that leads out through a linked folder, and .git/', () => {
    const { repo, outside } = slRepro()
    expect(() => repoFile(repo, 'evil.py')).toThrow(/evil\.py.* is a symbolic link/)
    expect(() => repoFile(repo, join(outside, 'creds'))).toThrow(/outside the repository/)
    expect(() => repoFile(repo, '../outside/creds')).toThrow(/outside the repository/)
    symlinkSync(outside, join(repo, 'linked'))
    expect(() => repoFile(repo, 'linked/new.py')).toThrow(/resolves outside the repository/)
    expect(() => writeRepoFile(repo, 'linked/new.py', 'x')).toThrow(ToolError)
    expect(() => repoFile(repo, '.git/config')).toThrow(/inside \.git/)
    expect(repoFile(repo, 'mechanical/new.py').rel).toBe('mechanical/new.py')
  })

  it('case.json: board and file are repository paths', () => {
    expect(CaseSettingsSchema.safeParse({ board: '../x.kicad_pcb' }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: '/etc/x.kicad_pcb' }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', source: 'file', file: '../x.step' }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', source: 'file', file: 'mechanical\\x.step' }).success).toBe(false)
    const repo = mkdtempSync(join(dir, 'cj-'))
    mkdirSync(join(repo, 'mechanical'))
    writeFileSync(join(repo, 'mechanical', 'case.json'), JSON.stringify({ board: 'hardware/../../x.kicad_pcb' }))
    expect(() => readSettings(repo)).toThrow(/mechanical\/case\.json: board: a path relative to the repository's root/)
    writeFileSync(join(repo, 'mechanical', 'case.json'), JSON.stringify({ board: 'b', source: 'file', file: '../x' }))
    expect(() => readSettings(repo)).toThrow(/file: a path relative/)
  })
})

describe('the mech tools on the sl/ reproduction', () => {
  type Dict = Record<string, any>
  const reg = allTools()
  const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
  const inRepo = async <T>(repo: string, f: () => Promise<T>): Promise<T> => {
    const cwd = process.cwd()
    process.chdir(repo)
    try {
      return await f()
    } finally {
      process.chdir(cwd)
    }
  }

  it('mech.hand_in refuses a source linked to a file outside, and to /proc/self/environ', async () => {
    const { repo } = slRepro()
    await inRepo(repo, async () => {
      await expect(call('mech.hand_in', { path: 'evil.py' })).rejects.toThrow(/the handed-in file \(evil\.py\) is a symbolic link/)
      await expect(call('mech.hand_in', { path: 'env.step' })).rejects.toThrow(/the handed-in file \(env\.step\) is a symbolic link/)
      await expect(call('mech.hand_in', { path: '../outside/creds' })).rejects.toThrow(/outside the repository/)
    })
  })

  it('mech.hand_in refuses a destination case.py linked outside, and leaves the target as it was', async () => {
    const { repo, outside } = slRepro()
    symlinkSync('../../outside/target', join(repo, 'mechanical', 'case.py'))
    await inRepo(repo, async () => {
      await expect(call('mech.hand_in', { path: 'payload.py' })).rejects.toThrow(/mechanical\/case\.py is a symbolic link/)
    })
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe("print('pwn')\n")
  })

  it('mech.init with replace refuses a linked case.py; writeSettings refuses a linked case.json', async () => {
    const { repo, outside } = slRepro()
    symlinkSync('../../outside/target', join(repo, 'mechanical', 'case.py'))
    await inRepo(repo, async () => {
      await expect(call('mech.init', { replace: true })).rejects.toThrow(/is a symbolic link/)
    })
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe("print('pwn')\n")
    rmSync(join(repo, 'mechanical', 'case.json'))
    symlinkSync('../../outside/creds', join(repo, 'mechanical', 'case.json'))
    expect(() => writeSettings(repo, defaults('b'))).toThrow(/is a symbolic link/)
    expect(readFileSync(join(outside, 'creds'), 'utf8')).toBe('SECRET=abc\n')
  })

  it('mech.build refuses a linked mechanical/out (nothing is removed or written through it)', async () => {
    const { repo, outside } = slRepro()
    writeFileSync(join(outside, 'case.step'), 'keep')
    symlinkSync(outside, join(repo, 'mechanical', 'out'))
    // the build needs the engine only after its paths are checked; a linked out/ is refused before any write either way
    await inRepo(repo, async () => {
      await expect(call('mech.build', { formats: ['step'] })).rejects.toThrow(/mechanical\/out is a symbolic link/)
    })
    expect(readFileSync(join(outside, 'case.step'), 'utf8')).toBe('keep')
  }, 240_000)

  it('mech.settings and mech.init store the material as the capabilities spell it, and warn of refs not on the board', async () => {
    const { repo } = slRepro()
    await inRepo(repo, async () => {
      const init = await call('mech.init', { replace: true, process: { service: 'JLC3DP', process: 'mjf', material: 'pa12s' }, reason: 'a cheaper powder' })
      expect(init.settings.process).toEqual({ service: 'jlc3dp', process: 'MJF', material: 'PA12S' })
      const back = await call('mech.settings', { set: [{ path: 'process.material', value: 'pa12-hp' }] })
      expect(back.settings.process.material).toBe('PA12-HP')
      expect(back.settings.reasons['process.material']).toBeUndefined()
      const w = await call('mech.settings', { clearance: [{ ref: 'J99', mm: 2, reason: 'a plug' }], set: [{ path: 'openings.skip', value: ['J1', 'X7'], reason: 'debug only' }] })
      expect(w.warnings).toEqual([
        'clearance for J99: J99 is not a part on hardware/trace-sample.kicad_pcb (it is kept; check the reference)',
        'openings.skip names X7: X7 is not a part on hardware/trace-sample.kicad_pcb (it is kept; check the reference)',
      ])
      expect(w.settings.clearance.parts.J99).toEqual({ mm: 2, reason: 'a plug' })
      await expect(call('mech.settings', { set: [{ path: 'params.standoff_d_mm', value: 0, reason: 'none' }] })).rejects.toThrow(/standoff_d_mm/)
    })
  })
})
