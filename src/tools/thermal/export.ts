/**
 * Result files for people and other tools, stored as run artifacts (never written into the repository):
 *
 *   CSV    one row per cell and layer (x, y, layer, T), and time series
 *   VTU    VTK XML unstructured grid (hexahedra, cell or point temperatures), for ParaView
 *          (https://docs.vtk.org/en/latest/design_documents/VTKFileFormats.html)
 *   GLB    binary glTF 2.0 of the board as a slab whose top and bottom faces carry the temperature maps as
 *          textures (KHR_materials_unlit, so the colours are the scale's), for render.model / thermal.render
 *          (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
 */

export function csv(header: readonly string[], rows: Iterable<readonly (number | string)[]>): string {
  const out = [header.join(',')]
  for (const r of rows) out.push(r.map((v) => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : '') : /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(','))
  return `${out.join('\n')}\n`
}

export interface HexMesh {
  /** x, y, z per point (m) */
  points: Float64Array
  /** 8 point indices per cell, VTK_HEXAHEDRON order (bottom face counter-clockwise, then the top face) */
  hexes: Int32Array
  cellData?: Record<string, Float64Array>
  pointData?: Record<string, Float64Array>
}

const arr = (a: ArrayLike<number>, fmt = (x: number): string => Number(x.toPrecision(7)).toString()): string => {
  const parts: string[] = []
  for (let i = 0; i < a.length; i++) parts.push(fmt(a[i]!))
  return parts.join(' ')
}

export function vtu(m: HexMesh): string {
  const np = m.points.length / 3
  const nc = m.hexes.length / 8
  const offsets = Int32Array.from({ length: nc }, (_, i) => 8 * (i + 1))
  const types = new Uint8Array(nc).fill(12)
  const data = (d: Record<string, Float64Array> | undefined): string => Object.entries(d ?? {}).map(([k, v]) => `<DataArray type="Float64" Name="${k}" format="ascii">${arr(v)}</DataArray>`).join('\n')
  return `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian">
<UnstructuredGrid>
<Piece NumberOfPoints="${np}" NumberOfCells="${nc}">
<Points><DataArray type="Float64" NumberOfComponents="3" format="ascii">${arr(m.points, (x) => Number(x.toPrecision(9)).toString())}</DataArray></Points>
<Cells>
<DataArray type="Int32" Name="connectivity" format="ascii">${arr(m.hexes, String)}</DataArray>
<DataArray type="Int32" Name="offsets" format="ascii">${arr(offsets, String)}</DataArray>
<DataArray type="UInt8" Name="types" format="ascii">${arr(types, String)}</DataArray>
</Cells>
<CellData>${data(m.cellData)}</CellData>
<PointData>${data(m.pointData)}</PointData>
</Piece>
</UnstructuredGrid>
</VTKFile>
`
}

const pad4 = (n: number): number => (n + 3) & ~3

/** A board-sized slab (width x height x thickness, m) with its top and bottom faces textured by two PNGs. */
export function texturedSlab(width: number, height: number, thickness: number, topPng: Uint8Array, bottomPng: Uint8Array): Uint8Array {
  // Y up; board x -> X, board y -> Z; top face at Y = 0
  const W = width
  const D = height
  const T = thickness
  const quad = (p: number[][], n: number[], uv: number[][]) => ({ p, n, uv })
  const faces = {
    top: quad([[0, 0, 0], [W, 0, 0], [W, 0, D], [0, 0, D]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]),
    bottom: quad([[0, -T, 0], [0, -T, D], [W, -T, D], [W, -T, 0]], [0, -1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]),
    sides: [
      quad([[0, 0, D], [W, 0, D], [W, -T, D], [0, -T, D]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]),
      quad([[W, 0, 0], [0, 0, 0], [0, -T, 0], [W, -T, 0]], [0, 0, -1], [[0, 0], [1, 0], [1, 1], [0, 1]]),
      quad([[W, 0, D], [W, 0, 0], [W, -T, 0], [W, -T, D]], [1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]),
      quad([[0, 0, 0], [0, 0, D], [0, -T, D], [0, -T, 0]], [-1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]),
    ],
  }
  const groups = [[faces.top], [faces.bottom], faces.sides]
  const chunks: Uint8Array[] = []
  const views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = []
  const accessors: Record<string, unknown>[] = []
  let offset = 0
  const pushView = (bytes: Uint8Array, target?: number): number => {
    const padded = new Uint8Array(pad4(bytes.length))
    padded.set(bytes)
    chunks.push(padded)
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) })
    offset += padded.length
    return views.length - 1
  }
  const prims = groups.map((qs, gi) => {
    const pos: number[] = []
    const nor: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    for (const q of qs) {
      const base = pos.length / 3
      for (let k = 0; k < 4; k++) { pos.push(...q.p[k]!); nor.push(...q.n); uv.push(...q.uv[k]!) }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
    const fpos = new Float32Array(pos)
    const mn = [0, 1, 2].map((a) => Math.min(...pos.filter((_, i) => i % 3 === a)))
    const mx = [0, 1, 2].map((a) => Math.max(...pos.filter((_, i) => i % 3 === a)))
    const vp = pushView(new Uint8Array(fpos.buffer), 34962)
    const vn = pushView(new Uint8Array(new Float32Array(nor).buffer), 34962)
    const vt = pushView(new Uint8Array(new Float32Array(uv).buffer), 34962)
    const vi = pushView(new Uint8Array(new Uint16Array(idx).buffer), 34963)
    const a0 = accessors.length
    accessors.push(
      { bufferView: vp, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx },
      { bufferView: vn, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: vt, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: vi, componentType: 5123, count: idx.length, type: 'SCALAR' },
    )
    return { attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2 }, indices: a0 + 3, material: gi }
  })
  const imTop = pushView(topPng)
  const imBottom = pushView(bottomPng)
  const unlit = { KHR_materials_unlit: {} }
  const gltf = {
    asset: { version: '2.0', generator: 'trace thermal.board' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'board' }],
    meshes: [{ name: 'board', primitives: prims }],
    materials: [
      { name: 'top', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: unlit },
      { name: 'bottom', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: unlit },
      { name: 'edge', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.55, 0.5, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: imTop, mimeType: 'image/png' }, { bufferView: imBottom, mimeType: 'image/png' }],
    accessors, bufferViews: views, buffers: [{ byteLength: offset }],
  }
  const json = new TextEncoder().encode(JSON.stringify(gltf))
  const jsonPadded = new Uint8Array(pad4(json.length)).fill(0x20)
  jsonPadded.set(json)
  const bin = new Uint8Array(offset)
  let o = 0
  for (const c of chunks) { bin.set(c, o); o += c.length }
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, total, true)
  v.setUint32(12, jsonPadded.length, true)
  v.setUint32(16, 0x4e4f534a, true)
  out.set(jsonPadded, 20)
  v.setUint32(20 + jsonPadded.length, bin.length, true)
  v.setUint32(24 + jsonPadded.length, 0x004e4942, true)
  out.set(bin, 28 + jsonPadded.length)
  return out
}
