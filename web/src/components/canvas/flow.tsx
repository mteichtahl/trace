/**
 * What every React Flow (@xyflow/react) drawing in the app shares: the traceability view, the block diagram and the
 * pin map. `FlowCanvas` puts a drawing in the Canvas frame with the frame's zoom and fit buttons driving React Flow's
 * viewport; `FlowView` draws the boxes and links and handles selection the same way everywhere: a click, a tap, or
 * Tab then Enter selects a box; clicking the empty canvas or Escape clears it. The drawing lights the selected box's
 * path itself (each module decides what the path is); `chainOf` is the usual rule.
 *
 * Boxes cannot be dragged or joined; a page scrolls past the drawing, and Ctrl/⌘ + scroll or a pinch zooms it.
 */
import '@xyflow/react/dist/base.css'
import { Background, type Edge, type Node, type NodeChange, type NodeTypes, ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CanvasFrame, type CanvasFrameProps } from './canvas-frame'

/**
 * How a drawing fits the frame: its boxes (with padding), or fixed bounds so a layout holds still between versions.
 * `readable`: the zoom below which the boxes cannot be read; a drawing that would open smaller than that (a long
 * column of rows) opens fitted to the frame's width instead, at its top, and the person drags it up and down. The
 * Fit button still shows the whole drawing.
 */
export type FlowFit = { padding: number; readable?: number } | { bounds: { x: number; y: number; width: number; height: number } }

type Rect = { x: number; y: number; width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }

/**
 * Where a drawing opens when fitting it whole would make it unreadable (smaller than `readable`): as wide as the frame
 * allows (between `readable` and 1), centred across when it is narrower, its top at the frame's top. null when the
 * whole drawing fits at a readable size (fit it whole), or the frame has no size yet. Pure.
 */
export function readableViewport(box: Rect, frame: { width: number; height: number }, padding: number, readable: number): Viewport | null {
  if (!frame.width || !frame.height || !box.width || !box.height) return null
  const pad = 1 + 2 * padding
  if (Math.min(frame.width / (box.width * pad), frame.height / (box.height * pad)) >= readable) return null
  const zoom = Math.min(1, Math.max(readable, frame.width / (box.width * pad)))
  const margin = Math.round(padding * Math.min(frame.width, frame.height) / 2) + 8
  return { zoom, x: Math.max(margin, (frame.width - box.width * zoom) / 2) - box.x * zoom, y: margin - box.y * zoom }
}

type Flow = ReturnType<typeof useReactFlow>
const fitTo = (flow: Flow, fit: FlowFit, duration?: number) =>
  'bounds' in fit ? flow.fitBounds(fit.bounds, { duration }) : flow.fitView({ padding: fit.padding, duration })
/** The first view of a drawing: readable (readableViewport) where it says so, else fitted. */
const openAt = (flow: Flow, fit: FlowFit, frame: { width: number; height: number }, duration?: number) => {
  const v = 'readable' in fit && fit.readable ? readableViewport(flow.getNodesBounds(flow.getNodes()), frame, fit.padding, fit.readable) : null
  return v ? flow.setViewport(v, { duration }) : fitTo(flow, fit, duration)
}

/** A drawing in the Canvas frame; `children` is a FlowView (or a component that renders one). */
export function FlowCanvas({ fit, children, ...frame }: Omit<CanvasFrameProps, 'viewport'> & { fit: FlowFit }) {
  return (
    <ReactFlowProvider>
      <Framed fit={fit} {...frame}>{children}</Framed>
    </ReactFlowProvider>
  )
}

function Framed({ fit, children, ...frame }: Omit<CanvasFrameProps, 'viewport'> & { fit: FlowFit }) {
  const flow = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const viewport = useMemo(() => ({
    zoom,
    zoomIn: () => void flow.zoomIn({ duration: 150 }),
    zoomOut: () => void flow.zoomOut({ duration: 150 }),
    fit: () => void fitTo(flow, fit, 200),
  }), [flow, zoom, fit])
  return <CanvasFrame {...frame} viewport={viewport}>{children}</CanvasFrame>
}

/** A selection a parent may hold (controlled) or leave to the drawing (uncontrolled, when `selected` is undefined). */
export function useFlowSelection<T>(controlled: string | null | undefined, onSelect: ((v: T | null) => void) | undefined, toValue: (key: string) => T | null) {
  const [own, setOwn] = useState<string | null>(null)
  const selected = controlled === undefined ? own : controlled
  const choose = useCallback((key: string | null) => {
    setOwn(key)
    onSelect?.(key ? toValue(key) : null)
  }, [onSelect, toValue])
  return [selected, choose] as const
}

export interface FlowViewProps {
  nodes: Node[]
  edges: Edge[]
  nodeTypes: NodeTypes
  selected: string | null
  onChoose: (key: string | null) => void
  /** the drawing's name for a screen reader */
  label: string
  fit: FlowFit
  /** fit again when this changes (a filter showing other boxes); unset, the drawing fits once */
  refitKey?: string
}

/** Needs a ReactFlowProvider above it (FlowCanvas gives one). */
export function FlowView({ nodes, edges, nodeTypes, selected, onChoose, label, fit, refitKey }: FlowViewProps) {
  const flow = useReactFlow()
  const pickable = useMemo(() => new Set(nodes.filter((n) => n.selectable !== false).map((n) => n.id)), [nodes])
  const store = useStoreApi()
  const sized = useStore((s) => s.width > 0 && s.height > 0)

  useEffect(() => {
    const t = setTimeout(() => { const { width, height } = store.getState(); void openAt(flow, fit, { width, height }, refitKey === undefined ? undefined : 200) }, 0)
    return () => clearTimeout(t)
    // fit is the caller's constant; refitKey says when the boxes changed; `sized` when the frame's size is first known
  }, [flow, store, refitKey, sized])

  // the selection leaves the drawing (a filter, another option): clear it
  useEffect(() => {
    if (selected && !pickable.has(selected)) onChoose(null)
  }, [selected, pickable, onChoose])

  // keyboard: Tab to a box and Enter selects it; Escape clears (React Flow reports both as select changes)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const on = changes.find((c) => c.type === 'select' && c.selected)
    if (on && 'id' in on) {
      if (on.id !== selected && pickable.has(on.id)) onChoose(on.id)
      return
    }
    if (selected && changes.some((c) => c.type === 'select' && !c.selected && c.id === selected)) onChoose(null)
  }, [selected, pickable, onChoose])

  return (
    <div className="h-full w-full" role="group" aria-label={label}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => { if (pickable.has(n.id)) onChoose(n.id) }}
        onPaneClick={() => selected && onChoose(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        deleteKeyCode={null}
        zoomOnScroll={false}
        zoomActivationKeyCode={['Control', 'Meta']}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.2}
        maxZoom={2.5}
      >
        <Background gap={16} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  )
}

export interface FlowLink {
  id: string
  source: string
  target: string
}

/**
 * A box's whole path: the box, everything it comes from (upstream) and everything that comes from it (downstream),
 * and the links on those paths. Siblings that only share a parent or child are not on it. Pure.
 */
export function chainOf(links: readonly FlowLink[], key: string): { nodes: Set<string>; links: Set<string> } {
  const nodes = new Set([key])
  const on = new Set<string>()
  // two directed walks, so a walk never turns round at a shared parent or child
  const walk = (from: 'source' | 'target', to: 'source' | 'target') => {
    const stack = [key]
    while (stack.length) {
      const at = stack.pop()!
      for (const l of links) {
        if (l[from] !== at) continue
        on.add(l.id)
        if (!nodes.has(l[to])) {
          nodes.add(l[to])
          stack.push(l[to])
        }
      }
    }
  }
  walk('source', 'target')
  walk('target', 'source')
  return { nodes, links: on }
}

export type Lit = 'none' | 'lit' | 'dim' | 'selected'
/** How a box shows against a selection's path. */
export const litOf = (path: { nodes: Set<string> } | null, selected: string | null, key: string): Lit =>
  !path ? 'none' : key === selected ? 'selected' : path.nodes.has(key) ? 'lit' : 'dim'

/** The classes for a box against a selection's path; `bad` boxes (failing, conflicting) light red. */
export const litClass = (lit: Lit, bad?: boolean): string | false =>
  lit === 'lit' ? (bad ? 'border-destructive ring-1 ring-destructive/60' : 'border-primary ring-1 ring-primary/50')
    : lit === 'selected' ? (bad ? 'border-destructive ring-2 ring-destructive' : 'border-primary ring-2 ring-primary')
      : lit === 'dim' && 'opacity-30'

/** A link's look against a selection's path; `bad` links stay red. */
export function litEdgeStyle(on: boolean, faded: boolean, o: { bad?: boolean; dashed?: boolean; base?: string } = {}) {
  const stroke = o.bad ? 'var(--destructive)' : on ? 'var(--primary)' : (o.base ?? 'var(--border)')
  return {
    stroke, strokeWidth: on ? 2.5 : o.bad ? 2 : 1.25, strokeDasharray: o.dashed ? '4 3' : undefined,
    opacity: faded ? 0.15 : 1, transition: 'opacity 150ms, stroke-width 150ms',
  }
}

/** Invisible connection points for a box (React Flow draws links between handles). */
export const HANDLE = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
