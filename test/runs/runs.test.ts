import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Registry } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { record } from '../../src/hil/record.js'
import { tools } from '../../src/runs/tools.js'

const reg = new Registry(tools)
type Obj = Record<string, unknown>
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Obj

describe('the run record tools', () => {
  it('list, show and read back what a tool recorded', async () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const r = await record('firmware.build', { subject: 'sup', args: { target: 'sup' } }, async (rec) => {
      rec.artifact('build.log', log)
      rec.artifact('image.bin', new Uint8Array([0, 1, 2, 3, 255]))
      rec.measure('flash_bytes', 20992, 'B')
      return { status: 'pass', summary: 'ok', result: { ok: true } }
    })
    await record('hil.psu', { subject: 'bench-psu:CH1' }, async () => ({ status: 'fail', summary: 'no', result: {} }))

    const list = await call('trace.runs', { kind: 'firmware.' })
    expect((list.runs as Obj[]).map((x) => x.id)).toContain(r.run_id)
    expect((list.runs as Obj[]).every((x) => String(x.kind).startsWith('firmware.'))).toBe(true)
    const fails = await call('trace.runs', { status: 'fail' })
    expect((fails.runs as Obj[]).every((x) => x.status === 'fail')).toBe(true)

    const one = await call('trace.run', { id: r.run_id.slice(0, 8) })
    expect(one).toMatchObject({ id: r.run_id, kind: 'firmware.build', subject: 'sup', status: 'pass', result: { ok: true, run_id: r.run_id } })
    expect(one.measurements).toEqual([{ name: 'flash_bytes', value: 20992, unit: 'B' }])
    expect((one.artifacts as Obj[]).map((a) => [a.name, a.size])).toEqual([['build.log', log.length], ['image.bin', 5]])

    const head = await call('trace.artifact', { run: r.run_id, name: 'build.log', max_chars: 100 })
    expect(head).toMatchObject({ truncated: true, next_offset: 100 })
    expect(String(head.text).startsWith('line 0\nline 1')).toBe(true)
    const next = await call('trace.artifact', { run: r.run_id, name: 'build.log', max_chars: 50, offset: 100 })
    expect(String(next.text)).toBe(log.slice(100, 150))
    const t = await call('trace.artifact', { run: r.run_id, name: 'build.log', tail_lines: 2 })
    expect(t.text).toBe('line 498\nline 499')

    const bin = await call('trace.artifact', { run: r.run_id, name: 'image.bin' })
    expect(bin).toMatchObject({ binary: true, hex_preview: '00010203ff' })
    const dest = join(mkdtempSync(join(tmpdir(), 'art-')), 'out', 'image.bin')
    const saved = await call('trace.artifact', { run: r.run_id, name: 'image.bin', save_to: dest })
    expect(saved.saved_to).toBe(dest)
    expect([...readFileSync(dest)]).toEqual([0, 1, 2, 3, 255])

    await expect(call('trace.run', { id: 'ffffffffffff' })).rejects.toThrow(/no run/)
    await expect(call('trace.artifact', { run: r.run_id, name: 'nope.txt' })).rejects.toThrow(/has no artifact "nope.txt" \(it has: build.log, image.bin\)/)
  })

  it('records a run that throws as an error, with the message', async () => {
    let id = ''
    await expect(record('hil.dmm', { subject: 'dmm' }, async (rec) => { id = rec.id; throw new Error('the meter went away') })).rejects.toThrow(/went away/)
    const w = new Work()
    const r = w.run(id)
    w.close()
    expect(r).toMatchObject({ status: 'error', summary: 'Error: the meter went away' })
  })
})
