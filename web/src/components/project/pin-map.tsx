/**
 * The pin map: the pin plan drawn as peripheral → pin → net, so a person sees which pins a UART, I²C bus or timer
 * takes and which net each pin drives. Drawn with React Flow like the traceability view and the block diagram.
 *
 * Selecting a box lights its whole path: a peripheral lights its pins and their nets; a pin its peripheral and its
 * net; a net every pin on it and their peripherals. A conflicting pin and its path are red; a spare pin is dashed
 * and has no peripheral. Clicking the empty canvas or Escape clears the selection.
 */
import { type Edge, Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { type ReactNode, memo, useCallback, useMemo } from 'react'
import type { CanvasFrameProps } from '@/components/canvas/canvas-frame'
import { FlowCanvas, FlowView, HANDLE, type FlowLink, type Lit, chainOf, litClass, litEdgeStyle, litOf, useFlowSelection } from '@/components/canvas/flow'
import { StatusBadge } from '@/components/status-badge'
import type { PinView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const ROW = 52
const BOX = 44
const COL = { per: { x: 0, w: 170 }, pin: { x: 240, w: 240 }, net: { x: 550, w: 190 } }
const FIT = { padding: 0.06 }

export const PIN_STATUS: Record<PinView['status'], { status: 'met' | 'failing' | 'idle' | 'waived' | 'yours'; label: string }> = {
  ok: { status: 'met', label: 'Agreed' }, conflict: { status: 'failing', label: 'Conflict' }, spare: { status: 'idle', label: 'Spare' }, waived: { status: 'waived', label: 'Waived' },
  // an open question names its part: not agreed until it is answered (test-esp32 #106)
  asked: { status: 'yours', label: 'Open question' },
}

/** A pin's key: its part (where the plan names one) and its pin. */
export const pinId = (p: Pick<PinView, 'part' | 'pin'>): string => `${p.part ?? ''}.${p.pin}`

/**
 * The peripheral a pin belongs to: the plan's own word where it gives one, else read from the function
 * ("USART2_TX" → USART2, "ADC_IN6" → ADC, "SWDIO" → SWD, "GPIO" → GPIO). A spare pin has none. Pure.
 */
export function peripheralOf(p: Pick<PinView, 'fn' | 'peripheral' | 'status'>): string | null {
  if (p.status === 'spare' || /^spare$/i.test(p.fn.trim())) return null
  if (p.peripheral) return p.peripheral
  const fn = p.fn.trim()
  if (/^SW(DIO|CLK|O)$/i.test(fn)) return 'SWD'
  if (/^GPIO/i.test(fn)) return 'GPIO'
  const m = fn.match(/^([^_]+)_/)
  return m ? m[1]!.toUpperCase() : fn || null
}

export interface PinLayout {
  pins: { pin: PinView; key: string; y: number; per: string | null; bad: boolean }[]
  pers: { name: string; y: number; pins: number; bad: boolean }[]
  nets: { name: string; y: number; pins: number; bad: boolean }[]
  links: (FlowLink & { bad: boolean; dashed: boolean })[]
}

/** Place every box: pins grouped by peripheral (spares last), each peripheral and net beside its pins. Pure. */
export function layoutPins(pins: readonly PinView[]): PinLayout {
  const order: string[] = []
  for (const p of pins) {
    const per = peripheralOf(p)
    if (per && !order.includes(per)) order.push(per)
  }
  const rank = (p: PinView) => { const per = peripheralOf(p); return per ? order.indexOf(per) : order.length }
  const sorted = pins.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p)
  const placed = sorted.map((pin, i) => ({ pin, key: `pin:${pinId(pin)}`, y: i * ROW, per: peripheralOf(pin), bad: pin.status === 'conflict' }))

  // a peripheral sits at the middle of its pins, a net beside its first pin; neither overlaps the one above it
  const column = <T extends { name: string; ys: number[]; bad: boolean }>(xs: T[], at: (ys: number[]) => number) => {
    let next = 0
    return xs.map((x) => {
      const y = Math.max(at(x.ys), next)
      next = y + ROW
      return { name: x.name, y, pins: x.ys.length, bad: x.bad }
    })
  }
  const group = (by: (r: (typeof placed)[number]) => string | null) => {
    const m = new Map<string, { name: string; ys: number[]; bad: boolean }>()
    for (const r of placed) {
      const k = by(r)
      if (!k) continue
      const g = m.get(k) ?? { name: k, ys: [], bad: false }
      g.ys.push(r.y)
      g.bad ||= r.bad
      m.set(k, g)
    }
    return [...m.values()]
  }
  const pers = column(group((r) => r.per), (ys) => (ys[0]! + ys[ys.length - 1]!) / 2)
  const nets = column(group((r) => r.pin.net || null), (ys) => ys[0]!)

  const links = placed.flatMap((r) => [
    ...(r.per ? [{ id: `per:${r.per}>${r.key}`, source: `per:${r.per}`, target: r.key, bad: r.bad, dashed: false }] : []),
    ...(r.pin.net ? [{ id: `${r.key}>net:${r.pin.net}`, source: r.key, target: `net:${r.pin.net}`, bad: r.bad, dashed: r.pin.status === 'spare' }] : []),
  ])
  return { pins: placed, pers, nets, links }
}

type BoxData = { lit: Lit; bad: boolean; dashed: boolean; side: 'left' | 'right' | 'both'; width: number; body: ReactNode }
type HeadData = { label: string; width: number }
type BoxNode = Node<BoxData, 'box'>
type HeadNode = Node<HeadData, 'head'>

const Box = memo(function Box({ data }: NodeProps<BoxNode>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card px-2.5 py-1 text-left text-xs leading-snug text-card-foreground shadow-xs transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none hover:border-foreground/30',
        data.bad && 'border-destructive/60 bg-destructive/5',
        data.dashed && 'border-dashed',
        litClass(data.lit, data.bad),
      )}
      style={{ width: data.width, height: BOX }}
    >
      {data.side !== 'right' && <Handle type="target" position={Position.Left} isConnectable={false} className={HANDLE} />}
      {data.body}
      {data.side !== 'left' && <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />}
    </div>
  )
})

const Head = memo(function Head({ data }: NodeProps<HeadNode>) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ width: data.width }}>{data.label}</div>
})

const nodeTypes = { box: Box, head: Head }
const count = (n: number) => `${n} ${n === 1 ? 'pin' : 'pins'}`

/** The boxes and links for React Flow, lit for the selected box's path. Pure apart from the JSX in each box. */
export function pinElements(l: PinLayout, selected: string | null, showPart: boolean): { nodes: (BoxNode | HeadNode)[]; edges: Edge[] } {
  const path = selected ? chainOf(l.links, selected) : null
  const head = (id: string, label: string, x: number, width: number): HeadNode => ({ id: `head:${id}`, type: 'head', position: { x, y: -26 }, data: { label, width }, selectable: false, focusable: false, draggable: false })
  const nodes: (BoxNode | HeadNode)[] = [head('per', 'Peripheral', COL.per.x, COL.per.w), head('pin', 'Pin', COL.pin.x, COL.pin.w), head('net', 'Net', COL.net.x, COL.net.w)]
  for (const p of l.pers) {
    const key = `per:${p.name}`
    nodes.push({
      id: key, type: 'box', position: { x: COL.per.x, y: p.y }, selected: key === selected, ariaLabel: `Peripheral ${p.name}, ${count(p.pins)}`,
      data: {
        lit: litOf(path, selected, key), bad: p.bad, dashed: false, side: 'right', width: COL.per.w,
        body: (
          <>
            <span className="block truncate font-semibold">{p.name}</span>
            <span className="block text-[11px] text-muted-foreground">{count(p.pins)}{p.bad ? ' · conflict' : ''}</span>
          </>
        ),
      },
    })
  }
  for (const r of l.pins) {
    const p = r.pin
    const s = PIN_STATUS[p.status]
    nodes.push({
      id: r.key, type: 'box', position: { x: COL.pin.x, y: r.y }, selected: r.key === selected,
      ariaLabel: `Pin ${showPart && p.part ? `${p.part}.` : ''}${p.pin}${p.name && p.name !== p.pin ? ` (${p.name})` : ''}: ${p.fn} on ${p.net || 'no net'}, ${s.label}`,
      data: {
        lit: litOf(path, selected, r.key), bad: r.bad, dashed: p.status === 'spare', side: r.per ? 'both' : 'right', width: COL.pin.w,
        body: (
          <>
            <span className="flex items-center gap-1.5">
              <span className="truncate font-mono font-semibold">{showPart && p.part ? `${p.part}.` : ''}{p.pin}</span>
              {p.name && p.name !== p.pin && <span className="truncate font-mono text-muted-foreground">{p.name}</span>}
              {p.status !== 'ok' && <span className="ml-auto shrink-0"><StatusBadge plain status={s.status} label={s.label} /></span>}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{p.fn}{p.alt ? ` · alt ${p.alt}` : ''}</span>
          </>
        ),
      },
    })
  }
  for (const n of l.nets) {
    const key = `net:${n.name}`
    nodes.push({
      id: key, type: 'box', position: { x: COL.net.x, y: n.y }, selected: key === selected, ariaLabel: `Net ${n.name}, ${count(n.pins)}`,
      data: {
        lit: litOf(path, selected, key), bad: n.bad, dashed: false, side: 'left', width: COL.net.w,
        body: (
          <>
            <span className="block truncate font-mono font-semibold">{n.name}</span>
            <span className="block text-[11px] text-muted-foreground">{count(n.pins)}</span>
          </>
        ),
      },
    })
  }
  const edges: Edge[] = l.links.map((k) => {
    const on = path?.links.has(k.id) ?? false
    return { id: k.id, source: k.source, target: k.target, selectable: false, focusable: false, zIndex: on ? 1 : 0, style: litEdgeStyle(on, !!path && !on, { bad: k.bad, dashed: k.dashed }) }
  })
  return { nodes, edges }
}

/** What a selection is: a peripheral, a pin or a net. */
export type PinMapNode = { kind: 'peripheral'; id: string } | { kind: 'pin'; id: string; pin: PinView } | { kind: 'net'; id: string }

export interface PinMapProps {
  pins: PinView[]
  /** the selected box's key (`per:USART2`, `pin:.PA2`, `net:UART_TX`); unset, the map keeps its own selection */
  selected?: string | null
  onSelect?: (n: PinMapNode | null) => void
}

/** The pin map's height for a frame: every row, within reason. */
export const pinMapHeight = (pins: number, max = 560) => Math.min(max, 90 + Math.max(pins, 3) * ROW)

/** The pin map in its Canvas frame, the frame's zoom and fit driving React Flow's viewport. */
export function PinMapCanvas({ pins, selected, onSelect, ...frame }: PinMapProps & Omit<CanvasFrameProps, 'children' | 'viewport'>) {
  return (
    <FlowCanvas {...frame} fit={FIT}>
      <PinMap pins={pins} selected={selected} onSelect={onSelect} />
    </FlowCanvas>
  )
}

/** The drawing itself; needs a ReactFlowProvider above it (PinMapCanvas gives one). */
export function PinMap({ pins, selected: controlled, onSelect }: PinMapProps) {
  const byKey = useMemo(() => new Map(pins.map((p) => [`pin:${pinId(p)}`, p])), [pins])
  const toNode = useCallback((key: string): PinMapNode | null => {
    const at = key.indexOf(':')
    const kind = key.slice(0, at)
    const id = key.slice(at + 1)
    if (kind === 'per') return { kind: 'peripheral', id }
    if (kind === 'net') return { kind: 'net', id }
    const pin = byKey.get(key)
    return pin ? { kind: 'pin', id, pin } : null
  }, [byKey])
  const [selected, choose] = useFlowSelection(controlled, onSelect, toNode)
  const layout = useMemo(() => layoutPins(pins), [pins])
  const showPart = useMemo(() => new Set(pins.map((p) => p.part ?? '')).size > 1, [pins])
  const { nodes, edges } = useMemo(() => pinElements(layout, selected, showPart), [layout, selected, showPart])
  return (
    <FlowView
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} selected={selected} onChoose={choose} fit={FIT}
      refitKey={nodes.map((n) => n.id).join('|')}
      label="Pin map: peripherals, pins and nets. Select a box to light its whole path."
    />
  )
}
