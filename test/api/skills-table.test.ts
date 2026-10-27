/** The API's guided-skill table (src/core/skills.ts) is the app's (web/src/components/skills/definitions.ts). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_DEFS } from '../../src/core/skills.js'

const src = readFileSync(join(import.meta.dirname, '../../web/src/components/skills/definitions.ts'), 'utf8')

/** Each skill's id with its step ids and check ids, in order, read from the app's table. */
function appSkills(): { id: string; steps: string[]; checks: string[] }[] {
  const body = src.slice(src.indexOf('export const SKILLS'), src.indexOf('export const SKILL_BY_ID'))
  return body.split(/\n  \{\n    id: /).slice(1).map((chunk) => {
    const id = /^'([a-z-]+)'/.exec(chunk)?.[1] ?? ''
    const steps = chunk.slice(chunk.indexOf('steps: ['), chunk.indexOf('checks: ['))
    const checks = chunk.slice(chunk.indexOf('checks: ['))
    const ids = (s: string): string[] => [...s.matchAll(/\{ id: '([a-z_-]+)'/g)].map((m) => m[1] as string)
    return { id, steps: ids(steps), checks: [...ids(checks.slice(0, checks.indexOf('],'))), ...(id === 'intent-builder' ? [] : ['reasons'])] }
  })
}

describe('the guided skills', () => {
  it('have the same ids, steps and checks on both sides', () => {
    const app = appSkills()
    expect(app).toHaveLength(19)
    expect(SKILL_DEFS.map((s) => ({ id: s.id, steps: s.steps.map((x) => x.id), checks: s.checks.map((c) => c.id) }))).toEqual(app)
  })
})
