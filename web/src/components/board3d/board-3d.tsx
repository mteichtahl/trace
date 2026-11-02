/**
 * The board in 3D, lifelike and explorable: built in the browser straight from the .kicad_pcb (src/lib/kicad-board.ts),
 * so it follows every push the moment the file does, with no export to wait for. Drag to turn it, pinch or scroll to
 * zoom, Turn over to see underneath, tap a part to see what it is. Findings sit on the board as numbered pins and the
 * camera flies to the one picked in the list. The solder mask colour and pad plating start from the board's own
 * stackup and can be tried in others here (the view only; the order is unchanged). Lift parts off and Power on are
 * for looking closely, and for fun.
 *
 * Parts are drawn from their footprint names (./parts.ts); one that matches no family is a grey block the size of its
 * courtyard, and the view says which.
 */
import { ArrowDownUp, Box, Eye, Rotate3d, ScanLine, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { FileFinding } from '@/components/files/data'
import { type Board, type Finish, finishOf, maskHex, MASK_COLOURS, readBoard } from '@/lib/kicad-board'
import { isDark } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { BoardScene, PartInfo, View } from './scene'

const MASKS: { id: string; label: string; hex: string }[] = [
  { id: 'green', label: 'Green', hex: MASK_COLOURS.green! }, { id: 'black', label: 'Black', hex: MASK_COLOURS.black! },
  { id: 'blue', label: 'Blue', hex: MASK_COLOURS.blue! }, { id: 'red', label: 'Red', hex: MASK_COLOURS.red! },
  { id: 'purple', label: 'Purple', hex: MASK_COLOURS.purple! }, { id: 'yellow', label: 'Yellow', hex: MASK_COLOURS.yellow! },
  { id: 'white', label: 'White', hex: MASK_COLOURS.white! },
]
const FINISHES: { id: Finish; label: string }[] = [
  { id: 'enig', label: 'Gold (ENIG)' }, { id: 'hasl', label: 'Tin (lead-free HASL)' }, { id: 'osp', label: 'Bare copper (OSP)' },
]
const SEV: Record<FileFinding['severity'], string> = {
  blocks: 'bg-destructive text-white', fix: 'bg-warning text-black', waived: 'bg-waived text-white',
}
const silkFor = (mask: string) => (mask === MASK_COLOURS.white || mask === MASK_COLOURS.yellow ? '#141414' : '#f2f2ec')

export interface Board3DProps {
  /** the .kicad_pcb's text */
  text: string
  findings: FileFinding[]
  /** the finding picked in the list beside it */
  selected?: string | null
  onSelectFinding?: (id: string) => void
  className?: string
}

export function Board3D({ text, findings, selected = null, onSelectFinding, className }: Board3DProps) {
  const parsed = useMemo((): { board: Board } | { error: string } => {
    try { return { board: readBoard(text) } } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
  }, [text])
  if ('error' in parsed) return <Unavailable className={className}>trace could not read this board file: {parsed.error} The flat drawing may still show it.</Unavailable>
  return <Scene board={parsed.board} findings={findings} selected={selected} onSelectFinding={onSelectFinding} className={className} />
}

function Unavailable({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex items-center justify-center p-6 text-center text-sm text-muted-foreground', className)}>{children}</div>
}

function Scene({ board, findings, selected, onSelectFinding, className }: { board: Board; findings: FileFinding[]; selected: string | null; onSelectFinding?: (id: string) => void; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<BoardScene | null>(null)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ownMask = maskHex(board.maskColor)
  const ownFinish = finishOf(board.copperFinish)
  const [mask, setMask] = useState(ownMask ?? MASK_COLOURS.green!)
  const [finish, setFinish] = useState<Finish>(ownFinish ?? 'hasl')
  const [under, setUnder] = useState(false)
  const [showParts, setShowParts] = useState(true)
  const [pins, setPins] = useState(true)
  const [power, setPower] = useState(false)
  const [lift, setLift] = useState(0)
  const [part, setPart] = useState<PartInfo | null>(null)
  const [pos, setPos] = useState<Record<string, { x: number; y: number } | null>>({})
  const findingsRef = useRef(findings)
  findingsRef.current = findings

  // build the scene (three.js is loaded on first use); rebuilt when the board changes
  useEffect(() => {
    const el = host.current
    if (!el) return
    let live = true
    let made: BoardScene | null = null
    let last = ''
    setReady(false)
    setErr(null)
    ;(async () => {
      try {
        if (!webgl()) throw new Error('This browser cannot draw 3D here (WebGL is off or unavailable). The flat drawing still works.')
        await document.fonts?.load('600 16px "Geist Mono Variable"').catch(() => undefined)
        const { buildScene } = await import('./scene')
        if (!live) return
        made = buildScene(el, board, {
          dark: isDark(), mask, silk: silkFor(mask), finish,
          onPick: (p) => setPart(p),
          onFrame: () => {
            const s = sceneRef.current
            if (!s) return
            const next: Record<string, { x: number; y: number } | null> = {}
            for (const f of findingsRef.current) next[f.id] = s.project(f.x_mm, f.y_mm)
            const key = JSON.stringify(next)
            if (key !== last) { last = key; setPos(next) }
          },
        })
        sceneRef.current = made
        setReady(true)
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      live = false
      made?.dispose()
      sceneRef.current = null
    }
    // the look and toggles are applied to the live scene below, not by rebuilding it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board])

  useEffect(() => { if (ready) sceneRef.current?.setLook({ mask, silk: silkFor(mask), finish }) }, [ready, mask, finish])
  useEffect(() => { if (ready) sceneRef.current?.showParts(showParts) }, [ready, showParts])
  useEffect(() => { if (ready) sceneRef.current?.lift(lift / 100) }, [ready, lift])
  useEffect(() => { if (ready) sceneRef.current?.power(power) }, [ready, power])
  useEffect(() => { if (ready) sceneRef.current?.turnOver(under) }, [ready, under])
  // the dark theme deepens the shadow under the board
  useEffect(() => {
    if (!ready) return
    const mo = new MutationObserver(() => sceneRef.current?.setDark(isDark()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [ready])
  // a finding picked in the list: turn the right way up, fly to it, select the part it names
  useEffect(() => {
    const s = sceneRef.current
    const f = findings.find((x) => x.id === selected)
    if (!ready || !s || !f) return
    const p = f.ref ? s.parts.find((x) => x.ref === f.ref) : undefined
    if (p) setUnder(p.side === 'B')
    s.flyTo(f.x_mm, f.y_mm)
    s.select(f.ref ?? null)
    setPart(p ?? null)
  }, [ready, selected, findings])

  const blocks = useMemo(() => (ready ? sceneRef.current?.parts.filter((p) => p.shape === 'block').map((p) => p.ref) ?? [] : []), [ready])
  const go = (v: View) => sceneRef.current?.view(v)
  const leds = board.footprints.some((f) => /^LED_/i.test(f.name))

  return (
    <div className={cn('grid lg:grid-cols-[minmax(0,1fr)_260px]', className)}>
      <div className="relative h-[clamp(360px,62vh,700px)] overflow-hidden bg-radial-[at_50%_30%] from-muted to-background">
        <div ref={host} className="absolute inset-0" />
        {!ready && !err && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" role="status">Building the board in 3D…</div>}
        {err && <Unavailable className="absolute inset-0">{err}</Unavailable>}
        {ready && pins && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            {findings.map((f, i) => {
              const p = pos[f.id]
              if (!p) return null
              return (
                <button key={f.id} type="button" tabIndex={-1} title={f.text} onClick={() => onSelectFinding?.(f.id)}
                  className={cn('pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[11px] font-semibold shadow ring-2 ring-background -rotate-45', SEV[f.severity], f.severity === 'waived' && 'opacity-70', selected === f.id && 'size-7 ring-primary')}
                  style={{ left: p.x, top: p.y }}>
                  <span className="rotate-45">{i + 1}</span>
                </button>
              )
            })}
          </div>
        )}
        {ready && (
          <>
            <div className="absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1.5" role="group" aria-label="Camera">
              <ViewChip onClick={() => go('angled')}><Rotate3d className="size-3.5" />Angled</ViewChip>
              <ViewChip onClick={() => go('top')}><ScanLine className="size-3.5" />From above</ViewChip>
              <ViewChip onClick={() => go('edge')}><Eye className="size-3.5" />Edge on</ViewChip>
              <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setUnder((u) => !u)} aria-pressed={under}>
                <ArrowDownUp className="size-3.5" />{under ? 'Turn back' : 'Turn over'}
              </Button>
            </div>
            <span className="absolute top-3 right-3 rounded-md border bg-background/85 px-2 py-1 font-mono text-[11px] font-semibold tracking-wider uppercase backdrop-blur">{under ? 'Underside' : 'Top side'}</span>
            <span className="absolute bottom-2.5 left-3 rounded-md bg-background/80 px-2 py-0.5 text-[11.5px] text-muted-foreground">Drag to turn · scroll or pinch to zoom · right-drag to move · tap a part</span>
          </>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-5 border-t p-3.5 text-sm lg:border-t-0 lg:border-l">
        <section>
          <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Selected part</h4>
          {part ? (
            <div className="rounded-lg border p-3">
              <div className="font-mono text-[15px] font-semibold">{part.ref}</div>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
                <dt className="text-muted-foreground">Value</dt><dd className="min-w-0 font-mono break-words">{part.value || '—'}</dd>
                <dt className="text-muted-foreground">Footprint</dt><dd className="min-w-0 font-mono break-words">{part.footprint}</dd>
                <dt className="text-muted-foreground">Side</dt><dd>{part.side === 'F' ? 'Top' : 'Bottom'}</dd>
                <dt className="text-muted-foreground">Position</dt><dd className="font-mono tabular-nums">{part.x}, {part.y} mm</dd>
                <dt className="text-muted-foreground">Pads</dt><dd className="tabular-nums">{part.pads}</dd>
              </dl>
              {part.shape === 'block' && <p className="mt-2 text-xs text-muted-foreground">Shown as a grey block: there is no shape for this footprint here yet.</p>}
            </div>
          ) : (
            <p className="rounded-lg border px-3 py-2.5 text-[13px] text-muted-foreground">Tap a part on the board to see what it is.</p>
          )}
        </section>

        <section>
          <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Board finish</h4>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Solder mask colour">
            {(ownMask && !MASKS.some((m) => m.hex === ownMask) ? [{ id: 'own', label: 'The board\'s own', hex: ownMask }, ...MASKS] : MASKS).map((m) => (
              <button key={m.id} type="button" title={m.label} aria-label={`${m.label} solder mask`} aria-pressed={mask === m.hex} onClick={() => setMask(m.hex)}
                className={cn('size-6 rounded-full border-2 border-background ring-1 ring-border transition-shadow', mask === m.hex && 'ring-2 ring-foreground')} style={{ background: m.hex }} />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Label htmlFor="board3d-finish" className="text-[13px] font-normal">Pad plating</Label>
            <select id="board3d-finish" value={finish} onChange={(e) => setFinish(e.target.value as Finish)} className="h-7 rounded-md border bg-background px-1.5 text-xs">
              {FINISHES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {ownMask || ownFinish ? 'Starts from the board\'s own stackup. ' : 'The board\'s stackup names no colour or plating, so this starts at green with tin. '}
            Trying others changes this view only, not the order.
          </p>
        </section>

        <section className="space-y-1.5">
          <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Show</h4>
          <Toggle id="board3d-parts" label="Parts" icon={<Box className="size-3.5" />} checked={showParts} onChange={setShowParts} />
          <Toggle id="board3d-pins" label="Findings on the board" checked={pins} onChange={setPins} />
          {leds && <Toggle id="board3d-power" label="Power on" icon={<Zap className="size-3.5" />} checked={power} onChange={setPower} />}
          <div className="pt-2">
            <Label htmlFor="board3d-lift" className="text-[13px] font-normal">Lift parts off</Label>
            <Slider id="board3d-lift" className="mt-2.5" value={[lift]} min={0} max={100} onValueChange={([v]) => setLift(v ?? 0)} aria-label="Lift parts off the board" disabled={!showParts} />
          </div>
        </section>

        {(blocks.length > 0 || board.notes.length > 0) && (
          <section className="space-y-1 text-xs text-muted-foreground">
            {board.notes.map((n) => <p key={n}>{n}</p>)}
            {blocks.length > 0 && <p>{blocks.length} part{blocks.length === 1 ? '' : 's'} show{blocks.length === 1 ? 's' : ''} as {blocks.length === 1 ? 'a grey block' : 'grey blocks'}, with no shape for {blocks.length === 1 ? 'its' : 'their'} footprint here yet: <span className="font-mono">{blocks.slice(0, 8).join(', ')}{blocks.length > 8 ? '…' : ''}</span>.</p>}
          </section>
        )}
      </aside>
    </div>
  )
}

function ViewChip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <Button size="sm" variant="outline" className="h-7 gap-1.5 bg-background/85 text-xs backdrop-blur" onClick={onClick}>{children}</Button>
}

function Toggle({ id, label, icon, checked, onChange }: { id: string; label: string; icon?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="flex items-center gap-1.5 text-[13px] font-normal">{icon}{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function webgl(): boolean {
  try {
    const c = document.createElement('canvas')
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return false
  }
}
