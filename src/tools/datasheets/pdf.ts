/**
 * What needs more than a text layer: tables, electrical-characteristics rows and vector figures (through the Python
 * bridge to pdfplumber, python/tracebridge/pdf.py), and page images (pdftoppm, for an agent to look at a figure).
 *
 * Each result is checked with a zod schema, and its sha256 is checked against the document the caller asked for, so
 * a citation can never name a document other than the one that was read.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { bridge, type Bridge } from '../../core/bridge.js'
import { ToolError } from '../../core/registry.js'

const run = promisify(execFile)

export const TablesSchema = z.object({
  sha256: z.string(),
  page: z.number().int(),
  tables: z.array(z.object({ rows: z.array(z.array(z.string())), row_count: z.number().int() })),
})

export const ParamRowSchema = z.object({
  page: z.number().int(),
  raw: z.string(),
  parsed: z.boolean(),
  parameter: z.string().optional(),
  symbol: z.string().optional(),
  conditions: z.string().optional(),
  min: z.string().nullable().optional(),
  typ: z.string().nullable().optional(),
  max: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
})
export const ParamsSchema = z.object({ sha256: z.string(), query: z.string(), total: z.number().int(), rows: z.array(ParamRowSchema) })

export const RowsSchema = z.object({
  sha256: z.string(),
  query: z.string(),
  total: z.number().int(),
  rows: z.array(z.object({ page: z.number().int(), raw: z.string(), cells: z.record(z.string(), z.string()).nullable() })),
})

export const FigureSchema = z.object({
  sha256: z.string(),
  page: z.number().int(),
  size: z.tuple([z.number(), z.number()]),
  stroke_count: z.number().int(),
  strokes: z.array(z.object({
    kind: z.enum(['line', 'curve', 'rect']),
    points: z.array(z.tuple([z.number(), z.number()])),
    colour: z.array(z.number()).nullable(),
    width: z.number(),
  })),
  words: z.array(z.object({ text: z.string(), x0: z.number(), top: z.number(), x1: z.number(), bottom: z.number() })),
})

export type Tables = z.output<typeof TablesSchema>
export type Params = z.output<typeof ParamsSchema>
export type Rows = z.output<typeof RowsSchema>
export type Figure = z.output<typeof FigureSchema>

function checked<T extends { sha256: string }>(r: T, sha256: string): T {
  if (r.sha256 !== sha256) throw new ToolError(`the document read (${r.sha256.slice(0, 12)}…) is not the one asked for (${sha256.slice(0, 12)}…)`)
  return r
}

export class PdfReader {
  constructor(private readonly b: Bridge = bridge()) {}

  async tables(path: string, sha256: string, page: number): Promise<Tables> {
    return checked(await this.b.call('pdf.tables', { path, page }, TablesSchema), sha256)
  }

  async params(path: string, sha256: string, query: string, opts: { pages?: number[]; regex?: boolean; limit?: number } = {}): Promise<Params> {
    return checked(await this.b.call('pdf.params', { path, query, ...opts }, ParamsSchema), sha256)
  }

  async rows(path: string, sha256: string, query: string, opts: { pages?: number[]; regex?: boolean; limit?: number } = {}): Promise<Rows> {
    return checked(await this.b.call('pdf.rows', { path, query, ...opts }, RowsSchema), sha256)
  }

  async figure(path: string, sha256: string, page: number, bbox?: [number, number, number, number]): Promise<Figure> {
    return checked(await this.b.call('pdf.figure', { path, page, ...(bbox ? { bbox } : {}) }, FigureSchema), sha256)
  }
}

/** One page as a PNG at 110 dpi (pdftoppm -r 110 -f N -l N -png). */
export async function pageImage(path: string, page: number, dpi = 110): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-page-'))
  try {
    await run('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-png', path, join(dir, 'p')], { timeout: 60_000 })
    const png = readdirSync(dir).find((f) => f.endsWith('.png'))
    if (!png) throw new ToolError(`pdftoppm produced no image for page ${page} (is the page in range?)`)
    return new Uint8Array(readFileSync(join(dir, png)))
  } catch (e) {
    if (e instanceof ToolError) throw e
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') throw new ToolError('pdftoppm is not installed (poppler-utils)')
    throw new ToolError(`pdftoppm failed: ${(err.stderr ?? err.message).trim().slice(0, 300)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
