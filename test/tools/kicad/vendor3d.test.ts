/**
 * A part's 3D body from its vendor (src/tools/kicad/vendor3d.ts), test-esp32 #214: J1, the HRO TYPE-C-31-M-12 USB-C
 * socket (LCSC C165948), names a .step that KiCad's 3D library does not have, so the render showed no socket in the
 * case's USB opening. The board here is the test run's own footprints (J1, a resistor, a mounting hole), and the
 * EasyEDA answer is the one for C165948, cut to its footprint and 3D model node.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, walk } from '../../../src/tools/kicad/sexpr.js'
import {
  ALIGN_TOLERANCE_MM, EASYEDA_PART, EASYEDA_STEP, boardFootprints, easyedaModel, footprintSpans, placeOn, quarter, vendorBodies, VENDOR_DIR, withModel,
} from '../../../src/tools/kicad/vendor3d.js'
import { bodiesNote, bodiless } from '../../../src/tools/render/model.js'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'vendor3d')
const BOARD = readFileSync(join(FIX, 'board.kicad_pcb'), 'utf8')
const ANSWER = JSON.parse(readFileSync(join(FIX, 'easyeda-C165948.json'), 'utf8'))
const USB = 'Connector_USB.3dshapes/USB_C_Receptacle_HRO_TYPE-C-31-M-12.step'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'vendor3d-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('the board\'s footprints', () => {
  it('are read with their reference, LCSC code, models and pads; a mounting hole is only the board', () => {
    const fps = boardFootprints(BOARD)
    expect(fps.map((f) => [f.ref, f.lcsc, f.boardOnly, f.models.length])).toEqual([['R1', 'C23186', false, 1], ['J1', 'C165948', false, 1], ['H3', null, true, 0]])
    const j1 = fps[1]!
    expect(j1.pads).toHaveLength(22)
    expect(j1.pads).toContainEqual([-4.32, 1.05])
    expect(BOARD.slice(...j1.span).startsWith('(footprint "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12"')).toBe(true)
    // a "(footprint" inside a string is not one
    const t = '(kicad_pcb (net 0 "(footprint") (footprint "a" (pad "1")))'
    expect(footprintSpans(t).map(([s, e]) => t.slice(s, e))).toEqual(['(footprint "a" (pad "1"))'])
  })

  it('without a body: a library model KiCad does not have, or no model at all; never what is only the board', () => {
    const fps = boardFootprints(BOARD)
    expect(bodiless(fps, new Set([USB])).map((f) => f.ref)).toEqual(['J1'])
    expect(bodiless(fps, new Set()).map((f) => f.ref)).toEqual([])
    const bare = boardFootprints(BOARD.replace(/\(model "[^"]*USB_C[^"]*"/, '(xmodel "x"'))
    expect(bodiless(bare, new Set()).map((f) => f.ref)).toEqual(['J1'])
  })
})

describe('EasyEDA\'s model', () => {
  it('is read from the part\'s answer: its uuid, its origin on the footprint, its height and rotation, and the pads', () => {
    const m = easyedaModel(ANSWER)!
    expect(m.uuid).toBe('617b05f9bba7410b96c001093d8189e4')
    // c_origin is 4.33 units (1.1 mm) below the pads' centre; raised 0.85 mm onto the board; turned half round
    expect(m.origin[0]).toBeCloseTo(0, 3)
    expect(m.origin[1]).toBeCloseTo(1.1, 2)
    expect(m.z).toBeCloseTo(0.85, 2)
    expect(m.rotate).toEqual([0, 0, 180])
    expect(m.pads).toHaveLength(18)
    expect(easyedaModel({ result: { packageDetail: { dataStr: { shape: ['PAD~RECT~1~2~1~1~1~~1~0'] } } } })).toBeNull()
    expect(easyedaModel(null)).toBeNull()
  })

  it('is placed on KiCad\'s footprint by its pads: J1\'s land patterns match as they are, a quarter turn finds a turned one', () => {
    const m = easyedaModel(ANSWER)!
    const j1 = boardFootprints(BOARD)[1]!
    const p = placeOn(m, j1.pads)!
    expect(p.turns).toBe(0)
    expect(p.error_mm).toBeLessThan(ALIGN_TOLERANCE_MM)
    // KiCad's pads' centre is 1.4975 mm above its origin; the model's origin 1.1 mm below that, so 0.3975 mm above
    // the origin, which is +0.3975 in KiCad's model frame (y up)
    expect(p.offset[0]).toBeCloseTo(0, 2)
    expect(p.offset[1]).toBeCloseTo(0.3975, 1)
    expect(p.offset[2]).toBeCloseTo(0.85, 2)
    expect(p.rotate).toEqual([0, 0, 180])
    // the same footprint turned a quarter: found, and the model turned with it
    const turned = j1.pads.map((q) => quarter(q, 1))
    const t = placeOn(m, turned)!
    expect(t.turns).toBe(1)
    expect(t.rotate[2]).toBe(90)
    // a different land pattern: not placed
    expect(placeOn(m, [[0, 0], [5, 0]])).toBeNull()
  })

  it('replaces the footprint\'s model, or adds one, leaving the rest of it as it was', () => {
    const fp = '(footprint "x" (layer "F.Cu")\n\t\t(pad "1" smd rect (at 0 0) (size 1 1))\n\t\t(model "${KICAD10_3DMODEL_DIR}/a.step"\n\t\t\t(offset (xyz 0 0 0))\n\t\t)\n\t)'
    const out = withModel(fp, '(model "new.step" (offset (xyz 1 2 3)))')
    const models = walk(parse(out), 'model')
    expect(models.map((m) => m[1])).toEqual(['new.step'])
    expect(out).toContain('(pad "1" smd rect (at 0 0) (size 1 1))')
    expect(walk(parse(withModel('(footprint "y" (pad "1"))', '(model "n.step")')), 'model').map((m) => m[1])).toEqual(['n.step'])
  })
})

describe('fetching it for the export', () => {
  const setup = () => {
    const base = tmp()
    const pcb = join(base, 'hardware', 'board.kicad_pcb')
    return { base, pcb, stage: join(base, 'trace-3dmodels'), cacheDir: tmp() }
  }

  it('fetches the part and its STEP once, stages it, and points J1 at it through ${KIPRJMOD}', async () => {
    const { pcb, stage, cacheDir } = setup()
    const asked: string[] = []
    const get = async (url: string): Promise<Uint8Array | null> => {
      asked.push(url)
      if (url === EASYEDA_PART('C165948')) return new TextEncoder().encode(JSON.stringify(ANSWER))
      if (url === EASYEDA_STEP('617b05f9bba7410b96c001093d8189e4')) return new TextEncoder().encode('ISO-10303-21; usb-c')
      return null
    }
    const need = bodiless(boardFootprints(BOARD), new Set([USB]))
    const r = await vendorBodies(pcb, BOARD, need, stage, { get, cacheDir })
    expect(r.missing).toEqual([])
    expect(r.got).toEqual([{ ref: 'J1', lcsc: 'C165948', source: 'easyeda', file: `../trace-3dmodels/${VENDOR_DIR}/C165948.step`, turns: 0, error_mm: expect.any(Number) }])
    expect(readFileSync(join(stage, VENDOR_DIR, 'C165948.step'), 'utf8')).toBe('ISO-10303-21; usb-c')
    const j1 = boardFootprints(r.text)[1]!
    expect(j1.models).toEqual([`\${KIPRJMOD}/../trace-3dmodels/${VENDOR_DIR}/C165948.step`])
    // the other footprints are as they were
    expect(boardFootprints(r.text)[0]!.models).toEqual(boardFootprints(BOARD)[0]!.models)
    // a second export reads the cache
    asked.length = 0
    await vendorBodies(pcb, BOARD, need, stage, { get, cacheDir })
    expect(asked).toEqual([])
  })

  it('without the network, or for a part EasyEDA has no model of, the part stays without a body, saying why', async () => {
    const { pcb, stage, cacheDir } = setup()
    const need = bodiless(boardFootprints(BOARD), new Set([USB]))
    const off = await vendorBodies(pcb, BOARD, need, stage, { get: async () => { throw new Error('getaddrinfo ENOTFOUND easyeda.com') }, cacheDir })
    expect(off.got).toEqual([])
    expect(off.text).toBe(BOARD)
    expect(off.missing).toEqual([{ ref: 'J1', footprint: 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12', lcsc: 'C165948', why: 'EasyEDA could not be reached (getaddrinfo ENOTFOUND easyeda.com)' }])
    expect(existsSync(join(stage, VENDOR_DIR))).toBe(false)
    const none = await vendorBodies(pcb, BOARD, need, stage, { get: async () => null, cacheDir: tmp() })
    expect(none.missing[0]!.why).toBe('EasyEDA does not know C165948')
    const noCode = await vendorBodies(pcb, BOARD, need.map((f) => ({ ...f, lcsc: null })), stage, { get: async () => null, cacheDir: tmp() })
    expect(noCode.missing[0]!.why).toMatch(/no LCSC part code/)
    expect(bodiesNote({ vendor: [], missing: off.missing })).toBe('no 3D body for J1 (EasyEDA could not be reached (getaddrinfo ENOTFOUND easyeda.com))')
    expect(bodiesNote({ vendor: [{ ref: 'J1', lcsc: 'C165948', source: 'easyeda', file: 'x', turns: 0, error_mm: 0.1 }], missing: [] })).toMatch(/^J1 \(LCSC C165948\) drawn with the vendor's 3D model from EasyEDA/)
  })
})
