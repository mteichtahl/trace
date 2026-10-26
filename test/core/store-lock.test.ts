import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { setJournalMode } from '../../src/core/store.js'

// SQLite can answer "database is locked" to a journal-mode switch, or to reading the mode during WAL recovery,
// without calling the busy handler: several processes opening the same database at once then failed (seen in CI as
// the central store's concurrent-writers test). The switch now retries.
const fake = (failures: number, mode = 'delete'): { db: Pick<DatabaseSync, 'prepare' | 'exec'>; calls: string[] } => {
  let left = failures
  let current = mode
  const calls: string[] = []
  const busy = (): never => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }) }
  const db = {
    prepare: () => ({ get: () => { calls.push('read'); if (left > 0) { left--; busy() } return { journal_mode: current } } }),
    exec: (sql: string) => { calls.push(sql); current = /WAL/.test(sql) ? 'wal' : 'delete' },
  } as unknown as Pick<DatabaseSync, 'prepare' | 'exec'>
  return { db, calls }
}

describe('setJournalMode', () => {
  it('retries while the database is locked, then switches', () => {
    const f = fake(3)
    setJournalMode(f.db, 'wal')
    expect(f.calls.filter((c) => c === 'read')).toHaveLength(4)
    expect(f.calls.at(-1)).toBe('PRAGMA journal_mode=WAL')
  })

  it('takes no lock when the mode is already set', () => {
    const f = fake(0, 'wal')
    setJournalMode(f.db, 'wal')
    expect(f.calls).toEqual(['read'])
  })

  it('does not swallow other errors', () => {
    const db = { prepare: () => ({ get: () => { throw new Error('disk I/O error') } }), exec: () => undefined } as unknown as Pick<DatabaseSync, 'prepare' | 'exec'>
    expect(() => setJournalMode(db, 'wal')).toThrow(/disk I\/O/)
  })
})
