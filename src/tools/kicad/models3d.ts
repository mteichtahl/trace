/**
 * The 3D models a board names from KiCad's own library, fetched for the export that needs them (a render's GLB or
 * VRML). The tools and GPU images carry KiCad and its footprints but not kicad-packages3D (several GB), so without this
 * every footprint's `(model "${KICAD10_3DMODEL_DIR}/…")` resolves to nothing and a render shows no component bodies
 * (testyyyu: 12 parts, 0 bodies).
 *
 *   refs     every `(model "${KICADn_3DMODEL_DIR}/<path>")` (and the older ${KISYS3DMOD}) in the .kicad_pcb; a model
 *            the project carries itself (${KIPRJMOD}, a relative or absolute path) already travels with the project
 *   source   KiCad's library repository at the tag of the kicad-cli in use (10.0.8), else <major>.0.0, else master:
 *            the .step a GLB export reads and, for a VRML export, the .wrl beside it
 *   cache    a folder kept on this machine (TRACE_KICAD_3D_CACHE, else ~/.cache/trace/kicad-3d), so a part is fetched
 *            once per machine and tag
 *   staged   into MODELS_DIR inside the folder the export runs from (packBase: the repository, else the project's), so a
 *            remote kicad-cli (src/tools/kicad/remote.ts) carries them with the project; every KICADn_3DMODEL_DIR is
 *            pointed there, here (modelEnv) and in the remote job (src/gpu/kicad-job.ts). The folder is removed after
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The folder the board's library models are staged in, inside the folder the export runs from. */
export const MODELS_DIR = 'trace-3dmodels'
/** The KiCad versions whose model variable is pointed at the staged folder (a board names its own version's). */
export const MODEL_VARS = ['KICAD6_3DMODEL_DIR', 'KICAD7_3DMODEL_DIR', 'KICAD8_3DMODEL_DIR', 'KICAD9_3DMODEL_DIR', 'KICAD10_3DMODEL_DIR', 'KICAD11_3DMODEL_DIR', 'KISYS3DMOD']
export const MODELS_REPO = 'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw'
/** At most this many models per board, and this many bytes per model (a STEP of a large connector is a few MB). */
export const MAX_MODELS = 300
export const MAX_MODEL_BYTES = 25 * 1024 * 1024

const REF = /\(model\s+"\$\{(?:KICAD\d+_3DMODEL_DIR|KISYS3DMOD)\}\/([^"]+)"/g
/** A library path: folders and a file name of KiCad's own characters, a 3D model's extension, nothing climbing out. */
const SAFE = /^[A-Za-z0-9_.,+()\- ]+(\/[A-Za-z0-9_.,+()\- ]+)*\.(step|stp|wrl|wrz)$/i

/** The library model paths a board names (relative to the library root), each once, in order. */
export function modelRefs(pcbText: string): string[] {
  const out: string[] = []
  for (const m of pcbText.matchAll(REF)) {
    const rel = m[1]!
    if (SAFE.test(rel) && !rel.split('/').includes('..') && !out.includes(rel)) out.push(rel)
  }
  return out
}

/** The tags to try for a kicad-cli version ("10.0.8"): its own, its major's .0.0, then master. */
export function tagsFor(version: string | null): string[] {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return v ? [...new Set([`${v[1]}.${v[2]}.${v[3]}`, `${v[1]}.0.0`, 'master'])] : ['master']
}

/** The files to fetch for one reference: the .step a GLB reads; for VRML, the .wrl beside it (KiCad substitutes). */
export function variants(rel: string, format: 'glb' | 'wrl'): string[] {
  const stem = rel.replace(/\.(step|stp|wrl|wrz)$/i, '')
  return format === 'glb' ? [`${stem}.step`] : [`${stem}.wrl`, `${stem}.step`]
}

export interface ModelDeps {
  /** GET a URL: its bytes, or null when it is not there (404); throws on anything else */
  get: (url: string) => Promise<Uint8Array | null>
  cacheDir: string
  version: string | null
}

export const defaultCacheDir = (): string => process.env.TRACE_KICAD_3D_CACHE || join(homedir(), '.cache', 'trace', 'kicad-3d')

export async function httpGet(url: string): Promise<Uint8Array | null> {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`)
  const len = Number(r.headers.get('content-length') ?? 0)
  if (len > MAX_MODEL_BYTES) throw new Error(`${url} is ${len} bytes (at most ${MAX_MODEL_BYTES})`)
  const b = new Uint8Array(await r.arrayBuffer())
  if (b.length > MAX_MODEL_BYTES) throw new Error(`${url} is ${b.length} bytes (at most ${MAX_MODEL_BYTES})`)
  return b
}

/** One library file: from the cache under any of the tags, else the first tag that has it (and then cached); null when
 * no tag has it. The cache is looked at first for every tag, so a part found at a fallback tag is not asked again. */
async function one(rel: string, d: ModelDeps): Promise<Uint8Array | null> {
  const tags = tagsFor(d.version)
  for (const tag of tags) {
    const cached = join(d.cacheDir, tag, rel)
    if (existsSync(cached) && statSync(cached).size > 0) return readFileSync(cached)
  }
  for (const tag of tags) {
    const cached = join(d.cacheDir, tag, rel)
    const b = await d.get(`${MODELS_REPO}/${encodeURIComponent(tag)}/${rel.split('/').map(encodeURIComponent).join('/')}`)
    if (b) {
      mkdirSync(dirname(cached), { recursive: true })
      writeFileSync(cached, b)
      return b
    }
  }
  return null
}

export interface Staged {
  /** the staged folder (inside `base`), or null when the board names no library model */
  dir: string | null
  /** library paths staged, and those no tag had (or that could not be fetched, with why) */
  staged: string[]
  missing: { rel: string; why: string }[]
  /** the environment that points kicad-cli's model variables at `dir` */
  env: Record<string, string>
  /** in words, for the render's notes: how many bodies the export can draw */
  note: string | null
  remove(): void
}

/** Stage the library models `pcb` names into `base`/MODELS_DIR for an export in `format`. Never throws for a model it
 * cannot get: the export still runs, without that body, and `missing` says which. */
export async function stageModels(pcb: string, base: string, format: 'glb' | 'wrl', d: ModelDeps): Promise<Staged> {
  const refs = modelRefs(readFileSync(pcb, 'utf8')).slice(0, MAX_MODELS)
  if (!refs.length) return { dir: null, staged: [], missing: [], env: {}, note: null, remove: () => undefined }
  const dir = join(base, MODELS_DIR)
  const staged: string[] = []
  const missing: { rel: string; why: string }[] = []
  for (const rel of refs) {
    let got = 0
    let why = 'not in KiCad\'s 3D library at this version'
    for (const v of variants(rel, format)) {
      try {
        const b = await one(v, d)
        if (!b) continue
        mkdirSync(dirname(join(dir, v)), { recursive: true })
        writeFileSync(join(dir, v), b)
        got++
      } catch (e) {
        why = e instanceof Error ? e.message : String(e)
      }
    }
    if (got) staged.push(rel)
    else missing.push({ rel, why })
  }
  const env = Object.fromEntries(MODEL_VARS.map((k) => [k, dir]))
  const note = missing.length
    ? `${staged.length} of ${refs.length} component models from KiCad's 3D library; without a body: ${missing.slice(0, 5).map((m) => m.rel.split('/').pop()).join(', ')}${missing.length > 5 ? ', …' : ''}`
    : null
  return { dir, staged, missing, env, note, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
