/**
 * A shape's evidence says what it checked (test-esp32 #44): "architect.stock: every record keeps to its shape, 0
 * findings" read the same over a record with no key parts as over one with seven. The run's summary and the
 * criterion's evidence now count the records the shape looked at, and say so when there was nothing to check.
 */
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { checkedSomething, shapeScope, shapeSummary } from '../../src/tools/shape/tools.js'

const T = 'https://trace-eda.com/ns/trace#'
const quads = (ttl: string) => new Parser().parse(`@prefix trace: <${T}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . ${ttl}`)

describe('what a shape checked', () => {
  it('counts the key parts architect.stock looks at, the project left out', () => {
    const scope = shapeScope('architect.stock', quads('<urn:p1> a trace:KeyPart . <urn:p2> a trace:KeyPart . <urn:j> a trace:Journey .'))
    expect(scope).toEqual([{ kind: 'KeyPart', words: 'key part', count: 2 }])
    expect(shapeSummary('architect.stock', scope, 0, 0)).toBe('architect.stock: checked 2 key parts: every one keeps to its shape')
    expect(shapeSummary('architect.stock', scope, 1, 1)).toBe('architect.stock: checked 2 key parts: 1 finding, 1 waived')
  })

  it('counts instances of a subclass too', () => {
    const scope = shapeScope('architect.stock', quads('trace:Module rdfs:subClassOf trace:KeyPart . <urn:m> a trace:Module .'))
    expect(scope[0]?.count).toBe(1)
  })

  it('says there was nothing to check over a record with no key parts, not that every record keeps to it', () => {
    const scope = shapeScope('architect.stock', quads('<urn:j> a trace:Journey .'))
    expect(checkedSomething(scope)).toBe(false)
    const s = shapeSummary('architect.stock', scope, 0, 0)
    expect(s).toBe('architect.stock: nothing to check: the record has no key parts yet, so nothing was shown to keep to its shape')
    expect(s).not.toMatch(/every record keeps/)
  })

  it('names each kind a shape with several looks at', () => {
    const scope = shapeScope('layout.fit', quads('<urn:f> a trace:FitFinding . <urn:r1> a trace:Requirement . <urn:r2> a trace:Requirement . <urn:c> a trace:FitCheck .'))
    expect(shapeSummary('layout.fit', scope, 0, 0)).toBe('layout.fit: checked 1 fit finding, 0 rule results, 1 fit check and 2 requirements: every one keeps to its shape')
  })

  it('says when the records come from several checks: 90 lines of six 15-line parts checks are not a 90-line parts list (test-esp32-run2 R59)', () => {
    const lines = Array.from({ length: 6 }, (_, r) => Array.from({ length: 15 }, (_, l) => `<urn:l${r}-${l}> a trace:PartsListLine ; trace:ofRun <urn:run${r}> .`).join(' ')).join(' ')
    const scope = shapeScope('signoff.bom', quads(lines))
    expect(scope.find((s) => s.kind === 'PartsListLine')).toMatchObject({ count: 90, runs: { count: 6, each: 15 } })
    expect(shapeSummary('signoff.bom', scope.filter((s) => s.kind === 'PartsListLine'), 0, 0)).toBe('signoff.bom: checked 90 parts list lines from 6 checks (15 each): every one keeps to its shape')
    const one = shapeScope('signoff.bom', quads('<urn:a> a trace:PartsListLine ; trace:ofRun <urn:r> . <urn:b> a trace:PartsListLine ; trace:ofRun <urn:r> .')).find((s) => s.kind === 'PartsListLine')
    expect(one).toEqual({ kind: 'PartsListLine', words: 'parts list line', count: 2 })
  })
})
