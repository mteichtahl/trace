/**
 * A project's icon (docs/ui-design.md, "Creating a project"): one of eight electronics glyphs on one of eight
 * theme-safe colours, or an uploaded square image. trace recommends a glyph from the name and description, and a
 * colour that differs from the person's other projects.
 */
import { BatteryMedium, CircuitBoard, Cpu, Fan, Microchip, Plug, RadioTower, Sprout, Upload } from 'lucide-react'
import type { ComponentType } from 'react'
import { useRef } from 'react'
import { Label } from '@/components/ui/label'
import type { IconColour, IconGlyph, ProjectIcon } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const GLYPHS: { id: IconGlyph; label: string; icon: ComponentType<{ className?: string }>; words: RegExp }[] = [
  { id: 'chip', label: 'Chip', icon: Cpu, words: /\b(mcu|micro|controller|cpu|chip)/i },
  { id: 'antenna', label: 'Antenna', icon: RadioTower, words: /\b(radio|lora|wifi|ble|bluetooth|antenna|rf|wireless|gateway)/i },
  { id: 'battery', label: 'Battery', icon: BatteryMedium, words: /\b(battery|charger|power bank|cell|bms)/i },
  { id: 'motor', label: 'Motor', icon: Fan, words: /\b(motor|driver|fan|servo|stepper)/i },
  { id: 'sensor', label: 'Sensor', icon: Sprout, words: /\b(sensor|moisture|soil|temperature|humidity|probe|measure)/i },
  { id: 'board', label: 'Board', icon: CircuitBoard, words: /\b(board|panel|carrier|breakout|pcb)/i },
  { id: 'fpga', label: 'FPGA', icon: Microchip, words: /\b(fpga|cpld|logic|lattice|xilinx)/i },
  { id: 'plug', label: 'Plug', icon: Plug, words: /\b(plug|supply|psu|adapter|usb|connector)/i },
]

/** Background and foreground classes per colour; each works in light and dark. */
export const COLOURS: Record<IconColour, { label: string; bg: string; fg: string; swatch: string }> = {
  blue: { label: 'Blue', bg: 'bg-sky-100 dark:bg-sky-950', fg: 'text-sky-700 dark:text-sky-300', swatch: 'bg-sky-200 dark:bg-sky-800' },
  green: { label: 'Green', bg: 'bg-emerald-100 dark:bg-emerald-950', fg: 'text-emerald-700 dark:text-emerald-300', swatch: 'bg-emerald-200 dark:bg-emerald-800' },
  amber: { label: 'Amber', bg: 'bg-amber-100 dark:bg-amber-950', fg: 'text-amber-700 dark:text-amber-300', swatch: 'bg-amber-200 dark:bg-amber-800' },
  violet: { label: 'Violet', bg: 'bg-violet-100 dark:bg-violet-950', fg: 'text-violet-700 dark:text-violet-300', swatch: 'bg-violet-200 dark:bg-violet-800' },
  pink: { label: 'Pink', bg: 'bg-pink-100 dark:bg-pink-950', fg: 'text-pink-700 dark:text-pink-300', swatch: 'bg-pink-200 dark:bg-pink-800' },
  teal: { label: 'Teal', bg: 'bg-teal-100 dark:bg-teal-950', fg: 'text-teal-700 dark:text-teal-300', swatch: 'bg-teal-200 dark:bg-teal-800' },
  indigo: { label: 'Indigo', bg: 'bg-indigo-100 dark:bg-indigo-950', fg: 'text-indigo-700 dark:text-indigo-300', swatch: 'bg-indigo-200 dark:bg-indigo-800' },
  grey: { label: 'Grey', bg: 'bg-neutral-100 dark:bg-neutral-800', fg: 'text-neutral-700 dark:text-neutral-300', swatch: 'bg-neutral-200 dark:bg-neutral-700' },
}

/** The glyph trace recommends for a name and description (Sensor for "soil moisture sensor"). */
export function recommendGlyph(text: string): IconGlyph {
  // the word that comes first wins: "soil moisture sensor … over LoRa" is a sensor
  let best: { id: IconGlyph; at: number } | null = null
  for (const g of GLYPHS) {
    const m = g.words.exec(text)
    if (m && (!best || m.index < best.at)) best = { id: g.id, at: m.index }
  }
  return best?.id ?? 'board'
}

/** A colour the person's other projects do not use yet. */
export function recommendColour(used: IconColour[]): IconColour {
  return (Object.keys(COLOURS) as IconColour[]).find((c) => !used.includes(c)) ?? 'blue'
}

export function ProjectIconView({ icon, size = 40, className }: { icon: ProjectIcon; size?: number; className?: string }) {
  const c = COLOURS[icon.colour]
  const G = GLYPHS.find((g) => g.id === icon.glyph)?.icon ?? CircuitBoard
  return (
    <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg', c.bg, c.fg, className)} style={{ width: size, height: size }} aria-hidden>
      {icon.image ? <img src={icon.image} alt="" className="size-full object-cover" /> : <G className="size-[55%]" />}
    </span>
  )
}

export function IconPicker({ value, onChange, recommended, why, disabled }: { value: ProjectIcon; onChange: (v: ProjectIcon) => void; recommended?: IconGlyph; why?: string; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null)
  const upload = (f: File | undefined) => {
    if (!f) return
    const r = new FileReader()
    r.onload = () => onChange({ ...value, image: String(r.result) })
    r.readAsDataURL(f)
  }
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Icon</legend>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8" role="radiogroup" aria-label="Icon">
          {GLYPHS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="radio"
              aria-checked={!value.image && value.glyph === g.id}
              aria-label={g.label}
              disabled={disabled}
              onClick={() => onChange({ ...value, glyph: g.id, image: undefined })}
              className={cn('flex h-12 items-center justify-center rounded-lg border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', !value.image && value.glyph === g.id && 'border-2 border-primary text-primary')}
            >
              <g.icon className="size-5" />
            </button>
          ))}
        </div>
        {(recommended || !disabled) && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {recommended && <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs text-primary">trace recommends</span>}
            {recommended && <span>{GLYPHS.find((g) => g.id === recommended)?.label}{why ? `, ${why}` : ''}.</span>}
            {!disabled && (
              <button type="button" className="text-primary hover:underline" onClick={() => file.current?.click()}>
                <Upload className="mr-1 inline size-3.5" aria-hidden />{value.image ? 'Replace the image' : 'Upload an image instead'}
              </button>
            )}
            {value.image && !disabled && <button type="button" className="hover:underline" onClick={() => onChange({ ...value, image: undefined })}>Use the glyph</button>}
          </p>
        )}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Colour</legend>
        <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Colour">
          {(Object.keys(COLOURS) as IconColour[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={value.colour === c}
              aria-label={COLOURS[c].label}
              disabled={disabled}
              onClick={() => onChange({ ...value, colour: c })}
              className={cn('size-8 rounded-full border-2 border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', COLOURS[c].swatch, value.colour === c && 'border-foreground')}
            />
          ))}
        </div>
      </fieldset>
      <Label className="sr-only">Icon preview</Label>
    </div>
  )
}
