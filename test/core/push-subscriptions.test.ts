import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MAX_DEVICES, PushSubscriptionSchema, addDevice, deviceList, devicesOf, removeDevice, validZone } from '../../src/core/push-subscriptions.js'

const SCHEMA = `CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, tz TEXT, label TEXT, created REAL NOT NULL)`
const sub = (n: number) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } })

describe('push devices', () => {
  it('keeps a person\'s devices, newest first, at most MAX_DEVICES, never showing their keys', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    for (let i = 0; i < MAX_DEVICES + 2; i++) addDevice(db, 'u1', sub(i), { tz: 'Australia/Melbourne', label: 'iPhone · Safari', at: i })
    const list = deviceList(db, 'u1')
    expect(list).toHaveLength(MAX_DEVICES)
    expect(list[0]!.endpoint).toBe(`https://push.example.com/${MAX_DEVICES + 1}`)
    expect(JSON.stringify(list)).not.toContain('AAAA')
  })

  it('an endpoint another person had moves to whoever subscribes it now; only your own device can be removed', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    addDevice(db, 'u1', sub(1), { at: 1 })
    addDevice(db, 'u2', sub(1), { at: 2 })
    expect(devicesOf(db, ['u1'])).toEqual([])
    expect(removeDevice(db, 'u1', sub(1).endpoint)).toBe(false)
    expect(removeDevice(db, 'u2', sub(1).endpoint)).toBe(true)
  })

  it('reads nothing from a store from before push, and takes only known time zones', () => {
    expect(devicesOf(new DatabaseSync(':memory:'), ['u1'])).toEqual([])
    expect(validZone('Australia/Melbourne')).toBe('Australia/Melbourne')
    expect(validZone('Mars/Olympus')).toBeNull()
  })

  it('takes only an https endpoint and keys of the right shape', () => {
    expect(PushSubscriptionSchema.safeParse(sub(1)).success).toBe(true)
    expect(PushSubscriptionSchema.safeParse({ ...sub(1), endpoint: 'http://push.example.com/1' }).success).toBe(false)
    expect(PushSubscriptionSchema.safeParse({ ...sub(1), keys: { p256dh: 'short', auth: 'A'.repeat(22) } }).success).toBe(false)
  })
})
