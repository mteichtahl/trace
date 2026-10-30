/**
 * The enclosure engine (python/tracebridge/mech, docs/enclosure-build.md "The engine" and "Trust") run as jobs of two
 * kinds (src/gpu/jobs.ts):
 *
 *   cad-script  the case script, when mechanical/case.py differs from the packaged template (its sha256 against
 *               python/tracebridge/mech/templates/printed-shell.py): user code, on the project's cad function or in a
 *               local child process, never on the tools function
 *                 python -m tracebridge.mech build-only --facts facts.json --settings settings.json
 *                   --capabilities capabilities.json --script case.py --out {dir}/out
 *               out: part-1.step … part-N.step and claims.json (CAD_SCRIPT_OUTPUTS); exit 2 with claims.json
 *               {"error"} is the script's own failure
 *   cad         trace's code: the built-in template in-process (case.py absent or the template byte for byte), the
 *               parts a cad-script job built (--built), or a handed-in STEP; then the fit, the rules, the files
 *                 python -m tracebridge.mech run --facts facts.json --settings case.json --capabilities capabilities.json
 *                   [--built {dir}/in/built | --case-file <file>.step] --out {dir}/out --formats step,stl,3mf
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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { type Backend, CAD_SCRIPT_OUTPUTS, backendFor, type GpuJob, type JobResult, runJob } from '../../gpu/jobs.js'
import type { BoardFacts } from './board.js'
import { CAPABILITIES, engineCapabilities } from './capabilities.js'
import type { CaseSettings } from './settings.js'

/** This repository's Python folder (as src/core/bridge.ts finds it), from src/tools/mech or dist/tools/mech. */
export const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python')

/** The engine's Python folder: TRACE_MECH_PYTHONPATH when set (an engine checked out elsewhere), else PY_DIR. */
export const pyDir = (env: NodeJS.ProcessEnv = process.env): string => env.TRACE_MECH_PYTHONPATH || PY_DIR

/** The packaged case template (what mech.init writes), as the engine ships it. */
export const templatePath = (env: NodeJS.ProcessEnv = process.env): string => join(pyDir(env), 'tracebridge', 'mech', 'templates', 'printed-shell.py')

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/**
 * Whether a case script is the packaged template byte for byte (docs/enclosure-build.md "Trust"): then no script
 * runs anywhere, and the engine builds its own template in-process. A missing template file counts as "not the
 * template" (the script runs as user code: the safe side).
 */
export function scriptIsTemplate(script: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const t = templatePath(env)
  if (!existsSync(script) || !existsSync(t)) return false
  return sha256(readFileSync(script)) === sha256(readFileSync(t))
}

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

/** The three files every engine job gets, written into `dir`. */
function commonInputs(input: CaseInput, dir: string, settingsName: string): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {
    'facts.json': join(dir, 'facts.json'),
    [settingsName]: join(dir, settingsName),
    'capabilities.json': join(dir, 'capabilities.json'),
  }
  writeFileSync(files['facts.json'] as string, JSON.stringify(input.facts))
  writeFileSync(files[settingsName] as string, JSON.stringify(input.settings))
  writeFileSync(files['capabilities.json'] as string, JSON.stringify(engineCapabilities(CAPABILITIES)))
  return files
}

/** The program and its environment where a job of `kind` runs: the venv's python3 on a function, else TRACE_PYTHON. */
function pythonFor(kind: 'cad' | 'cad-script', env: NodeJS.ProcessEnv): { where: Backend; python: string; jobEnv: Record<string, string> } {
  const where = backendFor({ kind }, env)
  const python = where === 'local' ? env.TRACE_PYTHON || 'python3' : 'python3'
  const jobEnv: Record<string, string> = { PYTHONUNBUFFERED: '1' }
  if (where === 'local') jobEnv.PYTHONPATH = [pyDir(env), env.PYTHONPATH].filter(Boolean).join(':')
  return { where, python, jobEnv }
}

/**
 * The `cad-script` job for a custom case script: the facts, the raw settings and the capabilities in, the script's
 * parts and claims out (CAD_SCRIPT_OUTPUTS). On the cad function or locally (src/gpu/jobs.ts backendFor).
 */
export function scriptJob(input: CaseInput & { script: string }, dir: string, env: NodeJS.ProcessEnv = process.env): { job: GpuJob; where: Backend } {
  const files = commonInputs(input, dir, 'settings.json')
  files['case.py'] = input.script
  const { where, python, jobEnv } = pythonFor('cad-script', env)
  const argv = [python, '-m', 'tracebridge.mech', 'build-only', '--facts', '{in:facts.json}', '--settings', '{in:settings.json}', '--capabilities', '{in:capabilities.json}', '--script', '{in:case.py}', '--out', '{dir}/out']
  return {
    // isolate: the script is the project's own code; it runs with no credentials, and nothing it starts outlives the job
    job: { kind: 'cad-script', argv, inputs: files, outputs: [...CAD_SCRIPT_OUTPUTS], timeoutSeconds: input.timeoutSeconds ?? 600, env: jobEnv, isolate: true },
    where,
  }
}

/**
 * The `cad` job runJob gets for a case: inputs staged from files in `dir`, argv, outputs, and where it runs. With
 * `built` (output name → local path, what a scriptJob handed back) the parts go in under built/ and the engine reads
 * them with --built, running no script; without it the engine builds its own template, or imports the handed-in file.
 */
export function caseJob(input: CaseInput, dir: string, env: NodeJS.ProcessEnv = process.env, built?: Record<string, string>): { job: GpuJob; where: Backend } {
  const formats = input.formats ?? FORMATS
  const files = commonInputs(input, dir, 'case.json')
  const { where, python, jobEnv } = pythonFor('cad', env)
  const argv = [python, '-m', 'tracebridge.mech', 'run', '--facts', '{in:facts.json}', '--settings', '{in:case.json}', '--capabilities', '{in:capabilities.json}']
  if (input.settings.source === 'file') {
    if (!input.caseFile) throw new ToolError('the case is a handed-in file (source "file") but no file was given')
    const name = `handed-in${extname(input.caseFile).toLowerCase() || '.step'}`
    files[name] = input.caseFile
    argv.push('--case-file', `{in:${name}}`)
  } else if (built) {
    for (const [name, path] of Object.entries(built)) files[`built/${name}`] = path
    argv.push('--built', '{dir}/in/built')
  }
  argv.push('--out', '{dir}/out', '--formats', formats.join(','))
  return {
    // isolate all the same (no credentials, its own process group): tidiness on the tools function, not the boundary
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

/** One stage of a build: which job kind ran, where, how long, and the job id where it ran remotely. */
export interface BuildStage { kind: 'cad-script' | 'cad'; where: Backend; seconds: number; job_id?: string }

export interface CaseRun {
  result: EngineResult
  /** output name → local path, for the files the engine wrote */
  outputs: Record<string, string>
  /** where the check (the `cad` job) ran */
  where: Backend
  seconds: number
  stderr: string
  /** the jobs this build ran, in order: a `cad-script` job for a custom script, then the `cad` job */
  stages: BuildStage[]
}

const stageOf = (kind: BuildStage['kind'], r: JobResult): BuildStage => ({ kind, where: r.where, seconds: r.seconds, ...(r.jobId ? { job_id: r.jobId } : {}) })

/** The "cannot run here" message when the engine's Python lacks build123d or tracebridge.mech, else null. */
function missingModule(stderr: string, where: Backend): string | null {
  const missing = /No module named '?(build123d|tracebridge[.\w]*)'?/.exec(stderr)
  if (!missing) return null
  return `the enclosure engine cannot run here: ${missing[0]} (${where === 'local' ? "pip install 'build123d==0.13.0' and the repository's python/ package, or set TRACE_PYTHON" : 'the tools image lacks it'})`
}

/**
 * Run a custom case script as a `cad-script` job: its parts and claims (output name → local path) for the `cad` job.
 * Exit 2 is the script's own failure, named from claims.json; anything else but 0 is a crash.
 */
async function runScript(input: CaseInput & { script: string }, dir: string): Promise<{ built: Record<string, string>; stage: BuildStage }> {
  const { job, where } = scriptJob(input, dir)
  const r = await runJob(job)
  const claimsPath = r.outputs['claims.json']
  const claims = claimsPath && existsSync(claimsPath) ? safeJson(readFileSync(claimsPath, 'utf8')) as { error?: unknown } | null : null
  if (r.exitCode === 2) throw new ToolError(`the case script (mechanical/case.py) failed: ${String(claims?.error ?? tail(r.stderr) ?? 'no claims written')}`)
  if (r.exitCode !== 0) {
    const m = missingModule(r.stderr, where)
    if (m) throw new ToolError(m)
    throw new ToolError(`the case script's process failed (exit ${r.exitCode}, ${where}): ${tail(r.stderr) || 'no output'}`)
  }
  if (!claimsPath) throw new ToolError(`the case script's process exited 0 but wrote no claims.json (${where})`)
  return { built: r.outputs, stage: stageOf('cad-script', r) }
}

/**
 * Build the case: stage, run the engine, read result.json. Throws ToolError for bad input or a crash. A case script
 * that is not the packaged template runs first, as its own job (docs/enclosure-build.md "Trust"); the `cad` job then
 * checks what it built.
 */
export async function runCase(input: CaseInput): Promise<CaseRun> {
  const dir = scratchDir('trace-mech-')
  try {
    const stages: BuildStage[] = []
    let built: Record<string, string> | undefined
    if (input.settings.source !== 'file' && input.script && !scriptIsTemplate(input.script)) {
      const s = await runScript({ ...input, script: input.script }, join(dir, 'script'))
      built = s.built
      stages.push(s.stage)
    }
    const { job, where } = caseJob(input, join(dir, 'case'), process.env, built)
    const r = await runJob(job)
    stages.push(stageOf('cad', r))
    const resPath = r.outputs['result.json']
    const parsed = resPath && existsSync(resPath) ? safeJson(readFileSync(resPath, 'utf8')) : null
    if (r.exitCode === 2) throw new ToolError(`the enclosure engine refused its input: ${String((parsed as { error?: unknown } | null)?.error ?? tail(r.stderr))}`)
    if (r.exitCode !== 0 || !parsed || typeof parsed !== 'object' || !('fit' in parsed)) {
      const m = missingModule(r.stderr, where)
      if (m) throw new ToolError(m)
      throw new ToolError(`the enclosure engine failed (exit ${r.exitCode}, ${where}): ${tail(r.stderr) || 'no result.json'}`)
    }
    return { result: parsed as EngineResult, outputs: r.outputs, where, seconds: stages.reduce((a, s) => a + s.seconds, 0), stderr: r.stderr, stages }
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
    env: { ...env, PYTHONPATH: [pyDir(env), env.PYTHONPATH].filter(Boolean).join(':') }, encoding: 'utf8', timeout: 60_000,
  })
  if (r.status === 0) return { ok: true, where, why: null }
  const line = (r.stderr ?? '').trim().split('\n').pop() || (r.error ? r.error.message : `exit ${r.status}`)
  return { ok: false, where, why: `${python} cannot import build123d and tracebridge.mech (${line})` }
}

/**
 * Why `tracectl check` does not build the case here, or null when it does. mechanical/case.py is code
 * (docs/enclosure-build.md "Trust"): in CI (GITHUB_ACTIONS or CI set) the case is built only when the workflow says so
 * with TRACE_CHECK_MECH=1, which templates/build/kicad.yml does for pushes and for pull requests from the repository
 * itself, never for a fork's; unset in CI, it is skipped (fail closed). On a laptop unset builds, and 0/false/no skips.
 * TRACE_CHECK_MECH_WHY, when given, is the reason printed.
 */
export function mechSkipReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.TRACE_CHECK_MECH ?? '').trim().toLowerCase()
  const why = env.TRACE_CHECK_MECH_WHY?.trim()
  if (['0', 'false', 'no'].includes(v)) return why || 'TRACE_CHECK_MECH=0, no case script is run'
  const ci = !!(env.GITHUB_ACTIONS?.trim() || env.CI?.trim())
  if (ci && !['1', 'true', 'yes'].includes(v)) return why || 'TRACE_CHECK_MECH is not set in CI'
  return null
}
