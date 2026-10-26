/**
 * The datasheets tools: the shared library (library.ts) for agents. Every figure returned carries a citation
 * {mpn, sha256, page}, so a project can pin exactly what it read; lists are capped and say their total.
 *
 * `library` (an explicit store location) exists for tests and one-off use; normally the store is TRACE_HOME.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { cacheDir } from '../../core/central.js'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { library, type PartEntry, type VersionInfo } from './library.js'
import { pageImage, PdfReader } from './pdf.js'

const mpn = z.string().min(1).describe('manufacturer part number (or an alias of one)')
const sha = z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional().describe('pin a version by its sha256 (8+ hex digits); default the current one')
const lib = z.string().optional().describe('a store location instead of TRACE_HOME (tests)')

const short = (v: VersionInfo | null) => (v ? { sha256: v.sha256, file: v.file, pages: v.pages, via: v.via, source_url: v.source_url, by: v.by, at: v.at } : null)

function summary(e: PartEntry) {
  return {
    mpn: e.key, written: e.mpn, manufacturer: e.manufacturer, title: e.title, status: e.status, current: short(e.current),
    versions: e.history.length + (e.current ? 1 : 0), changed: e.changed, aliases: e.aliases,
  }
}

let reader: PdfReader | null = null
const pdf = (): PdfReader => (reader ??= new PdfReader())

export const add = defineTool({
  name: 'datasheets.add',
  description: 'Add a datasheet to the shared library, from a URL (downloaded and checked to be a PDF) or a local file. The same document again changes nothing; a different one becomes the current version and opens a change until acknowledged.',
  input: z.object({
    mpn, url: z.string().url().optional(), file: z.string().optional().describe('a local PDF'),
    manufacturer: z.string().optional(), title: z.string().optional(), by: z.string().optional().describe('who is adding it'),
    aliases: z.array(z.string()).max(20).optional().describe('other spellings of this exact part (packaging variants), added on purpose'),
    library: lib,
  }),
  run: async (a) => {
    const r = await library(a.library).add({
      mpn: a.mpn, ...(a.url ? { url: a.url } : {}), ...(a.file ? { file: a.file } : {}),
      ...(a.manufacturer ? { manufacturer: a.manufacturer } : {}), ...(a.title ? { title: a.title } : {}),
      ...(a.by ? { by: a.by } : {}), ...(a.aliases ? { aliases: a.aliases } : {}),
    })
    return { outcome: r.outcome, sha256: r.sha256, ...(r.note ? { note: r.note } : {}), entry: summary(r.entry) }
  },
})

export const get = defineTool({
  name: 'datasheets.get',
  description: "One part's datasheet: a local path to the PDF (cached, its sha256 checked), the version, and whether a newer document replaced one a project may have pinned.",
  input: z.object({ mpn, sha256: sha, library: lib }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version, pinned } = await L.version(a.mpn, a.sha256)
    return { path: await L.localPath(version.sha256), pinned, version: short(version), entry: summary(entry) }
  },
})

export const list = defineTool({
  name: 'datasheets.list',
  description: 'The shared library: parts by MPN, manufacturer or title (substring), with their current sha256 and open changes.',
  input: z.object({
    query: z.string().optional(), status: z.enum(['current', 'retired', 'changed', 'all']).default('current'),
    limit: z.number().int().min(1).max(200).default(50), library: lib,
  }),
  run: async (a) => {
    const r = await library(a.library).list({ status: a.status, limit: a.limit, ...(a.query ? { query: a.query } : {}) })
    return { total: r.total, shown: r.parts.length, parts: r.parts.map(summary) }
  },
})

export const find = defineTool({
  name: 'datasheets.find',
  description: 'Find text in a datasheet: every page it appears on with a snippet (case-insensitive; regex optional). Cite the page.',
  input: z.object({ mpn, query: z.string().min(1), regex: z.boolean().default(false), sha256: sha, limit: z.number().int().min(1).max(100).default(20), library: lib }),
  run: async (a) => library(a.library).find(a.mpn, a.query, { regex: a.regex, limit: a.limit, ...(a.sha256 ? { sha256: a.sha256 } : {}) }),
})

export const text = defineTool({
  name: 'datasheets.text',
  description: 'The text of datasheet pages (from its text layer), capped per page. Empty pages are scans: look at datasheets.page_image.',
  input: z.object({
    mpn, pages: z.array(z.number().int().min(1)).min(1).max(10).describe('1-based page numbers'),
    sha256: sha, max_chars: z.number().int().min(200).max(40_000).default(8000), library: lib,
  }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version } = await L.version(a.mpn, a.sha256)
    const texts = await L.pageTexts(version.sha256)
    return {
      mpn: entry.key, sha256: version.sha256, page_count: texts.length,
      pages: a.pages.map((p) => {
        if (p > texts.length) throw new ToolError(`page ${p} out of range (the document has ${texts.length})`)
        const t = texts[p - 1] ?? ''
        return { page: p, chars: t.length, truncated: t.length > a.max_chars, text: t.slice(0, a.max_chars) }
      }),
    }
  },
})

export const tables = defineTool({
  name: 'datasheets.tables',
  description: 'The tables on one datasheet page, as rows of cells (pdfplumber).',
  input: z.object({ mpn, page: z.number().int().min(1), sha256: sha, library: lib }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version } = await L.version(a.mpn, a.sha256)
    const r = await pdf().tables(await L.localPath(version.sha256), version.sha256, a.page)
    return { mpn: entry.key, sha256: r.sha256, page: r.page, count: r.tables.length, tables: r.tables.slice(0, 10) }
  },
})

export const params = defineTool({
  name: 'datasheets.params',
  description: 'Electrical characteristics: the table rows whose parameter name or symbol matches, with min/typ/max/unit as printed and the page. Rows that cannot be split into columns come back as raw text (parsed: false): read them, never assume a column. Set kind=pins for pin or package tables.',
  input: z.object({
    mpn, query: z.string().min(1).describe('parameter name or symbol, e.g. "quiescent current" or "IQ"'),
    kind: z.enum(['electrical', 'pins']).default('electrical'), regex: z.boolean().default(false),
    pages: z.array(z.number().int().min(1)).max(50).optional(), sha256: sha, limit: z.number().int().min(1).max(50).default(20), library: lib,
  }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version } = await L.version(a.mpn, a.sha256)
    const path = await L.localPath(version.sha256)
    const opts = { regex: a.regex, limit: a.limit, ...(a.pages ? { pages: a.pages } : {}) }
    const cite = (page: number) => ({ mpn: entry.key, sha256: version.sha256, page })
    if (a.kind === 'pins') {
      const r = await pdf().rows(path, version.sha256, a.query, opts)
      return { total: r.total, rows: r.rows.map((x) => ({ ...x, cite: cite(x.page) })) }
    }
    const r = await pdf().params(path, version.sha256, a.query, opts)
    return {
      total: r.total,
      rows: r.rows.map((x) => ({ ...x, cite: cite(x.page) })),
      ...(r.total === 0 ? { note: 'no table row matched: try datasheets.find for the text, then datasheets.tables on its page' } : {}),
    }
  },
})

export const page_image = defineTool({
  name: 'datasheets.page_image',
  description: 'Render one datasheet page as a PNG (110 dpi) to look at a figure; returns the image path.',
  input: z.object({ mpn, page: z.number().int().min(1), sha256: sha, dpi: z.number().int().min(50).max(300).default(110), library: lib }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version } = await L.version(a.mpn, a.sha256)
    if (version.pages !== null && a.page > version.pages) throw new ToolError(`page ${a.page} out of range (the document has ${version.pages})`)
    const png = await pageImage(await L.localPath(version.sha256), a.page, a.dpi)
    const out = join(cacheDir('datasheets', 'pages'), `${version.sha256}-p${a.page}-${a.dpi}.png`)
    writeFileSync(out, png)
    return { path: out, bytes: png.length, cite: { mpn: entry.key, sha256: version.sha256, page: a.page } }
  },
})

export const history = defineTool({
  name: 'datasheets.history',
  description: "A part's document versions, newest first (sha256, source, who, when, when replaced) and its open change.",
  input: z.object({ mpn, library: lib }),
  run: async (a) => {
    const e = await library(a.library).entry(a.mpn)
    return { mpn: e.mpn, status: e.status, changed: e.changed, current: e.current, history: e.history.slice(0, 50), total: e.history.length + (e.current ? 1 : 0) }
  },
})

export const acknowledge = defineTool({
  name: 'datasheets.acknowledge',
  description: "Acknowledge that a part's changed datasheet has been re-read (figures taken from the old version checked against the new one). Closes its open change.",
  input: z.object({ mpn, by: z.string().optional(), note: z.string().max(500).optional(), library: lib }),
  run: async (a) => {
    const r = await library(a.library).acknowledge(a.mpn, a.by, a.note)
    return { acknowledged: r.acknowledged, entry: summary(r.entry) }
  },
})

export const tools: AnyTool[] = [add, get, list, find, text, tables, params, page_image, history, acknowledge] as AnyTool[]
