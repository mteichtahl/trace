/**
 * A board's library 3D models, fetched for its export (src/tools/kicad/models3d.ts): testyyyu's renders had no component
 * bodies because the images carry no kicad-packages3D.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_VARS, MODELS_DIR, MODELS_REPO, modelRefs, stageModels, tagsFor, variants } from '../../../src/tools/kicad/models3d.js'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'models3d-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// as testyyyu's board names them (KiCad 10), plus a project's own model and two that must never be fetched
const PCB = `(kicad_pcb (version 20240108)
  (footprint "Resistor_SMD:R_0603_1608Metric" (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0 0 0))))
  (footprint "Resistor_SMD:R_0603_1608Metric" (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"))
  (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (model "\${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step"))
  (footprint "Old:Part" (model "\${KISYS3DMOD}/LED_SMD.3dshapes/LED_0603_1608Metric.wrl"))
  (footprint "Mine:Case" (model "\${KIPRJMOD}/models/case.step"))
  (footprint "Bad:Climb" (model "\${KICAD10_3DMODEL_DIR}/../../etc/passwd.step"))
  (footprint "Bad:Exe" (model "\${KICAD10_3DMODEL_DIR}/x.3dshapes/run.sh"))
)`

describe('the models a board names', () => {
  it('are its library references, each once; a project\'s own model and anything climbing out or not a model are left', () => {
    expect(modelRefs(PCB)).toEqual([
      'Resistor_SMD.3dshapes/R_0603_1608Metric.step',
      'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step',
      'LED_SMD.3dshapes/LED_0603_1608Metric.wrl',
    ])
  })
  it('come from the kicad-cli version\'s tag, then its major\'s .0.0, then master', () => {
    expect(tagsFor('10.0.8')).toEqual(['10.0.8', '10.0.0', 'master'])
    expect(tagsFor('10.0.0')).toEqual(['10.0.0', 'master'])
    expect(tagsFor(null)).toEqual(['master'])
  })
  it('a GLB export reads the .step; a VRML export the .wrl, with the .step as well', () => {
    expect(variants('A.3dshapes/b.step', 'glb')).toEqual(['A.3dshapes/b.step'])
    expect(variants('A.3dshapes/b.wrl', 'glb')).toEqual(['A.3dshapes/b.step'])
    expect(variants('A.3dshapes/b.step', 'wrl')).toEqual(['A.3dshapes/b.wrl', 'A.3dshapes/b.step'])
  })
})

describe('staging them for an export', () => {
  const setup = () => {
    const base = tmp()
    const pcb = join(base, 'board.kicad_pcb')
    writeFileSync(pcb, PCB)
    return { base, pcb, cacheDir: tmp() }
  }

  it('fetches each from the first tag that has it, caches it, stages it in the project, and points every model variable there', async () => {
    const { base, pcb, cacheDir } = setup()
    const asked: string[] = []
    // 10.0.8 has the resistor, only 10.0.0 has the SOIC, no tag has the old LED
    const get = async (url: string): Promise<Uint8Array | null> => {
      asked.push(url.slice(MODELS_REPO.length + 1))
      if (url.includes('/10.0.8/Resistor_SMD')) return new TextEncoder().encode('STEP resistor')
      if (url.includes('/10.0.0/Package_SO')) return new TextEncoder().encode('STEP soic')
      return null
    }
    const s = await stageModels(pcb, base, 'glb', { get, cacheDir, version: '10.0.8' })
    expect(s.dir).toBe(join(base, MODELS_DIR))
    expect(s.staged).toEqual(['Resistor_SMD.3dshapes/R_0603_1608Metric.step', 'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step'])
    expect(s.missing.map((m) => m.rel)).toEqual(['LED_SMD.3dshapes/LED_0603_1608Metric.wrl'])
    expect(readFileSync(join(base, MODELS_DIR, 'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step'), 'utf8')).toBe('STEP soic')
    expect(Object.keys(s.env).sort()).toEqual([...MODEL_VARS].sort())
    expect(new Set(Object.values(s.env))).toEqual(new Set([s.dir]))
    expect(s.note).toBe('2 of 3 component models from KiCad\'s 3D library; without a body: LED_0603_1608Metric.wrl')
    // each URL is a path under the repository, encoded
    expect(asked).toContain('10.0.8/Resistor_SMD.3dshapes/R_0603_1608Metric.step')
    expect(asked).toContain('10.0.0/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step')
    expect(asked.every((a) => !a.includes('..'))).toBe(true)
    // cached under the tag it came from: a second board on this machine asks for none of them again
    expect(readFileSync(join(cacheDir, '10.0.0', 'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step'), 'utf8')).toBe('STEP soic')
    s.remove()
    expect(existsSync(join(base, MODELS_DIR))).toBe(false)
    asked.length = 0
    const again = await stageModels(pcb, base, 'glb', { get, cacheDir, version: '10.0.8' })
    expect(again.staged).toHaveLength(2)
    expect(asked.filter((a) => !a.includes('LED_SMD'))).toEqual([])
    again.remove()
  })

  it('a failed fetch leaves that body out and says why; the export still runs', async () => {
    const { base, pcb, cacheDir } = setup()
    const s = await stageModels(pcb, base, 'glb', { get: async () => { throw new Error('GET …: 503') }, cacheDir, version: '10.0.8' })
    expect(s.staged).toEqual([])
    expect(s.missing.map((m) => m.why)).toEqual(['GET …: 503', 'GET …: 503', 'GET …: 503'])
    expect(s.note).toMatch(/^0 of 3 component models/)
    s.remove()
  })

  it('a board with no library model stages nothing and changes no variable', async () => {
    const base = tmp()
    const pcb = join(base, 'b.kicad_pcb')
    writeFileSync(pcb, '(kicad_pcb (footprint "x" (model "${KIPRJMOD}/m.step")))')
    const s = await stageModels(pcb, base, 'glb', { get: async () => { throw new Error('not asked') }, cacheDir: tmp(), version: '10.0.8' })
    expect(s).toMatchObject({ dir: null, staged: [], missing: [], env: {}, note: null })
  })
})
