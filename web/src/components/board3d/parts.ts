/**
 * A body for each footprint, drawn from what its name and pads say about it: chip resistors, capacitors, inductors
 * and LEDs, small diodes, gull-wing and leadless chips (SOT, SOIC, SSOP, QFP, QFN…), DIP and TO-220 packages, pin
 * headers and sockets, electrolytic capacitors and crystals. A part none of these fits is a grey block the size of its
 * courtyard with its reference on top, and is listed (`kind: 'block'`), so the board never looks emptier than it is.
 *
 * Each body is built in the footprint's own frame (millimetres, x right, y down, z up off the board as three's y) and
 * the viewer places and turns it. Footprints that are not parts (holes, fiducials, test points, logos) get none.
 */
import * as THREE from 'three'
import type { Footprint, Xy } from '@/lib/kicad-board'

export interface Materials {
  resistor: THREE.Material
  ceramic: THREE.Material
  ferrite: THREE.Material
  epoxy: THREE.Material
  plastic: THREE.Material
  tin: THREE.Material
  gold: THREE.Material
  aluminium: THREE.Material
  block: THREE.Material
  ledBase: THREE.Material
  sleeve: THREE.Material
  band: THREE.Material
}

export function makeMaterials(): Materials {
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o)
  return {
    resistor: std({ color: 0x17171a, roughness: 0.55 }),
    ceramic: std({ color: 0xa88b5e, roughness: 0.62 }),
    ferrite: std({ color: 0x3a3b3f, roughness: 0.7 }),
    epoxy: std({ color: 0x1b1b1e, roughness: 0.5 }),
    plastic: std({ color: 0x19191b, roughness: 0.42 }),
    tin: std({ color: 0xcfd1d4, metalness: 1, roughness: 0.27 }),
    gold: std({ color: 0xe8c36a, metalness: 1, roughness: 0.2 }),
    aluminium: std({ color: 0xd6d8db, metalness: 0.9, roughness: 0.32 }),
    block: std({ color: 0x8c9098, roughness: 0.7 }),
    ledBase: std({ color: 0xf1eee6, roughness: 0.5 }),
    sleeve: std({ color: 0x1d2a4a, roughness: 0.35 }),
    band: std({ color: 0x9a9ca0, roughness: 0.6 }),
  }
}

export interface Built {
  group: THREE.Group
  kind: 'shaped' | 'block' | 'none'
  /** LED lenses, lit by Power on */
  lenses: THREE.Mesh[]
  /** the highest point above the board, mm */
  height: number
}

const LED_COLOURS: [RegExp, number][] = [
  [/red/i, 0xff2a1f], [/green|grn/i, 0x2cff4a], [/blue|blu/i, 0x2a6bff], [/yellow|yel|amber/i, 0xffc21a],
  [/orange/i, 0xff7a1a], [/white|wht/i, 0xf4f6ff], [/uv|violet|purple/i, 0x9b4bff],
]
export const ledColour = (value: string): number => LED_COLOURS.find(([re]) => re.test(value))?.[1] ?? 0xff3a2a

// ------------------------------------------------------------------ helpers

/** A box whose base sits on the board: centred at (x, z) in footprint millimetres, `h` tall from `y0`. */
function box(w: number, d: number, h: number, mat: THREE.Material, x = 0, z = 0, y0 = 0, bevel = 0): THREE.Mesh {
  let geo: THREE.BufferGeometry
  if (bevel > 0) {
    const r = Math.min(bevel, w / 2.2, d / 2.2)
    const s = new THREE.Shape()
    s.moveTo(-w / 2 + r, -d / 2)
    s.lineTo(w / 2 - r, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
    s.lineTo(w / 2, d / 2 - r); s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2)
    s.lineTo(-w / 2 + r, d / 2); s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r)
    s.lineTo(-w / 2, -d / 2 + r); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
    const e = Math.min(r, h / 3)
    geo = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, h - e * 2), bevelEnabled: true, bevelSize: e * 0.6, bevelThickness: e, bevelSegments: 2, curveSegments: 4 })
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, e, 0) // the shape is symmetric, so drawing it in (x, −z) after the turn changes nothing
  } else {
    geo = new THREE.BoxGeometry(w, h, d)
    geo.translate(0, h / 2, 0)
  }
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y0, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function cylinder(r: number, h: number, mat: THREE.Material, x = 0, z = 0, y0 = 0, seg = 40): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat)
  m.position.set(x, y0 + h / 2, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

const labels = new Map<string, THREE.CanvasTexture>()
/** Laser-etched or printed words on a part's top, as a texture (shared between parts that say the same thing). */
export function labelTexture(text: string, colour = '#c9c9c9', bg = 'transparent'): THREE.CanvasTexture {
  const key = `${text}|${colour}|${bg}`
  const have = labels.get(key)
  if (have) return have
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 96
  const g = c.getContext('2d')!
  if (bg !== 'transparent') { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height) }
  g.fillStyle = colour
  let size = 64
  g.font = `600 ${size}px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace`
  while (g.measureText(text).width > c.width * 0.9 && size > 18) { size -= 4; g.font = `600 ${size}px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace` }
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, c.width / 2, c.height / 2 + 2)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  labels.set(key, t)
  return t
}

/** A flat label lying on top of a body `h` high, `w` × `d`, reading along x. */
function topLabel(text: string, w: number, d: number, h: number, colour?: string, turn = false): THREE.Mesh {
  const lw = turn ? d : w, ld = turn ? w : d
  const m = new THREE.Mesh(new THREE.PlaneGeometry(lw * 0.82, Math.min(ld * 0.6, lw * 0.82 * 0.375)), new THREE.MeshBasicMaterial({ map: labelTexture(text, colour), transparent: true, depthWrite: false }))
  m.rotation.x = -Math.PI / 2
  if (turn) m.rotation.z = Math.PI / 2
  m.position.y = h + 0.004
  return m
}

/** The pads in the footprint's frame (KiCad millimetres). */
export function localPads(fp: Footprint): { num: string; at: Xy; size: [number, number]; angle: number; drill: Footprint['pads'][number]['drill']; type: string }[] {
  const a = (fp.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return fp.pads.map((p) => {
    const dx = p.at[0] - fp.at[0], dy = p.at[1] - fp.at[1]
    // the inverse of toBoard: x = dx c − dy s, y = dx s + dy c
    return { num: p.num, at: [dx * c - dy * s, dx * s + dy * c] as Xy, size: p.size, angle: p.angle - fp.angle, drill: p.drill, type: p.type }
  })
}

function boundsOf(pts: readonly Xy[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  return { minX, minY, maxX, maxY }
}

/** A pad's extent along x and y in the footprint frame, allowing for a pad turned a quarter. */
const padExtent = (p: { size: [number, number]; angle: number }): [number, number] => (Math.round(Math.abs(p.angle) / 90) % 2 ? [p.size[1], p.size[0]] : p.size)

const dims = (name: string): [number, number] | null => {
  const m = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:x\d+(?:\.\d+)?)?mm/i.exec(name)
  return m ? [Number(m[1]), Number(m[2])] : null
}

// ------------------------------------------------------------------ the families

const NOT_PARTS = /^(MountingHole|Fiducial|TestPoint|NetTie|SolderJumper|Symbol|Logo|kibuzzard|OSHW|Hole|Pad_|Jumper)/i

/** The body for one footprint, in its own frame; `block` when no family fits. */
export function buildPart(fp: Footprint, m: Materials): Built {
  const group = new THREE.Group()
  const lenses: THREE.Mesh[] = []
  const name = fp.name
  const pads = localPads(fp)
  const done = (kind: Built['kind'], height: number): Built => ({ group, kind, lenses, height })
  if (!pads.length || NOT_PARTS.test(name) || fp.attr.includes('board_only')) return done('none', 0)

  // two-pad chips: R, C, L, LED, fuses, ferrite beads (by their metric size code)
  const chip = /^(R|C|L|LED|D|F|Fuse|FB|Ferrite)[A-Za-z]*_(\d{4})_(\d{4})Metric/i.exec(name)
  if (chip && pads.length === 2) {
    const code = chip[3]!
    const len = Number(code.slice(0, 2)) / 10, wid = Number(code.slice(2)) / 10
    const along = Math.abs(pads[0]!.at[0] - pads[1]!.at[0]) >= Math.abs(pads[0]!.at[1] - pads[1]!.at[1])
    const g = new THREE.Group()
    if (!along) g.rotation.y = Math.PI / 2
    const kind = chip[1]!.toUpperCase()
    const cap = Math.min(0.5, len * 0.2)
    if (kind === 'LED') {
      const base = Math.max(0.2, wid * 0.3)
      g.add(box(len, wid, base, m.ledBase))
      const lensMat = new THREE.MeshPhysicalMaterial({ color: ledColour(fp.value), roughness: 0.12, transmission: 0.55, thickness: 0.4, emissive: ledColour(fp.value), emissiveIntensity: 0 })
      const lens = box(len * 0.72, wid * 0.86, wid * 0.42, lensMat, 0, 0, base, wid * 0.2)
      lens.castShadow = false
      g.add(lens); lenses.push(lens)
      g.add(box(cap * 0.8, wid * 1.01, base * 1.02, m.tin, -len / 2 + cap * 0.4)); g.add(box(cap * 0.8, wid * 1.01, base * 1.02, m.tin, len / 2 - cap * 0.4))
      group.add(g)
      return done('shaped', base + wid * 0.42)
    }
    const h = kind === 'R' ? Math.max(0.22, wid * 0.55) : kind === 'C' ? wid * 0.95 : wid
    const bodyMat = kind === 'R' ? m.resistor : kind === 'C' ? m.ceramic : m.ferrite
    g.add(box(len - cap * 1.9, wid * 0.98, h * (kind === 'R' ? 0.94 : 0.98), bodyMat, 0, 0, 0, kind === 'R' ? 0 : wid * 0.08))
    g.add(box(cap, wid, h, m.tin, -len / 2 + cap / 2, 0, 0, Math.min(cap, h) * 0.18))
    g.add(box(cap, wid, h, m.tin, len / 2 - cap / 2, 0, 0, Math.min(cap, h) * 0.18))
    if (kind === 'R' && len >= 1.5) g.add(topLabel(resistorCode(fp.value), len - cap * 2, wid, h * 0.94, '#e2e2e2'))
    group.add(g)
    return done('shaped', h)
  }

  // small two-pad diodes in moulded packages
  const DIODES: Record<string, [number, number, number]> = { 'SOD-123': [2.7, 1.6, 1.1], 'SOD-123F': [2.7, 1.6, 1.0], 'SOD-323': [1.7, 1.25, 0.9], 'SOD-523': [1.2, 0.8, 0.6], 'SOD-923': [0.8, 0.6, 0.4], 'D_SMA': [4.3, 2.6, 2.1], 'D_SMB': [4.4, 3.6, 2.2], 'D_SMC': [6.9, 5.9, 2.2], 'D_MiniMELF': [3.5, 1.5, 1.5] }
  const diode = Object.keys(DIODES).find((k) => name.startsWith(k) || name.startsWith(`D_${k}`))
  if (diode && pads.length === 2) {
    const [len, wid, h] = DIODES[diode]!
    const along = Math.abs(pads[0]!.at[0] - pads[1]!.at[0]) >= Math.abs(pads[0]!.at[1] - pads[1]!.at[1])
    const g = new THREE.Group()
    if (!along) g.rotation.y = Math.PI / 2
    g.add(box(len, wid, h, m.epoxy, 0, 0, 0, 0.15))
    // the cathode band, on pad 1's side
    const k = pads.find((p) => p.num === '1') ?? pads[0]!
    const sign = (along ? k.at[0] : k.at[1]) < 0 ? -1 : 1
    g.add(box(len * 0.12, wid * 0.98, 0.01, m.band, sign * len * 0.32, 0, h))
    for (const p of pads) {
      const at = along ? p.at[0] : p.at[1]
      g.add(box(Math.abs(at) - len / 2 + 0.3, wid * 0.45, 0.12, m.tin, Math.sign(at) * (len / 2 + (Math.abs(at) - len / 2) / 2 - 0.1), 0, 0))
    }
    group.add(g)
    return done('shaped', h)
  }

  // integrated circuits: gull-wing (SOT, SOIC, SSOP, TSSOP, MSOP, QFP) and leadless (QFN, DFN)
  const ic = /^(SOT-23|TSOT-23|SC-70|SOT-323|SOT-363|SOT-353|SOT-223|SOT-89|SOT-143|SOIC|SO-|SOP|SSOP|TSSOP|MSOP|VSSOP|HTSSOP|TQFP|LQFP|QFP|PQFP|QFN|VQFN|WQFN|UQFN|DFN|WDFN|UDFN|VSON|SON|TDFN|LGA|TO-252|TO-263|DPAK|D2PAK)/i.exec(name)
  if (ic && pads.length >= 3) return done('shaped', icBody(fp, ic[1]!.toUpperCase(), pads, group, m))

  // DIP packages (through-hole), and TO-220 power packages
  const dip = /^DIP-(\d+)_W(\d+(?:\.\d+)?)mm/i.exec(name)
  if (dip) {
    const b = boundsOf(pads.map((p) => p.at))
    const rowsAlongY = b.maxY - b.minY > b.maxX - b.minX
    const len = (rowsAlongY ? b.maxY - b.minY : b.maxX - b.minX) + 2.4
    const wid = Number(dip[2]) - 1.27
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    const body = box(rowsAlongY ? wid : len, rowsAlongY ? len : wid, 3.3, m.epoxy, cx, cz, 0.5, 0.25)
    group.add(body)
    for (const p of pads) {
      group.add(box(0.5, 0.5, 0.6, m.tin, p.at[0], p.at[1], 0))
      group.add(box(0.25, 0.25, 3.2, m.tin, p.at[0], p.at[1], -3.2))
    }
    const one = pads.find((p) => p.num === '1') ?? pads[0]!
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.45, 24), new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.9 }))
    dot.rotation.x = -Math.PI / 2
    dot.position.set(cx + (one.at[0] - cx) * 0.62, 3.81, cz + (one.at[1] - cz) * 0.8)
    group.add(dot)
    group.add(centeredLabel(fp.value || fp.ref, cx, cz, rowsAlongY ? wid : len, rowsAlongY ? len : wid, 3.8, rowsAlongY))
    return done('shaped', 3.8)
  }
  if (/^TO-220/i.test(name)) {
    const b = boundsOf(pads.map((p) => p.at))
    const cx = (b.minX + b.maxX) / 2
    group.add(box(10, 4.5, 9, m.epoxy, cx, b.minY - 0.5, 0))
    group.add(box(10, 1.3, 6.5, m.aluminium, cx, b.minY + 1.7 - 0.5, 8.5))
    const hole = cylinder(1.8, 1.35, new THREE.MeshStandardMaterial({ color: 0x050505 }), cx, b.minY + 1.7 - 0.5, 11.9)
    hole.rotation.x = Math.PI / 2
    group.add(hole)
    for (const p of pads) group.add(box(0.8, 0.5, 3.5, m.tin, p.at[0], p.at[1], -3))
    return done('shaped', 15)
  }

  // pin headers and sockets (vertical)
  const hdr = /^(PinHeader|PinSocket)_(\d+)x(\d+)_P(\d+(?:\.\d+)?)mm_Vertical/i.exec(name)
  if (hdr) {
    const socket = hdr[1]!.toLowerCase() === 'pinsocket'
    const pitch = Number(hdr[4])
    const k = pitch / 2.54
    const b = boundsOf(pads.map((p) => p.at))
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    const w = b.maxX - b.minX + pitch, d = b.maxY - b.minY + pitch
    const hh = socket ? 8.5 * k : 2.5 * k
    group.add(box(w - 0.04, d - 0.04, hh, m.plastic, cx, cz, 0, socket ? 0.15 : 0.05))
    const pinW = 0.64 * k
    for (const p of pads) {
      if (socket) {
        const hole = new THREE.Mesh(new THREE.PlaneGeometry(pinW * 1.6, pinW * 1.6), new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 }))
        hole.rotation.x = -Math.PI / 2
        hole.position.set(p.at[0], hh + 0.003, p.at[1])
        group.add(hole)
        group.add(box(pinW * 0.7, pinW * 0.7, 3, m.tin, p.at[0], p.at[1], -3))
      } else {
        const top = hh + 6 * k
        group.add(box(pinW, pinW, top + 3, m.gold, p.at[0], p.at[1], -3))
        const tip = new THREE.Mesh(new THREE.ConeGeometry(pinW * 0.72, pinW * 0.6, 4), m.gold)
        tip.rotation.y = Math.PI / 4
        tip.position.set(p.at[0], top + pinW * 0.3, p.at[1])
        group.add(tip)
      }
    }
    return done('shaped', socket ? hh : hh + 6 * k)
  }

  // electrolytic capacitors: SMD cans (CP_Elec_6.3x5.8) and radial (CP_Radial_D5.0mm)
  const elec = /^CP_Elec_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i.exec(name)
  const radial = /^C(?:P)?_Radial_D(\d+(?:\.\d+)?)mm(?:_H(\d+(?:\.\d+)?)mm)?/i.exec(name)
  if (elec || radial) {
    const dia = Number((elec ?? radial)![1])
    const h = elec ? Number(elec[2]) : radial![2] ? Number(radial![2]) : Math.max(5, dia * 1.6)
    const b = boundsOf(pads.map((p) => p.at))
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    let y0 = 0
    if (elec) { group.add(box(dia + 0.3, dia + 0.3, 0.45, m.plastic, cx, cz, 0, 0.3)); y0 = 0.45 }
    group.add(cylinder(dia / 2, h - y0, radial ? m.sleeve : m.aluminium, cx, cz, y0, 48))
    // the polarity mark: a dark stripe on the negative side (away from pad 1)
    const plus = pads.find((p) => p.num === '1') ?? pads[0]!
    const away = Math.atan2(-(plus.at[1] - cz), -(plus.at[0] - cx))
    const mark = new THREE.Mesh(new THREE.CircleGeometry(dia / 2 * 0.98, 32, -Math.PI / 5, Math.PI * 0.4), new THREE.MeshStandardMaterial({ color: radial ? 0xd6dce8 : 0x15151a, roughness: 0.5 }))
    mark.rotation.x = -Math.PI / 2
    mark.rotation.z = away
    mark.position.set(cx, h + 0.003, cz)
    group.add(mark)
    // the vent cross on the top
    for (const r of [0, Math.PI / 2]) { const v = box(dia * 0.5, 0.12, 0.01, new THREE.MeshStandardMaterial({ color: 0x8e9095, metalness: 0.6, roughness: 0.5 }), cx, cz, h); v.rotation.y = r; group.add(v) }
    return done('shaped', h)
  }

  // quartz crystals in SMD metal cans
  const xtal = /^Crystal_SMD_(\d{4})/i.exec(name)
  if (xtal) {
    const len = Number(xtal[1]!.slice(0, 2)) / 10, wid = Number(xtal[1]!.slice(2)) / 10
    const b = boundsOf(pads.map((p) => p.at))
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    group.add(box(len, wid, 0.25, m.ceramic, cx, cz, 0))
    group.add(box(len * 0.92, wid * 0.88, 0.55, m.aluminium, cx, cz, 0.25, 0.15))
    return done('shaped', 0.8)
  }

  return done('block', block(fp, pads, group, m))
}

/** EIA-96 is too much for a picture: the three-digit code a 5% chip resistor carries ("10k" → 103). */
export function resistorCode(value: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*([rkmRKM]?)(\d*)$/.exec(value.trim().replace(/Ω|ohm/gi, ''))
  if (!m) return value.slice(0, 4)
  const mult = { '': 1, r: 1, k: 1e3, m: 1e6 }[m[2]!.toLowerCase() as '' | 'r' | 'k' | 'm']
  const ohms = Number(m[3] ? `${m[1]}.${m[3]}` : m[1]) * mult
  if (!Number.isFinite(ohms) || ohms <= 0) return value.slice(0, 4)
  if (ohms < 10) return String(ohms).replace('.', 'R').slice(0, 3)
  const exp = Math.floor(Math.log10(ohms)) - 1
  const digits = Math.round(ohms / 10 ** exp)
  return `${digits >= 100 ? Math.round(digits / 10) : digits}${digits >= 100 ? exp + 1 : exp}`
}

function centeredLabel(text: string, x: number, z: number, w: number, d: number, h: number, turn: boolean): THREE.Mesh {
  const l = topLabel(text, w, d, h, '#bdbdc2', turn)
  l.position.x = x
  l.position.z = z
  return l
}

const IC_SIZE: Record<string, { w: number; l: number; h: number }> = {
  'SOT-23': { w: 1.3, l: 2.9, h: 1.0 }, 'TSOT-23': { w: 1.6, l: 2.9, h: 0.85 }, 'SC-70': { w: 1.25, l: 2.0, h: 0.9 }, 'SOT-323': { w: 1.25, l: 2.0, h: 0.9 },
  'SOT-363': { w: 1.25, l: 2.0, h: 0.9 }, 'SOT-353': { w: 1.25, l: 2.0, h: 0.9 }, 'SOT-223': { w: 3.5, l: 6.5, h: 1.65 }, 'SOT-89': { w: 2.5, l: 4.5, h: 1.5 },
  'SOT-143': { w: 1.3, l: 2.9, h: 1.0 },
}
const IC_HEIGHT: [RegExp, number][] = [
  [/^(QFN|VQFN|WQFN|UQFN|DFN|WDFN|UDFN|VSON|SON|TDFN|LGA)/, 0.85], [/^(TSSOP|HTSSOP|MSOP|VSSOP)/, 1.0], [/^TQFP/, 1.0],
  [/^(LQFP|QFP|PQFP)/, 1.4], [/^(SOIC|SO-|SOP|SSOP)/, 1.5], [/^(TO-252|DPAK)/, 2.3], [/^(TO-263|D2PAK)/, 4.4],
]

/** A chip's body and its leads; returns its height. */
function icBody(fp: Footprint, family: string, pads: ReturnType<typeof localPads>, group: THREE.Group, m: Materials): number {
  const leadless = /^(QFN|VQFN|WQFN|UQFN|DFN|WDFN|UDFN|VSON|SON|TDFN|LGA)/.test(family)
  const padB = boundsOf(pads.map((p) => p.at))
  const cx = (padB.minX + padB.maxX) / 2, cz = (padB.minY + padB.maxY) / 2
  // leads on the left and right (rows along y) or on all four sides
  const spreadX = padB.maxX - padB.minX, spreadY = padB.maxY - padB.minY
  let w: number, l: number
  const known = IC_SIZE[family]
  const named = dims(fp.name)
  const sideways = spreadY > spreadX * 1.15 // most leads run down the left and right
  if (known) [w, l] = spreadX >= spreadY ? [known.w, known.l] : [known.l, known.w]
  else if (named) [w, l] = sideways || Math.abs(spreadX - spreadY) < 0.2 ? named : [named[1], named[0]]
  else {
    // the space inside the pad rows
    const inner = pads.filter((p) => !(Math.abs(p.at[0] - cx) < 0.01 && Math.abs(p.at[1] - cz) < 0.01))
    const ins = (axis: 0 | 1) => Math.min(...inner.map((p) => Math.abs(p.at[axis] - (axis ? cz : cx)) - padExtent(p)[axis] / 2).filter((v) => v > 0.2))
    w = Number.isFinite(ins(0)) ? ins(0) * 2 + 0.2 : spreadX + 0.6
    l = Number.isFinite(ins(1)) ? ins(1) * 2 + 0.2 : spreadY + 0.6
    if (leadless) { w = spreadX + 0.5; l = spreadY + 0.5 }
  }
  if (leadless) { w = Math.max(w, spreadX + 0.1); l = Math.max(l, spreadY + 0.1) }
  const h = known?.h ?? IC_HEIGHT.find(([re]) => re.test(family))?.[1] ?? 1.2
  const lift = leadless ? 0 : h > 1.2 ? 0.1 : 0.05
  group.add(box(w, l, h - lift, m.epoxy, cx, cz, lift, Math.min(0.12, Math.min(w, l) * 0.06)))
  // leads: from the body's edge out to the pad, bent down onto it
  if (!leadless) {
    for (const p of pads) {
      const dx = p.at[0] - cx, dz = p.at[1] - cz
      const outX = Math.abs(dx) > w / 2 - 0.05, outZ = Math.abs(dz) > l / 2 - 0.05
      if (!outX && !outZ) continue
      const [ex, ez] = padExtent(p)
      const alongX = outX && (!outZ || Math.abs(dx) / w > Math.abs(dz) / l)
      const thick = 0.15, mid = Math.max(0.12, (h - lift) * 0.45) + lift
      if (alongX) {
        const s = Math.sign(dx), width = Math.min(ez * 0.75, 0.5), from = cx + s * w / 2, to = p.at[0] + s * Math.min(ex * 0.25, 0.3)
        const reach = Math.abs(to - from)
        const foot = Math.min(reach * 0.55, ex * 0.6)
        group.add(box(reach - foot + 0.02, width, thick, m.tin, from + s * (reach - foot) / 2, p.at[1], mid - thick / 2))
        group.add(box(thick, width, mid, m.tin, from + s * (reach - foot), p.at[1], 0))
        group.add(box(foot, width, thick, m.tin, to - s * foot / 2, p.at[1], 0))
      } else {
        const s = Math.sign(dz), width = Math.min(ex * 0.75, 0.5), from = cz + s * l / 2, to = p.at[1] + s * Math.min(ez * 0.25, 0.3)
        const reach = Math.abs(to - from)
        const foot = Math.min(reach * 0.55, ez * 0.6)
        group.add(box(width, reach - foot + 0.02, thick, m.tin, p.at[0], from + s * (reach - foot) / 2, mid - thick / 2))
        group.add(box(width, thick, mid, m.tin, p.at[0], from + s * (reach - foot), 0))
        group.add(box(width, foot, thick, m.tin, p.at[0], to - s * foot / 2, 0))
      }
    }
  } else {
    // the lands show at the body's edge
    for (const p of pads) {
      const dx = p.at[0] - cx, dz = p.at[1] - cz
      if (Math.abs(dx) < w / 2 - 0.6 && Math.abs(dz) < l / 2 - 0.6) continue
      const [ex, ez] = padExtent(p)
      group.add(box(Math.min(ex, 0.5), Math.min(ez, 0.5), 0.2, m.tin, Math.max(cx - w / 2 + 0.2, Math.min(cx + w / 2 - 0.2, p.at[0])), Math.max(cz - l / 2 + 0.2, Math.min(cz + l / 2 - 0.2, p.at[1])), 0))
    }
  }
  // pin 1: a dimple in its corner
  const one = pads.find((p) => p.num === '1')
  if (one && Math.min(w, l) > 1.1) {
    const r = Math.min(0.3, Math.min(w, l) * 0.1)
    const dot = new THREE.Mesh(new THREE.CircleGeometry(r, 24), new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.95 }))
    dot.rotation.x = -Math.PI / 2
    dot.position.set(cx + Math.sign(one.at[0] - cx || -1) * (w / 2 - r * 2.2), h + 0.004, cz + Math.sign(one.at[1] - cz || -1) * (l / 2 - r * 2.2))
    group.add(dot)
  }
  if (Math.min(w, l) > 1.2) group.add(centeredLabel(fp.value || fp.ref, cx, cz, w, l, h, l > w * 1.4))
  return h
}

/** A part with no shape here: a grey block over its courtyard (else its pads), its reference on top. */
function block(fp: Footprint, pads: ReturnType<typeof localPads>, group: THREE.Group, m: Materials): number {
  const crt = fp.graphics.filter((g) => /CrtYd/.test(g.layer)).flatMap((g) => g.pts)
  let minX: number, minY: number, maxX: number, maxY: number
  if (crt.length >= 2) {
    // the courtyard is drawn on the board: bring it back into the footprint's frame
    const a = (fp.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const local = crt.map(([x, y]): Xy => { const dx = x - fp.at[0], dy = y - fp.at[1]; return [dx * c - dy * s, dx * s + dy * c] })
    ;({ minX, minY, maxX, maxY } = boundsOf(local))
    minX += 0.25; minY += 0.25; maxX -= 0.25; maxY -= 0.25
  } else {
    ;({ minX, minY, maxX, maxY } = boundsOf(pads.flatMap((p) => { const [ex, ez] = padExtent(p); return [[p.at[0] - ex / 2, p.at[1] - ez / 2], [p.at[0] + ex / 2, p.at[1] + ez / 2]] as Xy[] })))
  }
  const w = Math.max(0.5, maxX - minX), d = Math.max(0.5, maxY - minY)
  const h = Math.min(3, Math.max(0.8, Math.min(w, d) * 0.35))
  group.add(box(w, d, h, m.block, (minX + maxX) / 2, (minY + maxY) / 2, 0, 0.1))
  group.add(centeredLabel(fp.ref, (minX + maxX) / 2, (minY + maxY) / 2, w, d, h, d > w * 1.4))
  return h
}
