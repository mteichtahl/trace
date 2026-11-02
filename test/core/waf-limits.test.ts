import { describe, expect, it } from 'vitest'
import { wafPer10Minutes } from '../../src/core/waf-limits.js'
import { InfraPropsSchema } from '../../src/infra/props.js'

describe('web.waf limits per 10 minutes', () => {
  it('reads the older 5-minute settings as twice as many, and their old defaults as the new defaults', () => {
    expect(wafPer10Minutes({ enabled: true, apiRequestsPer5Minutes: 3000, authRequestsPer5Minutes: 50 })).toEqual({ enabled: true, apiRequestsPer10Minutes: 6000, authRequestsPer10Minutes: 100 })
    expect(wafPer10Minutes({ apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 })).toEqual({})
    expect(wafPer10Minutes({ apiRequestsPer5Minutes: 3000, apiRequestsPer10Minutes: 7000 })).toEqual({ apiRequestsPer10Minutes: 7000 })
  })

  it('defaults to 10,000 API and 200 sign-in requests per address in 10 minutes, old saved settings included', () => {
    const base = { account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/trace'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com' }
    expect(InfraPropsSchema.parse(base).web.waf).toMatchObject({ apiRequestsPer10Minutes: 10_000, authRequestsPer10Minutes: 200 })
    expect(InfraPropsSchema.parse({ ...base, web: { waf: { apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 } } }).web.waf).toMatchObject({ apiRequestsPer10Minutes: 10_000, authRequestsPer10Minutes: 200 })
  })
})
