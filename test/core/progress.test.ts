/**
 * The progress channel (src/core/progress.ts): what a tool reports reaches the sink of the withProgress around it, and
 * nothing anywhere else; progress lines are throttled; chunked output becomes lines.
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PROGRESS_EVERY_MS, forwardOutput, lineSplitter, progressOpen, reportLine, reportOutput, reportProgress, withProgress } from '../../src/core/progress.js'
import { run as runProc } from '../../src/tools/sim/proc.js'
import { run as runFirmware } from '../../src/tools/firmware/run.js'
import { runProgram } from '../../src/tools/kicad/project.js'

const collect = (): { lines: string[]; sink: { line(t: string): void } } => {
  const lines: string[] = []
  return { lines, sink: { line: (t) => { lines.push(t) } } }
}

describe('withProgress, reportLine, reportProgress', () => {
  it('does nothing outside a channel', () => {
    expect(progressOpen()).toBe(false)
    expect(() => { reportLine('x'); reportProgress(0.5, 'y'); reportOutput('z') }).not.toThrow()
    expect(forwardOutput()).toBeNull()
  })

  it('reaches the sink through awaits, trims, and skips empty lines and colours', async () => {
    const { lines, sink } = collect()
    const r = await withProgress(sink, async () => {
      reportLine('  first  ')
      await new Promise((res) => setTimeout(res, 1))
      reportLine('')
      reportLine('   ')
      reportLine('\x1b[31mred\x1b[0m')
      await Promise.resolve()
      reportLine('last')
      return 42
    })
    expect(r).toBe(42)
    expect(lines).toEqual(['first', 'red', 'last'])
    // and nothing after it ends
    reportLine('after')
    expect(lines).toHaveLength(3)
  })

  it('keeps two channels apart', async () => {
    const a = collect()
    const b = collect()
    await Promise.all([
      withProgress(a.sink, async () => { reportLine('a1'); await new Promise((r) => setTimeout(r, 5)); reportLine('a2') }),
      withProgress(b.sink, async () => { reportLine('b1'); await new Promise((r) => setTimeout(r, 1)); reportLine('b2') }),
    ])
    expect(a.lines).toEqual(['a1', 'a2'])
    expect(b.lines).toEqual(['b1', 'b2'])
  })

  it('writes progress as "62% · text", throttled to one line per PROGRESS_EVERY_MS but 100% always', () => {
    const { lines, sink } = collect()
    let t = 1_000
    withProgress(sink, () => {
      reportProgress(0.623, 'meshing   the board')
      for (let i = 0; i < 50; i++) { t += 10; reportProgress(0.63 + i / 1000, 'spam') }
      t += PROGRESS_EVERY_MS
      reportProgress(0.8)
      reportProgress(1, 'done')
      reportProgress(Number.NaN)
      reportProgress(-3, 'below')
    }, { now: () => t })
    expect(lines[0]).toBe('62% · meshing the board')
    // 50 calls over 500 ms: at most one more line in that window
    expect(lines.filter((l) => l.includes('spam')).length).toBeLessThanOrEqual(1)
    expect(lines).toContain('80%')
    expect(lines).toContain('100% · done')
    expect(lines.some((l) => l.includes('below'))).toBe(false)
  })

  it('never lets a sink failure reach the tool', () => {
    expect(() => withProgress({ line: () => { throw new Error('sink broke') } }, () => { reportLine('x'); reportProgress(1) })).not.toThrow()
  })

  it('reportOutput gives a finished program\'s last lines', () => {
    const { lines, sink } = collect()
    withProgress(sink, () => reportOutput(Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n'), 3))
    expect(lines).toEqual(['… 2 earlier lines', 'l2', 'l3', 'l4'])
  })
})

describe('lineSplitter', () => {
  it('turns chunks into lines across chunk boundaries, CRLF and bare CR', () => {
    const out: string[] = []
    const s = lineSplitter((l) => out.push(l))
    s.push('hel')
    s.push('lo\nwor')
    s.push('ld\r\n')
    s.push('50%\r60%\rend')
    expect(out).toEqual(['hello', 'world', '50%', '60%'])
    s.push(new TextEncoder().encode(' bytes\n'))
    expect(out).toEqual(['hello', 'world', '50%', '60%', 'end bytes'])
    s.push('tail without newline')
    s.end()
    expect(out).toEqual(['hello', 'world', '50%', '60%', 'end bytes', 'tail without newline'])
  })

  it('keeps a CR that ends a chunk until it knows whether LF follows', () => {
    const out: string[] = []
    const s = lineSplitter((l) => out.push(l))
    s.push('a\r')
    s.push('\nb\n')
    expect(out).toEqual(['a', 'b'])
  })

  it('splits UTF-8 across byte chunks, and cuts a line longer than its maximum', () => {
    const out: string[] = []
    const s = lineSplitter((l) => out.push(l), 4)
    const b = new TextEncoder().encode('é✓\n')
    s.push(b.slice(0, 1))
    s.push(b.slice(1))
    s.push('abcdefghij\n')
    expect(out).toEqual(['é✓', 'abcd', 'efgh', 'ij'])
  })
})

describe('the process helpers report each line of their output', () => {
  it('src/tools/sim/proc.ts run: same result, and its stdout and stderr lines as they come', async () => {
    const { lines, sink } = collect()
    const r = await withProgress(sink, () => runProc('/bin/sh', ['-c', 'echo one; echo two 1>&2; printf three'], { timeoutMs: 10_000 }))
    expect(r).toMatchObject({ code: 0, stdout: 'one\nthree', stderr: 'two\n' })
    expect(lines.sort()).toEqual(['one', 'three', 'two'])
    // outside a channel: the same result, nothing reported
    const again = await runProc('/bin/sh', ['-c', 'echo one'], { timeoutMs: 10_000 })
    expect(again.stdout).toBe('one\n')
  })

  it('src/tools/firmware/run.ts run', async () => {
    const { lines, sink } = collect()
    const r = await withProgress(sink, () => runFirmware('echo built; echo warn >&2', { cwd: process.cwd(), timeoutMs: 10_000 }))
    expect(r.code).toBe(0)
    expect(r.output).toContain('built')
    expect(lines.sort()).toEqual(['built', 'warn'])
  })

  it('src/tools/kicad/project.ts runProgram (the kicad-cli runner)', async () => {
    const { lines, sink } = collect()
    const r = await withProgress(sink, () => runProgram('/bin/sh', ['-c', 'echo erc; echo drc 1>&2']))
    expect(r).toEqual({ code: 0, stdout: 'erc\n', stderr: 'drc\n' })
    expect(lines.sort()).toEqual(['drc', 'erc'])
  })

  it('forwardOutput keeps the channel it was made in, whatever context the child\'s events fire in', async () => {
    const { lines, sink } = collect()
    const fwd = withProgress(sink, () => forwardOutput())
    expect(fwd).not.toBeNull()
    await new Promise<void>((res) => {
      const c = spawn('/bin/sh', ['-c', 'echo late'])
      c.stdout.on('data', (d: Buffer) => fwd?.stdout.push(d))
      c.on('close', () => { fwd?.end(); res() })
    })
    expect(lines).toEqual(['late'])
  })
})
