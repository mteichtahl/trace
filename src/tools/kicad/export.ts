/**
 * Fabrication and documentation outputs, written by kicad-cli into an output directory the caller names: Gerbers and
 * drill files (optionally zipped together for a fab house), placement files, PDF/SVG plots of the schematic and the
 * board, a STEP model, and a 3D render (only when asked: it is slow). Every output goes through KiCad, so the files
 * are what KiCad would plot; this module only chooses sensible flags and reports the files written.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { runCli } from './project.js'

export const EXPORT_KINDS = ['gerbers', 'drill', 'pos', 'sch_pdf', 'sch_svg', 'pcb_pdf', 'pcb_svg', 'step', 'render'] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export interface OutFile { path: string; bytes: number }

/** Every file under dir (relative paths, sorted) with its size. */
export function listFiles(dir: string): OutFile[] {
  const out: OutFile[] = []
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) visit(p)
      else if (e.isFile()) out.push({ path: relative(dir, p), bytes: statSync(p).size })
    }
  }
  visit(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const DEFAULT_PCB_LAYERS = 'F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts'

export interface ExportOptions {
  /** board layers for pcb_pdf / pcb_svg (KiCad names, comma separated) */
  layers?: string
  /** 3D render side */
  side?: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back'
  timeoutMs?: number
}

/** Run one export into `outDir`; returns kicad-cli's command for the record. */
export async function exportOne(kind: ExportKind, files: { sch: string | null; pcb: string | null; name: string }, outDir: string,
  opts: ExportOptions = {}): Promise<string[]> {
  const need = (p: string | null, what: string): string => {
    if (!p) throw new ToolError(`${kind} needs the project's ${what}, which it does not have`)
    return p
  }
  const t = { timeoutMs: opts.timeoutMs ?? 900_000 }
  let args: string[]
  switch (kind) {
    case 'gerbers':
      mkdirSync(join(outDir, 'gerbers'), { recursive: true })
      args = ['pcb', 'export', 'gerbers', '--board-plot-params', '-o', join(outDir, 'gerbers') + '/', need(files.pcb, 'board')]
      break
    case 'drill':
      mkdirSync(join(outDir, 'gerbers'), { recursive: true })
      args = ['pcb', 'export', 'drill', '--format', 'excellon', '--excellon-units', 'mm', '--generate-map', '--map-format', 'gerberx2',
        '-o', join(outDir, 'gerbers') + '/', need(files.pcb, 'board')]
      break
    case 'pos':
      args = ['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both', '--exclude-dnp',
        '-o', join(outDir, `${files.name}-pos.csv`), need(files.pcb, 'board')]
      break
    case 'sch_pdf':
      args = ['sch', 'export', 'pdf', '-o', join(outDir, `${files.name}-schematic.pdf`), need(files.sch, 'schematic')]
      break
    case 'sch_svg':
      mkdirSync(join(outDir, 'schematic-svg'), { recursive: true })
      args = ['sch', 'export', 'svg', '-o', join(outDir, 'schematic-svg'), need(files.sch, 'schematic')]
      break
    case 'pcb_pdf':
      args = ['pcb', 'export', 'pdf', '--mode-single', '--layers', opts.layers ?? DEFAULT_PCB_LAYERS,
        '-o', join(outDir, `${files.name}-board.pdf`), need(files.pcb, 'board')]
      break
    case 'pcb_svg':
      args = ['pcb', 'export', 'svg', '--mode-single', '--fit-page-to-board', '--exclude-drawing-sheet', '--layers', opts.layers ?? DEFAULT_PCB_LAYERS,
        '-o', join(outDir, `${files.name}-board.svg`), need(files.pcb, 'board')]
      break
    case 'step':
      args = ['pcb', 'export', 'step', '--force', '--subst-models', '-o', join(outDir, `${files.name}.step`), need(files.pcb, 'board')]
      break
    case 'render':
      args = ['pcb', 'render', '--side', opts.side ?? 'top', '--quality', 'basic', '-w', '1600', '-h', '900',
        '-o', join(outDir, `${files.name}-${opts.side ?? 'top'}.png`), need(files.pcb, 'board')]
      break
  }
  await runCli(args, t)
  return args
}

/** Zip a folder, files stored uncompressed (no compression library needed: a fab house only needs them together). */
export function zipDir(dir: string, zipPath: string): void {
  const files = listFiles(dir)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const data = readFileSync(join(dir, f.path))
    const name = Buffer.from(f.path.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0, 10) // time/date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(0, 10)
    c.writeUInt32LE(0, 12)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += local.length + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(zipPath, Buffer.concat([...chunks, cd, end]))
}

let CRC_TABLE: Uint32Array | null = null

export function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function outDirFor(path: string | undefined, fallbackRoot: string, name: string): string {
  const d = resolve(path ?? join(fallbackRoot, 'build', 'kicad', name))
  mkdirSync(d, { recursive: true })
  return d
}

export const fileName = basename
