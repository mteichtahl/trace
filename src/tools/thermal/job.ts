/**
 * The 2.5D board model as a CPU job (runJob kind thermal), for grids too big to solve inside the caller (an agent
 * session): the board file and the run's inputs go in one SQLite file, the job runs runBoard where it lands, and the
 * temperatures and the summary come back in another. Data stays in SQLite end to end (no JSON or YAML files).
 *
 *   node dist/tools/thermal/job.js <job.db> <result.db>
 *
 * The job image runs /app/dist/tools/thermal/job.js (TRACE_THERMAL_JOB_ENTRY overrides it).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolError } from '../../core/registry.js'
import { open, scratchDir } from '../../core/store.js'
import { type Backend, backendFor, runJob } from '../../gpu/jobs.js'
import type { Environment } from './convection.js'
import { type BoardInput, type BoardRun, runBoard } from './model.js'
import { rasterise } from './raster.js'

const SCHEMA = 'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, text TEXT, bytes BLOB)'

export interface JobArgs { environment: Environment; power: Record<string, number>; cell_mm: number; samples?: number; transient?: { duration_s: number; dt_s: number }; laminate?: BoardInput['laminate']; heatsinks?: BoardInput['heatsinks']; plating_m?: number }

export function writeJob(path: string, boardText: string, a: JobArgs): void {
  const db = open(path, { wal: false })
  try {
    db.exec(SCHEMA)
    db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run('args', JSON.stringify(a), null)
    db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run('board', boardText, null)
  } finally {
    db.close()
  }
}

function readKv(path: string): Map<string, { text: string | null; bytes: Uint8Array | null }> {
  const db = open(path, { readonly: true })
  try {
    return new Map(db.prepare('SELECT k, text, bytes FROM kv').all().map((r) => [String(r.k), { text: r.text === null ? null : String(r.text), bytes: (r.bytes as Uint8Array | null) ?? null }]))
  } finally {
    db.close()
  }
}

/** Run a job file into a result file. */
export async function main(jobPath: string, resultPath: string): Promise<void> {
  const kv = readKv(jobPath)
  const a = JSON.parse(kv.get('args')?.text ?? 'null') as JobArgs
  const dir = scratchDir('trace-thermal-job-')
  try {
    const board = join(dir, 'board.kicad_pcb')
    writeFileSync(board, kv.get('board')?.text ?? '')
    const run = await runBoard({ board, ...a, power: new Map(Object.entries(a.power)) })
    const db = open(resultPath, { wal: false })
    try {
      db.exec(SCHEMA)
      const { model: _m, solution, ...rest } = run
      const { T, ...sol } = solution
      db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run('run', JSON.stringify({ ...rest, solution: sol }), null)
      db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run('T', null, new Uint8Array(T.buffer, T.byteOffset, T.byteLength))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Read a result file back into a BoardRun, with the model rasterised again here from the same inputs. */
export function readResult(resultPath: string, boardPath: string, a: JobArgs): BoardRun {
  const kv = readKv(resultPath)
  const run = JSON.parse(kv.get('run')?.text ?? 'null') as Omit<BoardRun, 'model' | 'solution'> & { solution: Omit<BoardRun['solution'], 'T'> }
  const bytes = kv.get('T')?.bytes
  if (!run || !bytes) throw new ToolError('the thermal job wrote no result')
  const T = new Float64Array(new Uint8Array(bytes).buffer)
  const model = rasterise(boardPath, { ...a, power: new Map(Object.entries(a.power)), emissivity: a.environment.emissivity }).model
  return { ...run, model, solution: { ...run.solution, T } }
}

export const localMaxCells = (): number => Number(process.env.TRACE_THERMAL_LOCAL_MAX_CELLS ?? 400_000)

/** runBoard here, or on the CPU queue when the grid is larger than TRACE_THERMAL_LOCAL_MAX_CELLS and a queue is set. */
export async function runBoardWhere(i: BoardInput, cells: number, mode: 'auto' | 'always' | 'never' = 'auto'): Promise<BoardRun & { where: Backend }> {
  const remote = mode === 'always' || (mode === 'auto' && cells > localMaxCells())
  if (mode === 'never' || backendFor({ gpu: false, remote }) === 'local') return { ...(await runBoard(i)), where: 'local' }
  const dir = scratchDir('trace-thermal-')
  try {
    const a: JobArgs = { environment: i.environment, power: Object.fromEntries(i.power), cell_mm: i.cell_mm, ...(i.samples ? { samples: i.samples } : {}), ...(i.transient ? { transient: i.transient } : {}), ...(i.laminate ? { laminate: i.laminate } : {}), ...(i.heatsinks ? { heatsinks: i.heatsinks } : {}), ...(i.plating_m ? { plating_m: i.plating_m } : {}) }
    const job = join(dir, 'job.db')
    writeJob(job, readFileSync(i.board, 'utf8'), a)
    const entry = process.env.TRACE_THERMAL_JOB_ENTRY ?? '/app/dist/tools/thermal/job.js'
    const r = await runJob({ kind: 'thermal', gpu: false, remote: true, argv: ['node', entry, '{in:job.db}', '{out:result.db}'], inputs: { 'job.db': job }, outputs: ['result.db'], timeoutSeconds: 7200 })
    if (r.exitCode !== 0 || !r.outputs['result.db']) throw new ToolError(`the thermal job failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-400)}`)
    const out = readResult(r.outputs['result.db'], i.board, a)
    rmSync(r.outputs['result.db'], { force: true })
    return { ...out, where: r.where }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , job, result] = process.argv
  if (!job || !result) { process.stderr.write('usage: node job.js <job.db> <result.db>\n'); process.exit(2) }
  main(job, result).then(() => process.exit(0), (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1) })
}
