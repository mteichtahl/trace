/** The structured viewers' pure parts: which JSON keys changed, and which nets a net list change touched. */
import { describe, expect, it } from 'vitest'
import { diffJson, isJsonFile, parseJson } from './json-diff'
import { compareMode, viewerKind } from './kinds'
import { diffNets, parseNetlist } from './netlist'

describe('JSON compared by key', () => {
  it('lists added, removed and changed keys by path, walking objects and arrays', () => {
    const a = { fab: { layers: 2, finish: 'HASL' }, parts: [{ ref: 'R1' }, { ref: 'R2' }], gone: 1 }
    const b = { fab: { layers: 4, finish: 'HASL' }, parts: [{ ref: 'R1' }, { ref: 'R3' }, { ref: 'C1' }], added: true }
    const d = diffJson(a, b)
    expect(d).toContainEqual({ path: 'fab.layers', change: 'changed', before: 2, after: 4 })
    expect(d).toContainEqual({ path: 'parts[1].ref', change: 'changed', before: 'R2', after: 'R3' })
    expect(d).toContainEqual({ path: 'parts[2]', change: 'added', after: { ref: 'C1' } })
    expect(d).toContainEqual({ path: 'gone', change: 'removed', before: 1 })
    expect(d).toContainEqual({ path: 'added', change: 'added', after: true })
    expect(d.find((x) => x.path === 'fab.finish')).toBeUndefined()
  })

  it('the same document has no changes; text that is not JSON parses to nothing', () => {
    expect(diffJson({ a: [1, 2] }, { a: [1, 2] })).toEqual([])
    expect(parseJson('not json')).toBeUndefined()
  })

  it('JSON, JSON-LD and project files are JSON files', () => {
    for (const p of ['a.json', 'ontology/board.jsonld', 'x.kicad_pro']) expect(isJsonFile(p)).toBe(true)
    expect(isJsonFile('a.yaml')).toBe(false)
    expect(viewerKind('ontology/board.jsonld')).toBe('code')
  })
})

const NET = (nodes: string) => `(export (version "E")
  (nets
    (net (code "1") (name "GND") ${nodes})
    (net (code "2") (name "/VCC") (node (ref "U1") (pin "8") (pinfunction "VCC")))))`

describe('net lists', () => {
  it('is a net list kind that compares net by net', () => {
    expect(viewerKind('hardware/board.net')).toBe('netlist')
    expect(compareMode('netlist')).toBe('netlist')
  })

  it('parses nets and their pins, sorted by name', () => {
    const nets = parseNetlist(NET('(node (ref "C1") (pin "2")) (node (ref "U1") (pin "4"))'))!
    expect(nets.map((n) => n.name)).toEqual(['/VCC', 'GND'])
    expect(nets[1]!.pins).toEqual([{ ref: 'C1', pin: '2', fn: undefined }, { ref: 'U1', pin: '4', fn: undefined }])
    expect(nets[0]!.pins[0]).toMatchObject({ ref: 'U1', pin: '8', fn: 'VCC' })
  })

  it('text that is not a net list parses to null', () => {
    expect(parseNetlist('* a SPICE deck\nR1 a b 1k')).toBeNull()
    expect(parseNetlist('(export (unclosed')).toBeNull()
  })

  it('says which nets were added, removed or rewired', () => {
    const a = parseNetlist(NET('(node (ref "C1") (pin "2"))'))!
    const b = parseNetlist(`(export (nets (net (code "1") (name "GND") (node (ref "C1") (pin "2")) (node (ref "R1") (pin "1"))) (net (code "3") (name "SDA") (node (ref "U1") (pin "1")))))`)!
    expect(diffNets(a, b)).toEqual([
      { name: '/VCC', change: 'removed', joined: [], left: ['U1.8'] },
      { name: 'GND', change: 'changed', joined: ['R1.1'], left: [] },
      { name: 'SDA', change: 'added', joined: ['U1.1'], left: [] },
    ])
  })
})
