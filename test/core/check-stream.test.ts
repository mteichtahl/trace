/**
 * A check's own stream on a CodeBuild runner (src/core/check-stream.ts): named only when every variable is there, and
 * what the process prints is copied to it, line by line, while still printed.
 */
import { describe, expect, it } from 'vitest'
import { checkLogFromEnv, checkStreamFromEnv, teeCheckOutput } from '../../src/core/check-stream.js'
import type { LogEvent, LogsApi } from '../../src/core/cw-writer.js'
import { parseStream } from '../../src/core/run-logs.js'

const ENV = {
  TRACE_RUNS_LOG_GROUP: '/trace/t/runs', CODEBUILD_BUILD_ID: 'trace-ci-1234abcd:5678', GITHUB_REPOSITORY: 'MTeichtahl/Potroller',
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'check',
}

function fakeLogs(): LogsApi & { events: (LogEvent & { stream: string })[] } {
  const events: (LogEvent & { stream: string })[] = []
  return {
    events,
    createLogStream: async () => undefined,
    putLogEvents: async (i) => { for (const e of i.logEvents) events.push({ ...e, stream: i.logStreamName }) },
  }
}

describe('checkStreamFromEnv', () => {
  it('names gha/<owner>/<repo>/<run>/<attempt>/<job> (the repository lower case), which the API parses back', () => {
    const s = checkStreamFromEnv(ENV)
    expect(s).toBe('gha/mteichtahl/potroller/123456/2/check')
    expect(parseStream(s ?? '')).toEqual({ kind: 'check', repo: 'mteichtahl/potroller', runId: '123456', attempt: '2', job: 'check' })
  })

  it('is null without any one of them: on GitHub\'s runners, or a runner without the group', () => {
    for (const k of Object.keys(ENV)) expect(checkStreamFromEnv({ ...ENV, [k]: '' }), k).toBeNull()
    expect(checkStreamFromEnv({ ...ENV, GITHUB_RUN_ID: 'x' })).toBeNull()
    expect(checkStreamFromEnv({ ...ENV, GITHUB_REPOSITORY: 'no-slash' })).toBeNull()
    expect(checkStreamFromEnv({})).toBeNull()
  })
})

describe('checkLogFromEnv', () => {
  it('writes lines to the check\'s stream and sends them on close', async () => {
    const api = fakeLogs()
    const log = checkLogFromEnv(ENV, { api })
    expect(log?.stream).toBe('gha/mteichtahl/potroller/123456/2/check')
    log?.write('▸ ERC on hardware/board')
    log?.write('   ')
    log?.write('✓ ok   kicad.erc hardware/board.kicad_pro: 0 errors, 0 warnings  ')
    await log?.close()
    expect(api.events.map((e) => [e.stream, e.message])).toEqual([
      ['gha/mteichtahl/potroller/123456/2/check', '▸ ERC on hardware/board'],
      ['gha/mteichtahl/potroller/123456/2/check', '✓ ok   kicad.erc hardware/board.kicad_pro: 0 errors, 0 warnings'],
    ])
    expect(checkLogFromEnv({}, { api })).toBeNull()
  })
})

describe('teeCheckOutput', () => {
  it('copies stdout and stderr to the stream while still printing them, and stops on close', async () => {
    const api = fakeLogs()
    const printed: string[] = []
    const stdout = process.stdout.write
    const stderr = process.stderr.write
    // what reaches the terminal, underneath the tee
    process.stdout.write = ((c: string | Uint8Array) => { printed.push(String(c)); return true }) as typeof process.stdout.write
    process.stderr.write = ((c: string | Uint8Array) => { printed.push(String(c)); return true }) as typeof process.stderr.write
    try {
      const tee = teeCheckOutput(ENV, { api })
      expect(tee?.stream).toBe('gha/mteichtahl/potroller/123456/2/check')
      // a second one while the first is open is refused (one tee per process)
      expect(teeCheckOutput(ENV, { api })).toBeNull()
      process.stdout.write('▸ DRC on hardware/board\npart')
      process.stdout.write('ial line\n')
      process.stderr.write('warning: something\n')
      process.stdout.write('no newline at the end')
      await tee?.close()
      process.stdout.write('after close\n')
    } finally {
      process.stdout.write = stdout
      process.stderr.write = stderr
    }
    expect(printed.join('')).toContain('▸ DRC on hardware/board\npartial line\n')
    expect(printed.join('')).toContain('after close')
    expect(api.events.map((e) => e.message).sort()).toEqual(['no newline at the end', 'partial line', 'warning: something', '▸ DRC on hardware/board'].sort())
  })

  it('does nothing where checks write no stream', () => {
    const before = process.stdout.write
    expect(teeCheckOutput({})).toBeNull()
    expect(process.stdout.write).toBe(before)
  })
})
