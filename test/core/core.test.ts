import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Bridge } from '../../src/core/bridge.js'
import { workerPrompt } from '../../src/core/cloudworker.js'
import { ConfigError, changed, load, resolve, setValue, unset } from '../../src/core/config.js'
import { merge, mergeMain } from '../../src/core/dbmerge.js'
import { doctor } from '../../src/core/doctor.js'
import { callTool, offered } from '../../src/core/mcp.js'
import * as onboard from '../../src/core/onboard.js'
import { Registry, ToolError, defineTool } from '../../src/core/registry.js'
import { Cache, Work } from '../../src/core/store.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'trace-core-'))
function gitRepo(dir = join(tmp(), 'r')): string {
  mkdirSync(dir, { recursive: true })
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) execFileSync('git', args, { cwd: dir })
  return dir
}

describe('settings in the project database', () => {
  it('round-trips, validates and unsets', () => {
    const repo = gitRepo()
    expect(load(repo).prs.merge_method).toBe('merge')
    setValue('prs.merge_method', 'squash', repo)
    setValue('hil.serial', [{ name: 'dut', port: '/dev/ttyACM0' }], repo)
    const cfg = load(repo)
    expect(cfg.prs.merge_method).toBe('squash')
    expect(cfg.hil.serial[0]?.name).toBe('dut')
    expect(Object.keys(changed(repo)).sort()).toEqual(['hil.serial', 'prs.merge_method'])
    expect(() => setValue('prs.merge_methd', 'squash', repo)).toThrow(/unknown setting/)
    expect(() => setValue('worker.max_attempts', 'three', repo)).toThrow(/expected number/)
    expect(() => setValue('prs.merge_method', 'octopus', repo)).toThrow(ConfigError)
    expect(() => setValue('deploy.enabled', true, repo)).toThrow(/deploy.command/)
    expect(unset('prs.merge_method', repo)).toBe(true)
    expect(load(repo).prs.merge_method).toBe('merge')
    const db = new DatabaseSync(join(repo, '.trace', 'project.db'))
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()?.n).toBe(1)
    db.close()
  })

  it('normalises and reports like the actions see it', () => {
    const { config, errors } = resolve({ 'worker.escalate_to': 'marc', 'ci_doctor.flaky_patterns': ['('] })
    expect(errors.some((e) => e.includes('flaky_patterns'))).toBe(true)
    expect(resolve({ 'worker.escalate_to': 'marc' }).config.worker.escalate_to).toBe('@marc')
    expect(config.branch).toBe('main')
  })
})

describe('run record and cache', () => {
  it('records runs with measurements and artifacts', () => {
    const w = new Work(join(tmp(), 'p.db'))
    const id = w.start('sim.spice', { subject: 'rc', args: { r: 1000 } })
    w.measure(id, 'f3db_hz', 159.2, 'Hz')
    w.artifact(id, 'netlist.cir', 'R1 1 2 1k')
    w.finish(id, 'pass', 'ok', { f3db_hz: 159.2 })
    const r = w.run(id)
    expect(r?.status).toBe('pass')
    expect(r?.measurements[0]?.value).toBe(159.2)
    expect(new TextDecoder().decode(w.getArtifact(id, 'netlist.cir')!)).toBe('R1 1 2 1k')
    expect(w.runs('sim')).toHaveLength(1)
  })
  it('caches with expiry', () => {
    const c = new Cache(join(tmp(), 'c.db'))
    c.put('ns', 'k', { a: 1 }, { ttlSeconds: 60 })
    expect(c.get('ns', 'k')).toEqual({ a: 1 })
    c.put('ns', 'old', 1, { ttlSeconds: -1 })
    expect(c.get('ns', 'old')).toBeUndefined()
  })
})

describe('db merge driver', () => {
  it('unions runs and merges settings three ways', () => {
    const dir = tmp()
    const base = join(dir, 'base.db'); const ours = join(dir, 'ours.db'); const theirs = join(dir, 'theirs.db')
    const b = new Work(base)
    for (const [k, v] of [['branch', '"main"'], ['prs.merge_method', '"merge"'], ['worker.model', '"a"']] as const) b.db.prepare("INSERT INTO settings VALUES (?, ?, 0, 'x')").run(k, v)
    b.close()
    writeFileSync(ours, readFileSync(base)); writeFileSync(theirs, readFileSync(base))
    const o = new Work(ours); const t = new Work(theirs)
    const ro = o.start('kicad.drc'); o.finish(ro, 'pass')
    const rt = t.start('sim.spice'); t.measure(rt, 'x', 1); t.finish(rt, 'fail')
    o.db.exec(`UPDATE settings SET value='"squash"' WHERE key='prs.merge_method'`) // only we changed it
    t.db.exec(`UPDATE settings SET value='"develop"' WHERE key='branch'`)         // only they changed it
    o.db.exec(`UPDATE settings SET value='"b"' WHERE key='worker.model'`)         // both, differently
    t.db.exec(`UPDATE settings SET value='"c"' WHERE key='worker.model'`)
    o.close(); t.close()
    expect(merge(base, ours, theirs)).toEqual(['worker.model'])
    const m = new Work(ours)
    expect(new Set(m.runs().map((r) => r.id))).toEqual(new Set([ro, rt]))
    expect(m.run(rt)?.measurements[0]?.name).toBe('x')
    expect(Object.fromEntries(m.db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])))
      .toEqual({ branch: '"develop"', 'prs.merge_method': '"squash"', 'worker.model': '"b"' })
    m.close()
    expect(mergeMain([base, ours, theirs])).toBe(1)
  })
})

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
    steps: [{run: pytest}]
  lint:
    runs-on: ubuntu-latest
    steps: [{run: ruff}]
  gate:
    name: tests pass
    needs: [unit, lint]
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
`

describe('onboarding', () => {
  it('detects and writes for an existing repository, idempotently, with empty rules', async () => {
    const repo = gitRepo()
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), WORKFLOW)
    writeFileSync(join(repo, '.github', 'workflows', 'release.yml'), 'name: release\non:\n  release:\njobs:\n  x:\n    runs-on: x\n')
    mkdirSync(join(repo, 'hw'))
    writeFileSync(join(repo, 'hw', 'board.kicad_pro'), '')
    writeFileSync(join(repo, 'CLAUDE.md'), '# Existing notes\n')
    const d = await onboard.detect(repo, 'main')
    expect(d.build?.file).toBe('ci.yml')
    expect(d.build?.name).toBe('CI')
    expect(d.check).toBe('tests pass')
    expect(d.kicadProjects).toEqual(['hw/board.kicad_pro'])
    const written = onboard.writeFiles(repo, d, onboard.settingsFor(d, 'marc'), 'me/trace', 'v9')
    expect(written).toContain('.trace/project.db')
    expect(readFileSync(join(repo, '.trace', 'rules.md'), 'utf8')).toBe('') // the owner writes the rules
    const cfg = load(repo)
    expect(cfg.build).toEqual({ workflow: 'ci.yml', required_check: 'tests pass' })
    expect(cfg.electronics.projects).toEqual(['hw/board.kicad_pro'])
    expect(cfg.worker.escalate_to).toBe('@marc')
    const prs = readFileSync(join(repo, '.github', 'workflows', 'trace-prs.yml'), 'utf8')
    expect(prs).toContain('me/trace/harness/actions/run@v9')
    expect(prs).not.toContain('__TR_')
    expect(readFileSync(join(repo, '.github', 'workflows', 'trace-ci.yml'), 'utf8')).toContain('workflows: ["CI"]')
    expect(readFileSync(join(repo, '.gitattributes'), 'utf8')).toContain('merge=trace-db')
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8')
    expect(claude.startsWith('# Existing notes')).toBe(true)
    expect(claude).toContain(onboard.CLAUDE_MARKER)
    writeFileSync(join(repo, '.trace', 'rules.md'), 'Never touch the power stage without asking.\n')
    onboard.writeFiles(repo, await onboard.detect(repo, 'main'), {}, 'me/trace', 'v9')
    expect(readFileSync(join(repo, '.trace', 'rules.md'), 'utf8')).toMatch(/^Never touch/)
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').split(onboard.CLAUDE_MARKER)).toHaveLength(2)
    // The person escalated to owns what steers trace; rewriting keeps one trace section, after the repo's own lines.
    const owners = readFileSync(join(repo, '.github', 'CODEOWNERS'), 'utf8')
    expect(owners).toContain('/.github/ @marc')
    expect(owners).toContain('/.trace/ @marc')
    expect(owners).toMatch(/^CODEOWNERS @marc$/m)
    writeFileSync(join(repo, '.github', 'CODEOWNERS'), `* @someone\n${owners}`)
    expect(onboard.codeOwners(repo, load(repo))).toBeNull()
    expect(readFileSync(join(repo, '.github', 'CODEOWNERS'), 'utf8').startsWith('* @someone\n# trace')).toBe(true)
  })

  it('gives a repository without a build the starter for its language', async () => {
    const repo = gitRepo()
    writeFileSync(join(repo, 'pyproject.toml'), "[project]\nname='x'\n")
    const d = await onboard.detect(repo, 'main')
    expect(d.build).toBeNull()
    expect(d.language).toBe('python')
    onboard.writeFiles(repo, d, onboard.settingsFor(d))
    const build = readFileSync(join(repo, '.github', 'workflows', 'trace-build.yml'), 'utf8')
    expect(build).toContain('pytest')
    expect(build).toContain('name: tests pass')
    expect(load(repo).build).toEqual({ workflow: 'trace-build.yml', required_check: 'tests pass' })
  })

  it('runs the onboard flow with GitHub replaced: branch, commit, held PR, ruleset', async () => {
    const repo = gitRepo()
    writeFileSync(join(repo, 'README.md'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
    const calls: string[][] = []
    const run: onboard.Runner = (cmd, opts) => {
      calls.push([...cmd])
      if (cmd[0] === 'gh') return cmd[1] === 'pr' && cmd[2] === 'create' ? 'https://github.com/o/r/pull/1\n' : '[]'
      if (cmd[0] === 'git' && cmd[1] === 'push') return ''
      return onboard.runCommand(cmd, opts)
    }
    const r = await onboard.onboard('o/r', { path: repo, apply: true, run })
    expect(r.pr).toMatch(/\/pull\/1$/)
    expect(execFileSync('git', ['log', '--oneline', '-1', 'trace/onboard'], { cwd: repo, encoding: 'utf8' })).toMatch(/under trace/)
    expect(calls.find((c) => c[1] === 'pr' && c[2] === 'create')).toContain('no-automerge')
    expect(calls.some((c) => c[0] === 'gh' && c.includes('POST') && c.some((x) => x.includes('rulesets')))).toBe(true)
  })

  it('renders every scaffold', () => {
    const dir = tmp()
    for (const t of onboard.SCAFFOLDS) {
      const repo = join(dir, t)
      mkdirSync(repo)
      onboard.scaffold(repo, t, 'my-board')
      expect(readFileSync(join(repo, 'README.md'), 'utf8').startsWith('# my-board')).toBe(true)
      expect(existsSync(join(repo, '.gitignore'))).toBe(true)
    }
    expect(existsSync(join(dir, 'python', 'src', 'my_board', '__init__.py'))).toBe(true)
  })

  it('doctor reports what is missing', () => {
    const answers: Record<string, unknown> = {
      'repos/o/r': { default_branch: 'main', allow_auto_merge: true, delete_branch_on_merge: false },
      'repos/o/r/contents/.trace/rules.md?ref=main': { size: 0 },
      'repos/o/r/actions/secrets': { secrets: [{ name: 'TRACE_TOKEN' }] },
      'repos/o/r/actions/variables': { variables: [{ name: 'TRACE_AWS_ROLE' }] },
    }
    const run: onboard.Runner = (cmd) => {
      const a = answers[cmd[2] ?? '']
      if (a === undefined) throw new onboard.OnboardError('404')
      return JSON.stringify(a)
    }
    const f = Object.fromEntries(doctor('o/r', run).map((x) => [x.what, x.ok]))
    expect(f['auto-merge is allowed']).toBe(true)
    expect(f['merged branches are deleted']).toBe(false)
    expect(f['.trace/rules.md has rules']).toBe(false)
    expect(f['secret TRACE_TOKEN']).toBe(true)
    expect(f['model access for the worker']).toBe(true)
    expect(f['TRACE_HOME (the central database)']).toBe(false)
  })
})

describe('registry and MCP', () => {
  const reg = new Registry([
    defineTool({ name: 'test.echo', description: 'Echo the input.', input: z.object({ x: z.number() }), run: ({ x }) => {
      if (x < 0) throw new ToolError('x must not be negative')
      return { x }
    } }),
    defineTool({ name: 'test.relay', description: 'Close a relay.', input: z.object({}), hardware: true, run: () => ({ closed: true }) }),
  ])

  it('validates input and guards hardware', async () => {
    const ctx = { hardware: false, via: 'test' } as const
    expect(await reg.call('test.echo', { x: 2 }, ctx)).toEqual({ x: 2 })
    await expect(reg.call('test.echo', {}, ctx)).rejects.toThrow(/x/)
    await expect(reg.call('test.echo', { x: 1, y: 2 }, ctx)).rejects.toThrow(ToolError)
    await expect(reg.call('test.relay', {}, ctx)).rejects.toThrow(/drives real hardware/)
    expect(await reg.call('test.relay', {}, { hardware: true, via: 'test' })).toEqual({ closed: true })
    expect(Registry.jsonSchema(reg.get('test.echo')!)).toMatchObject({ type: 'object', properties: { x: { type: 'number' } } })
  })

  it('offers tools under MCP names, hardware only when allowed, errors as results', async () => {
    expect([...offered(reg, false).keys()]).toEqual(['test_echo'])
    expect([...offered(reg, true).keys()]).toEqual(['test_echo', 'test_relay'])
    const ok = await callTool(reg, 'test_echo', { x: 5 }, false)
    expect(ok.isError).toBe(false)
    expect(JSON.parse((ok.content[0] as { text: string }).text)).toEqual({ x: 5 })
    const bad = await callTool(reg, 'test_echo', { x: -1 }, false)
    expect(bad.isError).toBe(true)
    expect((await callTool(reg, 'test_relay', {}, false)).isError).toBe(true)
  })
})

describe('python bridge', () => {
  const py = existsSync('/home/claude/trace/.venv/bin/python') ? '/home/claude/trace/.venv/bin/python' : 'python3'
  it('answers bridge.status and reports unknown methods', async () => {
    const b = new Bridge(py)
    try {
      const s = await b.call('bridge.status', {}, z.object({ areas: z.record(z.string(), z.string()), methods: z.array(z.string()) }))
      expect(Object.keys(s.areas)).toContain('tracebridge.pdf')
      await expect(b.call('nope.nothing', {}, z.unknown())).rejects.toThrow(/no method/)
    } finally {
      b.close()
    }
  })
})

it('builds the cloud worker prompt for several projects', () => {
  const p = workerPrompt(['o/a', 'o/b'])
  expect(p).toContain('- o/a')
  expect(p).toContain('.trace/rules.md')
  expect(p).toContain('never push to a default branch')
})
