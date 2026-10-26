/**
 * What goes into a project's knowledge base, worked out the same way every time from the checked-out tree, its
 * settings (`knowledge.*`) and the shared datasheet library. Nothing here talks to AWS.
 *
 *   object key (under projects/<slug>/kb/)        source      kind                      from
 *   repo/<path>[.txt]                             repo        markdown | doc | rules |  the repository's files that
 *                                                             claude | source           match knowledge.include and not
 *                                                                                       knowledge.exclude (git ls-files)
 *   summary/<path of the .kicad_pro>.md           summary     kicad                     a text summary of each KiCad
 *                                                                                       project: components, BOM, nets
 *   datasheets/<part>/<sha256 16>/p<page>.txt     datasheet   datasheet                 one object per page of the
 *                                                                                       current datasheet of each MPN in
 *                                                                                       the BOMs, from the shared library
 *
 * Bedrock reads .txt, .md, .html and .csv as text, so any other file (firmware sources, .rst) is stored with `.txt`
 * appended; raw KiCad files are never uploaded. Every object has its `<key>.metadata.json` sidecar beside it (the
 * format Bedrock requires), with these attributes:
 *
 *   source    repo | datasheet | summary                     filterable
 *   kind      as above                                        filterable
 *   path      the repository path (datasheets/<part> for a datasheet), embedded with the chunk
 *   commit    the commit the content was synced from          (not embedded)
 *   dir1…dir6 the first 16 hex digits of the sha256 of each enclosing folder (docs, docs/power, …): S3 Vectors has
 *             no startsWith filter, so kb.search's path_prefix is an equals on one of these
 *   part, mpn, sha256, page   a datasheet page's citation (part embedded with the chunk)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { TraceConfig } from '../../core/config.js'
import { buildBom } from '../kicad/bom.js'
import { loadBoard, netNames } from '../kicad/pcb.js'
import { discover, fromPath } from '../kicad/project.js'
import { naturalCompare, powerNets, readSchematic } from '../kicad/schematic.js'

export type KbSource = 'repo' | 'datasheet' | 'summary'
export const KB_SOURCES = ['repo', 'datasheet', 'summary'] as const
export const KB_KINDS = ['markdown', 'doc', 'rules', 'claude', 'source', 'kicad', 'datasheet'] as const
export type KbKind = (typeof KB_KINDS)[number]

/** How many enclosing folders get a dir<n> attribute. */
export const DIR_DEPTH = 6

export interface KbMeta {
  source: KbSource
  kind: KbKind
  path: string
  part?: string
  mpn?: string
  sha256?: string
  page?: number
}

/** One document for the knowledge base: its key under the kb prefix, its bytes and its metadata. */
export interface KbDoc {
  key: string
  body: Uint8Array
  contentType: string
  meta: KbMeta
}

export interface Collected {
  docs: KbDoc[]
  /** repository files that matched and were left out, with why */
  skipped: { path: string; reason: string }[]
  /** each BOM part number and what became of its datasheet */
  parts: { mpn: string; datasheet: string | null; pages: number; note?: string }[]
  /** KiCad projects summarised (their .kicad_pro paths) */
  kicad: string[]
}

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** The 16-hex-digit hash a folder's dir<n> attribute holds (and kb.search filters on). */
export const dirHash = (dir: string): string => sha256(dir.replace(/^\/+|\/+$/g, '')).slice(0, 16)

/** The folders enclosing `path`, outermost first: docs/power/rails.md → [docs, docs/power]. */
export function enclosing(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

// ------------------------------------------------------------------ globs

/** A repository glob as a regular expression: `**` any number of folders (`**\/` also none), `*` and `?` within one. */
export function globRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Whether a repository path is in the knowledge base by the include and exclude globs (exclude wins). */
export function selected(path: string, include: readonly string[], exclude: readonly string[]): boolean {
  return include.some((g) => globRegex(g).test(path)) && !exclude.some((g) => globRegex(g).test(path))
}

/** Never uploaded whatever the globs say: KiCad's own files (summarised instead), the project database, binaries. */
const NEVER = /\.(kicad_(pro|sch|pcb|prl|sym|mod|dru|wks)|db|db-wal|db-shm|sqlite|pdf|png|jpe?g|gif|zip|gz|step|stp|wrl|bin|elf|hex|uf2)$/i

/** The repository's files, relative and with `/`: what git tracks, or (not a git checkout) a walk of the tree. */
export function repoFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
    return out.split('\0').filter(Boolean).filter((f) => existsSync(join(root, f))).sort()
  } catch {
    const files: string[] = []
    const walk = (d: string, depth: number): void => {
      if (depth > 20) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const full = join(d, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile()) files.push(relative(root, full).split(sep).join('/'))
      }
    }
    walk(root, 0)
    return files.sort()
  }
}

const TEXT_TYPES: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.csv': 'text/csv' }

/** The object key and content type for a repository file: Bedrock's own text types keep their name, the rest get .txt. */
export function repoKey(path: string): { key: string; contentType: string } {
  const ext = extname(path).toLowerCase()
  const type = TEXT_TYPES[ext]
  return type ? { key: `repo/${path}`, contentType: type } : { key: `repo/${path}.txt`, contentType: 'text/plain' }
}

export function kindOf(path: string): KbKind {
  if (path === '.trace/rules.md') return 'rules'
  if (/(^|\/)CLAUDE\.md$/.test(path)) return 'claude'
  const ext = extname(path).toLowerCase()
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'markdown'
  if (['.txt', '.rst', '.adoc', '.html', '.htm'].includes(ext)) return 'doc'
  return 'source'
}

const isText = (b: Uint8Array): boolean => !b.subarray(0, 8192).includes(0)

// ------------------------------------------------------------------ KiCad summaries

const cell = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** A KiCad project as text: title block, sheets, BOM, parts left out, nets (power, labels, the board's). Deterministic. */
export function kicadSummary(proPath: string, root: string): { text: string; mpns: string[] } {
  const p = fromPath(proPath)
  const rel = relative(root, proPath).split(sep).join('/')
  const lines: string[] = [`# KiCad project ${p.name}`, '', `Summary of \`${rel}\` written by trace for the knowledge base (not the KiCad files themselves).`, '']
  const mpns: string[] = []
  if (p.sch) {
    try {
      const sch = readSchematic(p.sch, p.name)
      const title = Object.entries(sch.title).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b))
      if (title.length) lines.push('## Title block', '', ...title.map(([k, v]) => `- ${k}: ${cell(v)}`), '')
      if (sch.sheets.length) lines.push('## Sheets', '', ...[...sch.sheets].sort((a, b) => a.path.localeCompare(b.path)).map((s) => `- ${s.path} (${s.file})`), '')
      const bom = buildBom(sch)
      lines.push('## Bill of materials', '', `${bom.total_parts} parts on ${bom.unique_lines} lines; ${bom.missing_part_number} lines without a part number.`, '',
        '| Qty | References | Value | Footprint | MPN | Manufacturer | LCSC | Description |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const l of bom.lines) {
        lines.push(`| ${l.quantity} | ${cell(l.refs.join(', '))} | ${cell(l.value)} | ${cell(l.footprint)} | ${cell(l.mpn)} | ${cell(l.manufacturer)} | ${cell(l.lcsc)} | ${cell(l.description)} |`)
        if (l.mpn) mpns.push(l.mpn)
      }
      lines.push('')
      if (bom.excluded.length) lines.push('## Not fitted or not in the BOM', '', ...bom.excluded.map((x) => `- ${x.ref} ${cell(x.value)}: ${x.reason}`), '')
      const power = powerNets(sch)
      if (power.length) lines.push('## Power nets', '', power.join(', '), '')
      const labels = [...new Set(sch.labels.map((l) => `${l.text} (${l.kind.replace('_', ' ')})`))].sort(naturalCompare)
      if (labels.length) lines.push('## Net labels', '', labels.join(', '), '')
      if (sch.problems.length) lines.push('## Reading problems', '', ...sch.problems.map((x) => `- ${cell(x)}`), '')
    } catch (e) {
      lines.push(`The schematic could not be read: ${cell(e instanceof Error ? e.message : String(e))}`, '')
    }
  } else lines.push('No schematic.', '')
  if (p.pcb) {
    try {
      const b = loadBoard(p.pcb)
      const nets = netNames(b).filter(Boolean).sort(naturalCompare)
      lines.push('## Board', '', `${b.footprints.length} footprints, ${b.layers.length} copper layers (${b.layers.map((l) => l.name).join(', ')}).`, '')
      if (nets.length) lines.push(`### Nets on the board (${nets.length})`, '', nets.slice(0, 5000).join(', '), '')
    } catch (e) {
      lines.push(`The board could not be read: ${cell(e instanceof Error ? e.message : String(e))}`, '')
    }
  }
  return { text: `${lines.join('\n').trimEnd()}\n`, mpns }
}

// ------------------------------------------------------------------ datasheets

/** What collecting needs of the shared datasheet library (src/tools/datasheets/library.ts). */
export interface DatasheetSource {
  /** the part's key and current document, or null when the library has no datasheet for it */
  current(mpn: string): Promise<{ key: string; sha256: string } | null>
  pageTexts(sha256: string): Promise<string[]>
}

/** A part key as one S3 key segment (part numbers can hold `/`, `#`, `+`, `,`). */
export const partSegment = (key: string): string => encodeURIComponent(key)

// ------------------------------------------------------------------ collecting

export interface CollectOptions {
  root: string
  cfg: Pick<TraceConfig, 'knowledge' | 'electronics'>
  datasheets: DatasheetSource | null
}

/** Everything the knowledge base should hold for this tree, sorted by key. */
export async function collect(o: CollectOptions): Promise<Collected> {
  const k = o.cfg.knowledge
  const docs: KbDoc[] = []
  const skipped: Collected['skipped'] = []
  const enc = new TextEncoder()

  for (const path of repoFiles(o.root)) {
    if (!selected(path, k.include, k.exclude)) continue
    if (NEVER.test(path)) { skipped.push({ path, reason: 'not text the knowledge base takes (KiCad files are summarised instead)' }); continue }
    const full = join(o.root, path)
    const size = statSync(full).size
    if (size > k.max_file_kb * 1024) { skipped.push({ path, reason: `larger than knowledge.max_file_kb (${k.max_file_kb} KB)` }); continue }
    const body = readFileSync(full)
    if (!body.length) { skipped.push({ path, reason: 'empty' }); continue }
    if (!isText(body)) { skipped.push({ path, reason: 'binary' }); continue }
    const { key, contentType } = repoKey(path)
    docs.push({ key, body: new Uint8Array(body), contentType, meta: { source: 'repo', kind: kindOf(path), path } })
  }

  const kicad: string[] = []
  const mpns = new Map<string, string>()
  if (k.kicad || k.datasheets) {
    const listed = o.cfg.electronics.projects.map((p) => join(o.root, p))
    const pros = (listed.length ? listed : discover(o.root)).filter((p) => p.endsWith('.kicad_pro') && existsSync(p)).sort()
    for (const pro of pros) {
      const rel = relative(o.root, pro).split(sep).join('/')
      const s = kicadSummary(pro, o.root)
      for (const m of s.mpns) if (!mpns.has(m.trim().toUpperCase())) mpns.set(m.trim().toUpperCase(), m.trim())
      if (!k.kicad) continue
      kicad.push(rel)
      docs.push({ key: `summary/${rel}.md`, body: enc.encode(s.text), contentType: 'text/markdown', meta: { source: 'summary', kind: 'kicad', path: rel } })
    }
  }

  const parts: Collected['parts'] = []
  if (k.datasheets && o.datasheets) {
    for (const mpn of [...mpns.values()].sort(naturalCompare)) {
      let cur: { key: string; sha256: string } | null
      try {
        cur = await o.datasheets.current(mpn)
      } catch (e) {
        parts.push({ mpn, datasheet: null, pages: 0, note: e instanceof Error ? e.message : String(e) })
        continue
      }
      if (!cur) { parts.push({ mpn, datasheet: null, pages: 0, note: 'no datasheet in the shared library' }); continue }
      const texts = (await o.datasheets.pageTexts(cur.sha256)).slice(0, k.max_datasheet_pages)
      let n = 0
      texts.forEach((t, i) => {
        const text = t.trim()
        if (!text) return
        n++
        const page = i + 1
        const head = `${cur.key} datasheet (sha256 ${cur.sha256}), page ${page}\n\n`
        docs.push({
          key: `datasheets/${partSegment(cur.key)}/${cur.sha256.slice(0, 16)}/p${String(page).padStart(4, '0')}.txt`,
          body: enc.encode(head + text + '\n'), contentType: 'text/plain',
          meta: { source: 'datasheet', kind: 'datasheet', path: `datasheets/${cur.key}`, part: cur.key, mpn, sha256: cur.sha256, page },
        })
      })
      parts.push({ mpn, datasheet: cur.sha256, pages: n })
    }
  } else if (k.datasheets) {
    for (const mpn of [...mpns.values()].sort(naturalCompare)) parts.push({ mpn, datasheet: null, pages: 0, note: 'no datasheet library here' })
  }

  docs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { docs, skipped, parts, kicad }
}

// ------------------------------------------------------------------ metadata sidecars

export const SIDECAR = '.metadata.json'

/** Longest value kept in a string attribute (S3 Vectors allows about 1 KB of custom metadata per vector in all). */
const MAX_ATTR = 300

type Attr = { value: { type: 'STRING'; stringValue: string } | { type: 'NUMBER'; numberValue: number }; includeForEmbedding: boolean }

/** The sidecar's attributes, apart from the commit: what decides whether a sidecar changed. */
export function attributes(m: KbMeta): Record<string, Attr> {
  const s = (v: string, embed = false): Attr => ({ value: { type: 'STRING', stringValue: v.slice(0, MAX_ATTR) }, includeForEmbedding: embed })
  const out: Record<string, Attr> = { source: s(m.source), kind: s(m.kind), path: s(m.path, true) }
  enclosing(m.path).slice(0, DIR_DEPTH).forEach((d, i) => { out[`dir${i + 1}`] = s(dirHash(d)) })
  if (m.part !== undefined) out.part = s(m.part, true)
  if (m.mpn !== undefined) out.mpn = s(m.mpn)
  if (m.sha256 !== undefined) out.sha256 = s(m.sha256)
  if (m.page !== undefined) out.page = { value: { type: 'NUMBER', numberValue: m.page }, includeForEmbedding: false }
  return out
}

/** The sidecar Bedrock reads beside a document (`<key>.metadata.json`, at most 10 KB). */
export function sidecar(m: KbMeta, commit: string): Uint8Array {
  const attrs = { ...attributes(m), commit: { value: { type: 'STRING' as const, stringValue: commit }, includeForEmbedding: false } }
  const sorted = Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)))
  return new TextEncoder().encode(`${JSON.stringify({ metadataAttributes: sorted }, null, 1)}\n`)
}

/** What a sidecar's tracking hash covers: its document and its attributes, not the commit, so content synced once
 * keeps the commit it was first synced from instead of being uploaded again on every push. */
export const sidecarHash = (docHash: string, m: KbMeta): string => sha256(`${docHash}\n${JSON.stringify(attributes(m))}`)
