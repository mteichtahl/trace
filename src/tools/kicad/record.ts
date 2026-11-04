/**
 * Every kicad tool run is recorded in the project's run record (store.Work): what ran, on what, its compact result,
 * its measurements, and its larger outputs (reports, BOM CSVs, file lists) as artifacts. The tool's answer carries the
 * run id, so an agent can point at the stored record instead of pasting a long report back into its context.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { normalisedHash } from '../../core/normalise.js'
import { Work, findRoot, type RunInput, type RunStatus } from '../../core/store.js'

export interface RunHandle {
  readonly id: string
  measure(name: string, value: number | null, unit?: string): void
  artifact(name: string, data: string | Uint8Array, mime?: string): void
  /** another run's output this run was made from (lineage), by that run and the output's name */
  uses(run: string, name: string): void
}

/**
 * The repository files a run reads, from its arguments (lineage, docs/ontology.md): every argument that names an
 * existing file of the repository, and for a KiCad project (.kicad_pro) or a board or schematic of one, the project's
 * schematic sheets, board and design rules beside it. Each with the hash of its normalised content now, before the
 * run reads it. Files outside the repository are left out.
 */
export function fileInputs(args: unknown, root: string | null = findRoot()): RunInput[] {
  if (!root) return []
  const paths = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && v.length < 4096 && /[./]/.test(v)) {
      const p = isAbsolute(v) ? v : resolve(root, v)
      if (!p.startsWith(`${resolve(root)}/`) || !existsSync(p) || !statSync(p).isFile()) return
      paths.add(p)
      if (/\.(kicad_pro|kicad_pcb|kicad_sch)$/.test(p)) {
        const dir = dirname(p)
        for (const f of readdirSync(dir)) if (/\.(kicad_sch|kicad_pcb|kicad_dru)$/.test(f)) paths.add(join(dir, f))
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(args)
  return [...paths].sort().map((p) => {
    const ref = relative(root, p)
    return { kind: 'file' as const, ref, sha256: normalisedHash(ref, readFileSync(p)) }
  })
}

export interface Outcome<T> {
  status: Exclude<RunStatus, 'running'>
  summary: string
  result: T
}

/** Run `fn` inside a recorded run. A thrown error finishes the run as 'error' and is rethrown. */
export async function recorded<T extends object>(kind: string, subject: string | null, args: unknown,
  fn: (run: RunHandle) => Promise<Outcome<T>>): Promise<T & { run_id: string }> {
  const work = new Work()
  const id = work.start(kind, { subject: subject ?? undefined, args })
  // what the run reads, as it is before the run reads it; the outputs of other runs it names are added as it goes
  const inputs: RunInput[] = fileInputs(args)
  const handle: RunHandle = {
    id,
    measure: (name, value, unit = '') => work.measure(id, name, value, unit),
    artifact: (name, data, mime) => work.artifact(id, name, data, mime),
    uses: (run, name) => {
      const h = work.db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=? AND name=?').get(run, name) as { sha256: string } | undefined
      inputs.push({ kind: 'artifact', ref: run, name, sha256: h?.sha256 ?? null })
    },
  }
  try {
    const out = await fn(handle)
    work.inputs(id, inputs)
    const result = { ...out.result, run_id: id }
    work.finish(id, out.status, out.summary, result)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    work.inputs(id, inputs)
    work.finish(id, 'error', msg.slice(0, 300))
    if (e instanceof ToolError) throw new ToolError(`${msg} (run ${id})`)
    throw e
  } finally {
    work.close()
  }
}

/** The first `n` items and a note of how many were left out. */
export function cap<T>(items: readonly T[], n: number): { items: T[]; omitted: number } {
  return { items: items.slice(0, n), omitted: Math.max(0, items.length - n) }
}
