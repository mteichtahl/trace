/** Scribe's foundations (docs/scribe.md): the catalog, the markers, the diagram rules and the quality bar. */
import { describe, expect, it } from 'vitest'

import { DOC_KINDS, DOCS, docsFor, skeleton, SOURCE_KINDS, VALUE_KINDS } from '../../src/docs/catalog.js'
import { checkDoc, passes, unexplainedAcronyms } from '../../src/docs/checks.js'
import { FIGURE_KINDS, FIGURES, mermaidProblem, mermaidType } from '../../src/docs/diagrams.js'
import { parseDoc, replaceSection, setFront } from '../../src/docs/markers.js'
import { STAGE_IDS } from '../../src/core/journey-catalog.js'

const CTX = { project: 'test-esp32', revision: 'A', commit: 'abc1234', date: '2026-11-04' }
const codes = (f: { code: string }[]): string[] => [...new Set(f.map((x) => x.code))].sort()

describe('catalog', () => {
  it('every document has unique sections, known sources, figures and values, and a glossary last', () => {
    for (const k of DOC_KINDS) {
      const d = DOCS[k]
      const ids = d.sections.map((s) => s.id)
      expect(new Set(ids).size, k).toBe(ids.length)
      expect(ids.at(-1), k).toBe('glossary')
      for (const s of d.sections) {
        for (const src of s.sources) expect(SOURCE_KINDS, `${k}.${s.id}`).toContain(src)
        for (const f of s.figures ?? []) expect(FIGURE_KINDS, `${k}.${s.id}`).toContain(f.kind)
        for (const v of s.values ?? []) expect(VALUE_KINDS, `${k}.${s.id}`).toContain(v)
        expect(STAGE_IDS.indexOf(s.due), `${k}.${s.id} is due no earlier than the document exists`).toBeGreaterThanOrEqual(STAGE_IDS.indexOf(d.from))
      }
    }
  })

  it('carries the agreed figures: renders, mechanical drawings, traces, data flows and the three value kinds', () => {
    const figs = new Set(DOC_KINDS.flatMap((k) => DOCS[k].sections.flatMap((s) => (s.figures ?? []).map((f) => f.kind))))
    for (const f of ['render-top', 'render-bottom', 'render-in-case', 'render-exploded', 'mech-drawing', 'timing-diagram', 'decoded-trace', 'data-flow', 'block-diagram', 'sequence']) expect(figs).toContain(f)
    const vals = new Set(DOC_KINDS.flatMap((k) => DOCS[k].sections.flatMap((s) => s.values ?? [])))
    expect([...vals].sort()).toEqual([...VALUE_KINDS].sort())
    expect(FIGURES['render-top'].maker).toBe('blender')
    expect(FIGURES['mech-drawing'].maker).toBe('build123d')
  })

  it('documents appear with the journey, the protocol specification only with interfaces', () => {
    expect(docsFor('define', true).map((d) => d.kind)).toEqual([])
    expect(docsFor('architect', true).map((d) => d.kind)).toEqual(['hld'])
    expect(docsFor('capture', false).map((d) => d.kind)).toEqual(['hld', 'lld'])
    expect(docsFor('capture', true).map((d) => d.kind)).toEqual(['hld', 'lld', 'protocol'])
    expect(docsFor('fabricate', true).map((d) => d.kind)).toEqual(['hld', 'lld', 'protocol', 'guide'])
  })

  it('a fresh skeleton passes where nothing is due yet, and names every pending section once it is', () => {
    for (const k of DOC_KINDS) {
      const md = skeleton(k, CTX)
      expect(passes(checkDoc(k, md, { stage: 'define' })), k).toBe(true)
      const late = checkDoc(k, md, { stage: 'bringup' })
      expect(late.filter((f) => f.code === 'pending').map((f) => f.section).sort()).toEqual(DOCS[k].sections.map((s) => s.id).sort())
    }
  })
})

describe('markers', () => {
  it('reads sections, figures and value tables, and replaces one section leaving the rest byte for byte', () => {
    const md = [
      skeleton('lld', CTX),
      'A note a person wrote, outside every marker.',
    ].join('\n')
    const body = [
      '## Power budget', '',
      '<!-- scribe:values kind="power" -->',
      '| Quantity | Value | Limit | Margin | Basis | Source |', '|---|---|---|---|---|---|',
      '| 3.3 V rail current | 182 mA | 500 mA | 64 % | simulated | run:r-91aa |',
      '| Battery life | pending | | | pending | |',
    ].join('\n')
    const out = replaceSection(md, 'power-budget', body)
    expect(out.endsWith('A note a person wrote, outside every marker.')).toBe(true)
    expect(out.replace(body, '')).toBe(md.replace(/_Pending: Current per rail[^\n]*_/, '').replace('## Power budget\n\n', ''))
    const s = parseDoc(out).sections.find((x) => x.id === 'power-budget')!
    expect(s.pending).toBe(false)
    expect(s.values[0]!.rows.map((r) => [r.quantity, r.basis, r.source])).toEqual([['3.3 V rail current', 'simulated', 'run:r-91aa'], ['Battery life', 'pending', '']])
    expect(() => replaceSection(md, 'nope', 'x')).toThrow(/not in the document/)
  })

  it('reports markers that do not pair up', () => {
    const p = parseDoc('<!-- scribe:section id="a" -->\n## A\n<!-- scribe:section id="b" -->\n<!-- scribe:end id="b" -->\n<!-- scribe:end id="a" -->').problems
    expect(p.map((x) => x.text)).toEqual(['section a is not closed before b opens', 'end of a without its opening marker'])
  })

  it('sets a front-matter field', () => {
    const md = setFront(skeleton('hld', CTX), 'commit', 'def5678')
    expect(parseDoc(md).front?.commit).toBe('def5678')
    expect(parseDoc(setFront(md, 'logo', 'assets/logo.svg')).front?.logo).toBe('assets/logo.svg')
  })
})

describe('diagram rules', () => {
  it('reads a Mermaid block\'s type past front matter, directives and comments', () => {
    expect(mermaidType('---\ntitle: x\n---\n%%{init: {}}%%\n%% note\nsequenceDiagram\n  A->>B: hi')).toBe('sequenceDiagram')
    expect(mermaidType('  \n')).toBeNull()
  })

  it('holds each figure kind to its diagram types', () => {
    expect(mermaidProblem('sequence', 'sequenceDiagram\nA->>B: x')).toBeNull()
    expect(mermaidProblem('sequence', 'flowchart LR\nA-->B')).toMatch(/sequenceDiagram/)
    expect(mermaidProblem('render-top', 'flowchart LR')).toMatch(/blender/)
  })
})

describe('quality bar', () => {
  const hldWith = (id: string, body: string): string => replaceSection(skeleton('hld', CTX), id, body)

  it('passes a well-made figure and catches each way one can go wrong', () => {
    const good = hldWith('data-flow', '## Data flow\n\nReadings go from the sensor to the display.\n\n<!-- scribe:figure kind="data-flow" source="ontology:architecture@abc1234" -->\n```mermaid\nflowchart LR\n  S[Sensor] --> M[Controller] --> D[Display]\n```\n_How readings reach the display._')
    expect(checkDoc('hld', good, { stage: 'define' })).toEqual([])
    const bad = hldWith('data-flow', '## Data flow\n\n<!-- scribe:figure kind="sequence" -->\n```mermaid\nflowchart LR\n  A-->B\n```\n\n```mermaid\nflowchart LR\n  C-->D\n```')
    expect(codes(checkDoc('hld', bad, { stage: 'define' }))).toEqual(['caption', 'figure-marker', 'figure-place', 'figure-source', 'mermaid'])
  })

  it('requires the section\'s figures and values once it is due', () => {
    const md = hldWith('power-summary', '## Power and thermal summary\n\nThe board draws little.')
    expect(checkDoc('hld', md, { stage: 'architect' }).filter((f) => f.section === 'power-summary')).toEqual([])
    expect(codes(checkDoc('hld', md, { stage: 'prove' }).filter((f) => f.section === 'power-summary'))).toEqual(['values-required'])
  })

  it('no source, no number', () => {
    const md = hldWith('power-summary', [
      '## Power and thermal summary', '',
      '<!-- scribe:values kind="power" -->',
      '| Quantity | Value | Limit | Margin | Basis | Source |', '|---|---|---|---|---|---|',
      '| Supply current | 120 mA | 500 mA | 76 % | measured | |',
      '| Standby current | 2 mA | | | pending | |',
      '| Peak current | about right | 1 A | | estimated | run:r-1 |',
      '| Regulator headroom | 0.4 V | 0.3 V | | simulated | run:r-2 |',
      '| Inrush | 3 A | | | guessed | run:r-3 |',
    ].join('\n'))
    const f = checkDoc('hld', md, { stage: 'architect' }).filter((x) => x.section === 'power-summary')
    expect(f.map((x) => `${x.code}:${x.severity}`).sort()).toEqual(['basis:error', 'margin:warning', 'margin:warning', 'pending-value:error', 'source:error', 'value:error'])
  })

  it('every acronym is spelled out at first use or in the glossary; code is exempt', () => {
    expect(unexplainedAcronyms('Talks Inter-Integrated Circuit (I2C) to an OLED. Then I2C again.', '')).toEqual([{ word: 'OLED', line: 1 }])
    expect(unexplainedAcronyms('An OLED (organic light-emitting diode) display, part `SSD1306`.', '')).toEqual([])
    expect(unexplainedAcronyms('Uses USB power.', '| USB | Universal Serial Bus |')).toEqual([])
    expect(unexplainedAcronyms('```mermaid\nflowchart LR\n  MCU-->OLED\n```\nSaved as PDF. OK.', '')).toEqual([])
  })

  it('every finding names a code, a severity and words a person can act on', () => {
    for (const f of checkDoc('lld', 'no front matter, no markers. Uses an LDO.', { stage: 'release' })) {
      expect(f.code.length).toBeGreaterThan(0)
      expect(['error', 'warning']).toContain(f.severity)
      expect(f.text.length).toBeGreaterThan(8)
    }
  })
})
