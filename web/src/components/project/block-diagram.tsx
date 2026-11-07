/**
 * The architecture block diagram (docs/user-journey.md, "Architecture block diagram"): each block with its name, its
 * key part with stock, and the requirements it serves; each connection with what flows along it. Positions are
 * fractions of the frame, so options compare with the layout held still (the view fits the frame, not the blocks).
 *
 * Drawn with React Flow (@xyflow/react), as the traceability view is: blocks are its nodes, connections its edges,
 * and its viewport pans and zooms from the Canvas frame's toolbar. Selecting a block (click, tap, or Tab then Enter)
 * lights it, every block it connects to in either direction, and the connections between them with what flows along
 * each; everything else fades. Clicking the empty canvas or pressing Escape clears it.
 */
import { type Edge, Handle, MarkerType, type Node, type NodeProps, Position } from '@xyflow/react'
import { memo, useCallback, useMemo } from 'react'
import type { CanvasFrameProps } from '@/components/canvas/canvas-frame'
import { FlowCanvas, FlowView, HANDLE, type Lit, litClass, litOf, useFlowSelection } from '@/components/canvas/flow'
import { StatusBadge } from '@/components/status-badge'
import type { Block, BlockConnection } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const W = 1180
const H = 470
const BW = 200
const BH = 92
// fit the frame (not the blocks), so switching options keeps every block where it was drawn; below 0.8 a block's
// words cannot be read (test-esp32-run2 R31: Architecture choice opened it at 65 %), so it opens at 0.8 from its top
// left corner and the person drags it; Fit still shows the whole drawing
export const FIT = { bounds: { x: -16, y: -16, width: W + 32, height: H + 32 }, readable: 0.8 }

type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: { side: Side; position: Position }[] = [
  { side: 'left', position: Position.Left }, { side: 'right', position: Position.Right }, { side: 'top', position: Position.Top }, { side: 'bottom', position: Position.Bottom },
]

/** A block and the blocks it connects to (either direction), and the connections between them. Pure. */
export function linkedTo(connections: readonly Pick<BlockConnection, 'from' | 'to'>[], id: string): { blocks: Set<string>; connections: Set<string> } {
  const blocks = new Set([id])
  const on = new Set<string>()
  for (const c of connections) {
    if (c.from !== id && c.to !== id) continue
    blocks.add(c.from === id ? c.to : c.from)
    on.add(connectionId(c))
  }
  return { blocks, connections: on }
}

export const connectionId = (c: Pick<BlockConnection, 'from' | 'to'>): string => `${c.from}>${c.to}`

/** Which sides a connection leaves and enters by, from where the two blocks sit. Pure. */
export function sidesFor(a: { x: number; y: number }, b: { x: number; y: number }): { from: Side; to: Side } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  // compare in box units, so a block straight below (wider than tall) still reads as below
  if (Math.abs(dx) / BW >= Math.abs(dy) / BH) return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' }
}

type BlockData = { block: Block; lit: Lit }
type BlockNode = Node<BlockData, 'block'>

const BlockBox = memo(function BlockBox({ data }: NodeProps<BlockNode>) {
  const b = data.block
  return (
    <div
      className={cn(
        'rounded-lg border-2 bg-card p-2.5 text-left text-xs text-card-foreground shadow-xs transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none hover:border-foreground/40',
        'border-border',
        b.serves.length === 0 && 'border-dashed border-warning',
        litClass(data.lit),
      )}
      style={{ width: BW, height: BH }}
    >
      {SIDES.map((s) => <Handle key={`t-${s.side}`} id={`t-${s.side}`} type="target" position={s.position} isConnectable={false} className={HANDLE} />)}
      {SIDES.map((s) => <Handle key={`s-${s.side}`} id={`s-${s.side}`} type="source" position={s.position} isConnectable={false} className={HANDLE} />)}
      <span className="block text-sm font-semibold">{b.name}</span>
      {b.part && (
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate font-mono">{b.part}</span>
          {b.stock && <StatusBadge plain status={b.stock === 'in_stock' ? 'met' : b.stock === 'low' ? 'warning' : 'failing'} label={b.stock === 'in_stock' ? 'In stock' : b.stock === 'low' ? 'Low stock' : 'Out of stock'} />}
        </span>
      )}
      <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{b.serves.length ? b.serves.join(' ') : 'Serves no requirement'}</span>
    </div>
  )
})

const nodeTypes = { block: BlockBox }

/** The blocks and connections for React Flow, lit for the selected block. Pure apart from the JSX in each block. */
export function blockElements(blocks: readonly Block[], connections: readonly BlockConnection[], selected: string | null): { nodes: BlockNode[]; edges: Edge[] } {
  const at = new Map(blocks.map((b) => [b.id, { x: b.x * (W - BW), y: b.y * (H - BH) }]))
  const near = selected && at.has(selected) ? linkedTo(connections, selected) : null
  const lit = (id: string): Lit => litOf(near && { nodes: near.blocks }, selected, id)
  const nodes: BlockNode[] = blocks.map((b) => ({
    id: b.id, type: 'block', position: at.get(b.id)!, selected: b.id === selected, ariaRole: 'button',
    ariaLabel: `${b.name}${b.part ? `, ${b.part}` : ''}. Serves ${b.serves.length ? b.serves.join(', ') : 'no requirement'}`,
    data: { block: b, lit: lit(b.id) },
  }))
  const edges: Edge[] = connections.flatMap((c) => {
    const a = at.get(c.from)
    const b = at.get(c.to)
    if (!a || !b) return []
    const id = connectionId(c)
    const on = near?.connections.has(id) ?? false
    const faded = !!near && !on
    const color = on ? 'var(--primary)' : 'var(--muted-foreground)'
    const s = sidesFor(a, b)
    return [{
      id, source: c.from, target: c.to, sourceHandle: `s-${s.from}`, targetHandle: `t-${s.to}`, label: c.label, selectable: false, focusable: false, zIndex: on ? 1 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: { stroke: color, strokeWidth: on ? 2.5 : 1.5, opacity: faded ? 0.15 : 1, transition: 'opacity 150ms, stroke-width 150ms' },
      labelStyle: { fontSize: 11, fill: on ? 'var(--foreground)' : 'var(--muted-foreground)', fontWeight: on ? 600 : 400, opacity: faded ? 0.25 : 1 },
      labelBgStyle: { fill: 'var(--card)', opacity: faded ? 0.25 : 1 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    }]
  })
  return { nodes, edges }
}

export interface BlockDiagramProps {
  blocks: Block[]
  connections: BlockConnection[]
  selected?: string | null
  /** a block was selected, or (null) the selection was cleared */
  onSelect?: (b: Block | null) => void
}

/** The block diagram in its Canvas frame, the frame's zoom and fit driving React Flow's viewport. */
export function BlockDiagramCanvas({ blocks, connections, selected, onSelect, ...frame }: BlockDiagramProps & Omit<CanvasFrameProps, 'children' | 'viewport'>) {
  return (
    <FlowCanvas {...frame} fit={FIT}>
      <BlockDiagram blocks={blocks} connections={connections} selected={selected} onSelect={onSelect} />
    </FlowCanvas>
  )
}

/** The drawing itself; needs a ReactFlowProvider above it (BlockDiagramCanvas gives one). Uncontrolled (no
 * `selected`), as in a skill step that only looks, it keeps its own selection. */
export function BlockDiagram({ blocks, connections, selected: controlled, onSelect }: BlockDiagramProps) {
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks])
  const toBlock = useCallback((id: string) => byId.get(id) ?? null, [byId])
  const [selected, choose] = useFlowSelection(controlled, onSelect, toBlock)
  const { nodes, edges } = useMemo(() => blockElements(blocks, connections, selected ?? null), [blocks, connections, selected])
  return (
    <FlowView
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} selected={selected} onChoose={choose} fit={FIT}
      label="Block diagram. Select a block to light what it connects to."
    />
  )
}
