import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Registry } from '../../src/core/registry.js'
import { Net, parseBoard } from '../../src/kicad/pcb.js'
import { dsnWiring, lockedChanges, lockedItems } from '../../src/pcb/locked.js'
import { applyOrs, mergeVias, netRef, readOrs, type OrsSolution } from '../../src/pcb/ors.js'
import { buildOrp, encodeOrp } from '../../src/pcb/orp.js'
import { busStem, planRoute } from '../../src/pcb/plan.js'
import { tools } from '../../src/pcb/tools.js'
import { bga, bgaWithFanout, boardText, header, writeBoard, type BoardSpec } from './boards.js'

const GPU = { available: true, how: 'test GPU' }
const NO_GPU = { available: false, how: 'no GPU in the test' }
const parse = (s: BoardSpec): ReturnType<typeof parseBoard> => parseBoard(writeBoard(s))
const resistors = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `R${i + 1}`, x: 5 + i * 3, y: 10, pads: [{ num: '1', x: -0.5, y: 0, net: `N${i}` }, { num: '2', x: 0.5, y: 0, net: `N${i + 1}` }] }))

describe('planRoute', () => {
  const bgaBoard: BoardSpec = { copper: 6, width: 40, height: 40, footprints: bgaWithFanout(10, 0.8), zones: [{ net: 'B0_0', layer: 'In1.Cu' }] }
  const names = Array.from({ length: 40 }, (_, i) => `SIG_${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`)
  const backplane: BoardSpec = { copper: 4, width: 60, height: 80, footprints: [header('J1', 10, 10, names, 1.27), header('J2', 50, 10, names, 1.27)] }
  const plain: BoardSpec = { copper: 2, width: 40, height: 20, footprints: resistors(5) }

  it('finds a BGA, leaves its poured net alone, and uses both routers with a GPU', () => {
    const p = planRoute(parse(bgaBoard), { gpu: GPU })
    expect(p.core.arrays).toEqual([{ ref: 'U1', pads: 100, pitch_mm: 0.8, grid: '10x10', fill: 1 }])
    expect(p.core.nets).toHaveLength(99)
    expect(p.core.poured).toEqual(['B0_0'])
    expect(p.stages).toEqual(['orthoroute', 'freerouting'])
    expect(p.orthoroute_cpu_only).toBe(false)
  })

  it('without a GPU, auto uses Freerouting alone and says OrthoRoute was skipped', () => {
    const p = planRoute(parse(bgaBoard), { gpu: NO_GPU })
    expect(p.stages).toEqual(['freerouting'])
    expect(p.notes.join(' ')).toMatch(/OrthoRoute was skipped: no GPU backend \(no GPU in the test\)/)
    expect(p.core.nets).toHaveLength(99) // still shown, so the decision can be read
    const forced = planRoute(parse(bgaBoard), { gpu: NO_GPU, engine: 'both' })
    expect(forced).toMatchObject({ stages: ['orthoroute', 'freerouting'], orthoroute_cpu_only: true })
  })

  it('a coarse-pitch or ring-shaped footprint is not an area array', () => {
    expect(planRoute(parse({ ...bgaBoard, footprints: [bga('U1', 20, 20, 10, 1.0)], zones: [] }), { gpu: GPU }).core.arrays).toEqual([])
    const ring = bga('U2', 20, 20, 30, 0.5)
    ring.pads = ring.pads.filter((p) => Math.abs(p.x) > 6.5 || Math.abs(p.y) > 6.5) // a QFP-like perimeter, 3 deep
    expect(ring.pads.length).toBeGreaterThan(64)
    expect(planRoute(parse({ ...bgaBoard, footprints: [ring], zones: [] }), { gpu: GPU }).core.arrays).toEqual([])
  })

  it('finds a backplane fan between two connectors', () => {
    const p = planRoute(parse(backplane), { gpu: GPU })
    expect(p.core.backplanes).toEqual([{ footprints: ['J1', 'J2'], nets: 40 }])
    expect(p.stages).toEqual(['orthoroute', 'freerouting'])
  })

  it('finds a bus by name stem and footprints, and applies include/exclude', () => {
    const d = Array.from({ length: 8 }, (_, i) => `/mem/D${i}`)
    const b = parse({ copper: 4, width: 40, height: 30, footprints: [header('U1', 10, 10, d), header('U2', 30, 10, d), ...resistors(2)] })
    const p = planRoute(b, { gpu: GPU })
    expect(p.core.buses).toEqual([{ stem: 'mem/D#', nets: 8, footprints: ['U1', 'U2'] }])
    const q = planRoute(b, { gpu: GPU, settings: { include_nets: ['N1'], exclude_nets: ['/mem/D0', '/mem/D1'] } })
    expect(q.core.nets).toContain('N1')
    expect(q.core.nets).not.toContain('/mem/D0')
    expect(q.core.nets).toHaveLength(7)
  })

  it('a plain 2-layer board needs only Freerouting', () => {
    const p = planRoute(parse(plain), { gpu: GPU })
    expect(p.stages).toEqual(['freerouting'])
    expect(p.core.nets).toEqual([])
    expect(p.notes[0]).toMatch(/no complex core/)
  })

  it('a core on a 2-layer board stays with Freerouting', () => {
    const p = planRoute(parse({ ...backplane, copper: 2 }), { gpu: GPU })
    expect(p.stages).toEqual(['freerouting'])
    expect(p.notes.join(' ')).toMatch(/only 2 copper layers/)
  })

  const sample = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sensor-node', 'hardware', 'sensor-node.kicad_pcb')
  it.skipIf(!existsSync(sample))('the sensor-node sample is a plain board: Freerouting only', () => {
    const p = planRoute(parseBoard(sample), { gpu: GPU })
    expect(p.stages).toEqual(['freerouting'])
    expect(p.core.arrays).toEqual([])
  })

  it('reads bus stems', () => {
    expect(busStem('/mem/D12')).toBe('D#')
    expect(busStem('A[3]')).toBe('A[#]')
    expect(busStem('TX0_P')).toBe('TX#±')
    expect(busStem('LANE2N')).toBe('LANE#±')
    expect(busStem('GND')).toBeNull()
    expect(busStem('VCCP')).toBeNull()
  })
})

// two nets on a 4-layer board: A from (10,10) to (20,10); B's pad sits at (15,12)
const two = (kicad10 = false): BoardSpec => ({
  copper: 4, width: 30, height: 20, kicad10,
  footprints: [
    { ref: 'J1', x: 10, y: 10, pads: [{ num: '1', x: 0, y: 0, net: 'A' }] },
    { ref: 'J2', x: 20, y: 10, pads: [{ num: '1', x: 0, y: 0, net: 'A' }] },
    { ref: 'J3', x: 15, y: 12, pads: [{ num: '1', x: 0, y: 0, net: 'B' }] },
    { ref: 'J4', x: 25, y: 15, pads: [{ num: '1', x: 0, y: 0, net: 'B' }] },
  ],
})
const solution = (nets: OrsSolution['nets']): OrsSolution => ({ nets, metadata: {}, statistics: {}, iterations: 1 })
const L = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']

describe('ORP export', () => {
  it('lists only the asked nets to route, every pad, the rules and the stack', () => {
    const b = parse(two())
    const orp = buildOrp(b, { nets: ['A'], rules: { track_width: 0.15, clearance: 0.15, via_diameter: 0.45, via_drill: 0.2 }, boardName: 'two.kicad_pcb' })
    const back = JSON.parse(gunzipSync(encodeOrp(orp)).toString('utf8')) as Record<string, any>
    expect(back.format_version).toBe('1.0')
    for (const k of ['metadata', 'board', 'pads', 'nets', 'layers', 'drc_rules', 'grid_parameters']) expect(back).toHaveProperty(k) // OrthoRoute's required sections
    expect(back.nets.map((n: { name: string }) => n.name)).toEqual(['A'])
    expect(back.pads).toHaveLength(4)
    expect(back.pads[0]).toMatchObject({ id: 'J1@1', component_ref: 'J1', net_name: 'A', position: { x: 10, y: 10 }, layer: 'F.Cu', drill_size: null })
    expect(back.board).toMatchObject({ layer_count: 4, bounds: { x_min: 0, y_min: 0, x_max: 30, y_max: 20 } })
    expect(back.layers.map((l: { name: string }) => l.name)).toEqual(L)
    expect(back.drc_rules.default).toMatchObject({ track_width: 0.15, clearance: 0.15, via_diameter: 0.45, via_drill: 0.2 })
  })
})

describe('ORS import', () => {
  const opts = { nets: ['A'], blindBuried: false, clearance: 0.2 }
  // A over the top: down to In1 by a blind via, across, back up
  const viaRoute = (): OrsSolution['nets'] => ({
    A: {
      tracks: [
        { layer: 'F.Cu', x1: 10, y1: 10, x2: 10, y2: 8, width: 0.2 },
        { layer: 'In1.Cu', x1: 10, y1: 8, x2: 20, y2: 8, width: 0.2 },
        { layer: 'F.Cu', x1: 20, y1: 8, x2: 20, y2: 10, width: 0.2 },
      ],
      vias: [{ x: 10, y: 8, from: 'F.Cu', to: 'In1.Cu', diameter: 0.45, drill: 0.2 }, { x: 20, y: 8, from: 'F.Cu', to: 'In1.Cu', diameter: 0.45, drill: 0.2 }],
    },
  })

  it('reads a .ORS (gzip JSON), with numeric layers as stack indices', () => {
    const ors = { format_version: '1.0', geometry: { by_net: { A: { tracks: [{ layer: 1, start: { x: 1, y: 2 }, end: { x: 3, y: 2 }, width: 0.2 }], vias: [{ position: { x: 1, y: 2 }, from_layer: 0, to_layer: 1, diameter: 0.4, drill: 0.2 }] } } },
      metadata: { converged: true }, statistics: { total_tracks: 1 }, iteration_metrics: [{}, {}] }
    const s = readOrs(gzipSync(Buffer.from(JSON.stringify(ors))), L)
    expect(s.nets.A).toEqual({ tracks: [{ layer: 'In1.Cu', x1: 1, y1: 2, x2: 3, y2: 2, width: 0.2 }], vias: [{ x: 1, y: 2, from: 'F.Cu', to: 'In1.Cu', diameter: 0.4, drill: 0.2 }] })
    expect(s.iterations).toBe(2)
    expect(() => readOrs(new Uint8Array([1, 2, 3]), L)).toThrow(/gzip-compressed JSON/)
    expect(() => readOrs(Buffer.from(JSON.stringify({ format_version: '2.0' })), L)).toThrow(/format 1.0/)
  })

  it('writes a complete, clear net locked, with through vias when blind/buried are not allowed', () => {
    const b = parse(two())
    const text = readFileSync(b.path, 'utf8')
    const r = applyOrs(text, b, solution(viaRoute()), opts)
    expect(r).toMatchObject({ routed: ['A'], failed: [], tracks: 3, vias: 2, through_from_blind: 2 })
    expect(r.text).toContain('(via\n\t\t(at 10 8)')
    expect(r.text).toContain('(layers "F.Cu" "B.Cu")')
    expect(r.text).toMatch(/\(segment\n\t\t\(start 10 10\)\n\t\t\(end 10 8\)\n\t\t\(width 0.2\)\n\t\t\(locked yes\)\n\t\t\(layer "F.Cu"\)\n\t\t\(net 1\)/)
    const locked = lockedItems(r.text)
    expect(locked.filter((i) => i.kind === 'segment')).toHaveLength(3)
    expect(locked.filter((i) => i.kind === 'via')).toHaveLength(2)
    // the result is a board KiCad's reader (and trace's) accepts, with A now joined
    const after = parseBoard(writeBoardText(r.text))
    expect(new Net(after, 'A').unreached()).toEqual([])
  })

  it('keeps blind vias when allowed, and names buried ones for KiCad 10', () => {
    const b = parse(two(true))
    const sol = viaRoute()
    ;(sol.A as { vias: unknown[] }).vias.push({ x: 15, y: 6, from: 'In1.Cu', to: 'In2.Cu', diameter: 0.45, drill: 0.2 })
    ;(sol.A as { tracks: unknown[] }).tracks.push({ layer: 'In1.Cu', x1: 15, y1: 8, x2: 15, y2: 6, width: 0.2 })
    const r = applyOrs(readFileSync(b.path, 'utf8'), b, solution(sol), { ...opts, blindBuried: true })
    expect(r.routed).toEqual(['A'])
    expect(r.text).toContain('(via blind\n\t\t(at 10 8)')
    expect(r.text).toContain('(via buried\n\t\t(at 15 6)')
    expect(r.text).toContain('(net "A")') // KiCad 10 names nets in place
  })

  it('merges stacked vias of one net into one span', () => {
    expect(mergeVias([{ x: 1, y: 1, from: 'F.Cu', to: 'In1.Cu', diameter: 0.4, drill: 0.2 }, { x: 1, y: 1, from: 'In1.Cu', to: 'In2.Cu', diameter: 0.45, drill: 0.2 }], L))
      .toEqual([{ x: 1, y: 1, from: 'F.Cu', to: 'In2.Cu', diameter: 0.45, drill: 0.2 }])
  })

  it('leaves out a net that crowds another net, and one that is incomplete', () => {
    const b = parse(two())
    const text = readFileSync(b.path, 'utf8')
    const straight = { A: { tracks: [{ layer: 'F.Cu', x1: 10, y1: 10, x2: 20, y2: 10, width: 0.2 }], vias: [] } }
    expect(applyOrs(text, b, solution(straight), opts).routed).toEqual(['A']) // B's pad is 2 mm away
    const crowd = { A: { tracks: [{ layer: 'F.Cu', x1: 10, y1: 10, x2: 15, y2: 11.6 }, { layer: 'F.Cu', x1: 15, y1: 11.6, x2: 20, y2: 10 }].map((t) => ({ ...t, width: 0.2 })), vias: [] } }
    const c = applyOrs(text, b, solution(crowd), opts)
    expect(c.routed).toEqual([])
    expect(c.failed[0]?.reason).toMatch(/too close to pad J3.1 of B on F.Cu/)
    expect(c.text).toBe(text)
    const half = { A: { tracks: [{ layer: 'F.Cu', x1: 10, y1: 10, x2: 14, y2: 10, width: 0.2 }], vias: [] } }
    expect(applyOrs(text, b, solution(half), opts).failed[0]?.reason).toMatch(/incomplete: J2.1/)
    // a through via made from a blind one is checked on every layer it now crosses
    const viaOverB = viaRoute()
    const bB = parse({ ...two(), footprints: [...two().footprints, { ref: 'J5', x: 10, y: 8, side: 'B', pads: [{ num: '1', x: 0, y: 0, net: 'B' }] }] })
    const v = applyOrs(readFileSync(bB.path, 'utf8'), bB, solution(viaOverB), opts)
    expect(v.failed[0]?.reason).toMatch(/pad J5.1 of B on B.Cu/)
  })

  it('names nets by number in KiCad 9 files and by name in KiCad 10 files', () => {
    expect(netRef(boardText(two()))('A')).toBe('(net 1)')
    expect(netRef(boardText(two(true)))('A')).toBe('(net "A")')
  })
})

function writeBoardText(text: string): string {
  const p = writeBoard(two())
  writeFileSync(p, text)
  return p
}

describe('locked copper', () => {
  it('finds locked items in both syntaxes and notices one that moved or vanished', () => {
    const base = boardText(two())
    const body = '\t(segment\n\t\t(start 1 1)\n\t\t(end 2 1)\n\t\t(width 0.2)\n\t\t(locked yes)\n\t\t(layer "F.Cu")\n\t\t(net 1)\n\t\t(uuid "u1")\n\t)\n'
      + '\t(segment locked (start 3 3) (end 4 3) (width 0.2) (layer "B.Cu") (net 2) (uuid "u2"))\n'
      + '\t(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (locked yes) (net 1) (uuid "u3"))\n'
      + '\t(segment (start 6 6) (end 7 6) (width 0.2) (layer "F.Cu") (net 1) (uuid "u4"))\n'
    const a = base.replace(/\)\s*$/, `${body})\n`)
    const items = lockedItems(a)
    expect(items.map((i) => i.key)).toEqual(['segment|A|F.Cu|1,1|2,1|w0.2', 'segment|B|B.Cu|3,3|4,3|w0.2', 'via|A|5,5|F.Cu-B.Cu'])
    // pcbnew rewrites numbers and order: an item that only changed format is the same item
    const reformatted = a.replace('(start 1 1)\n\t\t(end 2 1)', '(start 2.0 1)\n\t\t(end 1 1.0000)')
    expect(lockedChanges(items, lockedItems(reformatted))).toEqual([])
    const moved = a.replace('(at 5 5)', '(at 5 5.1)')
    expect(lockedChanges(items, lockedItems(moved)).map((i) => i.key)).toEqual(['via|A|5,5|F.Cu-B.Cu'])
    const unlocked = a.replace('(segment locked', '(segment')
    expect(lockedChanges(items, lockedItems(unlocked))).toHaveLength(1)
  })

  const dsn = `(pcb x.dsn
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
  )
  (resolution um 10)
  (unit um)
  (structure
    (via "Via[0-3]_600:300_um")
  )
  (network
    (net A
      (pins J1-1 J2-1)
    )
    (net B
      (pins J3-1 J4-1)
    )
    (class kicad_default "" A B
      (circuit
        (use_via "Via[0-3]_600:300_um")
      )
      (rule
        (width 200)
        (clearance 200)
      )
    )
  )
  (wiring
    (wire (path F.Cu 200  10000 -10000  14000 -10000)(net A)(type route))
    (wire (path F.Cu 200  14000 -10000  20000 -10000)(net A)(type fix))
    (via "Via[0-3]_600:300_um"  14000 -10000 (net A)(type route))
  )
)
`
  it('counts a DSN\'s wiring by type', () => {
    expect(dsnWiring(dsn)).toEqual({ wires: { route: 1, fix: 1 }, vias: { route: 1 } })
  })

  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'kicad')
  const hasPy = (() => { try { execFileSync('python3', ['-c', '1']); return true } catch { return false } })()
  it.skipIf(!hasPy)('marks locked items that a DSN wrote as routable as fixed, and isolates ignored nets (python/kicad/autoroute.py)', () => {
    const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(script)}); import autoroute as a
t = sys.stdin.read()
out, rep = a.fix_dsn(t, {'tracks': [['F.Cu', 10, 10, 14, 10]], 'vias': [[14, 10]]})
iso, found, missing = a.isolate_nets(out, ['B', 'NOPE'])
print(json.dumps({'out': out, 'rep': rep, 'iso': iso, 'found': found, 'missing': missing}))`
    const r = JSON.parse(execFileSync('python3', ['-c', code], { input: dsn, encoding: 'utf8' })) as { out: string; rep: Record<string, number>; iso: string; found: string[]; missing: string[] }
    expect(r.rep).toEqual({ fixed_wires: 0, fixed_vias: 0, marked_wires: 1, marked_vias: 1 })
    expect(dsnWiring(r.out)).toEqual({ wires: { fix: 2 }, vias: { fix: 1 } })
    expect(r.found).toEqual(['B'])
    expect(r.missing).toEqual(['NOPE'])
    expect(r.iso).toMatch(/\(class kicad_default ""\s+A\s*\n/)
    expect(r.iso).toMatch(/\(class trace_ignore "B"\s+\(circuit/)
  })
})

describe('the pcb.autoroute tool', () => {
  const reg = new Registry(tools)
  const ctx = { hardware: false, via: 'test' } as const

  it('is registered with a JSON schema, and returns the plan alone when asked', async () => {
    expect(reg.list().map((t) => t.name)).toEqual(['pcb.autoroute'])
    expect(Registry.jsonSchema(reg.get('pcb.autoroute')!)).toHaveProperty('properties.engine')
    delete process.env.TRACE_GPU_QUEUE
    process.env.TRACE_GPU = '0'
    try {
      const pcb = writeBoard({ copper: 6, width: 40, height: 40, footprints: bgaWithFanout(10, 0.8) })
      const r = (await reg.call('pcb.autoroute', { project: pcb, plan_only: true }, ctx)) as { plan: { stages: string[]; gpu: { available: boolean } } }
      expect(r.plan.stages).toEqual(['freerouting'])
      expect(r.plan.gpu.available).toBe(false)
      process.env.TRACE_GPU_QUEUE = 'arn:aws:batch:us-east-1:123456789012:job-queue/q'
      const q = (await reg.call('pcb.autoroute', { project: pcb, plan_only: true }, ctx)) as { plan: { stages: string[] } }
      expect(q.plan.stages).toEqual(['orthoroute', 'freerouting'])
    } finally {
      delete process.env.TRACE_GPU_QUEUE
      delete process.env.TRACE_GPU
    }
  })

  it('refuses to overwrite the input unless in_place', async () => {
    const pcb = writeBoard({ copper: 2, width: 20, height: 20, footprints: resistors(2) })
    await expect(reg.call('pcb.autoroute', { project: pcb, output: pcb }, ctx)).rejects.toThrow(/in_place/)
    await expect(reg.call('pcb.autoroute', { project: pcb, output: 'x.txt' }, ctx)).rejects.toThrow(/\.kicad_pcb/)
  })
})
