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
import { Work, type RunStatus } from '../core/store.js'

export interface Rec {
  readonly id: string
  measure(name: string, value: number | null, unit?: string, detail?: unknown): void
  artifact(name: string, data: string | Uint8Array, mime?: string): void
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
  try {
    const id = work.start(kind, { subject: opts.subject, args: opts.args })
    const rec: Rec = {
      id,
      measure: (name, value, unit = '', detail) => work.measure(id, name, value !== null && Number.isFinite(value) ? value : null, unit, detail),
      // SQLite binds an empty blob as NULL, and an empty artifact says nothing: leave it out
      artifact: (name, data, mime) => { if (data.length) work.artifact(id, name, data, mime) },
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
    return result
  } finally {
    work.close()
  }
}
