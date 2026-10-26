/** Without an OpenTelemetry SDK (local runs, the CLI, every other test file) telemetry is a no-op and changes nothing. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { claudeTelemetry } from '../../src/agent/observe.js'
import { Registry, ToolError, defineTool } from '../../src/core/registry.js'
import { childNodeArgs, enabled, flush, recordMetric, span, startSdkIfConfigured, traceEnv, withSession } from '../../src/core/telemetry.js'

describe('telemetry without an SDK', () => {
  it('records nothing and gets out of the way', async () => {
    expect(enabled()).toBe(false)
    expect(await span('x', {}, async () => 42)).toBe(42)
    await expect(span('x', {}, async () => { throw new ToolError('no') })).rejects.toThrow('no')
    expect(withSession('s-1', () => traceEnv())).toEqual({})
    recordMetric('trace.jobs', 1, { 'trace.outcome': 'ok' })
    await flush(100)
  })

  it('leaves tool calls and their errors exactly as they were', async () => {
    const r = new Registry([defineTool({ name: 'calc.add', description: 'add', input: z.object({ a: z.number(), b: z.number() }), run: ({ a, b }) => a + b })])
    expect(await r.call('calc.add', { a: 1, b: 2 }, { hardware: false, via: 'test' })).toBe(3)
    await expect(r.call('calc.add', { a: 'x' }, { hardware: false, via: 'test' })).rejects.toBeInstanceOf(ToolError)
    await expect(r.call('calc.nope', {}, { hardware: false, via: 'test' })).rejects.toThrow(/no tool/)
  })

  it('starts no child SDK and no exporter, even with AgentCore observability switched on', async () => {
    expect(await childNodeArgs({ AGENT_OBSERVABILITY_ENABLED: 'true' })).toEqual([])
    expect(await startSdkIfConfigured({})).toBe(false)
    expect(await startSdkIfConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false)
    const t = await claudeTelemetry({ model: 'm' })
    expect(t.env).toEqual({})
    expect(t.nodeArgs).toEqual([])
    t.observe({ type: 'result', subtype: 'success', modelUsage: {} })
    t.end({ aborted: false })
  })
})
