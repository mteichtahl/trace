import { describe, expect, it } from 'vitest'
import { missing } from './layout'
import { wafLine } from '@/routes/_app/admin/installation'

describe('what a flat installation lacks, in words', () => {
  it('names each missing piece, and nothing for nested', () => {
    expect(missing({ has: { knowledgeBase: false, cpuQueue: false, answerEvents: false } })).toEqual([
      'a knowledge base per project', 'the CPU queue for heavy simulations', 'agents told at once when you answer their question',
    ])
    expect(missing({ has: { knowledgeBase: true, cpuQueue: true, answerEvents: true } })).toEqual([])
  })
})

describe('the WAF health line', () => {
  it('says on with its limits, off with what to do and the cost, and not reported for an older install', () => {
    expect(wafLine({ enabled: true, own: false, apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 })).toMatchObject({ status: 'verified', word: 'On', detail: expect.stringMatching(/1,000 requests to the API and 100 sign-in requests per address in 5 minutes/) })
    expect(wafLine({ enabled: true, own: true, apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 }).detail).toMatch(/Your own web ACL/)
    expect(wafLine({ enabled: false, own: false, apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 })).toMatchObject({ word: 'Off', todo: expect.stringMatching(/Protect the app with AWS WAF.*US\$11 a month/) })
    expect(wafLine(undefined)).toMatchObject({ word: 'Not reported' })
  })
})

describe('the API\'s real answer (api-answers.json)', () => {
  it('has the shape the screens read', async () => {
    const answers = (await import('@/lib/api-answers.json')).default as Record<string, { result: unknown }>
    const v = answers['installation.layout']!.result as import('./layout').LayoutView
    expect(v.layout).toBe('flat')
    expect(missing(v)).toHaveLength(3)
    expect(v.move?.steps).toHaveLength(3)
    expect(typeof v.projects.updateMax).toBe('number')
  })
})
