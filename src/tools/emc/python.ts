/**
 * The Python side of the EMC tools: which interpreter has openEMS/CSXCAD (and scikit-rf), and the TRACE_RESULT line
 * protocol the scripts in python/emc use (the last `TRACE_RESULT {json}` line of stdout).
 *
 *   TRACE_OPENEMS_PYTHON   the interpreter with the openEMS and CSXCAD modules (default: openems-python on PATH, as
 *                          the GPU image installs it, else python3)
 *   TRACE_PYTHON           the interpreter for emc.si (scikit-rf, numpy); default python3
 */
import { ToolError } from '../../core/registry.js'
import { run, which } from '../../sim/proc.js'

export function openemsPython(): string {
  return process.env.TRACE_OPENEMS_PYTHON || which('openems-python') || 'python3'
}

export function siPython(): string {
  return process.env.TRACE_PYTHON || process.env.TRACE_OPENEMS_PYTHON || 'python3'
}

const memo = new Map<string, boolean>()

/** Whether `python` can import every module in `mods` (cached per process). */
export async function canImport(python: string, mods: readonly string[]): Promise<boolean> {
  const key = `${python}|${mods.join(',')}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  let ok = false
  try {
    const r = await run(python, ['-c', mods.map((m) => `import ${m}`).join('; ')], { timeoutMs: 60_000 })
    ok = r.code === 0
  } catch {
    ok = false
  }
  memo.set(key, ok)
  return ok
}

export const RESULT_PREFIX = 'TRACE_RESULT '

export function resultLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] as string).trim()
    if (!l.startsWith(RESULT_PREFIX)) continue
    try {
      const v = JSON.parse(l.slice(RESULT_PREFIX.length)) as unknown
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      throw new ToolError(`a malformed result line: ${l.slice(0, 200)}`)
    }
  }
  return null
}

/** The script's result, or a ToolError with the script's own error or the tail of its output. */
export function expectResult(stdout: string, stderr: string, what: string): Record<string, unknown> {
  const r = resultLine(stdout)
  if (!r) throw new ToolError(`${what} printed no result:\n${(stderr + '\n' + stdout).trim().split('\n').slice(-12).join('\n')}`)
  if (r.ok !== true) throw new ToolError(`${what}: ${String(r.error ?? 'failed')}`)
  return r
}

/** openEMS's own throughput figure, from its log ("Speed: 123.45 MCells/s" or "... MC/s"), when it printed one. */
export function openemsSpeed(log: string): number | null {
  const all = [...log.matchAll(/Speed:\s*([\d.]+)\s*MC(?:ells)?\/s/gi)].map((m) => Number(m[1]))
  return all.length ? (all[all.length - 1] as number) : null
}

/** What openEMS's log says about each run: timesteps, and whether the energy end criterion was met. */
export function openemsRuns(log: string): { timesteps: number[]; endCriterionMet: boolean[] } {
  const timesteps = [...log.matchAll(/Time for (\d+) iterations/g)].map((m) => Number(m[1]))
  const runs = log.split(/Create FDTD operator/).slice(1)
  return { timesteps, endCriterionMet: runs.map((r) => /end-criteria of [-\d.]+dB reached/.test(r)) }
}
