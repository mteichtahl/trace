/**
 * What a file is, from its name (and, for JSON, a peek at its content): which viewer draws it, the word shown for its
 * kind, the group the Files screen lists it under, and the highlighting language for code. Pure, so it is tested.
 */

export type ViewerKind =
  | 'schematic' | 'board' | 'gerber' | 'gerber-zip' | 'model' | 'step' | 'image' | 'video' | 'svg' | 'pdf' | 'table'
  | 'vcd' | 'plot' | 'wavedrom' | 'code' | 'markdown' | 'firmware' | 'archive' | 'database' | 'unknown'
  | 'spice' | 'touchstone' | 'gzip' | 'report'

export type FileGroup = 'design' | 'fabrication' | 'evidence' | 'firmware' | 'documents'

export const GROUPS: { id: FileGroup; label: string; blurb: string }[] = [
  { id: 'design', label: 'Design', blurb: 'Schematics, boards, parts lists, drawings and models' },
  { id: 'fabrication', label: 'Fabrication', blurb: 'Gerbers, drill files, placement and the fab zip' },
  { id: 'evidence', label: 'Evidence', blurb: 'Run outputs: captures, plots, logs and renders' },
  { id: 'firmware', label: 'Firmware', blurb: 'Sources and built images' },
  { id: 'documents', label: 'Documents', blurb: 'Datasheets, notes, specs and archives' },
]

export const KIND_LABEL: Record<ViewerKind, string> = {
  schematic: 'Schematic', board: 'Board', gerber: 'Gerber', 'gerber-zip': 'Fabrication', model: '3D model', step: '3D model',
  image: 'Image', video: 'Video', svg: 'Drawing', pdf: 'PDF', table: 'Table', vcd: 'Waveform', plot: 'Simulation',
  wavedrom: 'Timing diagram', code: 'Code', markdown: 'Markdown', firmware: 'Firmware image', archive: 'Archive', database: 'Database', unknown: 'File',
  spice: 'Simulation', touchstone: 'S-parameters', gzip: 'Compressed', report: 'Check report',
}

const GERBER = new Set(['gbr', 'ger', 'pho', 'art', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gtp', 'gbp', 'gko', 'gm1', 'gm2', 'gml', 'gm', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'gp1', 'gp2', 'gpt', 'gpb', 'drl', 'xln', 'exc', 'drd', 'txt.drl'])
const CODE = new Set([
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'rs', 'py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'v', 'vh', 'sv', 'svh', 'vhd', 'vhdl',
  'cir', 'sp', 'spi', 'spice', 'net', 'lib', 'mod', 'ses', 'dsn', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'txt', 'out', 'sh', 'bash', 'zsh', 'ld', 'x', 'kicad_pro', 'kicad_sym', 'kicad_mod', 'kicad_dru', 'kicad_prl', 'pos',
  'xdc', 'pcf', 'lpf', 'sdc', 'tcl', 'mk', 'cmake', 'diff', 'patch', 'rpt',
  // text results the tools keep: openEMS and VTK XML, CalculiX decks, EDIF netlists, iCE40 ASCII bitstreams and CAN
  // logs (ASC, TRC, candump), S-expressions, ECP5 configs, coverage
  'xml', 'vtu', 'vtk', 'inp', 'frd', 'edif', 'edn', 'edf', 'asc', 'trc', 'candump', 'sexp', 'sexpr', 'config', 'info', 'dat', 'stat', 'dsl',
])
const NAMED_CODE = new Set(['makefile', 'dockerfile', 'cargo.lock', 'license', 'readme'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v'])
const DATABASE = new Set(['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'])
const FIRMWARE = new Set(['elf', 'hex', 'ihex', 'bin', 'map', 'uf2', 'axf', 'srec', 's19', 'bit', 'fs', 'jed', 'svf'])
/** kicad-cli's JSON check reports and the tools' findings files (a findings list with the file behind it) */
const REPORT_NAMES = /^(erc|drc)(-report)?\.json$|-(erc|drc)\.json$|^(pin-)?findings\.json$/

/** The file name without its folders. */
export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** The extension the viewers care about, lower case, with the compound ones kept whole (tar.gz, sim.json). */
export function extOf(path: string): string {
  const name = baseName(path).toLowerCase()
  for (const two of ['tar.gz', 'sim.json', 'plot.json', 'wavedrom.json', 'wave.json']) if (name.endsWith(`.${two}`)) return two
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1)
}

/** Which viewer draws this file. `head` (the first bytes as text) refines JSON into a timing diagram or a plot. */
export function viewerKind(path: string, head?: string): ViewerKind {
  const ext = extOf(path)
  const name = baseName(path).toLowerCase()
  if (ext === 'kicad_sch' || ext === 'sch') return ext === 'kicad_sch' ? 'schematic' : 'unknown'
  if (ext === 'kicad_pcb') return 'board'
  if (ext === 'zip') return /gerber|jlc|fab|pcbway|oshpark|manufactur/.test(name) ? 'gerber-zip' : 'archive'
  if (ext === 'tar.gz' || ext === 'tgz' || ext === 'tar') return 'archive'
  if (GERBER.has(ext) || /\.(g[tb][lospa]|gm\d*)$/.test(name)) return 'gerber'
  if (ext === 'stl' || ext === 'glb' || ext === 'gltf') return 'model'
  if (ext === 'step' || ext === 'stp') return 'step'
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (ext === 'svg') return 'svg'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'csv' || ext === 'tsv') return 'table'
  if (ext === 'raw') return 'spice'
  if (/^s\d+p$/.test(ext) || ext === 'snp') return 'touchstone'
  if (ext === 'gz') return 'gzip'
  if (ext === 'json' && REPORT_NAMES.test(name)) return 'report'
  if (ext === 'vcd') return 'vcd'
  if (ext === 'sim.json' || ext === 'plot.json') return 'plot'
  if (ext === 'wavedrom.json' || ext === 'wave.json' || ext === 'wavedrom' || ext === 'wavejson') return 'wavedrom'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (DATABASE.has(ext)) return 'database'
  if (FIRMWARE.has(ext)) return 'firmware'
  if (ext === 'json' && head) return refineJson(head)
  if (CODE.has(ext) || NAMED_CODE.has(name)) return 'code'
  return 'unknown'
}

/** A JSON file that is really a WaveDrom diagram or a plot. */
export function refineJson(text: string): ViewerKind {
  const t = text.trimStart()
  if (!t.startsWith('{')) return 'code'
  if (/^\{\s*"?(signal|reg)"?\s*:/.test(t)) return 'wavedrom'
  if (/"series"\s*:\s*\[/.test(t) && /"x"\s*:\s*\{/.test(t) && /"y"\s*:\s*\{/.test(t)) return 'plot'
  return 'code'
}

/** The kind word for the toolbar ("Board", "Waveform"). */
export const kindLabel = (path: string): string => KIND_LABEL[viewerKind(path)]

const GROUP_IDS = new Set<string>(GROUPS.map((g) => g.id))

/** The Files screen's group: the API's kind when it is a group, else worked out from the file. */
export function groupOf(path: string, apiKind?: string): FileGroup {
  const k = (apiKind ?? '').toLowerCase()
  if (GROUP_IDS.has(k)) return k as FileGroup
  const p = path.toLowerCase()
  const v = viewerKind(path)
  if (v === 'gerber' || v === 'gerber-zip' || /(^|\/)(fab|gerbers?|production|jlcpcb)\//.test(p) || /(cpl|placement|pick.?and.?place)/.test(baseName(p))) return 'fabrication'
  if (v === 'firmware' || /(^|\/)(firmware|fw|src\/main|embedded)\//.test(p)) return 'firmware'
  if (v === 'gzip') {
    const inner = path.replace(/\.gz$/i, '')
    return inner === path ? 'documents' : groupOf(inner)
  }
  if (v === 'vcd' || v === 'plot' || v === 'video' || v === 'spice' || v === 'touchstone' || v === 'report' || /(^|\/)(runs?|evidence|captures?|renders?|results?|reports?)\//.test(p) || extOf(p) === 'log') return 'evidence'
  if (v === 'schematic' || v === 'board' || v === 'model' || v === 'step' || v === 'svg' || /(bom|parts)/.test(baseName(p))) return 'design'
  return 'documents'
}

/** The highlighting language for code (a name lib/code-block understands), or null for plain text. */
export function codeLang(path: string): string | null {
  const ext = extOf(path)
  const map: Record<string, string> = {
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', rs: 'rust', py: 'python', ts: 'typescript', tsx: 'tsx',
    js: 'typescript', jsx: 'tsx', mjs: 'typescript', v: 'verilog', vh: 'verilog', sv: 'system-verilog', svh: 'system-verilog',
    json: 'json', jsonc: 'json', kicad_pro: 'json', 'wavedrom.json': 'json', 'sim.json': 'json', 'plot.json': 'json', yaml: 'yaml', yml: 'yaml',
    toml: 'toml', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', kicad_sch: 'lisp', kicad_pcb: 'lisp',
    kicad_sym: 'lisp', kicad_mod: 'lisp', kicad_dru: 'lisp', ses: 'lisp', dsn: 'lisp', diff: 'diff', patch: 'diff', md: 'markdown',
    edif: 'lisp', edn: 'lisp', edf: 'lisp', sexp: 'lisp', sexpr: 'lisp',
  }
  return map[ext] ?? null
}

/** Logs follow new lines; everything else is a fixed file. */
export const isLog = (path: string): boolean => extOf(path) === 'log' || /\.log\.txt$/i.test(path)

/** Which kinds can compare two versions, and how. */
export function compareMode(kind: ViewerKind): 'text' | 'table' | 'image' | 'kicad' | 'database' | null {
  if (kind === 'database') return 'database'
  if (kind === 'code' || kind === 'markdown' || kind === 'wavedrom' || kind === 'vcd' || kind === 'spice' || kind === 'touchstone' || kind === 'report') return 'text'
  if (kind === 'table') return 'table'
  if (kind === 'image' || kind === 'svg') return 'image'
  if (kind === 'schematic' || kind === 'board') return 'kicad'
  return null
}

/** A sentence about a file trace cannot draw, when it knows what the file is (shown with Download). */
export function aboutFile(path: string): string | null {
  switch (extOf(path)) {
    case 'blf': return 'A binary CAN bus log (Vector BLF) from hil.can_capture. trace does not draw it here: download it and open it in a CAN tool (python-can, Vector CANalyzer, BUSMASTER). Capture as candump, ASC or TRC to read it in trace.'
    case 'mf4': case 'mdf': return 'A binary measurement log (ASAM MDF). Download it and open it in a measurement tool (asammdf, CANape).'
    case 'pcap': case 'pcapng': return 'A packet capture. Download it and open it in Wireshark.'
    case 'sch': return 'A legacy KiCad (5 or earlier) schematic. Open it in KiCad and save it as .kicad_sch to view it here.'
    default: return null
  }
}
