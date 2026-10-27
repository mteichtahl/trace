/**
 * The graph drawn with Cytoscape.js (loaded lazily with its fcose force layout, falling back to cose): node shapes per
 * kind, link labels, "related by meaning" dashed, the focus with an accent ring, failing chains in red, the selected
 * path highlighted, "+N more" groups dashed. Colours come from the theme's CSS variables, read when the theme changes,
 * so light and dark both work. A mini-map shows where the view is. Keyboard handling lives in the screen.
 */
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { GroupNode, Graph, NodeKind } from '@/lib/graph'
import { LINK_WORD } from '@/lib/graph'

let layoutName: 'fcose' | 'cose' = 'cose'
let registered: Promise<void> | null = null
function register(): Promise<void> {
  registered ??= import('cytoscape-fcose')
    .then((m) => {
      cytoscape.use((m as { default: cytoscape.Ext }).default)
      layoutName = 'fcose'
    })
    .catch(() => {
      layoutName = 'cose'
    })
  return registered
}

/** The design's shape per kind (docs/ui-design.md, "What is in the graph"). */
const SHAPE: Record<NodeKind, string> = {
  intent: 'round-rectangle',
  requirement: 'ellipse',
  block: 'round-rectangle',
  part: 'hexagon',
  datasheet: 'tag',
  run: 'diamond',
  decision: 'triangle',
  memory: 'ellipse',
  document: 'rectangle',
  person: 'ellipse',
}
const SIZE: Partial<Record<NodeKind, [number, number]>> = { intent: [140, 34], memory: [16, 16], block: [34, 34], person: [30, 30], requirement: [44, 44], document: [26, 32], datasheet: [26, 32] }

let probe: CanvasRenderingContext2D | null = null
/** A theme token as rgb(): Cytoscape cannot read oklch(), and computed styles keep it, so paint one pixel and read it. */
function cssColour(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!v) return fallback
  try {
    probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
    if (!probe) return fallback
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = fallback
    probe.fillStyle = v
    probe.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
    return a !== undefined && a < 255 ? `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})` : `rgb(${r}, ${g}, ${b})`
  } catch {
    return fallback
  }
}

export interface Theme {
  fg: string
  muted: string
  border: string
  bg: string
  card: string
  primary: string
  failing: string
  verified: string
  warning: string
}

export function readTheme(): Theme {
  return {
    fg: cssColour('--foreground', '#111'),
    muted: cssColour('--muted-foreground', '#777'),
    border: cssColour('--border', '#ddd'),
    bg: cssColour('--background', '#fff'),
    card: cssColour('--card', '#fff'),
    primary: cssColour('--primary', '#2563eb'),
    failing: cssColour('--destructive', '#dc2626'),
    verified: cssColour('--verified', '#16a34a'),
    warning: cssColour('--warning', '#d97706'),
  }
}

function styles(t: Theme): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        'background-color': t.card,
        'border-width': 1.5,
        'border-color': t.muted,
        label: 'data(label)',
        color: t.fg,
        'font-size': 11,
        'font-family': 'Geist Variable, ui-sans-serif, system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'text-wrap': 'ellipsis',
        'text-max-width': '150px',
        width: 30,
        height: 30,
        'text-background-color': t.bg,
        'text-background-opacity': 0.75,
        'text-background-padding': '1px',
      },
    },
    ...(Object.keys(SHAPE) as NodeKind[]).map((k) => ({ selector: `node[kind="${k}"]`, style: { shape: SHAPE[k], ...(SIZE[k] ? { width: SIZE[k]![0], height: SIZE[k]![1] } : {}) } as Record<string, unknown> })),
    { selector: 'node[kind="intent"]', style: { 'text-valign': 'center', 'text-margin-y': 0, 'font-weight': 600, 'text-max-width': '130px' } },
    { selector: 'node[kind="requirement"]', style: { 'text-valign': 'center', 'text-margin-y': 0, 'font-family': 'Geist Mono Variable, ui-monospace, monospace', 'font-weight': 600, label: 'data(label)' } },
    { selector: 'node[kind="memory"]', style: { 'border-style': 'dotted', 'border-width': 2 } },
    { selector: 'node[kind="person"]', style: { 'text-valign': 'center', 'text-margin-y': 0, 'font-weight': 600, 'font-size': 10 } },
    { selector: 'node[kind="document"]', style: { 'border-style': 'double', 'border-width': 3 } },
    { selector: 'node[status="failing"]', style: { 'border-color': t.failing } },
    { selector: 'node[status="verified"]', style: { 'border-color': t.verified } },
    { selector: 'node[status="waived"], node[status="inactive"]', style: { 'border-style': 'dashed' } },
    { selector: 'node.group', style: { shape: 'round-rectangle', width: 120, height: 26, 'border-style': 'dashed', 'text-valign': 'center', 'text-margin-y': 0, 'font-size': 11, color: t.muted } },
    { selector: 'node.chain', style: { 'border-color': t.failing, 'border-width': 2.5 } },
    { selector: 'node.focus', style: { 'border-width': 3, 'border-color': t.primary, 'overlay-color': t.primary, 'overlay-opacity': 0.06, 'overlay-padding': 6, 'font-weight': 700 } },
    { selector: 'node:selected, node.selected', style: { 'border-width': 3, 'border-color': t.primary, 'underlay-color': t.primary, 'underlay-opacity': 0.15, 'underlay-padding': 6 } },
    { selector: 'node.path', style: { 'underlay-color': t.primary, 'underlay-opacity': 0.25, 'underlay-padding': 7 } },
    { selector: 'node.dim, edge.dim', style: { opacity: 0.3 } },
    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': t.muted,
        'target-arrow-color': t.muted,
        'target-arrow-shape': 'none',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 9,
        color: t.muted,
        'text-rotation': 'autorotate',
        'text-background-color': t.bg,
        'text-background-opacity': 0.9,
        'text-background-padding': '1px',
        'line-opacity': 0.7,
      },
    },
    { selector: 'edge[kind="related"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] } },
    { selector: 'edge.group', style: { 'line-style': 'dashed', label: '' } },
    { selector: 'edge.chain', style: { 'line-color': t.failing, color: t.failing, width: 2.5, 'line-opacity': 1 } },
    { selector: 'edge.path', style: { 'line-color': t.primary, color: t.primary, width: 3, 'line-opacity': 1 } },
  ] as unknown as StylesheetJson
}

export interface CanvasHandle {
  fit: () => void
  zoom: (factor: number) => void
  focusNode: (id: string) => void
}

export interface GraphCanvasProps {
  graph: Graph
  groups: GroupNode[]
  focus: string
  selected: string | null
  chain: { nodes: Set<string>; links: Set<string> } | null
  path: { nodes: Set<string>; links: Set<string> } | null
  pinned: boolean
  onSelect: (id: string | null) => void
  onOpenGroup: (g: GroupNode) => void
  onHover: (h: { id: string; x: number; y: number } | null) => void
  handle?: Ref<CanvasHandle>
}

export default function GraphCanvas({ graph, groups, focus, selected, chain, path, pinned, onSelect, onOpenGroup, onHover, handle }: GraphCanvasProps) {
  const box = useRef<HTMLDivElement>(null)
  const mini = useRef<HTMLCanvasElement>(null)
  const cy = useRef<Core | null>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const [ready, setReady] = useState(false)
  const [themeKey, setThemeKey] = useState(0)
  const cb = useRef({ onSelect, onOpenGroup, onHover, groups })
  cb.current = { onSelect, onOpenGroup, onHover, groups }

  // the theme: re-read the tokens when the root's class changes (light, dark, contrast)
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeKey((k) => k + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const on = () => setThemeKey((k) => k + 1)
    mq?.addEventListener('change', on)
    return () => {
      mo.disconnect()
      mq?.removeEventListener('change', on)
    }
  }, [])

  // create once
  useEffect(() => {
    let alive = true
    void register().then(() => {
      if (!alive || !box.current) return
      const c = cytoscape({ container: box.current, style: styles(readTheme()), minZoom: 0.2, maxZoom: 3, boxSelectionEnabled: false })
      c.on('tap', 'node', (e) => {
        const id = e.target.id() as string
        const g = cb.current.groups.find((x) => x.id === id)
        if (g) cb.current.onOpenGroup(g)
        else cb.current.onSelect(id)
      })
      c.on('tap', (e) => {
        if (e.target === c) cb.current.onSelect(null)
      })
      c.on('mouseover', 'node', (e) => {
        const p = e.target.renderedPosition()
        cb.current.onHover({ id: e.target.id(), x: p.x, y: p.y })
      })
      c.on('mouseout', 'node', () => cb.current.onHover(null))
      c.on('dragfree', 'node', (e) => positions.current.set(e.target.id(), { ...e.target.position() }))
      c.on('render viewport', () => drawMini(c, mini.current))
      cy.current = c
      setReady(true)
    })
    return () => {
      alive = false
      cy.current?.destroy()
      cy.current = null
    }
  }, [])

  useEffect(() => {
    cy.current?.style(styles(readTheme()))
    if (cy.current) drawMini(cy.current, mini.current)
  }, [themeKey, ready])

  // the elements, and a layout when they change (unless pinned)
  const key = graph.nodes.map((n) => n.id).join('|') + '#' + graph.links.map((l) => l.id).join('|') + '#' + groups.map((g) => g.id + g.members.length).join('|')
  useEffect(() => {
    const c = cy.current
    if (!c) return
    const els: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id, label: n.kind === 'person' ? n.label : n.label, kind: n.kind, status: n.status ?? '' } })),
      ...groups.map((g) => ({ group: 'nodes' as const, data: { id: g.id, label: g.label, kind: g.kind }, classes: 'group' })),
      ...graph.links.map((l) => ({ group: 'edges' as const, data: { id: l.id, source: l.source, target: l.target, kind: l.kind, label: l.kind === 'related' ? '' : LINK_WORD[l.kind] } })),
      ...groups.map((g) => ({ group: 'edges' as const, data: { id: `${g.id}-edge`, source: g.parent, target: g.id, kind: 'group' }, classes: 'group' })),
    ]
    c.batch(() => {
      c.elements().remove()
      c.add(els)
    })
    const known = c.nodes().filter((n) => positions.current.has(n.id()))
    if (pinned && known.length === c.nodes().length) {
      c.nodes().forEach((n) => { n.position(positions.current.get(n.id())!) })
      c.fit(undefined, 40)
      return
    }
    if (pinned) known.forEach((n) => { n.position(positions.current.get(n.id())!); n.lock() })
    const layout = c.layout({
      name: layoutName,
      animate: false,
      randomize: !pinned,
      nodeRepulsion: () => 9000,
      idealEdgeLength: () => 110,
      nodeSeparation: 90,
      padding: 40,
      fit: true,
    } as cytoscape.LayoutOptions)
    layout.one('layoutstop', () => {
      c.nodes().forEach((n) => {
        positions.current.set(n.id(), { ...n.position() })
        n.unlock()
      })
      drawMini(c, mini.current)
    })
    layout.run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  // classes: focus, selected, chains and the path
  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.batch(() => {
      c.elements().removeClass('focus selected chain path dim')
      c.getElementById(focus).addClass('focus')
      if (selected) c.getElementById(selected).addClass('selected')
      chain?.nodes.forEach((id) => c.getElementById(id).addClass('chain'))
      chain?.links.forEach((id) => c.getElementById(id).addClass('chain'))
      if (path && path.nodes.size) {
        path.nodes.forEach((id) => c.getElementById(id).addClass('path'))
        path.links.forEach((id) => c.getElementById(id).addClass('path'))
        c.elements().not('.path').addClass('dim')
      }
    })
  }, [focus, selected, chain, path, key, ready])

  // pinned: stop items moving
  useEffect(() => {
    const c = cy.current
    if (!c) return
    if (pinned) c.nodes().forEach((n) => { positions.current.set(n.id(), { ...n.position() }) })
    c.autoungrabify(false)
  }, [pinned])

  useImperativeHandle(handle, () => ({
    fit: () => cy.current?.fit(undefined, 40),
    zoom: (f) => {
      const c = cy.current
      if (!c) return
      c.zoom({ level: c.zoom() * f, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } })
    },
    focusNode: (id) => {
      const c = cy.current
      const n = c?.getElementById(id)
      if (!c || !n || n.empty()) return
      c.animate({ center: { eles: n } }, { duration: 150 })
    },
  }), [])

  return (
    <div className="relative h-full w-full">
      <div ref={box} className="h-full w-full" aria-hidden />
      <canvas
        ref={mini}
        width={140}
        height={88}
        aria-label="Mini-map: where the view is"
        className="absolute bottom-3 right-3 hidden cursor-pointer rounded-md border bg-background/90 md:block"
        onClick={(e) => {
          const c = cy.current
          if (!c) return
          const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
          const bb = c.elements().boundingBox()
          const s = Math.min(140 / bb.w, 88 / bb.h)
          const x = bb.x1 + (e.clientX - r.left - (140 - bb.w * s) / 2) / s
          const y = bb.y1 + (e.clientY - r.top - (88 - bb.h * s) / 2) / s
          c.pan({ x: c.width() / 2 - x * c.zoom(), y: c.height() / 2 - y * c.zoom() })
        }}
      />
    </div>
  )
}

/** A simple overview: every node as a dot, the viewport as a rectangle. */
function drawMini(c: Core, canvas: HTMLCanvasElement | null) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const t = readThemeCached()
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  if (c.nodes().empty()) return
  const bb = c.elements().boundingBox()
  const s = Math.min(W / Math.max(1, bb.w), H / Math.max(1, bb.h)) * 0.9
  const ox = (W - bb.w * s) / 2
  const oy = (H - bb.h * s) / 2
  ctx.fillStyle = t.muted
  c.nodes().forEach((n) => {
    const p = n.position()
    ctx.fillStyle = n.hasClass('focus') ? t.primary : n.hasClass('chain') ? t.failing : t.muted
    ctx.beginPath()
    ctx.arc(ox + (p.x - bb.x1) * s, oy + (p.y - bb.y1) * s, n.hasClass('focus') ? 3 : 1.6, 0, Math.PI * 2)
    ctx.fill()
  })
  const ext = c.extent()
  ctx.strokeStyle = t.primary
  ctx.lineWidth = 1.2
  ctx.strokeRect(ox + (ext.x1 - bb.x1) * s, oy + (ext.y1 - bb.y1) * s, ext.w * s, ext.h * s)
}

let cached: { at: number; t: Theme } | null = null
function readThemeCached(): Theme {
  if (!cached || Date.now() - cached.at > 1000) cached = { at: Date.now(), t: readTheme() }
  return cached.t
}
