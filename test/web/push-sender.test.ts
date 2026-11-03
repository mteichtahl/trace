/**
 * Push notifications (src/web/push-sender.ts, through src/web/journey-events.ts): what Next shows each subscribed
 * person, pushed once, to their devices, within their preferences and quiet hours, encrypted to each device. S3 is in
 * memory; the push service is a fetch that decrypts what it is given with the device's own key.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import '../../src/core/access.js'
import { AgentFactsStore, addAgentQuestion, addStuck } from '../../src/core/agent-facts.js'
import { Central, S3Backend } from '../../src/core/central.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { addDevice } from '../../src/core/push-subscriptions.js'
import type { LiveEvent, Publisher } from '../../src/web/events.js'
import { onObjectCreated } from '../../src/web/journey-events.js'
import { MemoryLedger, endpointKey, messageFor } from '../../src/web/push-sender.js'
import { b64url, generateVapidKeys } from '../../src/web/web-push.js'
import { FakeS3 } from '../core/fake-s3.js'

const BUCKET = 'central-bucket'
const FACTS = 'projects/acme/board/journey-agent/facts.db'
const JOURNEY = 'projects/acme/board/journey/journey.db'
const VERIFY = { agent: 'verify', label: 'the Verification specialist', jobId: 'job-1' }
const opts = [
  { id: 'a', label: 'Use 4.2 A', recommended: true, why: 'the motor datasheet, page 3' },
  { id: 'b', label: 'Use 3.0 A', recommended: false, why: 'if the motor is derated' },
]
const scratch = mkdtempSync(join(tmpdir(), 'trace-push-'))
const prevCache = process.env.XDG_CACHE_HOME
process.env.XDG_CACHE_HOME = scratch
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = prevCache
})

const quietPub: Publisher = { async publish(_c: string, _e: readonly LiveEvent[]) {} }

/** A browser: its own key pair and auth secret, and what it can read of a push. */
function device(name: string) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const endpoint = `https://push.example.com/${name}`
  return {
    endpoint,
    json: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } },
    read(body: Uint8Array): Record<string, unknown> {
      const b = Buffer.from(body)
      const salt = b.subarray(0, 16)
      const as = b.subarray(21, 21 + b[20]!)
      const h = (k: Uint8Array, d: Uint8Array) => createHmac('sha256', k).update(d).digest()
      const ikm = h(h(auth, ecdh.computeSecret(as)), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), as, Buffer.from([1])]))
      const prk = h(salt, ikm)
      const d = createDecipheriv('aes-128-gcm', h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12))
      const ct = b.subarray(21 + b[20]!)
      d.setAuthTag(ct.subarray(-16))
      const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()])
      return JSON.parse(pt.subarray(0, -1).toString()) as Record<string, unknown>
    },
  }
}
type Device = ReturnType<typeof device>

const pushOn = { kinds: { gate: { push: true }, question: { push: true }, spend: { push: true }, stuck: { push: true } } }

async function rig(o: { status?: (endpoint: string) => number } = {}) {
  const s3 = new FakeS3()
  const access = new Central({ home: `s3://${BUCKET}/access`, s3 })
  const devices: Record<string, Device> = { admin: device('admin-phone'), user: device('user-phone'), off: device('off-phone'), reviewer: device('reviewer-phone') }
  await access.update((db) => {
    const user = db.prepare('INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,?,0,0)')
    for (const [sub, cls] of [['admin-1', 'admin'], ['user-1', 'user'], ['user-off', 'user'], ['user-2', 'user']] as const) user.run(sub, `${sub}@example.com`, cls)
    const assign = db.prepare("INSERT INTO assignments (sub, repo, assigned_by, assigned_at, part) VALUES (?,?,'admin',0,?)")
    assign.run('user-1', 'acme/board', 'contributor')
    assign.run('user-off', 'acme/board', 'contributor')
    assign.run('user-2', 'acme/board', 'reviewer')
    const pref = db.prepare('INSERT INTO preferences (sub, doc, updated) VALUES (?,?,0)')
    pref.run('admin-1', JSON.stringify({ notifications: pushOn }))
    pref.run('user-1', JSON.stringify({ notifications: pushOn }))
    pref.run('user-2', JSON.stringify({ notifications: pushOn }))
    // user-off has a device but never turned push on for a kind
    addDevice(db, 'admin-1', devices.admin!.json, { tz: 'Australia/Melbourne', at: 1 })
    addDevice(db, 'user-1', devices.user!.json, { tz: 'Australia/Melbourne', at: 1 })
    addDevice(db, 'user-off', devices.off!.json, { tz: 'Australia/Melbourne', at: 1 })
    addDevice(db, 'user-2', devices.reviewer!.json, { tz: 'Australia/Melbourne', at: 1 })
  })
  const projects = new S3Backend(BUCKET, 'projects', s3)
  const journey = new JourneyStore(projects, 'acme/board')
  await journey.update((db) => { startJourney(db, { template: 'board', by: 'admin-1@example.com', name: 'Motor driver' }); return { result: null } })
  const record = (await journey.read((db) => loadJourney(db))).result
  const facts = new AgentFactsStore(projects, 'acme/board')
  const keys = generateVapidKeys('https://github.com/mteichtahl/trace')
  const sent: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = []
  const fetchFake = (async (url: string, init: RequestInit) => {
    sent.push({ endpoint: url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array })
    return new Response(null, { status: o.status?.(url) ?? 201 })
  }) as unknown as typeof fetch
  const ledger = new MemoryLedger()
  const logs: Record<string, unknown>[] = []
  // a Tuesday, 11:00 in Melbourne
  let t = Date.parse('2026-11-03T00:00:00Z')
  let keysAsked = 0
  const event = (key = FACTS) => ({ 'detail-type': 'Object Created', time: new Date(t).toISOString(), detail: { bucket: { name: BUCKET }, object: { key } } })
  const run = (key = FACTS) => onObjectCreated(event(key), {
    bucket: BUCKET, s3, publisher: quietPub, now: () => t, log: (x) => logs.push(x), scratch,
    push: { ledger, fetch: fetchFake, keys: async () => { keysAsked++; return keys } },
  })
  const to = (d: Device) => sent.filter((s) => s.endpoint === d.endpoint).map((s) => d.read(s.body))
  return { access, facts, record, devices, sent, to, ledger, logs, run, at: (iso: string) => { t = Date.parse(iso) }, keysAsked: () => keysAsked }
}

describe('push notifications', () => {
  beforeEach(() => forgetNoJourney())

  it('pushes a new question to the people it is for who asked for push, encrypted to each device, with a link to it', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing the current-sense resistor', options: opts }, r.record) }))
    const out = await r.run()
    expect(out.pushed).toBe(2)
    // the contributor and the admin; not the reviewer (not theirs to answer), not the one who left push off
    const user = r.to(r.devices.user!)
    expect(r.to(r.devices.admin!)).toHaveLength(1)
    expect(r.to(r.devices.reviewer!)).toEqual([])
    expect(r.to(r.devices.off!)).toEqual([])
    expect(user).toEqual([{
      id: expect.stringMatching(/^question:aq/), kind: 'question', title: 'Motor driver · Question',
      body: expect.stringContaining('stall current'), url: expect.stringMatching(/^\/next\?item=question%3Aaq.*&repo=acme%2Fboard$/), tag: expect.stringMatching(/^acme\/board:question:/),
    }])
    // blocking work: high urgency; the push service sees only ciphertext
    const s = r.sent.find((x) => x.endpoint === r.devices.user!.endpoint)!
    expect(s.headers.Urgency).toBe('high')
    expect(Buffer.from(s.body).toString('latin1')).not.toMatch(/stall/)
  })

  it('pushes each item once, whatever writes follow', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r.record) }))
    await r.run()
    await r.run(JOURNEY)
    await r.run()
    expect(r.to(r.devices.user!)).toHaveLength(1)
    // a person's write of the journey record pushes too (a gate a person made ready, say), with no live event
    await r.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r.record) }))
    const out = await r.run(JOURNEY)
    expect(out).toMatchObject({ repo: 'acme/board', changed: 0, notified: 0, pushed: 2 })
    expect(r.to(r.devices.user!).map((m) => m.kind)).toEqual(['question', 'stuck'])
  })

  it('keeps quiet hours on the device\'s own clock, and pushes after them when the item still waits', async () => {
    const r = await rig()
    await r.access.update((db) => {
      db.prepare('UPDATE preferences SET doc=? WHERE sub=?').run(JSON.stringify({ notifications: { ...pushOn, quiet: { on: true, from: '19:00', to: '07:00', days: [0, 1, 2, 3, 4, 5, 6] } } }), 'user-1')
    })
    r.at('2026-11-03T11:30:00Z') // 22:30 in Melbourne
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r.record) }))
    await r.run()
    expect(r.to(r.devices.user!)).toEqual([])
    expect(r.to(r.devices.admin!)).toHaveLength(1)
    r.at('2026-11-03T21:30:00Z') // 08:30 the next morning
    await r.run(JOURNEY)
    expect(r.to(r.devices.user!)).toHaveLength(1)
  })

  it('a project set to gates and spend pushes no questions; a kind turned off is not pushed', async () => {
    const r = await rig()
    await r.access.update((db) => {
      db.prepare('UPDATE preferences SET doc=? WHERE sub=?').run(JSON.stringify({ notifications: { ...pushOn, projects: { 'acme/board': 'gates-spend' } } }), 'user-1')
      db.prepare('UPDATE preferences SET doc=? WHERE sub=?').run(JSON.stringify({ notifications: { kinds: { ...pushOn.kinds, stuck: { push: false } } } }), 'admin-1')
    })
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r.record) }))
    await r.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r.record) }))
    await r.run()
    expect(r.to(r.devices.user!)).toEqual([])
    expect(r.to(r.devices.admin!).map((m) => m.kind)).toEqual(['question'])
  })

  it('stops using a device the push service says is gone, and retries later when it says to', async () => {
    let status = 410
    const r = await rig({ status: (e) => (e.endsWith('user-phone') ? status : 201) })
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r.record) }))
    await r.run()
    expect(await r.ledger.held(endpointKey(r.devices.user!.endpoint), Date.now() / 1000 + 10)).toBe(true)
    await r.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r.record) }))
    const before = r.sent.filter((s) => s.endpoint === r.devices.user!.endpoint).length
    await r.run()
    expect(r.sent.filter((s) => s.endpoint === r.devices.user!.endpoint).length).toBe(before)
    // the admin's device answers 503 once: the claim is let go, and the next change sends it
    status = 201
    const r2 = await rig({ status: (e) => (e.endsWith('admin-phone') && r2.sent.filter((s) => s.endpoint === e).length === 1 ? 503 : 201) })
    await r2.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r2.record) }))
    await r2.run()
    await r2.run(JOURNEY)
    expect(r2.sent.filter((s) => s.endpoint === r2.devices.admin!.endpoint)).toHaveLength(2)
  })

  it('reads nothing more, and asks for no keys, when no one on the project wants push', async () => {
    const r = await rig()
    await r.access.update((db) => { db.exec('DELETE FROM preferences') })
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the motor\'s stall current?', blocks: 'sizing', options: opts }, r.record) }))
    await r.run()
    expect(r.keysAsked()).toBe(0)
    expect(r.sent).toEqual([])
  })

  it('a gate opens on its own page; the message keeps to 180 characters', () => {
    const m = messageFor({ id: 'gate:architecture', kind: 'gate', repo: 'acme/board', project: 'Motor driver', stage: 'architect', summary: `Motor driver: ${'x'.repeat(300)}`, since: '', waited: '', blocking: true, action: '', ref: { kind: 'gate', id: 'architecture' } })
    expect(m.url).toBe('/p/acme~board/gates/architecture')
    expect(m.title).toBe('Motor driver · Gate ready')
    expect(m.body.length).toBe(178)
  })
})
