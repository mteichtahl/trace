/**
 * The run record for simulations: every tool call that runs a simulator is one row in the project database's `runs`
 * table, with what it ran (netlist, sources), what the simulator said (log, raw output, VCD, testbench output) as
 * artifacts, and its measurements in `measurements`. Tools return the run id so a later call can fetch an artifact
 * (a VCD for sim.wave_decode, say) without any file being kept on disk.
 */
import { ToolError } from '../core/registry.js'
import { Work, type RunStatus } from '../core/store.js'
import type { MeasureResult } from './measure.js'

export class Recorder {
  readonly id: string
  private readonly work: Work
  private closed = false

  constructor(kind: string, subject: string | undefined, args: unknown) {
    this.work = new Work()
    this.id = this.work.start(kind, { subject, args })
  }

  /** Store an artifact; an empty one is skipped (an empty blob is stored as NULL, which the schema refuses). */
  artifact(name: string, data: string | Uint8Array, mime?: string): void {
    if (data.length === 0) return
    this.work.artifact(this.id, name, data, mime)
  }

  measurements(results: readonly MeasureResult[], prefix = ''): void {
    for (const m of results) {
      const { name, value, unit, ...detail } = m
      this.work.measure(this.id, prefix + name, value, unit, detail)
    }
  }

  measure(name: string, value: number | null, unit = '', detail?: unknown): void {
    this.work.measure(this.id, name, value, unit, detail)
  }

  finish(status: Exclude<RunStatus, 'running'>, summary: string, result: unknown): void {
    if (this.closed) return
    this.work.finish(this.id, status, summary.slice(0, 300), result)
    this.closed = true
    this.work.close()
  }

  /** Record a failure (the error's message as the summary) and close; returns the error for rethrowing. */
  fail(e: unknown): unknown {
    if (!this.closed) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.finish('error', msg, { error: msg })
      } catch {
        /* the record is best effort once the run has failed */
      }
    }
    return e
  }
}

/** An artifact of an earlier run. */
export function readArtifact(runId: string, name: string): Uint8Array {
  const w = new Work()
  try {
    const rec = w.run(runId)
    if (!rec) throw new ToolError(`no run ${JSON.stringify(runId)} in ${'the project database'}`)
    const data = w.getArtifact(runId, name)
    if (!data) {
      throw new ToolError(`run ${runId} has no artifact ${JSON.stringify(name)} (it has: ${rec.artifacts.map((a) => a.name).join(', ') || 'none'})`)
    }
    return data
  } finally {
    w.close()
  }
}

/** The names of a run's artifacts (ToolError when there is no such run). */
export function artifactNames(runId: string): string[] {
  const w = new Work()
  try {
    const rec = w.run(runId)
    if (!rec) throw new ToolError(`no run ${JSON.stringify(runId)} in the project database`)
    return rec.artifacts.map((a) => a.name)
  } finally {
    w.close()
  }
}

/** The run's capture: its only .vcd (or .csv) artifact. */
export function defaultCapture(runId: string): string {
  const names = artifactNames(runId)
  const vcd = names.filter((n) => /\.vcd$/i.test(n))
  if (vcd.length === 1) return vcd[0] as string
  const csv = names.filter((n) => /\.csv$/i.test(n))
  if (!vcd.length && csv.length === 1) return csv[0] as string
  throw new ToolError(`run ${runId}: give artifact (it has: ${names.join(', ') || 'none'})`)
}
