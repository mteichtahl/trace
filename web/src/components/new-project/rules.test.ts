import { describe, expect, it } from 'vitest'
import type { NewProjectDraft } from '@/lib/types-s1'
import { type RepoCheck, checks, partsFor, recommendTemplate, repoOk, slug, stepOk } from './rules'

const d: NewProjectDraft = {
  name: 'Soil sensor 2', description: '', icon: { glyph: 'sensor', colour: 'green' }, start: 'idea', template: 'board',
  repository: { mode: 'new', owner: 'acme', name: 'soil-sensor-2', branch: 'main' },
  advanced: { ownToken: false, memoryDays: 30, onboardingPr: true, applySettings: true }, people: [],
  build: { quantity: 10, later: { certify: false, produce: false, sustain: false }, fab: 'JLCPCB' },
}

const free: RepoCheck = { repo: 'acme/soil-sensor-2', exists: false, project: null, suggestion: null, text: null }

describe('New project', () => {
  it('can be made with a name and five Continues: every step passes on its defaults', () => {
    for (const s of ['about', 'start', 'repository', 'people', 'build', 'review'] as const) expect(stepOk(d, s, { taken: ['Soil sensor'], repo: free })).toBe(true)
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

  // test-esp32 log #78: "A new repository: mteichtahl/test-esp32" read "Repository reachable: met" because the name was
  // well formed, though the retired project test-esp32 still had that repository
  describe('the repository', () => {
    const repo = (c: RepoCheck | undefined, mode: 'new' | 'existing' = 'new') => checks({ ...d, repository: { ...d.repository, mode } }, { taken: [], repo: c }).find((x) => x.id === 'repo')!
    const onGitHub: RepoCheck = { ...free, exists: true, suggestion: 'acme/soil-sensor-3', text: 'acme/soil-sensor-2 already exists on GitHub. acme/soil-sensor-3 is free.' }
    const retired: RepoCheck = { ...onGitHub, project: { name: 'Soil sensor 2', retired: true } }

    it('a new one is met only once GitHub says the name is free', () => {
      expect(repo(free)).toMatchObject({ ok: true, text: 'Repository name free on GitHub' })
      expect(repo(undefined).ok).toBe(false)
      expect(repo(onGitHub).ok).toBe(false)
      expect(repo(retired).ok).toBe(false)
      // an answer about the name before the person changed it does not count
      expect(repo({ ...free, repo: 'acme/soil-sensor' }).ok).toBe(false)
      // GitHub could not be asked: Create asks again, so it does not hold the person here
      expect(repo({ ...free, exists: null }).ok).toBe(true)
    })

    it('an existing one must be there, and not a retired project\'s', () => {
      expect(repo(onGitHub, 'existing')).toMatchObject({ ok: true, text: 'Repository reachable' })
      expect(repo(free, 'existing').ok).toBe(false)
      expect(repo(retired, 'existing').ok).toBe(false)
    })

    it('a malformed name is never met', () => expect(repoOk({ ...d, repository: { ...d.repository, name: 'soil sensor' } }, { ...free, repo: 'acme/soil sensor' })).toBe(false))
  })
})
