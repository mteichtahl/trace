/**
 * Bring-up readings and instrument identities from the real hil tools on the emulated bench (src/core/bench.ts,
 * src/tools/hil/record.ts): a measurement taken with `bringup` is stored against the board serial and step with its
 * limits and pass or fail, an identity query is stored per instrument, both in the run record and in the project's
 * live copy when the session has a project in scope; and the bring-up checks read them.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BenchStore, idsFromRuns, latestByQuantity, loadIds, loadReadings, newReading, stepOrderProblems, stepStates, unionReadings, withinLimits } from '../../../src/core/bench.js'
import { backendFor } from '../../../src/core/central.js'
import { openProject } from '../../../src/core/store.js'
import { startBench, writeBenchSettings, type Bench } from '../../../src/tools/hil/emulator/bench.js'
import { allTools } from '../../../src/tools/index.js'

type Obj = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, { hardware: true, via: 'test' })) as Obj

describe('readings against a board and step, on the emulated bench', () => {
  let bench: Bench
  const home = process.env.TRACE_HOME as string
  beforeAll(async () => {
    bench = await startBench({ ports: { psu: 0, scope: 0, dmm: 0 } })
    writeBenchSettings(bench.settings)
    // a project in scope: the readings' live copy goes to <TRACE_HOME's parent>/projects/<slug>/journey-agent/bench.db
    process.env.TRACE_PROJECT = 'acme/bench'
  })
  afterAll(async () => { delete process.env.TRACE_PROJECT; await bench.stop() })

  it('stores each identity answer, and each tagged reading with its limits and pass or fail', async () => {
    await call('hil.idn', { instrument: 'bench-psu' })
    await call('hil.idn', { instrument: 'bench-dmm' })
    const unpowered = await call('hil.dmm', { instrument: 'bench-dmm', function: 'vdc', bringup: { board: 'SN-001', step: 'unpowered', quantity: 'ADC_IN with no supply', max: 0.05 } })
    expect(unpowered.reading).toMatchObject({ board: 'SN-001', step: 'unpowered', pass: true })
    const psu = await call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 12, current: 0.05, output: 'on', bringup: { board: 'SN-001', step: 'rails', quantity: 'VIN current', max: 0.001 } })
    expect(psu.reading).toMatchObject({ step: 'rails', pass: true })
    // ADC_IN is 3.0 V: outside a 3.2-3.4 V window, so the reading fails, and so does the run
    const out = await call('hil.dmm', { instrument: 'bench-dmm', function: 'vdc', bringup: { board: 'SN-001', step: 'rails', quantity: 'ADC_IN', min: 3.2, max: 3.4 } })
    expect(out.reading).toMatchObject({ pass: false })
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, output: 'off' })

    const db = openProject()
    try {
      const rs = loadReadings(db, 'SN-001')
      expect(rs.map((r) => [r.step, r.quantity, r.unit, r.pass])).toEqual([['unpowered', 'ADC_IN with no supply', 'V', true], ['rails', 'VIN current', 'A', true], ['rails', 'ADC_IN', 'V', false]])
      expect(rs[2]).toMatchObject({ instrument: 'bench-dmm', min: 3.2, max: 3.4 })
      expect(rs[2]?.value).toBeCloseTo(3, 1)
      expect(rs.every((r) => r.runId)).toBe(true)
      expect(loadIds(db).map((i) => [i.instrument, i.model, i.ok])).toEqual([['bench-dmm', '34465A', true], ['bench-psu', 'DP832', true]])
      expect(idsFromRuns(db).map((i) => i.instrument).sort()).toEqual(['bench-dmm', 'bench-psu'])
    } finally {
      db.close()
    }
    // the live copy beside the agents' facts
    const live = new BenchStore(backendFor(join(home, 'projects')), 'acme/bench')
    const got = (await live.read((db2) => ({ r: loadReadings(db2), i: loadIds(db2) }))).result
    expect(got.r.map((r) => r.quantity)).toEqual(['ADC_IN with no supply', 'VIN current', 'ADC_IN'])
    expect(got.i).toHaveLength(2)
  })
})

describe('the bring-up checks over readings', () => {
  const r = (step: 'unpowered' | 'rails' | 'clocks', quantity: string, value: number, at: number, lim: { min?: number; max?: number } = {}) =>
    newReading({ board: 'SN-002', step, instrument: 'dmm', quantity, value, unit: 'V', min: lim.min ?? null, max: lim.max ?? null, by: 'verify', runId: null, at })

  it('passes a board whose every step passed before the next began, and keeps the newest reading of a quantity', () => {
    expect(withinLimits(null, null, null)).toBe(false)
    expect(withinLimits(3.3, 3.2, 3.4)).toBe(true)
    const rows = [r('unpowered', '3V3 to GND', 1.2, 1, { min: 0.5 }), r('rails', '3V3', 3.1, 2, { min: 3.2, max: 3.4 }), r('rails', '3V3', 3.3, 3, { min: 3.2, max: 3.4 }), r('clocks', 'OSC', 1, 4, { min: 0.5 })]
    expect(latestByQuantity(rows).map((x) => x.value)).toEqual([1.2, 3.3, 1])
    expect(stepStates(rows).map((s) => [s.step, s.passed])).toEqual([['unpowered', true], ['rails', true], ['clocks', true]])
    expect(stepOrderProblems(rows)).toEqual([])
  })

  it('names a step out of limits, and a step that began before the one before it passed', () => {
    const failing = [r('unpowered', '3V3 to GND', 0.1, 1, { min: 0.5 })]
    expect(stepOrderProblems(failing)).toEqual(['unpowered: 3V3 to GND out of limits'])
    const early = [r('unpowered', 'R', 1, 1, { min: 0.5 }), r('rails', '3V3', 3.0, 2, { min: 3.2 }), r('clocks', 'OSC', 1, 3), r('rails', '3V3', 3.3, 4, { min: 3.2 })]
    expect(stepOrderProblems(early)).toEqual(['clocks began before rails had passed'])
    expect(stepOrderProblems([])).toBeNull()
    expect(unionReadings(early, early)).toHaveLength(4)
  })
})
