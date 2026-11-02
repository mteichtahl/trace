/**
 * The board as a lifelike 3D scene (three.js): a glass-fibre core cut to the outline with its holes, the solder mask
 * faces (colour, height and bare-copper maps from ./artwork.ts) under a clear coat, plated pads and hole barrels,
 * solder joints under through-hole parts, and a body for every part (./parts.ts). Lit by a soft studio environment
 * with one shadow-casting light, tone-mapped for film, drawn only when something changed.
 *
 * Coordinates: one unit is a millimetre; the board's centre is the origin; x is KiCad's x, z is KiCad's y, y is up.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { Board, Finish, Footprint, Side, Xy } from '@/lib/kicad-board'
import { colourArt, heightArt, metalArt, scaleFor, type Look } from './artwork'
import { buildPart, makeMaterials, type Built } from './parts'

export type View = 'angled' | 'top' | 'edge'

export interface PartInfo {
  ref: string
  value: string
  footprint: string
  side: Side
  /** position from the board's top-left corner, mm */
  x: number
  y: number
  pads: number
  shape: Built['kind']
}

export interface SceneOptions {
  dark: boolean
  mask: string
  silk: string
  finish: Finish
  onPick: (part: PartInfo | null) => void
  /** called whenever a frame was drawn (the overlay follows the camera) */
  onFrame: () => void
}

export interface BoardScene {
  parts: PartInfo[]
  setLook(o: { mask?: string; silk?: string; finish?: Finish }): void
  showParts(on: boolean): void
  lift(k: number): void
  power(on: boolean): void
  turnOver(under: boolean): void
  view(v: View): void
  /** fly to a spot on the board (KiCad millimetres) */
  flyTo(x: number, y: number): void
  select(ref: string | null): void
  /** where a spot on the board (KiCad mm) is on screen, in px from the canvas's top-left; null when off screen */
  project(x: number, y: number): { x: number; y: number } | null
  setDark(dark: boolean): void
  dispose(): void
}

export const FINISH_COLOUR: Record<Finish, string> = { enig: '#e3bd6a', hasl: '#d4d6d9', osp: '#c98a5a' }

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export function buildScene(host: HTMLElement, board: Board, o: SceneOptions): BoardScene {
  const { minX, minY, maxX, maxY } = board.bounds
  const W = maxX - minX, H = maxY - minY, T = board.thickness
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const span = Math.max(W, H)
  const w3 = (x: number, y: number): [number, number] => [x - cx, y - cy]

  // ---- renderer, camera, light
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.9
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setSize(host.clientWidth, host.clientHeight)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.touchAction = 'none'
  renderer.domElement.setAttribute('aria-label', 'The board in 3D. Drag to turn it, scroll or pinch to zoom, tap a part to see what it is.')
  renderer.domElement.setAttribute('role', 'img')
  host.replaceChildren(renderer.domElement)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  scene.environment = pmrem.fromScene(room, 0.03).texture
  room.dispose()

  const key = new THREE.DirectionalLight(0xfff3e4, 2.3)
  key.position.set(span * 0.7, span * 1.4, span * 0.55)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  const sc = key.shadow.camera
  sc.left = sc.bottom = -span
  sc.right = sc.top = span
  sc.near = span * 0.1
  sc.far = span * 4
  key.shadow.bias = -0.0003
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xdce8ff, 0.7)
  rim.position.set(-span, span * 0.5, -span * 0.8)
  scene.add(rim)

  const camera = new THREE.PerspectiveCamera(32, host.clientWidth / Math.max(1, host.clientHeight), span / 200, span * 40)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.minDistance = Math.max(4, span * 0.15)
  controls.maxDistance = span * 6
  controls.zoomToCursor = true

  // the shadow catcher under everything (through-hole pins hang about 3 mm below the board)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ opacity: o.dark ? 0.35 : 0.16 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -T / 2 - Math.max(5, span * 0.08)
  floor.receiveShadow = true
  scene.add(floor)

  const holder = new THREE.Group() // turned over as a whole
  scene.add(holder)

  // ---- the board: core, faces, plating
  const shape = new THREE.Shape(board.outline.map(([x, y]) => new THREE.Vector2(x - cx, -(y - cy))))
  const holeLoops: Xy[][] = [...board.cutouts]
  const barrels: { at: Xy; r: number }[] = []
  for (const f of board.footprints) for (const p of f.pads) {
    if (!p.drill) continue
    const d = typeof p.drill === 'number' ? p.drill : Math.min(...p.drill)
    const n = 28
    holeLoops.push(Array.from({ length: n }, (_, i) => [p.at[0] + (Math.cos((i / n) * Math.PI * 2) * d) / 2, p.at[1] + (Math.sin((i / n) * Math.PI * 2) * d) / 2] as Xy))
    if (p.type === 'thru_hole') barrels.push({ at: p.at, r: d / 2 })
  }
  for (const loop of holeLoops) shape.holes.push(new THREE.Path(loop.map(([x, y]) => new THREE.Vector2(x - cx, -(y - cy)))))

  const fr4 = new THREE.MeshStandardMaterial({ color: 0xbfae7c, roughness: 0.88 })
  const core = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T - 0.03, bevelEnabled: false, curveSegments: 24 }), fr4)
  core.geometry.rotateX(-Math.PI / 2)
  core.geometry.translate(0, -(T - 0.03) / 2, 0)
  core.castShadow = true
  core.receiveShadow = true
  holder.add(core)

  const face = (side: Side): THREE.BufferGeometry => {
    const g = new THREE.ShapeGeometry(shape, 24)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position!, uv = g.attributes.uv!
    for (let i = 0; i < pos.count; i++) {
      const X = pos.getX(i) + cx, Y = pos.getZ(i) + cy
      uv.setXY(i, (X - minX) / W, 1 - (Y - minY) / H)
    }
    if (side === 'B') {
      // face down: normals point down and triangles wind the other way, so the face is seen from below
      g.scale(1, -1, 1)
      const idx = g.index!
      for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a) }
    }
    return g
  }
  const s = scaleFor(board)
  const tex = (c: HTMLCanvasElement, colour: boolean) => {
    const t = new THREE.CanvasTexture(c)
    if (colour) t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = renderer.capabilities.getMaxAnisotropy()
    return t
  }
  let look: Look = { mask: o.mask, silk: o.silk, metal: FINISH_COLOUR[o.finish] }
  const faces = (['F', 'B'] as Side[]).map((side) => {
    const geo = face(side)
    const y = side === 'F' ? T / 2 : -T / 2
    const mask = new THREE.MeshPhysicalMaterial({
      map: tex(colourArt(board, side, look, s), true), bumpMap: tex(heightArt(board, side, s), false), bumpScale: 0.035,
      roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.4,
    })
    const m = new THREE.Mesh(geo, mask)
    m.position.y = y + (side === 'F' ? 0.001 : -0.001)
    m.receiveShadow = true
    holder.add(m)
    const metalMap = tex(metalArt(board, side, s), false)
    const plating = new THREE.MeshStandardMaterial({ color: FINISH_COLOUR[o.finish], metalness: 1, roughness: o.finish === 'osp' ? 0.45 : 0.22, alphaMap: metalMap, alphaTest: 0.5, bumpMap: metalMap, bumpScale: 0.02 })
    const pm = new THREE.Mesh(geo, plating)
    pm.position.y = y + (side === 'F' ? 0.02 : -0.02)
    pm.receiveShadow = true
    holder.add(pm)
    return { side, mask, plating }
  })
  // the plated barrels of through-holes
  const barrelMat = new THREE.MeshStandardMaterial({ color: FINISH_COLOUR[o.finish], metalness: 1, roughness: 0.3, side: THREE.BackSide })
  for (const b of barrels) {
    const [x, z] = w3(b.at[0], b.at[1])
    const m = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r, T, 24, 1, true), barrelMat)
    m.position.set(x, 0, z)
    holder.add(m)
  }

  // ---- parts
  const mats = makeMaterials()
  const partsG = new THREE.Group()
  holder.add(partsG)
  const solder = new THREE.MeshStandardMaterial({ color: 0xd2d4d7, metalness: 1, roughness: 0.16 })
  const placed: { g: THREE.Group; fp: Footprint; built: Built; home: number }[] = []
  const lenses: THREE.Mesh[] = []
  const glows: THREE.PointLight[] = []
  const parts: PartInfo[] = []
  for (const fp of board.footprints) {
    const built = buildPart(fp, mats)
    const info: PartInfo = { ref: fp.ref, value: fp.value, footprint: fp.name, side: fp.side, x: round(fp.at[0] - minX), y: round(fp.at[1] - minY), pads: fp.pads.length, shape: built.kind }
    if (fp.ref) parts.push(info)
    if (built.kind === 'none') continue
    const g = new THREE.Group()
    g.add(built.group)
    const [x, z] = w3(fp.at[0], fp.at[1])
    const home = fp.side === 'F' ? T / 2 + 0.035 : -T / 2 - 0.035
    g.position.set(x, home, z)
    g.rotation.y = (fp.angle * Math.PI) / 180
    if (fp.side === 'B') g.scale.y = -1
    g.userData.ref = fp.ref
    g.traverse((c) => { c.userData.ref = fp.ref })
    partsG.add(g)
    placed.push({ g, fp, built, home })
    for (const l of built.lenses) {
      lenses.push(l)
      if (glows.length < 8) {
        const light = new THREE.PointLight((l.material as THREE.MeshPhysicalMaterial).color, 0, span * 0.4, 2)
        light.position.set(x, home + (fp.side === 'F' ? 1.2 : -1.2), z)
        holder.add(light)
        glows.push(light)
      }
    }
    // solder joints where through-hole leads come out on the far side
    for (const p of fp.pads) {
      if (p.type !== 'thru_hole' || !p.drill) continue
      const r = Math.min(p.size[0], p.size[1]) / 2
      const j = new THREE.Mesh(new THREE.SphereGeometry(r * 0.95, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), solder)
      const [jx, jz] = w3(p.at[0], p.at[1])
      const far = fp.side === 'F' ? -1 : 1
      j.scale.set(1, 0.65, 1)
      if (far < 0) j.rotation.x = Math.PI
      j.position.set(jx, far * (T / 2 + 0.02), jz)
      j.castShadow = true
      holder.add(j)
    }
  }

  // ---- drawing on demand
  let dirty = true
  let frame = 0
  let flip = { from: 0, to: 0, t: 1 }
  let tween: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t: number } | null = null
  let lifted = 0
  let outline: THREE.BoxHelper | null = null
  let last = performance.now()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  controls.addEventListener('change', () => { dirty = true })

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (flip.t < 1) {
      flip.t = reduce ? 1 : Math.min(1, flip.t + dt / 0.9)
      const k = ease(flip.t)
      holder.rotation.z = flip.from + (flip.to - flip.from) * k
      holder.position.y = Math.sin(Math.PI * k) * span * 0.18
      dirty = true
    }
    if (tween) {
      tween.t = reduce ? 1 : Math.min(1, tween.t + dt / 0.8)
      const k = ease(tween.t)
      camera.position.lerpVectors(tween.from, tween.to, k)
      controls.target.lerpVectors(tween.tf, tween.tt, k)
      if (tween.t >= 1) tween = null
      dirty = true
    }
    controls.update()
    if (dirty) {
      outline?.update()
      renderer.render(scene, camera)
      dirty = false
      o.onFrame()
    }
    frame = requestAnimationFrame(tick)
  }

  // far enough back that the whole board fits the frame, whatever its shape and the frame's
  const fit = () => {
    const half = Math.tan((camera.fov * Math.PI) / 360)
    const need = Math.max(H / 2 / half, W / 2 / (half * Math.max(0.3, camera.aspect)))
    return need * 1.25 + T
  }
  const VIEWS: Record<View, () => [number, number, number]> = {
    angled: () => { const d = fit() * 1.15; return [d * 0.42, d * 0.68, d * 0.6] },
    top: () => [0, fit(), 0.001],
    edge: () => [0, T * 2 + span * 0.04, fit()],
  }
  camera.position.set(...VIEWS.angled())
  controls.target.set(0, 0, 0)
  controls.update()
  frame = requestAnimationFrame(tick)

  const ro = new ResizeObserver(() => {
    camera.aspect = host.clientWidth / Math.max(1, host.clientHeight)
    camera.updateProjectionMatrix()
    renderer.setSize(host.clientWidth, host.clientHeight)
    dirty = true
  })
  ro.observe(host)

  // ---- picking: a tap (not a drag) on a part
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let down: [number, number] | null = null
  const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY] }
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
    const r = renderer.domElement.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = partsG.visible ? ray.intersectObjects(partsG.children, true)[0] : undefined
    const ref = (hit?.object.userData.ref as string | undefined) ?? null
    api.select(ref)
    o.onPick(ref ? parts.find((p) => p.ref === ref) ?? null : null)
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)

  const flipped = () => flip.to !== 0
  const v = new THREE.Vector3()

  const api: BoardScene = {
    parts,
    setLook(n) {
      look = { mask: n.mask ?? look.mask, silk: n.silk ?? look.silk, metal: n.finish ? FINISH_COLOUR[n.finish] : look.metal }
      for (const f of faces) {
        const t = f.mask.map!
        t.image = colourArt(board, f.side, look, s)
        t.needsUpdate = true
        if (n.finish) {
          f.plating.color.set(FINISH_COLOUR[n.finish])
          f.plating.roughness = n.finish === 'osp' ? 0.45 : 0.22
        }
      }
      if (n.finish) barrelMat.color.set(FINISH_COLOUR[n.finish])
      dirty = true
    },
    showParts(on) { partsG.visible = on; if (outline) outline.visible = on; dirty = true },
    lift(k) {
      lifted = k
      for (const p of placed) {
        const up = (span * 0.12 + p.built.height) * lifted
        p.g.position.y = p.home + (p.fp.side === 'F' ? up : -up)
      }
      dirty = true
    },
    power(on) {
      for (const l of lenses) (l.material as THREE.MeshPhysicalMaterial).emissiveIntensity = on ? 3.5 : 0
      for (const g of glows) g.intensity = on ? 5 : 0
      dirty = true
    },
    turnOver(under) {
      flip = { from: holder.rotation.z, to: under ? Math.PI : 0, t: 0 }
    },
    view(which) {
      const [x, y, z] = VIEWS[which]()
      tween = { from: camera.position.clone(), to: new THREE.Vector3(x, y, z), tf: controls.target.clone(), tt: new THREE.Vector3(), t: 0 }
    },
    flyTo(x, y) {
      const [wx, wz] = w3(x, y)
      const tx = flipped() ? -wx : wx
      const d = Math.max(span * 0.35, 12)
      tween = { from: camera.position.clone(), to: new THREE.Vector3(tx + d * 0.35, d * 0.85, wz + d * 0.6), tf: controls.target.clone(), tt: new THREE.Vector3(tx, 0, wz), t: 0 }
    },
    select(ref) {
      if (outline) { scene.remove(outline); outline.dispose(); outline = null }
      const p = ref ? placed.find((x) => x.fp.ref === ref) : undefined
      if (p) {
        outline = new THREE.BoxHelper(p.g, 0x38bdf8)
        outline.visible = partsG.visible
        scene.add(outline)
      }
      dirty = true
    },
    project(x, y) {
      const [wx, wz] = w3(x, y)
      // on the face that is up: the top, or the bottom once the board is turned over
      v.set(wx, flipped() ? -(T / 2 + 0.6) : T / 2 + 0.6, wz)
      holder.updateMatrixWorld()
      holder.localToWorld(v)
      v.project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null
      return { x: ((v.x + 1) / 2) * host.clientWidth, y: ((1 - v.y) / 2) * host.clientHeight }
    },
    setDark(dark) {
      ;(floor.material as THREE.ShadowMaterial).opacity = dark ? 0.35 : 0.16
      dirty = true
    },
    dispose() {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh
        m.geometry?.dispose?.()
        const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
        for (const mat of ms) {
          for (const k of ['map', 'bumpMap', 'alphaMap'] as const) (mat as THREE.MeshStandardMaterial)[k]?.dispose?.()
          mat.dispose()
        }
      })
      scene.environment?.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
  return api
}

const round = (n: number) => Math.round(n * 100) / 100
