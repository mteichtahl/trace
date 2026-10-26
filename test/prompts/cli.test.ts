/**
 * `trace prompts …` locally (this clone's .trace/project.db, and --installation on the installation's store) and
 * `trace remote prompts …` (the same commands as API calls).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localBackend, runPrompts } from '../../src/prompts/cli.js'
import { InstallationPrompts, projectOverrides } from '../../src/prompts/store.js'
import { remotePrompts } from '../../src/login/prompts.js'

let stdout: string[] = []
let stderr: string[] = []
const cwd = process.cwd()
let root = ''
let installation: InstallationPrompts

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { stdout.push(String(s)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { stderr.push(String(s)); return true })
  root = mkdtempSync(join(tmpdir(), 'trace-prompts-cli-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.trace'))
  writeFileSync(join(root, '.trace', 'rules.md'), 'Ask before ordering parts.')
  process.chdir(root)
  // the test setup points TRACE_PROJECT_DB at a scratch database; here the clone's own is used
  delete process.env.TRACE_PROJECT_DB
  installation = new InstallationPrompts({ home: mkdtempSync(join(tmpdir(), 'trace-prompts-cli-home-')) })
})
afterEach(() => {
  process.chdir(cwd)
  vi.restoreAllMocks()
})

const run = (argv: string[]): Promise<number> => runPrompts(argv, localBackend(installation))
const text = (): string => stdout.join('')

describe('trace prompts (local)', () => {
  it('sets from a file, shows where each text comes from, keeps the history, diffs and reverts', async () => {
    const f = join(root, 'workflow.txt')
    writeFileSync(f, 'WORKFLOW:\n1. Check {{repository}} first.')
    expect(await run(['set', 'specialist.verify.workflow', '--file', f, '--reason', 'our order'])).toBe(0)
    expect(text()).toMatch(/set as project v1 .* Commit \.trace\/project\.db/)
    expect(projectOverrides(join(root, '.trace', 'project.db')).get('specialist.verify.workflow')?.text).toBe('WORKFLOW:\n1. Check {{repository}} first.')

    stdout = []
    expect(await run(['list'])).toBe(0)
    expect(text()).toMatch(/specialist\.verify\.workflow\s+editable\s+project v1/)
    expect(text()).toMatch(/specialist\.guardrails\s+locked\s+default/)

    stdout = []
    expect(await run(['get', 'specialist.verify.workflow'])).toBe(0)
    expect(text()).toContain('[editable specialist.verify.workflow · project v1]')
    expect(text()).toContain('[locked specialist.tools]')

    writeFileSync(f, 'WORKFLOW:\n1. Check {{repository}} last.')
    expect(await run(['set', 'specialist.verify.workflow', '--file', f, '--reason', 'changed my mind'])).toBe(0)
    stdout = []
    expect(await run(['history', 'specialist.verify.workflow'])).toBe(0)
    expect(text()).toMatch(/v1 .* set .* our order/)
    expect(text()).toMatch(/v2 .* set .* changed my mind/)

    stdout = []
    expect(await run(['diff', 'specialist.verify.workflow', 'v1', 'v2'])).toBe(0)
    expect(text()).toContain('- 1. Check {{repository}} first.')
    expect(text()).toContain('+ 1. Check {{repository}} last.')
    stdout = []
    expect(await run(['diff', 'specialist.verify.workflow'])).toBe(0)
    expect(text()).toMatch(/--- default\n\+\+\+ effective \(project v2\)/)

    expect(await run(['revert', 'specialist.verify.workflow', '1'])).toBe(0)
    expect(projectOverrides(join(root, '.trace', 'project.db')).get('specialist.verify.workflow')?.text).toBe('WORKFLOW:\n1. Check {{repository}} first.')

    stdout = []
    expect(await run(['preview', 'verify', '--marked'])).toBe(0)
    expect(text()).toContain('[editable specialist.verify.workflow · project v3')
    expect(text()).toContain('WORKFLOW:\n1. Check OWNER/REPO first.')
    expect(text()).toContain('<rules>\nAsk before ordering parts.\n</rules>')
    expect(text()).toMatch(/\[locked specialist\.guardrails · default · [0-9a-f]{12}\]\nGUARDRAILS/)

    expect(await run(['reset', 'specialist.verify.workflow'])).toBe(0)
    stdout = []
    await run(['list'])
    expect(text()).toMatch(/specialist\.verify\.workflow\s+editable\s+default/)
  })

  it('--installation writes the installation\'s store; refusals are printed with the bad variable', async () => {
    const f = join(root, 'r.txt')
    writeFileSync(f, 'Pick one specialist for {{repository}}.')
    expect(await run(['set', 'router.classify', '--file', f, '--reason', 'x', '--installation'])).toBe(1)
    expect(stderr.join('')).toMatch(/unknown variable \{\{repository\}\} \(it takes no variables\)/)
    writeFileSync(f, 'Pick one specialist.')
    expect(await run(['set', 'router.classify', '--file', f, '--reason', 'clearer', '--installation'])).toBe(0)
    expect(text()).toMatch(/set as installation v1/)
    expect((await installation.overrides()).get('router.classify')?.text).toBe('Pick one specialist.')
    expect(await run(['set', 'specialist.guardrails', '--file', f, '--reason', 'x'])).toBe(1)
    expect(stderr.join('')).toMatch(/locked/)
    expect(await run(['set', 'router.classify', '--file', f])).toBe(2)
    expect(await run(['nonsense'])).toBe(2)
  })
})

describe('trace remote prompts', () => {
  it('sends the same commands as prompts.* API calls, with --repo for a project and --installation for the installation', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const invoke = async (action: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push([action, args])
      if (action.startsWith('prompts.set') || action === 'prompts.reset' || action === 'prompts.revert') return { version: 2, uid: 'u1', action: 'set', branch: 'trace/prompts-x-1', commit: 'c0ffee' }
      if (action === 'prompts.history') return { history: [] }
      if (action === 'prompts.preview') return { text: 'T', marked: 'M' }
      return { prompts: [], problems: [] }
    }
    const f = join(root, 't.txt')
    writeFileSync(f, 'REPORT: short.')
    expect(await remotePrompts(['set', 'specialist.report', '--file', f, '--reason', 'R', '--repo', 'acme/board'], invoke)).toBe(0)
    expect(await remotePrompts(['reset', 'specialist.report', '--installation'], invoke)).toBe(0)
    expect(await remotePrompts(['revert', 'specialist.report', '2', '--repo', 'acme/board'], invoke)).toBe(0)
    expect(await remotePrompts(['revert', 'specialist.report', 'abc123', '--repo', 'acme/board'], invoke)).toBe(0)
    expect(await remotePrompts(['history', 'specialist.report', '--repo', 'acme/board'], invoke)).toBe(0)
    expect(await remotePrompts(['list', '--repo', 'acme/board'], invoke)).toBe(0)
    expect(await remotePrompts(['preview', 'verify', '--repo', 'acme/board', '--marked'], invoke)).toBe(0)
    expect(calls).toEqual([
      ['prompts.set', { id: 'specialist.report', scope: 'project', repo: 'acme/board', text: 'REPORT: short.', reason: 'R' }],
      ['prompts.reset', { id: 'specialist.report', scope: 'installation', reason: 'reset to the layer below' }],
      ['prompts.revert', { id: 'specialist.report', scope: 'project', repo: 'acme/board', version: 2 }],
      ['prompts.revert', { id: 'specialist.report', scope: 'project', repo: 'acme/board', version: 'abc123' }],
      ['prompts.history', { id: 'specialist.report', scope: 'project', repo: 'acme/board' }],
      ['prompts.list', { repo: 'acme/board' }],
      ['prompts.preview', { repo: 'acme/board', target: 'verify' }],
    ])
    expect(text()).toContain('committed to trace/prompts-x-1')
    expect(text()).toContain('M')
    // a project change without --repo is refused before any call
    calls.length = 0
    expect(await remotePrompts(['set', 'specialist.report', '--file', f, '--reason', 'R'], invoke)).toBe(2)
    expect(calls).toEqual([])
  })
})
