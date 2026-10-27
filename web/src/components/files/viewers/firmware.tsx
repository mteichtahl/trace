/**
 * Firmware images (.elf, .hex, .bin, .map): size against flash and RAM from trace's `firmware.size` tool (run through
 * the `tool` action on the project's worker) when it answers; otherwise what the file itself says (an ELF's section
 * sizes read here, a HEX file's programmed bytes, a binary's length) with an honest line that the limits come from
 * the tool. A .map file also shows as text.
 */
import { useQuery } from '@tanstack/react-query'
import { Progress } from '@/components/ui/progress'
import { call } from '@/lib/api'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useFileBytes } from '../data'
import { readElf, hexBytes } from '../elf'
import { extOf } from '../kinds'
import { CodeText } from './code'
import { AREA, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

export interface FirmwareSize {
  flash_bytes: number
  ram_bytes: number
  flash_total?: number
  ram_total?: number
  flash_pct?: number
  ram_pct?: number
  text?: number
  data?: number
  bss?: number
}

/** The tool's answer, wherever the run record put it. */
export function sizeFrom(r: unknown): FirmwareSize | null {
  const o = (r ?? {}) as Record<string, unknown>
  for (const c of [o, o.result, (o.result as Record<string, unknown> | undefined)?.result]) {
    const x = c as Partial<FirmwareSize> | undefined
    if (x && typeof x.flash_bytes === 'number' && typeof x.ram_bytes === 'number') return x as FirmwareSize
  }
  return null
}

function Meter({ label, used, total, pct }: { label: string; used: number; total?: number; pct?: number }) {
  const p = pct ?? (total ? (used / total) * 100 : undefined)
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {eng(used, 'B')}
          {total ? ` of ${eng(total, 'B')} · ${p!.toFixed(1)}%` : ''}
        </span>
      </div>
      {p !== undefined && <Progress value={p} aria-label={`${label} used`} className={cn(p > 90 && '[&>div]:bg-destructive', p > 75 && p <= 90 && '[&>div]:bg-warning')} />}
    </div>
  )
}

export default function FirmwareViewer({ file, size, commit }: ViewerProps) {
  const ext = extOf(file.path)
  const bytes = useFileBytes(file, { commit })
  const tool = useQuery({
    queryKey: ['tool', file.repo, 'firmware.size', file.path, commit ?? ''],
    queryFn: () => call('tool', { repo: file.repo, name: 'firmware.size', args: { artifact: file.path } }),
    enabled: !commit && !file.run && ext !== 'map',
    retry: false,
    staleTime: 5 * 60_000,
  })
  if (bytes.isError) return <ViewerError error={bytes.error} onRetry={() => void bytes.refetch()} />
  if (!bytes.data) return <ViewerLoading size={size} />
  const buf = bytes.data
  const text = ext === 'map' || ext === 'hex' || ext === 'ihex' ? new TextDecoder().decode(buf) : null
  const measured = sizeFrom(tool.data)
  const elf = ext === 'elf' || ext === 'axf' ? readElf(buf) : null
  const local = elf ? { flash: elf.flash, ram: elf.ram } : ext === 'hex' && text ? { flash: hexBytes(text), ram: null } : ext === 'bin' ? { flash: buf.byteLength, ram: null } : null

  const meters = measured ? (
    <div className="space-y-3">
      <Meter label="Flash" used={measured.flash_bytes} total={measured.flash_total} pct={measured.flash_pct} />
      <Meter label="RAM" used={measured.ram_bytes} total={measured.ram_total} pct={measured.ram_pct} />
    </div>
  ) : local ? (
    <div className="space-y-3">
      <Meter label="Flash (from the file)" used={local.flash} />
      {local.ram !== null && <Meter label="RAM (from the file)" used={local.ram} />}
    </div>
  ) : null

  const honest = !measured && (
    <Note className="px-0">
      {tool.isLoading ? 'Asking trace’s firmware size check for the flash and RAM limits…' : 'The share of flash and RAM needs trace’s firmware size check (firmware.size), which did not answer for this file; the sizes here are read from the file itself.'}
    </Note>
  )

  if (size === 'card')
    return (
      <div className="space-y-2 p-3">
        {meters ?? <p className="text-sm">{eng(buf.byteLength, 'B')} file</p>}
        {honest}
      </div>
    )

  return (
    <div className={cn('flex flex-col overflow-auto', AREA[size])}>
      <div className="max-w-2xl space-y-4 p-4">
        {meters ?? <p className="text-sm">{eng(buf.byteLength, 'B')} file. This format carries no section sizes.</p>}
        {honest}
        {elf && (
          <div>
            <p className="section-label mb-2">Largest sections</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1 font-medium">Section</th>
                  <th className="py-1 font-medium">Goes to</th>
                  <th className="py-1 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {elf.sections.slice(0, 12).map((s) => (
                  <tr key={s.name + s.addr} className="border-b last:border-0">
                    <td className="py-1 font-mono">{s.name}</td>
                    <td className="py-1 text-muted-foreground">{s.nobits ? 'RAM (zeroed)' : s.write ? 'Flash and RAM' : 'Flash'}</td>
                    <td className="py-1 text-right tabular-nums">{eng(s.size, 'B')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Note className="px-0">The largest symbols and the change since the last build come from the build's map and trace's size history; they are not shown here yet.</Note>
      </div>
      {text && ext === 'map' && <CodeText text={text} lang={null} size={size} className="min-h-[300px] flex-1 border-t" />}
    </div>
  )
}
