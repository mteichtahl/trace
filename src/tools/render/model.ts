/**
 * Getting a model Blender can import. A KiCad board is exported by kicad-cli: GLB (`pcb export glb`, with tracks,
 * pads, zones, silkscreen and mask) when this Blender's glTF importer works, else VRML (`pcb export vrml --units m`),
 * which Blender reads with its pure-Python X3D/VRML importer. The glTF importer needs numpy, which distribution builds
 * of Blender that use the system Python (Ubuntu's `blender` package) often lack; VRML always works and carries the same
 * board, layers and component models with KiCad's colours.
 *
 * Blender has no STEP importer, so a STEP (an enclosure, an assembly) is tessellated by kicad-cli too: it is placed as
 * the 3D model of one footprint on an otherwise empty board and that board is exported (GLB without a board body, or
 * VRML, whose stand-in board the script drops).
 */
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { findRoot } from '../../core/store.js'
import { type ModelDeps, MODELS_DIR, defaultCacheDir, httpGet, stageModels } from '../kicad/models3d.js'
import { type BoardFootprint, type NoBody, type VendorBody, boardFootprints, vendorBodies } from '../kicad/vendor3d.js'
import { kicadCliVersion, runCli } from '../kicad/project.js'
import { packBase } from '../kicad/remote.js'

export const MODEL_EXTS = ['.glb', '.gltf', '.wrl', '.vrml', '.x3d', '.stl', '.obj', '.ply', '.fbx', '.step', '.stp'] as const
export type BoardFormat = 'glb' | 'wrl'

export interface Prepared {
  /** the file Blender imports */
  path: string
  /** its format for the script */
  format: string
  /** extra files it needs beside it (an OBJ's .mtl), name → path */
  extra: Record<string, string>
  /** the model is Z-up (KiCad's exports) */
  zUp: boolean
  /** VRML from a STEP wrapper: the script removes KiCad's stand-in board */
  dropKicadBoard: boolean
  /** in words, for the render's notes (a board's component models that could not be had) */
  note?: string
  /** a board's parts drawn with their vendor's model, and those drawn without a body (and why) */
  bodies?: Bodies
}

export interface Bodies { vendor: VendorBody[]; missing: NoBody[] }

const LIBRARY_MODEL = /^\$\{(?:KICAD\d+_3DMODEL_DIR|KISYS3DMOD)\}\/(.+)$/

/**
 * The footprints the export would draw without a body: those whose library models KiCad's 3D library does not have
 * (`missing`, from ./models3d.ts), and those that name no model at all, leaving out what is only the board (mounting
 * holes, fiducials, logos). A model the project carries itself is its own.
 */
export function bodiless(fps: readonly BoardFootprint[], missing: ReadonlySet<string>): BoardFootprint[] {
  return fps.filter((fp) => {
    if (fp.boardOnly || !fp.pads.length) return false
    if (!fp.models.length) return true
    return fp.models.every((m) => {
      const rel = LIBRARY_MODEL.exec(m)?.[1]
      return rel !== undefined && missing.has(rel)
    })
  })
}

/** The bodies in words, for the render's notes. */
export function bodiesNote(b: Bodies): string | null {
  const parts: string[] = []
  if (b.vendor.length) parts.push(`${b.vendor.map((v) => `${v.ref} (LCSC ${v.lcsc})`).join(', ')} drawn with the vendor's 3D model from EasyEDA: KiCad's 3D library has none`)
  if (b.missing.length) parts.push(`no 3D body for ${b.missing.slice(0, 8).map((m) => `${m.ref} (${m.why})`).join('; ')}${b.missing.length > 8 ? `; and ${b.missing.length - 8} more` : ''}`)
  return parts.length ? parts.join('. ') : null
}

/**
 * Export a board's 3D model into `dir`, with the component models it names from KiCad's library fetched for it first
 * (../kicad/models3d.ts: the images do not carry the library). `models` is for tests.
 */
export async function exportBoard(pcb: string, dir: string, format: BoardFormat, models?: ModelDeps): Promise<Prepared> {
  const deps = models ?? { get: httpGet, cacheDir: defaultCacheDir(), version: await kicadCliVersion() }
  const base = packBase(pcb)
  const staged = await stageModels(pcb, base, format, deps)
  const stageDir = staged.dir ?? join(base, MODELS_DIR)
  // the parts KiCad's library has no body for: their vendor's model, on a copy of the board that names it
  let board = pcb
  let copy: string | null = null
  let madeStage = false
  try {
    const text = readFileSync(pcb, 'utf8')
    const need = bodiless(boardFootprints(text), new Set(staged.missing.map((m) => m.rel)))
    let bodies: Bodies | undefined
    if (need.length) {
      madeStage = !staged.dir
      const v = await vendorBodies(pcb, text, need, stageDir, { get: deps.get, cacheDir: deps.cacheDir })
      const lib = new Set(staged.missing.map((m) => m.rel))
      const why = (m: NoBody): string => {
        const fp = need.find((f) => f.ref === m.ref)
        const own = fp?.models.length ? (fp.models.some((x) => lib.has(LIBRARY_MODEL.exec(x)?.[1] ?? '')) ? 'not in KiCad\'s 3D library' : 'its model could not be had') : 'its footprint names no 3D model'
        return `${own}; ${m.why}`
      }
      bodies = { vendor: v.got, missing: v.missing.map((m) => ({ ...m, why: why(m) })) }
      if (v.got.length) {
        // beside the board, so ${KIPRJMOD} and a remote kicad-cli (src/tools/kicad/remote.ts) read the same files
        copy = join(dirname(pcb), `trace-render-${process.pid}-${Date.now()}.kicad_pcb`)
        writeFileSync(copy, v.text)
        board = copy
      }
    }
    const said = bodies ? bodiesNote(bodies) : staged.note
    const note = { ...(said ? { note: said } : {}), ...(bodies ? { bodies } : {}) }
    if (format === 'glb') {
      const out = join(dir, 'board.glb')
      await runCli(['pcb', 'export', 'glb', '--subst-models', '--include-tracks', '--include-pads', '--include-zones',
        '--include-silkscreen', '--include-soldermask', '-f', '-o', out, board], { timeoutMs: 900_000, env: staged.env })
      return { path: out, format: 'glb', extra: {}, zUp: true, dropKicadBoard: false, ...note }
    }
    const out = join(dir, 'board.wrl')
    await runCli(['pcb', 'export', 'vrml', '--units', 'm', '-f', '-o', out, board], { timeoutMs: 900_000, env: staged.env })
    return { path: out, format: 'wrl', extra: {}, zUp: true, dropKicadBoard: false, ...note }
  } finally {
    if (copy) rmSync(copy, { force: true })
    staged.remove()
    if (madeStage) rmSync(stageDir, { recursive: true, force: true })
  }
}

/** A STEP tessellated through kicad-cli (see the module note). */
export async function stepToMesh(step: string, dir: string, format: BoardFormat): Promise<Prepared> {
  const pcb = join(dir, 'step-wrapper.kicad_pcb')
  const q = (s: string): string => JSON.stringify(s)
  // the model beside the wrapper, named relative to it: where kicad-cli runs elsewhere (the tools function), the
  // wrapper's folder is what travels with the job (src/tools/kicad/remote.ts)
  const local = `model${extname(step).toLowerCase() || '.step'}`
  copyFileSync(resolve(step), join(dir, local))
  writeFileSync(pcb, `(kicad_pcb (version 20240108) (generator "trace") (generator_version "8.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (footprint "trace:model" (layer "F.Cu") (at 0 0)
    (model ${q(`\${KIPRJMOD}/${local}`)} (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
  )
)
`)
  if (format === 'glb') {
    const out = join(dir, 'model.glb')
    await runCli(['pcb', 'export', 'glb', '--no-board-body', '-f', '-o', out, pcb], { timeoutMs: 900_000 })
    return { path: out, format: 'glb', extra: {}, zUp: true, dropKicadBoard: false }
  }
  const out = join(dir, 'model.wrl')
  await runCli(['pcb', 'export', 'vrml', '--units', 'm', '-f', '-o', out, pcb], { timeoutMs: 900_000 })
  return { path: out, format: 'wrl', extra: {}, zUp: true, dropKicadBoard: true }
}

/** A model file as Blender will import it (STEP converted first). */
export async function prepareModel(path: string, dir: string, format: BoardFormat): Promise<Prepared> {
  const ext = extname(path).toLowerCase()
  if (!(MODEL_EXTS as readonly string[]).includes(ext)) {
    throw new ToolError(`${path}: not a model trace renders (${MODEL_EXTS.join(', ')})`)
  }
  if (ext === '.step' || ext === '.stp') return stepToMesh(path, dir, format)
  const extra: Record<string, string> = {}
  if (ext === '.obj') {
    // the materials an OBJ names (mtllib) travel with it
    for (const m of readFileSync(path, 'utf8').matchAll(/^mtllib\s+(\S+)\s*$/gm)) {
      const name = m[1] as string
      const p = join(dirname(path), name)
      if (/^[\w.-]+$/.test(name) && existsSync(p)) extra[name] = p
    }
  }
  if (ext === '.gltf') {
    throw new ToolError(`${path}: a .gltf refers to side files; export a .glb (one file) instead`)
  }
  return { path, format: ext.slice(1).replace('vrml', 'wrl').replace('stp', 'step'), extra, zUp: false, dropKicadBoard: false }
}

/** A path from a tool argument: absolute, or relative to the repository root (else the working directory). */
export function inRepo(p: string): string {
  if (isAbsolute(p)) return p
  const root = findRoot() ?? process.cwd()
  const r = resolve(root, p)
  return existsSync(r) ? r : resolve(p)
}

/** The commit checked out in the repository holding `start` (read from .git, without running git), or null. */
export function commitOf(start: string): string | null {
  let d = resolve(start)
  try {
    if (!statSync(d).isDirectory()) d = dirname(d)
  } catch {
    return null
  }
  for (;;) {
    const g = join(d, '.git')
    if (existsSync(g)) {
      let gitDir = g
      try {
        if (statSync(g).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'))
          if (!m?.[1]) return null
          gitDir = resolve(d, m[1].trim())
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
        const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
        if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : null
        // a worktree keeps refs in the common directory
        const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()) : gitDir
        for (const base of [gitDir, common]) {
          const f = join(base, ref)
          if (existsSync(f)) return readFileSync(f, 'utf8').trim()
          const packed = join(base, 'packed-refs')
          if (existsSync(packed)) {
            const line = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))
            if (line) return line.split(' ')[0] ?? null
          }
        }
        return null
      } catch {
        return null
      }
    }
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}
