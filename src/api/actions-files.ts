/**
 * The project's files (docs/ui-design.md "File viewers" and "Files screen"), read from GitHub after the read check.
 *
 *   files.list   read   every file of the repository at a ref (the default branch unless named), grouped by kind:
 *                         design         KiCad schematics, boards and projects
 *                         fabrication    Gerbers, drill files, placement and parts lists for the maker, their zips
 *                         firmware       sources and images (C, C++, Rust, Verilog and the like; .elf .hex .bin .map)
 *                         documents      PDFs, Markdown, text, office documents
 *                         models         3D models and renders (.step .stl .glb, images)
 *                         evidence       the artifacts runs recorded in the project database (by run), not files in
 *                                        the tree: their path is runs/<run id>/<name>
 *                         other          the rest (left out unless asked for)
 *                       Each file has its path, kind, size and blob sha; `.git`, `node_modules`, the project database
 *                       and other machinery are never listed
 *   files.url    read   one file: its bytes (base64) when at most 8 MB (the artifact limit), else GitHub's own short
 *                       download link (it carries a token for a private repository and lasts minutes). An evidence
 *                       path returns the artifact's bytes from the project database (or says it is too large)
 */
import { z } from 'zod'
import { Work } from '../core/store.js'
import { ActionError, type Context, MAX_ARTIFACT, PROJECT_DB_PATH, Repo, def, withProjectDb } from './action-kit.js'

export const FILE_KINDS = ['design', 'fabrication', 'firmware', 'documents', 'models', 'evidence', 'other'] as const
export type FileKind = (typeof FILE_KINDS)[number]

const SKIP = /(^|\/)(\.git|node_modules|\.venv|__pycache__|\.pytest_cache|target|dist|build\/cache)(\/|$)|(^|\/)\.trace\/project\.db$|-backups\/|(^|\/)~?_autosave-|\.lck$/i

const EXT: readonly [RegExp, FileKind][] = [
  [/\.(kicad_sch|kicad_pcb|kicad_pro|kicad_sym|kicad_mod|kicad_dru|kicad_wks|sch|net)$/i, 'design'],
  [/\.(gbr|ger|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gm1|gko|g[0-9]+|drl|xln|exc)$/i, 'fabrication'],
  [/(^|\/)(fab|fabrication|gerbers?|production|jlcpcb)\/.*\.(zip|csv|xlsx?)$/i, 'fabrication'],
  [/(-|_)(bom|cpl|pos|top-pos|bottom-pos)\.(csv|xlsx?)$/i, 'fabrication'],
  [/\.(c|h|cc|cpp|hpp|rs|s|ld|ino|v|sv|vh|vhd|vhdl|elf|hex|bin|map|uf2|bit|bitstream)$/i, 'firmware'],
  [/(^|\/)(Cargo\.toml|platformio\.ini|CMakeLists\.txt|memory\.x)$/i, 'firmware'],
  [/\.(pdf|md|markdown|txt|rst|docx?|odt|html?)$/i, 'documents'],
  [/\.(step|stp|stl|glb|gltf|wrl|png|jpe?g|webp|svg|mp4)$/i, 'models'],
]

/** The kind of one repository path. */
export function kindOf(path: string): FileKind {
  for (const [re, k] of EXT) if (re.test(path)) return k
  return 'other'
}

const SafePath = z.string().min(1).max(500).refine((p) => !p.startsWith('/') && !p.split('/').some((x) => x === '..' || x === ''), 'a path inside the repository')
const Ref = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, 'a branch, tag or commit').refine((r) => !r.includes('..'), 'a branch, tag or commit')

export interface FileEntry { path: string; kind: FileKind; size: number; sha: string | null; run?: string | undefined; mime?: string | null | undefined }

const EVIDENCE = /^runs\/([A-Za-z0-9_-]{1,64})\/(.+)$/

async function evidence(ctx: Context, repo: string, limit: number): Promise<FileEntry[]> {
  return withProjectDb(ctx, repo, (db) => {
    const w = new Work(db)
    try {
      return (w.db.prepare('SELECT a.run_id, a.name, a.mime, length(a.bytes) AS size FROM artifacts a JOIN runs r ON r.id = a.run_id ORDER BY r.started DESC LIMIT ?').all(limit) as Record<string, unknown>[])
        .map((r) => ({ path: `runs/${String(r.run_id)}/${String(r.name)}`, kind: 'evidence' as const, size: Number(r.size), sha: null, run: String(r.run_id), mime: r.mime === null ? null : String(r.mime) }))
    } finally {
      w.close()
    }
  })
}

const mimeOf = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const m: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', stl: 'model/stl', glb: 'model/gltf-binary', step: 'model/step', stp: 'model/step',
  }
  return m[ext] ?? (/(kicad_|\.(c|h|rs|v|sv|py|ts|toml|ya?ml|ini|log|net|cir)$)/.test(path) ? 'text/plain' : 'application/octet-stream')
}

export const FILE_ACTIONS = {
  'files.list': def('read', Repo.extend({
    kinds: z.array(z.enum(FILE_KINDS)).optional(), ref: Ref.optional(), evidence_limit: z.number().int().min(0).max(2000).default(200),
  }), async (a, ctx) => {
    const kinds = new Set<FileKind>(a.kinds ?? FILE_KINDS.filter((k) => k !== 'other'))
    const gh = await ctx.deps.github()
    const ref = a.ref ?? (await gh.defaultBranch(a.repo)).branch
    const t = await gh.tree(a.repo, ref)
    const files: FileEntry[] = t.files.filter((f) => !SKIP.test(f.path) && f.path !== PROJECT_DB_PATH)
      .map((f) => ({ path: f.path, kind: kindOf(f.path), size: f.size, sha: f.sha })).filter((f) => kinds.has(f.kind))
    if (kinds.has('evidence') && a.evidence_limit > 0) files.push(...await evidence(ctx, a.repo, a.evidence_limit))
    const groups = FILE_KINDS.filter((k) => kinds.has(k)).map((k) => ({ kind: k, files: files.filter((f) => f.kind === k).sort((x, y) => x.path.localeCompare(y.path)) }))
    return { repo: a.repo, ref, truncated: t.truncated, groups, counts: Object.fromEntries(groups.map((g) => [g.kind, g.files.length])) }
  }),

  'files.url': def('read', Repo.extend({ path: SafePath, ref: Ref.optional() }), async (a, ctx) => {
    const ev = EVIDENCE.exec(a.path)
    if (ev) {
      const [, run, name] = ev as unknown as [string, string, string]
      return withProjectDb(ctx, a.repo, (db) => {
        const w = new Work(db)
        try {
          const row = w.db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(run, name)
          if (!row) throw new ActionError(`There is no ${name} on run ${run}.`)
          const bytes = row.bytes as Uint8Array
          if (bytes.length > MAX_ARTIFACT) throw new ActionError(`${name} is ${bytes.length} bytes; the API returns at most ${MAX_ARTIFACT}.`)
          return { repo: a.repo, path: a.path, kind: 'evidence', mime: row.mime === null ? mimeOf(name) : String(row.mime), size: bytes.length, base64: Buffer.from(bytes).toString('base64') }
        } finally {
          w.close()
        }
      })
    }
    if (SKIP.test(a.path) || a.path === PROJECT_DB_PATH) throw new ActionError(`There is no file ${a.path} to show.`)
    const gh = await ctx.deps.github()
    const ref = a.ref ?? (await gh.defaultBranch(a.repo)).branch
    const info = await gh.fileInfo(a.repo, a.path, ref)
    if (!info) throw new ActionError(`There is no file ${a.path} at ${ref}.`)
    const base = { repo: a.repo, path: a.path, ref, kind: kindOf(a.path), mime: mimeOf(a.path), size: info.size, sha: info.sha }
    if (info.size <= MAX_ARTIFACT) {
      const bytes = await gh.rawFile(a.repo, a.path, ref)
      if (!bytes) throw new ActionError(`There is no file ${a.path} at ${ref}.`)
      return { ...base, base64: Buffer.from(bytes).toString('base64') }
    }
    if (!info.downloadUrl) throw new ActionError(`${a.path} is larger than 8 MB and GitHub gave no download link for it.`)
    return { ...base, url: info.downloadUrl, note: 'A short-lived link from GitHub; ask again when it stops working.' }
  }),
}
