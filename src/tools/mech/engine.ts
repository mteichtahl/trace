/**
 * The enclosure engine (python/tracebridge/mech, docs/enclosure-build.md "The engine") run as a job of kind `cad`:
 *
 *   python -m tracebridge.mech run --facts facts.json --settings case.json --capabilities capabilities.json
 *     [--script case.py] [--case-file <file>.step] --out {dir}/out --formats step,stl,3mf
 *
 * The facts, the settings, the capabilities and the script or handed-in file are the job's inputs; result.json and the
 * files the engine writes are its outputs, by name (runJob brings back the ones that were written, so a 3MF the
 * engine skipped is simply absent). Where it runs (src/gpu/jobs.ts backendFor): on the tools function, whose image
 * has build123d in the venv first on PATH (`python3`); locally with TRACE_PYTHON (else python3) and PYTHONPATH at this
 * repository's python/ folder (TRACE_MECH_PYTHONPATH replaces that folder, for an engine checked out elsewhere).
 *
 * Exit 0 is a result (a failing fit included); exit 2 is bad input, with {"error"} in result.json; anything else is
 * a crash, reported with the end of stderr.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { type Backend, backendFor, type GpuJob, runJob } from '../../gpu/jobs.js'
import type { BoardFacts } from './board.js'
import { CAPABILITIES, engineCapabilities } from './capabilities.js'
import type { CaseSettings } from './settings.js'

/** This repository's Python folder (as src/core/bridge.ts finds it), from src/tools/mech or dist/tools/mech. */
export const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python')

export const FORMATS = ['step', 'stl', '3mf'] as const
export type Format = (typeof FORMATS)[number]

/** The case parts the engine writes files for: base and lid from a script, the one `case` from a handed-in STEP. */
export const partsFor = (source: CaseSettings['source']): string[] => (source === 'file' ? ['case'] : ['base', 'lid'])

/** Every file the engine may write for these settings, result.json last (what the job brings back). */
export function engineOutputs(source: CaseSettings['source'], formats: readonly Format[] = FORMATS): string[] {
  const out: string[] = []
  if (formats.includes('step')) out.push('case.step')
  for (const p of partsFor(source)) for (const f of FORMATS) if (formats.includes(f)) out.push(`case-${p}.${f}`)
  return [...out, 'fit.json', 'case.jsonld', 'result.json']
}

/** Every file name the engine can write, for clearing an old build out of mechanical/out. */
export const ALL_ENGINE_FILES = [...new Set([...engineOutputs('script'), ...engineOutputs('file')])]

export interface CaseInput {
  facts: BoardFacts
  settings: CaseSettings
  /** the case script (mechanical/case.py), when the case is scripted and the project has one */
  script?: string | null
  /** the handed-in STEP, when settings.source is "file" */
  caseFile?: string | null
  formats?: readonly Format[]
  timeoutSeconds?: number
}

/** The job runJob gets for a case: inputs staged from files in `dir`, argv, outputs, and where it runs. */
export function caseJob(input: CaseInput, dir: string, env: NodeJS.ProcessEnv = process.env): { job: GpuJob; where: Backend } {
  const formats = input.formats ?? FORMATS
  const files: Record<string, string> = {
    'facts.json': join(dir, 'facts.json'),
    'case.json': join(dir, 'case.json'),
    'capabilities.json': join(dir, 'capabilities.json'),
  }
  writeFileSync(files['facts.json'] as string, JSON.stringify(input.facts))
  writeFileSync(files['case.json'] as string, JSON.stringify(input.settings))
  writeFileSync(files['capabilities.json'] as string, JSON.stringify(engineCapabilities(CAPABILITIES)))
  const where = backendFor({ kind: 'cad' }, env)
  const python = where === 'local' ? env.TRACE_PYTHON || 'python3' : 'python3'
  const argv = [python, '-m', 'tracebridge.mech', 'run', '--facts', '{in:facts.json}', '--settings', '{in:case.json}', '--capabilities', '{in:capabilities.json}']
  if (input.settings.source === 'file') {
    if (!input.caseFile) throw new ToolError('the case is a handed-in file (source "file") but no file was given')
    const name = `handed-in${extname(input.caseFile).toLowerCase() || '.step'}`
    files[name] = input.caseFile
    argv.push('--case-file', `{in:${name}}`)
  } else if (input.script) {
    files['case.py'] = input.script
    argv.push('--script', '{in:case.py}')
  }
  argv.push('--out', '{dir}/out', '--formats', formats.join(','))
  const jobEnv: Record<string, string> = { PYTHONUNBUFFERED: '1' }
  if (where === 'local') jobEnv.PYTHONPATH = [env.TRACE_MECH_PYTHONPATH || PY_DIR, env.PYTHONPATH].filter(Boolean).join(':')
  return {
    // isolate: case.py is the project's own code; it runs with no credentials, and nothing it starts outlives the job
    job: { kind: 'cad', argv, inputs: files, outputs: engineOutputs(input.settings.source, formats), timeoutSeconds: input.timeoutSeconds ?? 600, env: jobEnv, isolate: true },
    where,
  }
}

/** result.json as the engine writes it (docs/enclosure-build.md); fields the TypeScript side reads are typed. */
export interface EngineResult {
  version: number
  seconds: number
  source: 'script' | 'file'
  board_sha256: string | null
  case: { parts: { name: string; volume_mm3: number; bbox_mm: [number, number, number] }[]; bbox_mm: [number, number, number] }
  fit: {
    status: 'pass' | 'fail'
    clashes: { ref: string; case_part: string; volume_mm3: number }[]
    gaps: { ref: string; where: string; measured_mm: number | null; required_mm: number; ok: boolean }[]
    openings: { ref: string; side: string; made: boolean }[]
    assumptions: { ref: string; height_mm: number; source: string }[]
    summary: string
  }
  rules: { rule: string; ok: boolean | null; detail: string; measured: unknown; limit: unknown; source: string | null; basis?: string }[]
  files: string[]
  records?: unknown
  notes?: string[]
  fasteners?: { ref: string; size: string; length_mm: number; pilot_d_mm: number }[]
}

export interface CaseRun {
  result: EngineResult
  /** output name → local path, for the files the engine wrote */
  outputs: Record<string, string>
  where: Backend
  seconds: number
  stderr: string
}

/** Build the case: stage, run the engine, read result.json. Throws ToolError for bad input or a crash. */
export async function runCase(input: CaseInput): Promise<CaseRun> {
  const dir = scratchDir('trace-mech-')
  try {
    const { job, where } = caseJob(input, dir)
    const r = await runJob(job)
    const resPath = r.outputs['result.json']
    const parsed = resPath && existsSync(resPath) ? safeJson(readFileSync(resPath, 'utf8')) : null
    if (r.exitCode === 2) throw new ToolError(`the enclosure engine refused its input: ${String((parsed as { error?: unknown } | null)?.error ?? tail(r.stderr))}`)
    if (r.exitCode !== 0 || !parsed || typeof parsed !== 'object' || !('fit' in parsed)) {
      const missing = /No module named '?(build123d|tracebridge[.\w]*)'?/.exec(r.stderr)
      if (missing) throw new ToolError(`the enclosure engine cannot run here: ${missing[0]} (${where === 'local' ? "pip install 'build123d==0.13.0' and the repository's python/ package, or set TRACE_PYTHON" : 'the tools image lacks it'})`)
      throw new ToolError(`the enclosure engine failed (exit ${r.exitCode}, ${where}): ${tail(r.stderr) || 'no result.json'}`)
    }
    return { result: parsed as EngineResult, outputs: r.outputs, where, seconds: r.seconds, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const tail = (s: string): string => s.trim().split('\n').slice(-12).join('\n').slice(-1500)
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Whether the engine can run where a cad job would now: on the tools function it is assumed (its image has it);
 * locally, whether TRACE_PYTHON (or python3) imports build123d and tracebridge.mech. The reason, when not.
 */
export function engineAvailable(env: NodeJS.ProcessEnv = process.env): { ok: boolean; where: Backend; why: string | null } {
  const where = backendFor({ kind: 'cad' }, env)
  if (where !== 'local') return { ok: true, where, why: null }
  const python = env.TRACE_PYTHON || 'python3'
  const r = spawnSync(python, ['-c', 'import build123d, tracebridge.mech'], {
    env: { ...env, PYTHONPATH: [env.TRACE_MECH_PYTHONPATH || PY_DIR, env.PYTHONPATH].filter(Boolean).join(':') }, encoding: 'utf8', timeout: 60_000,
  })
  if (r.status === 0) return { ok: true, where, why: null }
  const line = (r.stderr ?? '').trim().split('\n').pop() || (r.error ? r.error.message : `exit ${r.status}`)
  return { ok: false, where, why: `${python} cannot import build123d and tracebridge.mech (${line})` }
}
