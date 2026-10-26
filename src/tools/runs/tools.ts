/**
 * The run record, for agents: what ran (simulations, checks, builds, flashes, captures, measurements), how it went,
 * and the artifacts it kept — all from the project database (.trace/project.db). Every tool that records a run returns
 * its `run_id`; these three read it back.
 *
 *   trace.runs      recent runs, newest first, optionally by kind prefix ("hil.", "firmware.build")
 *   trace.run       one run: its arguments, result, measurements and artifact names
 *   trace.artifact  one artifact: its text (truncated, or a window of it), or saved to a path the caller names
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { findRoot, Work } from '../../core/store.js'

function withWork<T>(fn: (w: Work) => T): T {
  const w = new Work()
  try {
    return fn(w)
  } finally {
    w.close()
  }
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z'))

export const runs = defineTool({
  name: 'trace.runs',
  description: 'Recent runs in the project record (newest first): id, kind, subject, status, summary, when and how long. Filter by kind prefix (e.g. "hil.", "firmware.build", "sim.").',
  input: z.object({
    kind: z.string().optional().describe('kind prefix'),
    subject: z.string().optional().describe('only runs on this subject (a target, an instrument, a netlist)'),
    status: z.enum(['running', 'pass', 'fail', 'error']).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  run: ({ kind, subject, status, limit }) => withWork((w) => {
    // filter after fetching a wider window, so subject/status filters still return `limit` rows when they can
    const rows = w.runs(kind, subject || status ? Math.min(2000, limit * 20) : limit)
      .filter((r) => (!subject || r.subject === subject) && (!status || r.status === status))
      .slice(0, limit)
    return {
      runs: rows.map((r) => ({
        id: r.id, kind: r.kind, subject: r.subject, status: r.status, summary: r.summary,
        started: iso(r.started), seconds: r.finished === null ? null : Number((r.finished - r.started).toFixed(3)),
      })),
    }
  }),
})

export const run = defineTool({
  name: 'trace.run',
  description: 'One run from the project record: its kind, subject, status, summary, arguments, result, measurements (name, value, unit) and artifact names and sizes (read them with trace.artifact).',
  input: z.object({ id: z.string().min(4).describe('the run id (as returned in run_id)') }),
  run: ({ id }) => withWork((w) => {
    const r = w.run(id) ?? matchPrefix(w, id)
    if (!r) throw new ToolError(`no run ${JSON.stringify(id)} in ${w.db.location() ?? 'the project record'} (trace.runs lists recent ones)`)
    return {
      id: r.id, kind: r.kind, subject: r.subject, status: r.status, summary: r.summary,
      started: iso(r.started), finished: iso(r.finished), seconds: r.finished === null ? null : Number((r.finished - r.started).toFixed(3)),
      git_sha: r.git_sha, args: r.args, result: r.result, measurements: r.measurements, artifacts: r.artifacts,
    }
  }),
})

/** A unique run whose id starts with `prefix` (people paste the first few characters). */
function matchPrefix(w: Work, prefix: string): ReturnType<Work['run']> {
  const rows = w.db.prepare('SELECT id FROM runs WHERE id LIKE ? LIMIT 2').all(`${prefix.replace(/[%_]/g, '')}%`)
  if (rows.length > 1) throw new ToolError(`${prefix} matches several runs; give more of the id`)
  const id = rows[0]?.id
  return typeof id === 'string' ? w.run(id) : null
}

const TEXTISH = /^(text\/|application\/(json|xml|csv|x-yaml)|image\/svg)/

function looksText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096)
  let bad = 0
  for (let i = 0; i < n; i++) {
    const c = b[i]!
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) bad++
  }
  return bad <= n * 0.02
}

export const artifact = defineTool({
  name: 'trace.artifact',
  description: "An artifact of a run: its text (truncated to max_chars, or a window with offset / the last tail_lines), or, with save_to, written to that path. Binary artifacts are saved or shown as a hex preview.",
  input: z.object({
    run: z.string().min(4).describe('the run id'),
    name: z.string().min(1).describe('the artifact name (trace.run lists them)'),
    max_chars: z.number().int().min(1).max(200_000).default(8000),
    offset: z.number().int().min(0).default(0).describe('start this many characters in'),
    tail_lines: z.number().int().min(1).max(5000).optional().describe('the last N lines instead'),
    save_to: z.string().optional().describe('write the artifact to this path (relative to the repository) instead of returning it'),
  }),
  run: ({ run: id, name, max_chars, offset, tail_lines, save_to }) => withWork((w) => {
    const rec = w.run(id) ?? matchPrefix(w, id)
    if (!rec) throw new ToolError(`no run ${JSON.stringify(id)}`)
    const bytes = w.getArtifact(rec.id, name)
    if (!bytes) throw new ToolError(`run ${rec.id} has no artifact ${JSON.stringify(name)} (it has: ${rec.artifacts.map((a) => a.name).join(', ') || 'none'})`)
    const meta = rec.artifacts.find((a) => a.name === name)
    const mime = meta?.mime ?? null
    if (save_to) {
      const base = findRoot() ?? process.cwd()
      const dest = isAbsolute(save_to) ? save_to : resolve(join(base, save_to))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, bytes)
      return { run: rec.id, name, mime, bytes: bytes.length, saved_to: dest }
    }
    const isText = (mime !== null && TEXTISH.test(mime)) || looksText(bytes)
    if (!isText) {
      return { run: rec.id, name, mime, bytes: bytes.length, binary: true, hex_preview: Buffer.from(bytes.subarray(0, 64)).toString('hex'), note: 'binary: use save_to to write it to a file' }
    }
    const text = new TextDecoder().decode(bytes)
    if (tail_lines) {
      const lines = text.split(/\r?\n/)
      if (lines.at(-1) === '') lines.pop()
      const chunk = lines.slice(-tail_lines).join('\n')
      const cut = chunk.length > max_chars
      return { run: rec.id, name, mime, bytes: bytes.length, lines: lines.length, text: cut ? chunk.slice(-max_chars) : chunk, truncated: cut || lines.length > tail_lines }
    }
    const chunk = text.slice(offset, offset + max_chars)
    const more = offset + chunk.length < text.length
    return {
      run: rec.id, name, mime, bytes: bytes.length, chars: text.length, offset, text: chunk, truncated: more || offset > 0,
      ...(more ? { next_offset: offset + chunk.length } : {}),
    }
  }),
})

/** The runs tools. */
export const tools: AnyTool[] = [runs, run, artifact] as unknown as AnyTool[]
