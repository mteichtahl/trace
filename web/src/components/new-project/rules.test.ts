import { describe, expect, it } from 'vitest'
import type { NewProjectDraft } from '@/lib/types-s1'
import { checks, partsFor, recommendTemplate, slug, stepOk } from './rules'

const d: NewProjectDraft = {
  name: 'Soil sensor 2', description: '', icon: { glyph: 'sensor', colour: 'green' }, start: 'idea', template: 'board',
  repository: { mode: 'new', owner: 'acme', name: 'soil-sensor-2', branch: 'main' },
  advanced: { ownToken: false, memoryDays: 30, onboardingPr: true, applySettings: true }, people: [],
  build: { quantity: 10, later: { certify: false, produce: false, sustain: false }, fab: 'JLCPCB' },
}

describe('New project', () => {
  it('can be made with a name and five Continues: every step passes on its defaults', () => {
    for (const s of ['about', 'start', 'repository', 'people', 'build', 'review'] as const) expect(stepOk(d, s, { taken: ['Soil sensor'] })).toBe(true)
  })
  it('refuses a name another project uses', () => expect(stepOk({ ...d, name: 'soil sensor' }, 'about', { taken: ['Soil sensor'] })).toBe(false))
  it('wants a description to be a full sentence', () => expect(checks({ ...d, description: 'a sensor' }, { taken: [] }).find((c) => c.id === 'desc')!.ok).toBe(false))
  it('locks a Guest to Reviewer and leaves admins out of the choice', () => {
    expect(partsFor('guest')).toEqual(['reviewer'])
    expect(partsFor('user')).toEqual(['contributor', 'reviewer'])
    expect(partsFor('admin')).toEqual([])
    expect(stepOk({ ...d, people: [{ who: 't', email: 't@x', class: 'guest', part: 'contributor', notify: 'normal' }] }, 'people', { taken: [] })).toBe(false)
  })
  it('recommends a template with why', () => {
    expect(recommendTemplate('LoRa sensor with an STM32', 'idea').template).toBe('board')
    expect(recommendTemplate('FPGA panel controller with MCU firmware', 'idea').template).toBe('mixed')
  })
  it('names the repository from the project', () => expect(slug('Soil sensor 2!')).toBe('soil-sensor-2'))
})
