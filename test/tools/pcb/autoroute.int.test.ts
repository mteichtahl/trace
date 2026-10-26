/**
 * End-to-end routing with the real programs, when this machine has them (skipped otherwise):
 *   Freerouting: TRACE_FREEROUTING_JAR (and TRACE_JAVA, a Java 25), KiCad's Python with pcbnew (TRACE_KICAD_PYTHON
 *   or python3), kicad-cli;  OrthoRoute: TRACE_ORTHOROUTE (its source) and TRACE_ORTHOROUTE_PYTHON (numpy, scipy).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Registry } from '../../../src/core/registry.js'
import { lockedItems } from '../../../src/tools/pcb/locked.js'
import { tools } from '../../../src/tools/pcb/tools.js'
import { header, writeBoard } from './boards.js'

const works = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 60_000 })
    return true
  } catch {
    return false
  }
}
const py = process.env.TRACE_KICAD_PYTHON ?? 'python3'
const hasFreerouting = !!process.env.TRACE_FREEROUTING_JAR && existsSync(process.env.TRACE_FREEROUTING_JAR)
  && works(process.env.TRACE_JAVA ?? 'java', ['-version']) && works(py, ['-c', 'import pcbnew']) && works('kicad-cli', ['version'])
const hasOrthoRoute = !!process.env.TRACE_ORTHOROUTE && existsSync(`${process.env.TRACE_ORTHOROUTE}/main.py`)
  && works(process.env.TRACE_ORTHOROUTE_PYTHON ?? 'python3', ['-c', 'import numpy, scipy, psutil'])

const reg = new Registry(tools)
const ctx = { hardware: false, via: 'test' } as const
type Dict = Record<string, unknown>

// eight data lines between two connectors on a 4-layer board: a bus, so the planner calls it a core
const nets = Array.from({ length: 8 }, (_, i) => `D${i}`)
const spec = { copper: 4 as const, width: 40, height: 30, footprints: [header('J1', 10, 10, nets), header('J2', 30, 10, [...nets].reverse())] }
const rules = { track: 0.15, clearance: 0.15, via: 0.45, drill: 0.2 }

describe.skipIf(!hasFreerouting)('pcb.autoroute with Freerouting (real)', () => {
  it('routes the board with Freerouting alone and runs DRC', async () => {
    delete process.env.TRACE_GPU_QUEUE
    const pcb = writeBoard(spec, 'bus', rules)
    const before = readFileSync(pcb, 'utf8')
    const r = (await reg.call('pcb.autoroute', { project: pcb, engine: 'freerouting', passes: 20, max_seconds: 300 }, ctx)) as Dict
    expect(readFileSync(pcb, 'utf8')).toBe(before) // never the input
    const st = (r.stages as Dict[])[0] as Dict
    expect(st).toMatchObject({ stage: 'freerouting', where: 'local', nets_attempted: 8 })
    expect(r.output).toMatch(/bus\.routed\.kicad_pcb$/)
    expect(existsSync(pcb.replace(/\.kicad_pcb$/, '.routed.kicad_pcb'))).toBe(true)
    expect(r.unrouted).toBe(0)
    expect(r.drc).toMatchObject({ unconnected: 0 })
  }, 600_000)

  it.skipIf(!hasOrthoRoute)('routes the bus with OrthoRoute (CPU) first, locks it, then Freerouting keeps it', async () => {
    delete process.env.TRACE_GPU_QUEUE
    const pcb = writeBoard(spec, 'bus', rules)
    const plan = ((await reg.call('pcb.autoroute', { project: pcb, plan_only: true }, ctx)) as Dict).plan as Dict
    expect(plan.stages).toEqual(['freerouting']) // no GPU here: auto skips OrthoRoute, and says why
    expect((plan.notes as string[]).join(' ')).toMatch(/OrthoRoute was skipped: no GPU backend/)
    const r = (await reg.call('pcb.autoroute', { project: pcb, engine: 'both', iterations: 40, passes: 20, max_seconds: 600 }, ctx)) as Dict
    const [s1, s2] = r.stages as Dict[]
    expect(s1).toMatchObject({ stage: 'orthoroute', where: 'local', cpu_only: true, device: 'cpu', nets_attempted: 8, via_policy: 'through vias only' })
    expect((s1?.nets_routed as number) + (s1?.nets_failed as number)).toBe(8)
    expect(s2).toMatchObject({ stage: 'freerouting' })
    const out = readFileSync(pcb.replace(/\.kicad_pcb$/, '.routed.kicad_pcb'), 'utf8')
    if ((s1?.nets_routed as number) > 0) expect(lockedItems(out).length).toBeGreaterThan(0)
    expect(s2?.locked_kept).toBe(lockedItems(out).length)
    if (process.env.TRACE_TEST_VERBOSE) writeFileSync(process.env.TRACE_TEST_VERBOSE, JSON.stringify({ stages: r.stages, unrouted: r.unrouted, drc: r.drc }, null, 1))
    expect(typeof r.unrouted).toBe('number')
  }, 1_200_000)
})
