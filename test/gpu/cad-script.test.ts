/**
 * The case script's own job kind (docs/enclosure-build.md "Trust"): `cad-script` runs the project's case script on the
 * cad function (TRACE_CAD_FUNCTION) or locally, never on the queue or the tools function, and `cad` (trace's code) runs
 * as before. Here: where each kind runs, the defaults, and the outputs a script job hands back.
 */
import { describe, expect, it } from 'vitest'
import { CAD_SCRIPT_OUTPUTS, FUNCTION_KINDS, GpuJobSchema, ISOLATED_KINDS, NO_CAD_FUNCTION, backendFor, runJob } from '../../src/gpu/jobs.js'

describe('the cad-script job kind', () => {
  const at = (e: Record<string, string>, j: Parameters<typeof backendFor>[0]) => backendFor(j, { TRACE_GPU: '0', ...e })

  it('is not one the tools function runs, and is isolated by default, as cad is', () => {
    expect(FUNCTION_KINDS.has('cad-script')).toBe(false)
    expect(FUNCTION_KINDS.has('cad')).toBe(true)
    expect(ISOLATED_KINDS.has('cad-script')).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'] }).isolate).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad', argv: ['x'] }).isolate).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'], isolate: false }).isolate).toBe(false)
  })

  it('runs on the cad function when the project has one, else here; never the queue or the tools function', () => {
    expect(at({ TRACE_CAD_FUNCTION: 'trace-cad-x', TRACE_TOOLS_FUNCTION: 'trace-tools-x' }, { kind: 'cad-script' })).toBe('function')
    expect(at({ TRACE_CAD_FUNCTION: 'trace-cad-x' }, { kind: 'cad-script' })).toBe('function')
    // the tools function alone does not take it: it holds credentials
    expect(at({ TRACE_TOOLS_FUNCTION: 'trace-tools-x' }, { kind: 'cad-script' })).toBe('local')
    expect(at({}, { kind: 'cad-script' })).toBe('local')
    // no queue, whatever the settings say
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_GPU_REMOTE: 'always' }, { kind: 'cad-script' })).toBe('local')
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_TOOLS_ELSEWHERE: '1' }, { kind: 'cad-script' })).toBe('local')
    expect(at({ TRACE_GPU_QUEUE: 'q' }, { kind: 'cad-script', remote: true })).toBe('local')
    expect(at({ TRACE_CAD_FUNCTION: 'f', TRACE_GPU_REMOTE: 'never' }, { kind: 'cad-script' })).toBe('local')
    // cad is unchanged: the tools function, or the queue from the agent image
    expect(at({ TRACE_TOOLS_FUNCTION: 'trace-tools-x', TRACE_CAD_FUNCTION: 'trace-cad-x' }, { kind: 'cad' })).toBe('function')
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_TOOLS_ELSEWHERE: '1' }, { kind: 'cad' })).toBe('batch')
  })

  it('refuses to run on the agent image without a cad function (the flat layout), saying where a script builds', async () => {
    const saved = { ...process.env }
    try {
      process.env.TRACE_TOOLS_ELSEWHERE = '1'
      process.env.TRACE_GPU_QUEUE = 'q'
      delete process.env.TRACE_CAD_FUNCTION
      await expect(runJob({ kind: 'cad-script', argv: ['true'], timeoutSeconds: 10 })).rejects.toThrow(NO_CAD_FUNCTION)
      expect(NO_CAD_FUNCTION).toMatch(/cad function \(nested layout\) or on a laptop/)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it('hands back one STEP per part and claims.json', () => {
    expect(CAD_SCRIPT_OUTPUTS.at(-1)).toBe('claims.json')
    expect(CAD_SCRIPT_OUTPUTS).toContain('part-0.step')
    expect(CAD_SCRIPT_OUTPUTS).toContain('part-1.step')
    expect(CAD_SCRIPT_OUTPUTS).toContain('part-16.step')
    expect(CAD_SCRIPT_OUTPUTS.filter((n) => n.endsWith('.step'))).toHaveLength(17)
    // names the remote spec and the staging accept
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'], outputs: [...CAD_SCRIPT_OUTPUTS] }).outputs).toHaveLength(18)
  })
})
