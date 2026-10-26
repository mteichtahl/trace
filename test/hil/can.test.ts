/**
 * CAN through the Python bridge on python-can's in-process `virtual` bus: a responder thread is not available from
 * here, so each test opens a second session on the same virtual channel and plays the other node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setValue } from '../../src/core/config.js'
import { bridge } from '../../src/core/bridge.js'
import { Registry } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { CanSession, checkFrame, parseId } from '../../src/hil/can.js'
import { tools } from '../../src/hil/tools.js'

process.env.TRACE_PYTHON ||= '/home/claude/trace/.venv/bin/python'
const reg = new Registry(tools)
const hw = { hardware: true, via: 'test' as const }
type Obj = Record<string, unknown>
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, hw)) as Obj

const vbus = (channel: string) => ({ name: 'peer', interface: 'virtual' as const, channel, bitrate: 500_000, fd: false })

beforeAll(() => {
  setValue('hil.can', [{ name: 'veh', interface: 'virtual', channel: 'veh' }])
})
afterAll(() => bridge().close())

describe('CAN frames', () => {
  it('are checked before they are sent', () => {
    expect(() => checkFrame({ id: 0x800, data: '', extended: false }, 0)).toThrow(/out of range for a 11-bit/)
    expect(() => checkFrame({ id: 0x123, data: 'zz' }, 1)).toThrow(/not hex/)
    expect(() => checkFrame({ id: 0x123, data: '00'.repeat(9) }, 2)).toThrow(/too long for classic CAN/)
    expect(() => checkFrame({ id: 0x123, data: '00'.repeat(9), fd: true }, 3)).toThrow(/CAN FD payloads/)
    expect(() => checkFrame({ id: 0x123, data: '00'.repeat(12), fd: true }, 4)).not.toThrow()
    expect(parseId('0x18FF00AA')).toBe(0x18ff00aa)
    expect(parseId('7DFh')).toBe(0x7df)
  })
})

describe('CAN on the virtual bus', () => {
  it('sends standard and extended frames that the other node receives, with filters', async () => {
    const peer = await CanSession.open(vbus('veh'))
    try {
      const r = await call('hil.can_send', { bus: 'veh', frames: [{ id: '0x123', data: 'de ad be ef' }, { id: 0x18ff00aa, data: '01' }, { id: 0x100, data: '' }] })
      expect(r.sent).toBe(3)
      const got = await peer.receive(500, 10)
      expect(got.frames.map((f) => [f.id, f.ext, f.data])).toEqual([[0x123, false, 'deadbeef'], [0x18ff00aa, true, '01'], [0x100, false, '']])
      await call('hil.can_send', { bus: 'veh', frames: [{ id: 0x200, data: 'aa' }, { id: 0x201, data: 'bb' }] })
      const filtered = await peer.receive(300, 10, [{ id: 0x201 }])
      expect(filtered.frames.map((f) => f.id)).toEqual([0x201])
    } finally {
      await peer.close()
    }
  })

  it('collects replies after a send', async () => {
    const peer = await CanSession.open(vbus('veh'))
    try {
      const sending = call('hil.can_send', { bus: 'veh', frames: [{ id: 0x7df, data: '02010d' }], reply_timeout_ms: 800, reply_filters: [{ id: '0x7e8' }] })
      const req = await peer.receive(2000, 1)
      expect(req.frames[0]?.id).toBe(0x7df)
      await peer.send([{ id: 0x7e8, data: '03410d32' }, { id: 0x555, data: '00' }])
      const r = await sending
      expect((r.replies as Obj[]).map((f) => f.data)).toEqual(['03410d32'])
    } finally {
      await peer.close()
    }
  })

  it('captures to a candump log kept in the record, with per-id counts', async () => {
    const peer = await CanSession.open(vbus('veh'))
    try {
      const capturing = call('hil.can_capture', { bus: 'veh', seconds: 1, format: 'candump' })
      await new Promise((r) => setTimeout(r, 300))
      await peer.send([...Array.from({ length: 5 }, (_, i) => ({ id: 0x321, data: `0${i}`, extended: false })), { id: 0x1abcdef, data: 'ff', extended: true }])
      const r = await capturing
      expect(r.frames).toBe(6)
      expect(r.ids).toEqual([{ id: '0x321', count: 5 }, { id: '0x01ABCDEF', count: 1 }])
      const w = new Work()
      const run = w.run(String(r.run_id))!
      const log = new TextDecoder().decode(w.getArtifact(run.id, 'capture.log')!)
      w.close()
      expect(log.trim().split('\n')).toHaveLength(6)
      expect(log).toMatch(/321#04/)
      expect(run.measurements.find((m) => m.name === 'frames')?.value).toBe(6)
    } finally {
      await peer.close()
    }
  })

  it('writes BLF (binary) through python-can', async () => {
    const r = await call('hil.can_capture', { interface: 'virtual', channel: 'quiet', seconds: 0.3, format: 'blf' })
    expect(r.frames).toBe(0)
    expect((r.log as Obj).name).toBe('capture.blf')
    expect((r.log as Obj).bytes as number).toBeGreaterThan(0)
  })

  it('names a missing bus and refuses DBC encoding without a dbc', async () => {
    await expect(call('hil.can_send', { bus: 'nope', frames: [{ id: 1, data: '' }] })).rejects.toThrow(/no CAN bus "nope"/)
    await expect(call('hil.can_send', { bus: 'veh', message: 'EngineData' })).rejects.toThrow(/has no dbc/)
  })
})
