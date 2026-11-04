/** Which project tabs show: Evidence from Capture on (from Prove where a project has no Capture), and the later line. */
import { describe, expect, it } from 'vitest'
import { visibleTabs } from '@/routes/_app/p/$id'
import type { Journey, Stage } from '@/lib/types'
import { laterLine } from './sections-sheet'

const journey = (names: string[], current: string): Journey => {
  const at = names.indexOf(current)
  return {
    stages: names.map((name, i): Stage => ({ id: name.toLowerCase(), name, state: i < at ? 'done' : i === at ? 'current' : 'queued', criteria: { met: 0, total: 0 } })),
    gates: [],
  } as unknown as Journey
}
const BOARD = ['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off', 'Release', 'Fabricate', 'Bring up']
const FIRMWARE = ['Define', 'Architect', 'Prove', 'Release', 'Bring up']
const has = (j: Journey) => visibleTabs(j, { admin: false }).some((t) => t.id === 'evidence')

describe('the Evidence tab', () => {
  it('shows from Capture on, not only from Prove', () => {
    expect(has(journey(BOARD, 'Architect'))).toBe(false)
    expect(has(journey(BOARD, 'Capture'))).toBe(true)
    expect(has(journey(BOARD, 'Prove'))).toBe(true)
  })

  it('shows from Prove in a project without Capture', () => {
    expect(has(journey(FIRMWARE, 'Architect'))).toBe(false)
    expect(has(journey(FIRMWARE, 'Prove'))).toBe(true)
  })

  it('the later line names the stage the project actually has', () => {
    const b = journey(BOARD, 'Architect')
    expect(laterLine(visibleTabs(b, { admin: false }), b)).toBe('Evidence, Build and Renders appear once the project reaches Capture and Release.')
    const f = journey(FIRMWARE, 'Architect')
    expect(laterLine(visibleTabs(f, { admin: false }), f)).toBe('Evidence, Build and Renders appear once the project reaches Prove and Release.')
    const c = journey(BOARD, 'Capture')
    expect(laterLine(visibleTabs(c, { admin: false }), c)).toBe('Build and Renders appear once the project reaches Release.')
  })
})

describe('the Renders tab', () => {
  const renders = (j: Journey) => visibleTabs(j, { admin: false }).some((t) => t.id === 'renders')
  it('shows from Release on, when the first revision is cut and rendered', () => {
    expect(renders(journey(BOARD, 'Sign-off'))).toBe(false)
    expect(renders(journey(BOARD, 'Release'))).toBe(true)
    expect(renders(journey(FIRMWARE, 'Release'))).toBe(true)
  })
})

describe('the Documents tab', () => {
  const docs = (j: Journey) => visibleTabs(j, { admin: false }).some((t) => t.id === 'docs')
  it('shows from Architect on', () => {
    expect(docs(journey(BOARD, 'Define'))).toBe(false)
    expect(docs(journey(BOARD, 'Architect'))).toBe(true)
    expect(docs(journey(FIRMWARE, 'Prove'))).toBe(true)
  })
})
