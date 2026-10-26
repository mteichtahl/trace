/**
 * Every kicad tool run is recorded in the project's run record (store.Work): what ran, on what, its compact result,
 * its measurements, and its larger outputs (reports, BOM CSVs, file lists) as artifacts. The tool's answer carries the
 * run id, so an agent can point at the stored record instead of pasting a long report back into its context.
 */
import { ToolError } from '../../core/registry.js'
import { Work, type RunStatus } from '../../core/store.js'

export interface RunHandle {
  readonly id: string
  measure(name: string, value: number | null, unit?: string): void
  artifact(name: string, data: string | Uint8Array, mime?: string): void
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
  const handle: RunHandle = {
    id,
    measure: (name, value, unit = '') => work.measure(id, name, value, unit),
    artifact: (name, data, mime) => work.artifact(id, name, data, mime),
  }
  try {
    const out = await fn(handle)
    const result = { ...out.result, run_id: id }
    work.finish(id, out.status, out.summary, result)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
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
