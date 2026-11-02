import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { prepareRecord, recordFingerprint } from '../../src/agents/runtime/record-guard.js'
import { RecordChanged, ToolRefused, recordChangedMessage, toolRunner } from '../../src/agents/runtime/tool.js'
import { Registry, defineTool } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'

// A tool through the API runs on a scratch clone that is never committed: one that changes the record must not answer
// as if it had saved anything (test-2: the chat's design.intent add answered "saved" and the record stayed empty).

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A clone with a project database holding one setting. */
const clone = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-guard-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.git')) // a clone: openProject finds its root by it
  const db = openProject(dir)
  db.prepare(`INSERT INTO settings (key, value, updated) VALUES ('test.marker', '"test-2"', 0)`).run()
  db.close()
  return dir
}

const write = (sql: string): void => {
  const db = openProject(process.cwd())
  try { db.exec(sql) } finally { db.close() }
}

const registry = new Registry([
  defineTool({ name: 'rec.read', description: 'reads', input: z.object({}), run: () => { const db = openProject(process.cwd()); const n = db.prepare('SELECT count(*) AS n FROM settings').get(); db.close(); return n } }),
  defineTool({ name: 'rec.add', description: 'writes the record', input: z.object({}), run: () => { write(`INSERT INTO settings (key, value, updated) VALUES ('intent.purpose', '"flash"', 0)`); return { added: ['INT-1'] } } }),
  defineTool({ name: 'rec.edit', description: 'changes a row', input: z.object({}), run: () => { write(`UPDATE settings SET value = '"other"' WHERE key = 'test.marker'`); return { ok: true } } }),
  defineTool({ name: 'rec.simulate', description: 'records its own run', input: z.object({}), run: () => { write("INSERT INTO runs (id, kind, started, status) VALUES ('r1', 'sim.spice', 0, 'pass')"); return { hz: 1.0 } } }),
])

const runner = (dir: string, guarded = true) => toolRunner({
  registry: () => registry,
  checkout: async () => ({ dir, cleanup: () => undefined }),
  ...(guarded ? { record: { prepare: prepareRecord, fingerprint: recordFingerprint } } : {}),
})

describe('record guard on API tool calls', () => {
  it('answers a read as before', async () => {
    expect(await runner(clone())({ kind: 'tool', repository: 'o/r', name: 'rec.read', args: {} })).toEqual({ n: 1 })
  })

  it('refuses a call that adds or changes record rows, saying nothing was saved and how to save it', async () => {
    for (const name of ['rec.add', 'rec.edit']) {
      const call = runner(clone())({ kind: 'tool', repository: 'o/r', name, args: {} })
      await expect(call).rejects.toBeInstanceOf(RecordChanged)
      await expect(runner(clone())({ kind: 'tool', repository: 'o/r', name, args: {} })).rejects.toBeInstanceOf(ToolRefused)
      await expect(runner(clone())({ kind: 'tool', repository: 'o/r', name, args: {} })).rejects.toThrow(recordChangedMessage(name))
    }
    expect(recordChangedMessage('design.intent')).toMatch(/nothing was saved.*start_task/s)
  })

  it('lets a tool record its own run: that is what a run through the API is for', async () => {
    expect(await runner(clone())({ kind: 'tool', repository: 'o/r', name: 'rec.simulate', args: {} })).toEqual({ hz: 1.0 })
  })

  it('without the guard, the old behaviour stands (tests and callers that do not ask for it)', async () => {
    expect(await runner(clone(), false)({ kind: 'tool', repository: 'o/r', name: 'rec.add', args: {} })).toEqual({ added: ['INT-1'] })
  })
})

describe('recordFingerprint', () => {
  it('is empty without a database, and unchanged by applying the schema again', () => {
    const empty = mkdtempSync(join(tmpdir(), 'trace-guard-'))
    dirs.push(empty)
    mkdirSync(join(empty, '.git'))
    expect(recordFingerprint(empty)).toBe('')
    prepareRecord(empty)
    expect(recordFingerprint(empty)).toBe('')
    const dir = clone()
    prepareRecord(dir)
    const a = recordFingerprint(dir)
    openProject(dir).close()
    expect(recordFingerprint(dir)).toBe(a)
  })
})
