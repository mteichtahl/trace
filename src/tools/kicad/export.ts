/**
 * Fabrication and documentation outputs, written by kicad-cli into an output directory the caller names: Gerbers and
 * drill files (optionally zipped together for a fab house), placement files, PDF/SVG plots of the schematic and the
 * board, a STEP model, and a 3D render (only when asked: it is slow). Every output goes through KiCad, so the files
 * are what KiCad would plot; this module only chooses sensible flags and reports the files written.
 *
 * The drawings people look at (each schematic sheet's SVG, the board's SVG and render) are also kept in the run record
 * (`drawingArtifacts`), not only in the output folder, which is a working copy that is not committed: one artifact per
 * sheet named sheets/<sheet file>.svg, board/<name>.svg and board/<name>.png, and drawings.json saying which
 * schematic file each SVG draws, at which sheet path, and its page size in millimetres (from the SVG's own width and
 * height), so findings in millimetres can be placed on it. Anything over the artifact limit is left out and listed.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
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

// ------------------------------------------------------------------ drawings kept in the run record

/** The most an artifact may hold for files.url to hand it back (src/api/action-kit.ts MAX_ARTIFACT). */
export const DRAWING_LIMIT = 8 * 1024 * 1024

export interface SheetPlace { file: string; path: string; name: string }
export interface Drawing {
  /** the artifact's name in the run: sheets/hw/power.kicad_sch.svg, board/demo.svg, board/demo-top.png */
  artifact: string
  kind: 'sheet' | 'board' | 'render'
  /** sheet: the schematic file it draws (relative to the repository) and its sheet path ('/', '/Power/') */
  file?: string | undefined
  sheet?: string | undefined
  /** the page (or fitted board) size in millimetres, from the SVG's width and height */
  width_mm?: number | undefined
  height_mm?: number | undefined
  /** board: where the fitted SVG's top left corner is in board millimetres (the outline's corner) */
  origin_mm?: { x_mm: number; y_mm: number } | undefined
  bytes: number
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** An SVG's width and height in millimetres (kicad-cli writes them as "297.0022mm"), or null. */
export function svgSizeMm(svg: string): { width_mm: number; height_mm: number } | null {
  const head = svg.slice(0, 2000)
  const w = /\bwidth="([\d.]+)mm"/.exec(head)
  const h = /\bheight="([\d.]+)mm"/.exec(head)
  // without millimetre units the size is not guessed at: findings are then listed, not placed
  return w && h ? { width_mm: Number(w[1]), height_mm: Number(h[1]) } : null
}

/**
 * Which sheet each SVG kicad-cli wrote draws. kicad-cli names the root sheet's SVG after the project and each
 * sub-sheet's after the project and its sheet path (demo.svg, demo-Power.svg, demo-Power-Filter.svg); the match
 * ignores case and separators, and falls back to the last sheet name alone. `sheets` are every sheet instance (the
 * root first), each with its file relative to the repository.
 */
export function sheetOfSvg(svgName: string, project: string, sheets: readonly SheetPlace[]): SheetPlace | null {
  const stem = norm(svgName.replace(/\.svg$/i, ''))
  const root = sheets[0]
  if (stem === norm(project) && root) return root
  for (const s of sheets.slice(1)) {
    const parts = s.path.split('/').filter(Boolean)
    if (stem === norm(`${project}-${parts.join('-')}`) || stem === norm(`${project}-${parts[parts.length - 1] ?? ''}`)) return s
  }
  for (const s of sheets.slice(1)) if (stem.endsWith(norm(s.name)) && norm(s.name)) return s
  return null
}

/**
 * The drawings in an export folder, as artifacts to keep: each sheet SVG (named by the schematic file it draws), the
 * board SVG and the render PNG. Returns what to store and what was left out (too large, or not matched to a sheet).
 */
export function drawingArtifacts(outDir: string, o: { project: string; sheets: readonly SheetPlace[] }): { keep: { drawing: Drawing; bytes: Uint8Array; mime: string }[]; left: string[] } {
  const keep: { drawing: Drawing; bytes: Uint8Array; mime: string }[] = []
  const left: string[] = []
  const svgDir = join(outDir, 'schematic-svg')
  const used = new Set<string>()
  try {
    for (const f of readdirSync(svgDir).filter((x) => x.toLowerCase().endsWith('.svg')).sort()) {
      const bytes = readFileSync(join(svgDir, f))
      const place = sheetOfSvg(f, o.project, o.sheets)
      if (bytes.length > DRAWING_LIMIT) { left.push(`${f} (${Math.round(bytes.length / 1e6)} MB, over the 8 MB a drawing may be)`); continue }
      // one drawing per file: a sheet placed twice (two channels) is drawn once
      const name = place ? `sheets/${place.file}.svg` : `sheets/${f}`
      if (used.has(name)) continue
      used.add(name)
      if (!place) left.push(`${f} (not matched to a sheet: kept under its own name)`)
      keep.push({ drawing: { artifact: name, kind: 'sheet', ...(place ? { file: place.file, sheet: place.path } : {}), ...(svgSizeMm(bytes.toString('utf8')) ?? {}), bytes: bytes.length }, bytes, mime: 'image/svg+xml' })
    }
  } catch { /* no schematic SVGs asked for */ }
  for (const e of readdirSync(outDir)) {
    const full = join(outDir, e)
    const board = e === `${o.project}-board.svg`
    const render = new RegExp(`^${o.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(top|bottom|left|right|front|back)\\.png$`).test(e)
    if (!board && !render) continue
    const bytes = readFileSync(full)
    if (bytes.length > DRAWING_LIMIT) { left.push(`${e} (${Math.round(bytes.length / 1e6)} MB, over the 8 MB a drawing may be)`); continue }
    keep.push({
      drawing: { artifact: `board/${e}`, kind: board ? 'board' : 'render', ...(board ? svgSizeMm(bytes.toString('utf8')) ?? {} : {}), bytes: bytes.length },
      bytes, mime: board ? 'image/svg+xml' : 'image/png',
    })
  }
  return { keep, left }
}

/** Every sheet instance of a schematic (the root first), each with its file relative to `root`. */
export function sheetPlaces(sch: { root: string; sheets: readonly { name: string; file: string; path: string }[] }, root: string): SheetPlace[] {
  const rel = (f: string): string => relative(root, f).split('\\').join('/')
  return [
    { file: rel(sch.root), path: '/', name: basename(sch.root).replace(/\.kicad_sch$/, '') },
    ...sch.sheets.map((s) => ({ file: rel(resolve(dirname(sch.root), s.file)), path: s.path, name: s.name })),
  ]
}
