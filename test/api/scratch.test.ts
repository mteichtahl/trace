// The API's per-request scratch (src/api/actions.ts defaultScratch) is the container's /tmp, never AgentCore's session
// storage: there every request's SQLite I/O went over its network file system (calls of minutes, the web app's 503s) and
// removing the temporary folders failed with ENOTEMPTY.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultScratch } from '../../src/api/actions.js'

describe("the API's scratch", () => {
  const was = process.env.TRACE_WORKSPACE
  afterEach(() => { if (was === undefined) delete process.env.TRACE_WORKSPACE; else process.env.TRACE_WORKSPACE = was })

  it('is under /tmp, with or without the session storage mounted', () => {
    delete process.env.TRACE_WORKSPACE
    expect(defaultScratch()).toBe(join(tmpdir(), 'trace-api'))
    process.env.TRACE_WORKSPACE = '/mnt/workspace'
    expect(defaultScratch()).toBe(join(tmpdir(), 'trace-api'))
    expect(defaultScratch().startsWith('/mnt/workspace')).toBe(false)
  })
})
