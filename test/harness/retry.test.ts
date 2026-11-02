/** A GitHub read retries a gateway timeout or server error, and nothing else (src/harness/retry.ts). */
import { describe, expect, it } from 'vitest'
import { retried } from '../../src/harness/retry.js'

const failing = (statuses: (number | undefined)[], value = 'ok') => {
  let n = 0
  return { calls: () => n, read: async () => { const s = statuses[n++]; if (n <= statuses.length) throw Object.assign(new Error(`status ${s}`), s === undefined ? {} : { status: s }); return value } }
}
const waits: number[] = []
const sleep = async (ms: number) => { waits.push(ms) }

describe('retried', () => {
  it('retries a 504 (a large blob GitHub could not answer in time) and returns the read', async () => {
    waits.length = 0
    const r = failing([504, 502])
    expect(await retried(r.read, { sleep, waitMs: 10 })).toBe('ok')
    expect(r.calls()).toBe(3)
    expect(waits).toEqual([10, 20])
  })
  it('gives up after the tries, with the last error', async () => {
    const r = failing([503, 503, 503, 503])
    await expect(retried(r.read, { sleep, tries: 3 })).rejects.toThrow('status 503')
    expect(r.calls()).toBe(3)
  })
  it('throws a 4xx or an error without a status at once', async () => {
    const notFound = failing([404])
    await expect(retried(notFound.read, { sleep })).rejects.toMatchObject({ status: 404 })
    expect(notFound.calls()).toBe(1)
    const plain = failing([undefined])
    await expect(retried(plain.read, { sleep })).rejects.toThrow()
    expect(plain.calls()).toBe(1)
  })
})
