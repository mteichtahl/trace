/**
 * A part's 3D body from its vendor, for a footprint whose own model KiCad's 3D library does not have (test-esp32 #214:
 * J1, the HRO TYPE-C-31-M-12 USB-C socket, names a .step that kicad-packages3D has never held, so the render showed
 * bare board edge in the case's USB opening). A footprint with an LCSC part code gets the model EasyEDA keeps for that
 * part, the one LCSC and JLCPCB show:
 *
 *   part     easyeda.com/api/products/<LCSC>/components: the part's footprint (its pads, in EasyEDA units of 10 mil,
 *            y down) and its 3D model (an `outline3D` node: the model's uuid, where its origin sits on the footprint,
 *            its height offset and its rotation)
 *   model    modules.easyeda.com/…/<uuid>: the STEP
 *   cache    under the KiCad 3D cache (./models3d.ts defaultCacheDir)/easyeda, so a part is fetched once per machine
 *   placed   EasyEDA's footprint and KiCad's are drawn from the same land pattern but not around the same origin, nor
 *            always the same way round. The pads say how they lie: EasyEDA's pad centres are turned by a quarter turn
 *            at a time and moved so their bounds' centre is KiCad's, the turn whose pads land nearest KiCad's is
 *            taken, and the model's origin goes through the same move. Pads that do not match (more than
 *            ALIGN_TOLERANCE_MM apart on average) mean a different land pattern: the model is not used and the part
 *            stays without a body, said so.
 *
 * The export runs on a copy of the board (in the board's folder, so ${KIPRJMOD} and a remote kicad-cli see the same
 * files) whose footprint names the fetched model, beside the library models in ./models3d.ts's staged folder. Nothing
 * here changes the person's board. Without the network (or when EasyEDA does not answer) the part stays without a body,
 * and the result says which parts and why.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { atomAt, find, findAll, isAtom, isList, num, parse, value, type SList } from './sexpr.js'

export const EASYEDA_PART = (lcsc: string): string => `https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components?version=6.4.19.5`
export const EASYEDA_STEP = (uuid: string): string => `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${encodeURIComponent(uuid)}`
/** EasyEDA's footprint unit, 10 mil, in mm. */
export const EASYEDA_UNIT_MM = 0.254
/** Pads further apart than this on average (mm) are not the same land pattern. */
export const ALIGN_TOLERANCE_MM = 0.35
/** The folder fetched models go in, inside ./models3d.ts's staged folder. */
export const VENDOR_DIR = 'vendor'
/** At most this many parts are asked of EasyEDA in one export. */
export const MAX_VENDOR_PARTS = 40

const LCSC = /^C\d{1,10}$/i
const LCSC_FIELD = /^(lcsc|jlc|jlcpcb)(\s*(part|pn|#|no\.?|number|code))*\s*#?$/i

// ------------------------------------------------------------------ the board's footprints

export interface BoardFootprint {
  /** its reference (J1), or its library name when it has none */
  ref: string
  lib: string
  /** its LCSC part code, from a property such as LCSC or "LCSC Part" */
  lcsc: string | null
  back: boolean
  /** a mounting hole, a fiducial or a logo: drawn as the board, never as a part */
  boardOnly: boolean
  /** the model paths it names */
  models: string[]
  /** its pads' centres in its own frame (mm, y down), as placed on the front */
  pads: [number, number][]
  /** where its text is in the board file: [start, end) */
  span: [number, number]
}

/** The [start, end) of each top-level (footprint …) in a board file, skipping strings. */
export function footprintSpans(text: string): [number, number][] {
  const out: [number, number][] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 34) {
      // a string: to its closing quote, past escaped ones
      for (i++; i < text.length && text.charCodeAt(i) !== 34; i++) if (text.charCodeAt(i) === 92) i++
      continue
    }
    if (c === 40) {
      depth++
      if (depth === 2 && text.startsWith('(footprint', i) && /[\s"]/.test(text[i + 10] ?? '')) start = i
    } else if (c === 41) {
      if (depth === 2 && start >= 0) { out.push([start, i + 1]); start = -1 }
      depth--
    }
  }
  return out
}

/** The board's footprints: what a body for each needs. */
export function boardFootprints(text: string): BoardFootprint[] {
  return footprintSpans(text).flatMap(([s, e]) => {
    let fp: SList
    try { fp = parse(text.slice(s, e)) } catch { return [] }
    const lib = atomAt(fp, 1) ?? ''
    const props = new Map<string, string>()
    for (const p of findAll(fp, 'property')) {
      const k = atomAt(p, 1)
      const v = atomAt(p, 2)
      if (k !== undefined && v !== undefined) props.set(k, v)
    }
    // KiCad 6 and older wrote the reference as (fp_text reference "J1")
    const ref = props.get('Reference') ?? findAll(fp, 'fp_text').find((t) => t[1] === 'reference')?.[2]
    const code = [...props].find(([k, v]) => LCSC_FIELD.test(k.trim()) && LCSC.test(v.trim()))?.[1].trim().toUpperCase() ?? null
    const attr = find(fp, 'attr')
    const attrs = attr ? attr.slice(1).filter(isAtom) : []
    const back = value(fp, 'layer') === 'B.Cu'
    const pads = findAll(fp, 'pad').flatMap((p) => {
      const at = find(p, 'at')
      const x = num(at?.[1])
      const y = num(at?.[2])
      // a back footprint's pads are stored flipped (y negated); its model is placed before the flip
      return x === undefined || y === undefined ? [] : [[x, back ? -y : y] as [number, number]]
    })
    return [{
      ref: isAtom(ref) && ref ? ref : lib, lib, lcsc: code, back,
      boardOnly: attrs.includes('board_only') || /^(MountingHole|Fiducial|TestPoint|Symbol|Logo)/i.test(lib),
      models: findAll(fp, 'model').map((m) => atomAt(m, 1)).filter((m): m is string => typeof m === 'string'),
      pads, span: [s, e],
    }]
  })
}

// ------------------------------------------------------------------ EasyEDA's part

export interface VendorModel {
  uuid: string
  /** the model's origin, relative to the centre of the footprint's pad bounds (mm, y down) */
  origin: [number, number]
  /** how far the model is raised onto the board (mm) */
  z: number
  /** its rotation about x, y and z (degrees, as KiCad's model rotate takes them) */
  rotate: [number, number, number]
  /** the footprint's pad and hole centres, relative to the same centre (mm, y down) */
  pads: [number, number][]
}

/** The centre of the bounds of a set of points. */
export function boundsCentre(pts: readonly (readonly [number, number])[]): [number, number] {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

/** The model and footprint in EasyEDA's answer for one part, or null when it has no 3D model. */
export function easyedaModel(answer: unknown): VendorModel | null {
  const pkg = (answer as { result?: { packageDetail?: { dataStr?: { shape?: unknown } } } } | null)?.result?.packageDetail?.dataStr
  const shapes = Array.isArray(pkg?.shape) ? (pkg.shape as unknown[]).filter((s): s is string => typeof s === 'string') : []
  const raw: [number, number][] = []
  let model: { uuid: string; origin: [number, number]; z: number; rot: number[] } | null = null
  for (const s of shapes) {
    const f = s.split('~')
    if (f[0] === 'PAD' || f[0] === 'HOLE') {
      // PAD~shape~x~y~…; HOLE~x~y~r~…
      const [x, y] = f[0] === 'PAD' ? [Number(f[2]), Number(f[3])] : [Number(f[1]), Number(f[2])]
      if (Number.isFinite(x) && Number.isFinite(y)) raw.push([x, y])
    } else if (f[0] === 'SVGNODE' && !model) {
      try {
        const a = (JSON.parse(s.slice('SVGNODE~'.length)) as { attrs?: Record<string, string> }).attrs ?? {}
        const o = String(a.c_origin ?? '').split(',').map(Number)
        if (a.c_etype === 'outline3D' && typeof a.uuid === 'string' && /^[0-9a-f]{32}$/i.test(a.uuid) && o.length === 2 && o.every(Number.isFinite)) {
          const r = String(a.c_rotation ?? '0,0,0').split(',').map(Number)
          model = { uuid: a.uuid, origin: [o[0] as number, o[1] as number], z: Number(a.z ?? 0) || 0, rot: r.length === 3 && r.every(Number.isFinite) ? r : [0, 0, 0] }
        }
      } catch { /* not a node trace reads */ }
    }
  }
  if (!model || !raw.length) return null
  const c = boundsCentre(raw)
  const mm = (p: readonly [number, number]): [number, number] => [(p[0] - c[0]) * EASYEDA_UNIT_MM, (p[1] - c[1]) * EASYEDA_UNIT_MM]
  const turn = (d: number): number => (360 - d) % 360
  return {
    uuid: model.uuid, origin: mm(model.origin), z: -model.z * EASYEDA_UNIT_MM,
    rotate: [turn(model.rot[0] as number), turn(model.rot[1] as number), turn(model.rot[2] as number)],
    pads: raw.map(mm),
  }
}

// ------------------------------------------------------------------ placing it on KiCad's footprint

/** A quarter turn k times, in y-down coordinates (each turn is clockwise as drawn). */
export const quarter = (p: readonly [number, number], k: number): [number, number] => {
  let [x, y] = p
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x]
  return [x + 0, y + 0]
}

/** The mean distance from each point to the nearest of the others, both ways. */
export function padDistance(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): number {
  const near = (p: readonly [number, number], set: readonly (readonly [number, number])[]): number => Math.min(...set.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))
  const d = [...a.map((p) => near(p, b)), ...b.map((p) => near(p, a))]
  return d.reduce((s, x) => s + x, 0) / d.length
}

export interface Placement { offset: [number, number, number]; rotate: [number, number, number]; turns: number; error_mm: number }

/**
 * Where the vendor's model goes on KiCad's footprint (the module note): its offset (mm, KiCad's model frame: y up) and
 * rotation, or null when the pads do not match.
 */
export function placeOn(model: VendorModel, kicadPads: readonly (readonly [number, number])[]): Placement | null {
  if (!kicadPads.length || !model.pads.length) return null
  const kc = boundsCentre(kicadPads)
  const k0 = kicadPads.map((p) => [p[0] - kc[0], p[1] - kc[1]] as [number, number])
  let best: { k: number; err: number } | null = null
  for (let k = 0; k < 4; k++) {
    const turned = model.pads.map((p) => quarter(p, k))
    const tc = boundsCentre(turned)
    const err = padDistance(turned.map((p) => [p[0] - tc[0], p[1] - tc[1]] as [number, number]), k0)
    // a symmetric land pattern fits more than one way: the first (fewest turns) is kept
    if (!best || err < best.err - 1e-6) best = { k, err }
  }
  if (!best || best.err > ALIGN_TOLERANCE_MM) return null
  const turned = model.pads.map((p) => quarter(p, best.k))
  const tc = boundsCentre(turned)
  const o = quarter(model.origin, best.k)
  const at: [number, number] = [o[0] - tc[0] + kc[0], o[1] - tc[1] + kc[1]]
  const r = (v: number): number => Math.round(v * 1e4) / 1e4 + 0
  // a clockwise quarter turn as drawn (y down) is -90 degrees about z in KiCad's model frame (y up)
  const rz = (((model.rotate[2] - 90 * best.k) % 360) + 360) % 360
  return { offset: [r(at[0]), r(-at[1]), r(model.z)], rotate: [model.rotate[0], model.rotate[1], rz], turns: best.k, error_mm: r(best.err) }
}

/** A (model …) naming `path`, placed. */
export function modelBlock(path: string, p: Placement): string {
  const xyz = (v: readonly number[]): string => v.map((x) => String(x)).join(' ')
  return `(model ${JSON.stringify(path)} (offset (xyz ${xyz(p.offset)})) (scale (xyz 1 1 1)) (rotate (xyz ${xyz(p.rotate)})))`
}

/** The footprint's text with its models replaced by `block` (or `block` added when it names none). */
export function withModel(fpText: string, block: string): string {
  let tree: SList
  try { tree = parse(fpText) } catch { return fpText }
  const models = tree.filter((n) => isList(n) && n[0] === 'model')
  let out = fpText
  if (models.length) {
    // remove every (model …) at depth 1 of the footprint, then add the one
    const spans: [number, number][] = []
    let depth = 0
    let start = -1
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i)
      if (c === 34) { for (i++; i < out.length && out.charCodeAt(i) !== 34; i++) if (out.charCodeAt(i) === 92) i++; continue }
      if (c === 40) { depth++; if (depth === 2 && out.startsWith('(model', i) && /[\s"]/.test(out[i + 6] ?? '')) start = i }
      else if (c === 41) { if (depth === 2 && start >= 0) { spans.push([start, i + 1]); start = -1 } depth-- }
    }
    for (const [s, e] of spans.reverse()) out = out.slice(0, s) + out.slice(e)
  }
  const close = out.lastIndexOf(')')
  return `${out.slice(0, close).replace(/\s*$/, '')}\n\t\t${block}\n\t${out.slice(close)}`
}

// ------------------------------------------------------------------ fetching and staging

export interface VendorDeps {
  /** GET a URL: its bytes, or null when it is not there (404); throws on anything else */
  get: (url: string) => Promise<Uint8Array | null>
  cacheDir: string
}

export interface VendorBody { ref: string; lcsc: string; source: 'easyeda'; file: string; turns: number; error_mm: number }
export interface NoBody { ref: string; footprint: string; lcsc: string | null; why: string }

async function cached(path: string, fetchIt: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  if (existsSync(path)) {
    const b = readFileSync(path)
    if (b.length) return b
  }
  const b = await fetchIt()
  if (b?.length) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, b)
  }
  return b
}

/**
 * Bodies for the footprints in `needing` (references), from their vendor: each fetched model is written under
 * `stageDir`/VENDOR_DIR, and the board's text comes back with those footprints naming it (relative to the board's
 * folder, through ${KIPRJMOD}). Never throws for a part it cannot get: that part is in `missing`, with why.
 */
export async function vendorBodies(pcb: string, text: string, needing: readonly BoardFootprint[], stageDir: string, d: VendorDeps): Promise<{ text: string; got: VendorBody[]; missing: NoBody[] }> {
  const got: VendorBody[] = []
  const missing: NoBody[] = []
  const edits: { span: [number, number]; text: string }[] = []
  const byCode = new Map<string, { file: string; model: VendorModel } | { why: string }>()
  let asked = 0
  for (const fp of needing) {
    const no = (why: string): void => { missing.push({ ref: fp.ref, footprint: fp.lib, lcsc: fp.lcsc, why }) }
    if (!fp.lcsc) { no('no LCSC part code on the footprint to fetch a vendor model by'); continue }
    let have = byCode.get(fp.lcsc)
    if (!have) {
      if (asked >= MAX_VENDOR_PARTS) { no(`more than ${MAX_VENDOR_PARTS} parts to fetch: not asked`); continue }
      asked++
      try {
        const json = await cached(join(d.cacheDir, 'easyeda', `${fp.lcsc}.json`), () => d.get(EASYEDA_PART(fp.lcsc as string)))
        const model = json ? easyedaModel(JSON.parse(Buffer.from(json).toString('utf8'))) : null
        if (!model) {
          have = { why: json ? `EasyEDA has no 3D model for ${fp.lcsc}` : `EasyEDA does not know ${fp.lcsc}` }
        } else {
          const step = await cached(join(d.cacheDir, 'easyeda', `${model.uuid}.step`), () => d.get(EASYEDA_STEP(model.uuid)))
          if (!step) {
            have = { why: `EasyEDA's 3D model for ${fp.lcsc} could not be had` }
          } else {
            const file = join(stageDir, VENDOR_DIR, `${fp.lcsc}.step`)
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, step)
            have = { file, model }
          }
        }
      } catch (e) {
        have = { why: `EasyEDA could not be reached (${e instanceof Error ? e.message : String(e)})` }
      }
      byCode.set(fp.lcsc, have)
    }
    if ('why' in have) { no(have.why); continue }
    const p = placeOn(have.model, fp.pads)
    if (!p) { no(`EasyEDA's footprint for ${fp.lcsc} does not match ${fp.lib}'s pads, so its model would not sit on them`); continue }
    const rel = relative(dirname(pcb), have.file).split('\\').join('/')
    edits.push({ span: fp.span, text: withModel(text.slice(fp.span[0], fp.span[1]), modelBlock(`\${KIPRJMOD}/${rel}`, p)) })
    got.push({ ref: fp.ref, lcsc: fp.lcsc, source: 'easyeda', file: rel, turns: p.turns, error_mm: p.error_mm })
  }
  let out = text
  for (const e of edits.sort((a, b) => b.span[0] - a.span[0])) out = out.slice(0, e.span[0]) + e.text + out.slice(e.span[1])
  return { text: out, got, missing }
}
