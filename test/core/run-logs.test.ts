/**
 * The run logs' shared contract (src/core/run-logs.ts) and the quiet profiles (src/core/quiet.ts): stream names both
 * ways, run refs, line marks, secrets masked, GitHub's log read, each step's longest silence, and learning it once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { backendFor } from '../../src/core/central.js'
import { emptyQuiet, learn, learnQuiet, quietStepKey, readQuiet, usualQuietS } from '../../src/core/quiet.js'
import {
  DEFAULT_QUIET_S, TOOL_RUN_ID, checkStream, currentStep, githubLogLines, jobStream, markOf, maskSecrets, newToolRunId, parseRunRef, parseStream,
  stepGaps, stepName, toLogLine, toolStream,
} from '../../src/core/run-logs.js'

describe('streams and runs', () => {
  it('names each kind of run and reads the name back', () => {
    expect(parseStream(jobStream('acme/soil', 'job-mf1-ab12'))).toEqual({ kind: 'job', repo: 'acme/soil', id: 'job-mf1-ab12' })
    expect(parseStream(toolStream('acme/soil', 't1abc'))).toEqual({ kind: 'tool', repo: 'acme/soil', id: 't1abc' })
    expect(parseStream(checkStream('acme/soil', 123, 2, 'check'))).toEqual({ kind: 'check', repo: 'acme/soil', runId: '123', attempt: '2', job: 'check' })
  })
  it('ignores streams trace did not name', () => {
    expect(parseStream('a1b2c3d4-0000-1111-2222-333344445555')).toBeNull()
    expect(parseStream('job/acme/soil')).toBeNull()
    expect(parseStream('gha/acme/soil/x/1/check')).toBeNull()
  })
  it('parses run refs, and only numbers for checks', () => {
    expect(parseRunRef('job:abc.job-1')).toEqual({ kind: 'job', id: 'abc.job-1' })
    expect(parseRunRef('check:42')).toEqual({ kind: 'check', id: '42' })
    expect(parseRunRef('check:x')).toBeNull()
    expect(parseRunRef('nope:1')).toBeNull()
  })
  it('makes tool run ids that sort by time', () => {
    const a = newToolRunId(1_700_000_000_000, () => 'aaaaaaaa')
    const b = newToolRunId(1_700_000_005_000, () => '00000000')
    expect(a < b).toBe(true)
    expect(TOOL_RUN_ID.test(a)).toBe(true)
    expect(TOOL_RUN_ID.test(newToolRunId())).toBe(true)
  })
})

describe('lines', () => {
  it('marks steps, passes, warnings and failures', () => {
    expect(markOf('▸ Design rule check')).toBe('step')
    expect(markOf('##[group]Run tracectl check')).toBe('step')
    expect(markOf('✓ parity: 62 of 62 nets match')).toBe('ok')
    expect(markOf('⚠ silkscreen over mask')).toBe('warn')
    expect(markOf('warning: unused variable')).toBe('warn')
    expect(markOf('error[E0425]: cannot find value')).toBe('error')
    expect(markOf('##[error]Process completed with exit code 1.')).toBe('error')
    expect(markOf('drc: 412 of 2,480 items checked')).toBeNull()
    expect(stepName('▸ Load the board')).toBe('Load the board')
    expect(stepName('##[group]Run actions/checkout')).toBe('Run actions/checkout')
  })
  it('masks tokens, keys and passwords', () => {
    const t = 'token ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP'
    expect(maskSecrets(t)).not.toMatch(/ghp_|AKIA/)
    expect(maskSecrets('password=hunter2xyz ok')).toBe('password=•••••• ok')
    expect(maskSecrets('"api_key": "sk-live-1234567890abcdef1234"')).not.toContain('1234567890')
    expect(maskSecrets('Authorization: Bearer abc.def.ghijklmnopqrstu')).not.toContain('ghijklmnop')
    expect(maskSecrets('git clone https://x-access-token:secretvalue@github.com/a/b')).toBe('git clone https://••••••@github.com/a/b')
    expect(maskSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('a private key')
    expect(maskSecrets('drc: 412 of 2,480 items checked')).toBe('drc: 412 of 2,480 items checked')
  })
  it('gives the app a masked, marked line', () => {
    const l = toLogLine(Date.parse('2026-11-03T10:00:00Z'), '✗ token=ghp_abcdefghijklmnopqrstuvwxyz')
    expect(l).toEqual({ at: '2026-11-03T10:00:00.000Z', text: expect.not.stringContaining('ghp_') as unknown as string, mark: 'error' })
  })
  it('reads GitHub\'s own log: stamps, colours, groups', () => {
    const lines = githubLogLines([
      '2026-11-03T01:00:00.1234567Z ##[group]Run kicad-cli sch erc',
      '2026-11-03T01:00:01.0000000Z \x1b[31mERC: pin 4 of U3\x1b[0m',
      '2026-11-03T01:00:02.0000000Z ##[endgroup]',
      '2026-11-03T01:00:03.0000000Z ##[error]Process completed with exit code 1.',
    ].join('\n'))
    expect(lines.map((l) => [l.at, l.text, l.mark])).toEqual([
      ['2026-11-03T01:00:00.123Z', '##[group]Run kicad-cli sch erc', 'step'],
      ['2026-11-03T01:00:01.000Z', 'ERC: pin 4 of U3', null],
      ['2026-11-03T01:00:03.000Z', '##[error]Process completed with exit code 1.', 'error'],
    ])
  })
})

describe('quiet', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 10, 3, 10, 0, s)).toISOString()
  const run = [
    { at: at(0), text: '▸ Load the board' }, { at: at(5), text: 'loaded' },
    { at: at(6), text: '▸ Design rule check' }, { at: at(46), text: 'drc: 412' }, { at: at(50), text: 'drc: 980' },
  ]
  it('finds each step\'s longest silence and the step it is in', () => {
    expect(stepGaps(run)).toEqual({ 'Load the board': 5, 'Design rule check': 40 })
    expect(currentStep(run)).toBe('Design rule check')
  })
  it('learns a run once, and says the usual from enough samples', () => {
    const k = quietStepKey('check', 'Board checks', 'Design rule check')
    let p = learn(emptyQuiet(), 'check:1', 'check', 'Board checks', { 'Design rule check': 40 })
    expect(learn(p, 'check:1', 'check', 'Board checks', { 'Design rule check': 999 })).toBe(p)
    expect(usualQuietS(p, k)).toBe(DEFAULT_QUIET_S)
    p = learn(p, 'check:2', 'check', 'Board checks', { 'Design rule check': 60 })
    expect(usualQuietS(p, k)).toBe(75)
    expect(usualQuietS(learn(learn(emptyQuiet(), 'a', 'tool', 'x', { s: 1 }), 'b', 'tool', 'x', { s: 2 }), quietStepKey('tool', 'x', 's'))).toBe(20)
  })
  const dir = mkdtempSync(join(tmpdir(), 'trace-quiet-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('keeps the profile in the store, written conditionally', async () => {
    const store = backendFor(dir)
    expect(await learnQuiet(store, 'acme/soil', 'job:1', 'job', 'impl', { Starting: 30 })).toBe(true)
    expect(await learnQuiet(store, 'acme/soil', 'job:1', 'job', 'impl', { Starting: 30 })).toBe(false)
    expect(await learnQuiet(store, 'acme/soil', 'job:2', 'job', 'impl', { Starting: 50 })).toBe(true)
    const p = await readQuiet(store, 'acme/soil')
    expect(p.steps[quietStepKey('job', 'impl', 'Starting')]).toEqual([30, 50])
    expect(p.seen).toEqual(['job:1', 'job:2'])
  })
})
