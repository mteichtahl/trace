/**
 * 3D models with three.js: .stl and .glb/.gltf, and .step/.stp through occt-import-js (OpenCascade compiled to
 * WebAssembly, about 7 MB, fetched only when a STEP file is opened). Orbit with the mouse or a finger, a section plane
 * that slides through the model, and explode (each part pushed out from the centre) for models with several parts.
 * The card is a still view with no controls.
 */
import { useEffect, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useFileBytes } from '../data'
import { extOf } from '../kinds'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

type Three = typeof import('three')

interface Scene {
  dispose: () => void
  setSection: (on: boolean, at: number) => void
  setExplode: (k: number) => void
  parts: number
}

async function loadStep(bytes: ArrayBuffer, THREE: Three) {
  const [{ default: init }, { default: wasmUrl }] = await Promise.all([import('occt-import-js'), import('occt-import-js/dist/occt-import-js.wasm?url')])
  const occt = await init({ locateFile: () => wasmUrl })
  const res = occt.ReadStepFile(new Uint8Array(bytes), null)
  if (!res.success) throw new Error('OpenCascade could not read this STEP file.')
  const group = new THREE.Group()
  for (const m of res.meshes) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3))
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3))
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index.array), 1))
    if (!m.attributes.normal) g.computeVertexNormals()
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0x9aa3ad)
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide })))
  }
  return group
}

async function build(el: HTMLElement, bytes: ArrayBuffer, ext: string, interactive: boolean, dark: boolean): Promise<Scene> {
  const THREE = await import('three')
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')
  let object: import('three').Object3D
  if (ext === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
    const g = new STLLoader().parse(bytes)
    g.computeVertexNormals()
    object = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8c96a3, metalness: 0.15, roughness: 0.6, side: THREE.DoubleSide }))
  } else if (ext === 'step' || ext === 'stp') {
    object = await loadStep(bytes, THREE)
  } else {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const gltf = await new GLTFLoader().parseAsync(bytes, '')
    object = gltf.scene
  }

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(dark ? 0x17171a : 0xf4f4f5)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666670, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  // centre and frame the model
  const box = new THREE.Box3().setFromObject(object)
  const centre = box.getCenter(new THREE.Vector3())
  const span = box.getSize(new THREE.Vector3()).length() || 1
  object.position.sub(centre)
  const holder = new THREE.Group()
  holder.add(object)
  scene.add(holder)

  const camera = new THREE.PerspectiveCamera(40, el.clientWidth / Math.max(1, el.clientHeight), span / 1000, span * 100)
  camera.position.set(span * 0.8, span * 0.6, span * 0.9)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !interactive })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(el.clientWidth, el.clientHeight)
  renderer.localClippingEnabled = true
  el.replaceChildren(renderer.domElement)
  renderer.domElement.setAttribute('aria-label', '3D model; drag to orbit, scroll to zoom')

  const controls = interactive ? new OrbitControls(camera, renderer.domElement) : null
  if (controls) controls.enableDamping = true

  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
  const meshes: import('three').Mesh[] = []
  object.traverse((o) => {
    if ((o as import('three').Mesh).isMesh) meshes.push(o as import('three').Mesh)
  })
  // explode: top-level parts move out along the line from the centre
  const parts = (object.children.length > 1 ? object.children : meshes).map((p) => {
    const b = new THREE.Box3().setFromObject(p)
    return { o: p, home: p.position.clone(), dir: b.getCenter(new THREE.Vector3()).sub(new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3())) }
  })

  let frame = 0
  const tick = () => {
    controls?.update()
    renderer.render(scene, camera)
    if (interactive) frame = requestAnimationFrame(tick)
  }
  tick()
  const ro = new ResizeObserver(() => {
    camera.aspect = el.clientWidth / Math.max(1, el.clientHeight)
    camera.updateProjectionMatrix()
    renderer.setSize(el.clientWidth, el.clientHeight)
    if (!interactive) renderer.render(scene, camera)
  })
  ro.observe(el)

  return {
    parts: parts.length,
    setSection(on, at) {
      plane.constant = (at - 0.5) * box.getSize(new THREE.Vector3()).y
      for (const m of meshes) {
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.clippingPlanes = on ? [plane] : []
      }
    },
    setExplode(k) {
      for (const p of parts) p.o.position.copy(p.home).addScaledVector(p.dir, k)
    },
    dispose() {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls?.dispose()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as import('three').Mesh
        m.geometry?.dispose?.()
      })
    },
  }
}

export default function ModelViewer({ file, size, commit }: ViewerProps) {
  const ext = extOf(file.path)
  const q = useFileBytes(file, { commit })
  const host = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<Scene | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [section, setSection] = useState(false)
  const [at, setAt] = useState(50)
  const [explode, setExplode] = useState(0)

  useEffect(() => {
    if (!q.data || !host.current) return
    let s: Scene | null = null
    let live = true
    setBuilding(true)
    setErr(null)
    const dark = document.documentElement.classList.contains('dark')
    build(host.current, q.data, ext, size !== 'card', dark)
      .then((made) => {
        if (!live) return made.dispose()
        s = made
        setScene(made)
      })
      .catch((e: Error) => live && setErr(e.message))
      .finally(() => live && setBuilding(false))
    return () => {
      live = false
      s?.dispose()
      setScene(null)
    }
  }, [q.data, ext, size])

  useEffect(() => scene?.setSection(section, at / 100), [scene, section, at])
  useEffect(() => scene?.setExplode(explode / 100), [scene, explode])

  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (err)
    return (
      <Note>
        This model could not be drawn: {err} {ext === 'step' || ext === 'stp' ? 'Download it and open it in a CAD program, or ask trace for an STL or GLB export.' : ''}
      </Note>
    )
  return (
    <div className={cn('flex flex-col', size === 'card' ? 'h-[220px]' : AREA[size])}>
      {size !== 'card' && (
        <Controls>
          <div className="flex items-center gap-2">
            <Switch id="section" checked={section} onCheckedChange={setSection} />
            <Label htmlFor="section" className="text-xs font-normal">Section</Label>
            {section && <Slider value={[at]} onValueChange={([v]) => setAt(v ?? 50)} min={0} max={100} className="w-32" aria-label="Section height" />}
          </div>
          <div className="flex items-center gap-2">
            <span>Explode</span>
            <Slider value={[explode]} onValueChange={([v]) => setExplode(v ?? 0)} min={0} max={100} className="w-32" disabled={!scene || scene.parts < 2} aria-label="Explode parts" />
            {scene && scene.parts < 2 && <span className="text-muted-foreground">one part only</span>}
          </div>
          <span className="ml-auto text-muted-foreground">Drag to orbit · scroll to zoom · right-drag to pan</span>
        </Controls>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {(!q.data || building) && (
          <div className="absolute inset-0">
            <ViewerLoading size={size} label={ext === 'step' || ext === 'stp' ? 'Loading OpenCascade to read the STEP file' : 'Drawing the model'} />
          </div>
        )}
      </div>
      {size !== 'card' && <Note>Clash marks for the board in its enclosure need trace's clash check; they are not in the model file.</Note>}
    </div>
  )
}
