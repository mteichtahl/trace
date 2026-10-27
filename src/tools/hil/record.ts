/**
 * Recording a hardware session or firmware run in the project's database (.trace/project.db).
 *
 * Every bench action (a serial exchange, a CAN capture, a scope waveform, a PSU set-point, a DMM reading) and every
 * firmware step (build, size, flash, log capture) becomes one row in `runs`, with its readings in `measurements` and
 * its logs, transcripts and waveforms as blobs in `artifacts`. Nothing is left on disk. The caller gets the run id
 * back (`run_id` in every result) and reads the details later with trace.run / trace.artifact.
 *
 *   return record('hil.scope_capture', { subject: 'bench-scope', args }, async (rec) => {
 *     rec.artifact('CH1.csv', csv)
 *     rec.measure('CH1.vpp', 3.28, 'V')
 *     return { status: 'pass', summary: 'CH1 1200 points', result: { ... } }
 *   })
 *
 * A throw inside the body finishes the run as `error` (with the message as its summary) and is re-thrown.
 */
import { type BringupStep, type InstrumentId, type Reading, insertIds, insertReadings, mirrorBench, newReading } from '../../core/bench.js'
import { Work, type RunStatus } from '../../core/store.js'

/** A measurement taken for a bring-up step (the tools' `bringup` argument): which board, which step, its limits. */
export interface BringupTag { board: string; step: BringupStep; quantity?: string | undefined; min?: number | undefined; max?: number | undefined; by?: string | undefined }

export interface Rec {
  readonly id: string
  measure(name: string, value: number | null, unit?: string, detail?: unknown): void
  artifact(name: string, data: string | Uint8Array, mime?: string): void
  /**
   * Store a reading against a board and bring-up step (src/core/bench.ts), in the run record beside this run, and
   * after the run in the project's live copy when the session reaches it. Returns it, with pass or fail.
   */
  reading(tag: BringupTag, r: { instrument: string | null; quantity: string; value: number | null; unit: string | null }): Reading
  /** Store an instrument's identity (hil.idn), the same way. */
  identity(id: Omit<InstrumentId, 'at' | 'runId'>): void
}

export interface Outcome<R> {
  status: Exclude<RunStatus, 'running'>
  summary: string
  result: R
}

export async function record<R extends object>(
  kind: string,
  opts: { subject?: string; args?: unknown },
  body: (rec: Rec) => Promise<Outcome<R>>,
): Promise<R & { run_id: string }> {
  const work = new Work()
  const readings: Reading[] = []
  const ids: InstrumentId[] = []
  try {
    const id = work.start(kind, { subject: opts.subject, args: opts.args })
    const rec: Rec = {
      id,
      measure: (name, value, unit = '', detail) => work.measure(id, name, value !== null && Number.isFinite(value) ? value : null, unit, detail),
      // SQLite binds an empty blob as NULL, and an empty artifact says nothing: leave it out
      artifact: (name, data, mime) => { if (data.length) work.artifact(id, name, data, mime) },
      reading: (tag, r) => {
        const row = newReading({
          board: tag.board, step: tag.step, instrument: r.instrument, quantity: tag.quantity ?? r.quantity, value: r.value !== null && Number.isFinite(r.value) ? r.value : null,
          unit: r.unit, min: tag.min ?? null, max: tag.max ?? null, by: tag.by ?? (process.env.TRACE_AGENT_LABEL || process.env.TRACE_AGENT || 'a person at the bench'), runId: id,
        })
        insertReadings(work.db, [row])
        readings.push(row)
        return row
      },
      identity: (x) => {
        const row = { ...x, at: Date.now() / 1000, runId: id }
        insertIds(work.db, [row])
        ids.push(row)
      },
    }
    let out: Outcome<R>
    try {
      out = await body(rec)
    } catch (e) {
      const msg = e instanceof Error ? `${e.name === 'ToolError' ? '' : `${e.name}: `}${e.message}` : String(e)
      work.finish(id, 'error', msg.slice(0, 300))
      throw e
    }
    const result = { ...out.result, run_id: id }
    work.finish(id, out.status, out.summary, result)
    if (readings.length || ids.length) await mirrorBench({ readings, ids })
    return result
  } finally {
    work.close()
  }
}
