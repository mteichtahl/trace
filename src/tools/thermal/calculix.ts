/**
 * The 3D finite-element path (thermal.board solver=calculix): the board as a structured mesh of 8-node heat-transfer
 * bricks (DC3D8), solved by CalculiX ccx (http://www.calculix.de; the CCX 2.21 manual documents every keyword
 * below), steady state or transient, through runJob (kind calculix: local, or the CPU queue when large).
 *
 *   geometry    the same rasterised board as the 2.5D model (raster.ts): in-plane cells, and through the thickness
 *               one element layer per copper layer and `sublayers` per dielectric
 *   materials   copper layers: coverage-weighted conductivity, c k_Cu + (1 - c) k_laminate, per element (bucketed);
 *               dielectrics: orthotropic, k_xy in-plane and k_z plus the cell's via barrels through the thickness;
 *               component bodies (optional): mould-compound blocks over each powered part's pads
 *   loads       each part's power as a surface flux (*DFLUX Sn) on its pads' faces, or as a body flux (BF) in its body
 *   boundaries  *FILM on every exposed face (top, bottom, edge coefficients from convection.ts, iterated on the film
 *               temperature like the 2.5D model), *RADIATE with the surface emissivity (non-linear, solved by ccx)
 *
 * Mesh faces follow the Abaqus/CalculiX brick convention (checked against ccx 2.21): S1 z-, S2 z+, S3 y-, S4 x+,
 * S5 y+, S6 x-. Without a STEP importer (no gmsh here), enclosures and heatsinks from CAD models are not meshed:
 * a heatsink is a film coefficient on its footprint (raster heatsinks), as in the 2.5D model.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { type Backend, backendFor, runJob } from '../../gpu/jobs.js'
import type { GridModel } from './grid.js'
import type { PerSurface } from './convection.js'
import { MOLD } from './materials.js'
import type { HexMesh } from './export.js'

export interface CcxMesh {
  nodes: Float64Array
  /** 8 node ids (1-based) per element */
  elements: Int32Array
  /** per element: material index */
  material: Int32Array
  materials: { name: string; k: [number, number, number]; rho_cp: number }[]
  /** exposed faces: element (1-based), face 1..6, surface class */
  faces: { el: number; face: number; surface: keyof PerSurface; area: number }[]
  /** heat: element, face (0 = body flux) and value (W/m^2 or W/m^3) */
  loads: { el: number; face: number; value: number }[]
  /** per part: the top-face node ids (1-based) under it, for its board temperature */
  partNodes: Map<string, number[]>
  nz: number
  stats: { elements: number; nodes: number; materials: number; layers: string[] }
}

export interface MeshOptions { sublayers?: number; bodies?: { height_m: number } | undefined }

/** Bucket a conductivity to 3 significant digits so that materials can be shared. */
const bucket = (k: number): number => Number(k.toPrecision(3))

export function buildMesh(m: GridModel, o: MeshOptions = {}): CcxMesh {
  const sub = Math.max(1, o.sublayers ?? 2)
  const L = m.layers.length
  const { nx, ny, dx, dy } = m
  const N = nx * ny
  const A = dx * dy
  // the element layers top down: kind, thickness, which copper layer or dielectric
  type ZL = { kind: 'cu'; l: number; t: number } | { kind: 'diel'; d: number; t: number } | { kind: 'body'; t: number }
  const zl: ZL[] = []
  if (o.bodies) zl.push({ kind: 'body', t: o.bodies.height_m })
  for (let l = 0; l < L; l++) {
    zl.push({ kind: 'cu', l, t: Math.max(m.layers[l]!.t_cu, 1e-6) })
    if (L === 1) for (let s = 0; s < sub; s++) zl.push({ kind: 'diel', d: 0, t: m.diel[0]!.t / sub })
    else if (l < L - 1) for (let s = 0; s < sub; s++) zl.push({ kind: 'diel', d: l, t: m.diel[l]!.t / sub })
  }
  const nzl = zl.length
  const z: number[] = [0]
  for (let k = 0; k < nzl; k++) z.push(z[k]! - zl[k]!.t)
  // body occupancy: the bounding box of each powered part's pads, on its own side only (top side here)
  const body = new Int32Array(N).fill(-1)
  if (o.bodies) {
    m.parts.forEach((p, pi) => {
      if (p.layer !== 0) return
      let i0 = nx, i1 = -1, j0 = ny, j1 = -1
      for (const nd of p.nodes) { const c = nd % N; const i = c % nx; const j = Math.floor(c / nx); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j) }
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (m.inside[j * nx + i]) body[j * nx + i] = pi
    })
  }
  const occupied = (i: number, j: number, k: number): boolean => {
    if (i < 0 || j < 0 || i >= nx || j >= ny || k < 0 || k >= nzl) return false
    const c = j * nx + i
    if (!m.inside[c]) return false
    return zl[k]!.kind !== 'body' || body[c]! >= 0
  }
  // nodes: a full (nx+1)(ny+1)(nzl+1) lattice, numbered 1..; only those used are written
  const px = nx + 1
  const py = ny + 1
  const nid = (i: number, j: number, k: number): number => (k * py + j) * px + i + 1
  const matIndex = new Map<string, number>()
  const materials: CcxMesh['materials'] = []
  const mat = (k: [number, number, number], rhoCp: number): number => {
    const key = `${k.map(bucket).join(',')}|${bucket(rhoCp)}`
    let i = matIndex.get(key)
    if (i === undefined) { i = materials.length; matIndex.set(key, i); materials.push({ name: `M${i + 1}`, k: [bucket(k[0]), bucket(k[1]), bucket(k[2])], rho_cp: bucket(rhoCp) }) }
    return i
  }
  const elIds = new Int32Array(nx * ny * nzl).fill(0)
  const elements: number[] = []
  const material: number[] = []
  let ne = 0
  for (let k = 0; k < nzl; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!occupied(i, j, k)) continue
    const c = j * nx + i
    const layer = zl[k]!
    let mi: number
    if (layer.kind === 'body') mi = mat([MOLD.k.value, MOLD.k.value, MOLD.k.value], MOLD.rho.value * MOLD.cp.value)
    else if (layer.kind === 'cu') {
      const cv = m.coverage[layer.l]![c]!
      const d = m.diel[Math.min(layer.l, m.diel.length - 1)]!
      const kxy = cv * m.copper.k + (1 - cv) * d.k_xy
      const kz = cv * m.copper.k + (1 - cv) * d.k_z
      mi = mat([kxy, kxy, kz], cv * m.copper.rho_cp + (1 - cv) * d.rho_cp)
    } else {
      const d = m.diel[layer.d]!
      const kz = d.k_z + ((m.viaG[layer.d]?.[c] ?? 0) * d.t) / A
      mi = mat([d.k_xy, d.k_xy, kz], d.rho_cp)
    }
    ne++
    elIds[(k * ny + j) * nx + i] = ne
    // DC3D8: bottom face (z lower = k + 1) counter-clockwise seen from +z, then the top face (k)
    elements.push(nid(i, j, k + 1), nid(i + 1, j, k + 1), nid(i + 1, j + 1, k + 1), nid(i, j + 1, k + 1), nid(i, j, k), nid(i + 1, j, k), nid(i + 1, j + 1, k), nid(i, j + 1, k))
    material.push(mi)
  }
  if (!ne) throw new ToolError('calculix: the board has no cells')
  const used = new Uint8Array(px * py * (nzl + 1) + 1)
  for (const n of elements) used[n] = 1
  const nodes: number[] = []
  for (let k = 0; k <= nzl; k++) for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) {
    const id = nid(i, j, k)
    if (used[id]) nodes.push(id, m.origin_mm[0] * 1e-3 + i * dx, m.origin_mm[1] * 1e-3 + j * dy, z[k]!)
  }
  // exposed faces
  const faces: CcxMesh['faces'] = []
  for (let k = 0; k < nzl; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const el = elIds[(k * ny + j) * nx + i]!
    if (!el) continue
    const t = zl[k]!.t
    if (!occupied(i, j, k - 1)) faces.push({ el, face: 2, surface: 'top', area: A })
    if (!occupied(i, j, k + 1)) faces.push({ el, face: 1, surface: 'bottom', area: A })
    const side = 'edge' as const
    if (!occupied(i, j - 1, k)) faces.push({ el, face: 3, surface: side, area: dx * t })
    if (!occupied(i + 1, j, k)) faces.push({ el, face: 4, surface: side, area: dy * t })
    if (!occupied(i, j + 1, k)) faces.push({ el, face: 5, surface: side, area: dx * t })
    if (!occupied(i - 1, j, k)) faces.push({ el, face: 6, surface: side, area: dy * t })
  }
  // loads and part probes
  const kOf = (l: number): number => zl.findIndex((x) => x.kind === 'cu' && x.l === l)
  const loads: CcxMesh['loads'] = []
  const partNodes = new Map<string, number[]>()
  m.parts.forEach((p, pi) => {
    const k = kOf(p.layer)
    const probe: number[] = []
    const bodyCells: number[] = []
    for (let q = 0; q < p.nodes.length; q++) {
      const c = p.nodes[q]! % N
      const i = c % nx
      const j = Math.floor(c / nx)
      const el = elIds[(k * ny + j) * nx + i]!
      const w = p.weights[q]!
      if (p.layer === 0) probe.push(nid(i, j, k), nid(i + 1, j, k), nid(i + 1, j + 1, k), nid(i, j + 1, k))
      else probe.push(nid(i, j, k + 1), nid(i + 1, j, k + 1), nid(i + 1, j + 1, k + 1), nid(i, j + 1, k + 1))
      if (o.bodies && p.layer === 0) continue
      loads.push({ el, face: p.layer === 0 ? 2 : 1, value: (p.power_w * w) / A })
    }
    if (o.bodies && p.layer === 0) {
      for (let c = 0; c < N; c++) if (body[c] === pi) bodyCells.push(c)
      const vol = bodyCells.length * A * o.bodies.height_m
      for (const c of bodyCells) loads.push({ el: elIds[c]!, face: 0, value: p.power_w / vol })
    }
    partNodes.set(p.ref, probe)
  })
  return {
    nodes: Float64Array.from(nodes), elements: Int32Array.from(elements), material: Int32Array.from(material), materials, faces, loads, partNodes, nz: nzl,
    stats: { elements: ne, nodes: nodes.length / 4, materials: materials.length, layers: zl.map((x) => (x.kind === 'cu' ? m.layers[x.l]!.name : x.kind === 'body' ? 'bodies' : `dielectric ${x.d + 1}`)) },
  }
}

const num = (x: number): string => (Number.isInteger(x) ? `${x}.` : x.toExponential(6))

export interface InpOptions {
  h: PerSurface
  emissivity: PerSurface
  sink_c: number
  radiation: boolean
  transient?: { dt_s: number; duration_s: number; output_every: number } | undefined
}

/** The CalculiX input deck. */
export function writeInp(mesh: CcxMesh, o: InpOptions): string {
  const L: string[] = ['** trace thermal.board solver=calculix (generated)', '*NODE']
  for (let i = 0; i < mesh.nodes.length; i += 4) L.push(`${mesh.nodes[i]},${num(mesh.nodes[i + 1]!)},${num(mesh.nodes[i + 2]!)},${num(mesh.nodes[i + 3]!)}`)
  const byMat = new Map<number, number[]>()
  for (let e = 0; e < mesh.material.length; e++) byMat.set(mesh.material[e]!, [...(byMat.get(mesh.material[e]!) ?? []), e + 1])
  for (const [mi, els] of byMat) {
    L.push(`*ELEMENT,TYPE=DC3D8,ELSET=E${mi + 1}`)
    for (const e of els) L.push(`${e},${Array.from(mesh.elements.subarray((e - 1) * 8, e * 8)).join(',')}`)
  }
  for (const [mi] of byMat) {
    const mt = mesh.materials[mi]!
    L.push(`*MATERIAL,NAME=${mt.name}`, '*CONDUCTIVITY,TYPE=ORTHO', `${num(mt.k[0])},${num(mt.k[1])},${num(mt.k[2])}`, '*DENSITY', num(mt.rho_cp / 1000), '*SPECIFIC HEAT', '1000.')
    L.push(`*SOLID SECTION,ELSET=E${mi + 1},MATERIAL=${mt.name}`)
  }
  L.push('*PHYSICAL CONSTANTS,ABSOLUTE ZERO=-273.15,STEFAN BOLTZMANN=5.670374E-8')
  L.push('*INITIAL CONDITIONS,TYPE=TEMPERATURE')
  for (let i = 0; i < mesh.nodes.length; i += 4) L.push(`${mesh.nodes[i]},${num(o.sink_c)}`)
  L.push('*STEP,INC=100000')
  if (o.transient) L.push('*HEAT TRANSFER,DIRECT', `${num(o.transient.dt_s)},${num(o.transient.duration_s)}`)
  else L.push('*HEAT TRANSFER,STEADY STATE')
  if (mesh.loads.length) {
    L.push('*DFLUX')
    for (const ld of mesh.loads) L.push(`${ld.el},${ld.face ? `S${ld.face}` : 'BF'},${num(ld.value)}`)
  }
  L.push('*FILM')
  for (const f of mesh.faces) L.push(`${f.el},F${f.face},${num(o.sink_c)},${num(o.h[f.surface])}`)
  if (o.radiation) {
    const rad = mesh.faces.filter((f) => o.emissivity[f.surface] > 0)
    if (rad.length) {
      L.push('*RADIATE')
      for (const f of rad) L.push(`${f.el},R${f.face},${num(o.sink_c)},${num(o.emissivity[f.surface])}`)
    }
  }
  L.push(o.transient ? `*NODE FILE,FREQUENCY=${o.transient.output_every}` : '*NODE FILE', 'NT', '*END STEP', '')
  return L.join('\n')
}

export interface FrdStep { time: number; temps: Map<number, number> }

/** Nodal temperatures (NDTEMP blocks) from a CalculiX .frd (ASCII), one entry per output time. */
export function parseFrd(text: string): FrdStep[] {
  const out: FrdStep[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.startsWith('  100CL')) continue
    const time = Number(l.slice(12, 24))
    if (!lines[i + 1]?.includes('NDTEMP')) continue
    const temps = new Map<number, number>()
    for (i += 2; i < lines.length; i++) {
      const r = lines[i]!
      if (r.startsWith(' -3')) break
      if (!r.startsWith(' -1')) continue
      temps.set(Number(r.slice(3, 13)), Number(r.slice(13, 25)))
    }
    out.push({ time, temps })
  }
  return out
}

/** Area-weighted mean temperature of each surface class, from the faces' corner nodes. */
const FACE_NODES: Readonly<Record<number, readonly number[]>> = { 1: [0, 1, 2, 3], 2: [4, 5, 6, 7], 3: [0, 4, 5, 1], 4: [1, 5, 6, 2], 5: [2, 6, 7, 3], 6: [3, 7, 4, 0] }

export function surfaceMeans(mesh: CcxMesh, T: Map<number, number>): PerSurface {
  const acc = { top: [0, 0], bottom: [0, 0], edge: [0, 0] } as Record<keyof PerSurface, [number, number]>
  for (const f of mesh.faces) {
    const base = (f.el - 1) * 8
    const t = FACE_NODES[f.face]!.reduce((s, q) => s + (T.get(mesh.elements[base + q]!) ?? NaN), 0) / 4
    acc[f.surface][0] += t * f.area
    acc[f.surface][1] += f.area
  }
  const top = acc.top[0] / acc.top[1]
  return { top, bottom: acc.bottom[0] / acc.bottom[1], edge: acc.edge[1] ? acc.edge[0] / acc.edge[1] : top }
}

export function surfaceLoss(mesh: CcxMesh, T: Map<number, number>, o: InpOptions): { convective_w: number; radiative_w: number } {
  let conv = 0
  let rad = 0
  const ts = o.sink_c + 273.15
  for (const f of mesh.faces) {
    const base = (f.el - 1) * 8
    const ns = FACE_NODES[f.face]!.map((q) => T.get(mesh.elements[base + q]!)!)
    const t = ns.reduce((s, x) => s + x, 0) / 4
    conv += o.h[f.surface] * f.area * (t - o.sink_c)
    if (o.radiation) rad += o.emissivity[f.surface] * 5.670374e-8 * f.area * (ns.reduce((s, x) => s + (x + 273.15) ** 4, 0) / 4 - ts ** 4)
  }
  return { convective_w: conv, radiative_w: rad }
}

export const ccxBinary = (): string => process.env.TRACE_CCX || 'ccx'

export function ccxInstalled(): boolean {
  const bin = ccxBinary()
  if (bin.includes('/')) return existsSync(bin)
  return (process.env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, bin)))
}

/** Elements above which a run goes to the CPU queue (when TRACE_GPU_QUEUE is set). */
export const localMaxElements = (): number => Number(process.env.TRACE_CALCULIX_LOCAL_MAX_ELEMENTS ?? 300_000)

export interface CcxRun { frd: string; log: string; where: Backend; seconds: number }

/** Run ccx on a deck through runJob (kind calculix, CPU). */
export async function runCcx(inp: string, o: { elements: number; threads?: number; timeoutSeconds?: number; remote?: 'auto' | 'always' | 'never' }): Promise<CcxRun> {
  const mode = o.remote ?? 'auto'
  const wantRemote = mode === 'always' || (mode === 'auto' && (o.elements > localMaxElements() || !ccxInstalled()))
  const where = backendFor({ kind: 'calculix', gpu: false, remote: wantRemote })
  if (where === 'local' && !ccxInstalled()) throw new ToolError('CalculiX (ccx) is not installed here (apt install calculix-ccx, or set TRACE_CCX; with TRACE_GPU_QUEUE set, runs go to the CPU queue)')
  const dir = scratchDir('trace-ccx-in-')
  try {
    writeFileSync(join(dir, 'model.inp'), inp)
    const bin = ccxBinary().replace(/'/g, '')
    const r = await runJob({
      kind: 'calculix', gpu: false, remote: wantRemote, timeoutSeconds: o.timeoutSeconds ?? 3600,
      argv: ['sh', '-c', `cd '{dir}' && cp '{in:model.inp}' model.inp && '${bin}' -i model > ccx.log 2>&1; rc=$?; cp model.frd '{out:model.frd}' 2>/dev/null; cp ccx.log '{out:ccx.log}'; exit $rc`],
      inputs: { 'model.inp': join(dir, 'model.inp') }, outputs: ['model.frd', 'ccx.log'],
      env: { OMP_NUM_THREADS: String(o.threads ?? 1), CCX_NPROC_EQUATION_SOLVER: String(o.threads ?? 1) },
    })
    const log = r.outputs['ccx.log'] ? readFileSync(r.outputs['ccx.log'], 'utf8') : r.stdout + r.stderr
    if (r.exitCode !== 0 || !r.outputs['model.frd']) throw new ToolError(`ccx failed (exit ${r.exitCode}): ${log.split('\n').filter((x) => /error|\*ERROR|warning/i.test(x)).slice(0, 5).join(' | ') || log.slice(-400)}`)
    const frd = readFileSync(r.outputs['model.frd'], 'utf8')
    for (const p of Object.values(r.outputs)) rmSync(p, { force: true })
    return { frd, log, where: r.where, seconds: r.seconds }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The mesh with nodal temperatures, for VTU. */
export function ccxHexMesh(mesh: CcxMesh, T: Map<number, number>): HexMesh {
  const index = new Map<number, number>()
  const pts: number[] = []
  const temp: number[] = []
  for (let i = 0; i < mesh.nodes.length; i += 4) { index.set(mesh.nodes[i]!, pts.length / 3); pts.push(mesh.nodes[i + 1]!, mesh.nodes[i + 2]!, mesh.nodes[i + 3]!); temp.push(T.get(mesh.nodes[i]!) ?? NaN) }
  const hexes = Int32Array.from(mesh.elements, (n) => index.get(n)!)
  return { points: Float64Array.from(pts), hexes, pointData: { temperature_c: Float64Array.from(temp) }, cellData: { material: Float64Array.from(mesh.material, (x) => x + 1) } }
}
