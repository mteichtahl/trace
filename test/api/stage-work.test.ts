/**
 * What each stage's signature starts (STAGE_WORK, src/api/actions-journey.ts): Architect's options, Capture's
 * schematic, Prove's tests, Layout's board and Sign-off's report, so a project does not sit in a stage with nothing
 * working on it.
 */
import { describe, expect, it } from 'vitest'
import { STAGE_WORK } from '../../src/api/actions-journey.js'
import { SPECIALISTS } from '../../src/agents/index.js'
import { API_HIDDEN_TOOLS } from '../../src/agents/runtime/tool.js'
import { SHARED_TOOLS } from '../../src/agents/specialist.js'
import { GATES } from '../../src/core/journey.js'

describe('STAGE_WORK', () => {
  it('Capture draws the schematic and runs each check the schematic review gate needs, leaving people their calls', () => {
    const c = STAGE_WORK.capture
    expect(c?.agent).toBe('impl')
    for (const needed of ['kicad.erc', 'capture.erc', 'parts.bom_check', 'capture.stock', 'capture.datasheets', 'design.pins', 'design.sheets', 'journey.ask']) expect(c?.request).toContain(needed)
    expect(c?.request).toMatch(/no \.kicad_pcb/)
    expect(c?.request).toMatch(/Do not agree it yourself/)
  })

  it('every stage up to Sign-off whose gate has criteria trace owns starts work when the gate before it is signed', () => {
    for (const stage of ['architect', 'capture', 'prove', 'layout', 'signoff'] as const) {
      const gate = GATES.find((g) => g.stage === stage)
      expect(gate?.criteria.some((c) => c.owner === 'trace'), stage).toBe(true)
      expect(STAGE_WORK[stage], stage).toBeDefined()
    }
  })

  it('names each trace-owned criterion of its gate it records, and only tools its specialist has', () => {
    for (const [stage, w] of Object.entries(STAGE_WORK)) {
      const tools = new Set([...SPECIALISTS[w.agent].tools, ...SHARED_TOOLS, ...API_HIDDEN_TOOLS])
      const named = [...w.request.matchAll(/\b([a-z]+\.[a-z_]+)\b/g)].map((m) => m[1]!).filter((n) => !n.startsWith(`${stage}.`) && !/\.kicad_/.test(n) && !/^(kicad_pcb|kicad_sch)$/.test(n))
      for (const t of named) expect(tools.has(t), `${stage}: ${w.agent} has no ${t}`).toBe(true)
    }
    for (const [stage, keys] of [['prove', ['verified', 'failing']], ['layout', ['routed', 'drc', 'lengths']], ['signoff', ['coverage', 'bom', 'emc']]] as const) {
      for (const k of keys) expect(STAGE_WORK[stage]?.request, `${stage}.${k}`).toContain(`${stage}.${k}`)
    }
  })

  it('leaves the person-owned calls to people', () => {
    expect(STAGE_WORK.prove?.request).toMatch(/Do not waive anything yourself/)
    expect(STAGE_WORK.layout?.request).toMatch(/Do not approve them yourself/)
    expect(STAGE_WORK.signoff?.request).toMatch(/Do not sign or waive anything yourself/)
  })
})
