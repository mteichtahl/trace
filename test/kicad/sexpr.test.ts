import { describe, expect, it } from 'vitest'
import { atoms, find, findAll, flag, num, parse, quote, SexprError, value, walk, xy } from '../../src/kicad/sexpr.js'

describe('sexpr.parse', () => {
  it('reads nested lists, keeping atoms as strings', () => {
    const t = parse('(kicad_pcb (version 20241229) (net 1 "GND") (at 1.5 -2 90))')
    expect(t).toEqual(['kicad_pcb', ['version', '20241229'], ['net', '1', 'GND'], ['at', '1.5', '-2', '90']])
  })

  it('unescapes quoted strings and keeps parentheses inside them', () => {
    const t = parse('(p "a \\"q\\" (b)" "back\\\\slash" "line\\nbreak" "")')
    expect(t).toEqual(['p', 'a "q" (b)', 'back\\slash', 'line\nbreak', ''])
  })

  it('round-trips quote()', () => {
    const s = 'odd "name" \\ here'
    expect(parse(`(x ${quote(s)})`)[1]).toBe(s)
  })

  it('handles whitespace of every kind and utf-8', () => {
    expect(parse('\n\t( a\r\n\t"µF 10 Ω" )\n')).toEqual(['a', 'µF 10 Ω'])
  })

  it('rejects malformed input', () => {
    expect(() => parse('(a (b)')).toThrow(SexprError)
    expect(() => parse('(a))')).toThrow(SexprError)
    expect(() => parse('(a) (b)')).toThrow(/more than one/)
    expect(() => parse('(a "open)')).toThrow(/unterminated string/)
    expect(() => parse('   ')).toThrow(/no expression/)
  })

  it('parses a large generated file quickly', () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `\t(segment (start ${i} 0) (end ${i + 1} 0) (width 0.2) (layer "F.Cu") (net "N${i % 10}"))`).join('\n')
    const t0 = Date.now()
    const t = parse(`(kicad_pcb\n${body}\n)`)
    expect(t.length).toBe(50_001)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('sexpr helpers', () => {
  const t = parse('(sym (lib_id "Device:R") (at 10 20) (dnp yes) (in_bom no) (on_board) (pin "1") (pin "2") (g (pin "3")) hide)')

  it('finds children and values', () => {
    expect(value(t, 'lib_id')).toBe('Device:R')
    expect(find(t, 'missing')).toBeUndefined()
    expect(findAll(t, 'pin').map((p) => p[1])).toEqual(['1', '2'])
    expect(walk(t, 'pin').map((p) => p[1])).toEqual(['1', '2', '3'])
    expect(atoms(t)).toEqual(['hide'])
  })

  it('reads positions, numbers and flags', () => {
    expect(xy(t)).toEqual([10, 20, 0])
    expect(num('1e-3')).toBe(0.001)
    expect(num('abc')).toBeUndefined()
    expect(flag(t, 'dnp', false)).toBe(true)
    expect(flag(t, 'in_bom', true)).toBe(false)
    expect(flag(t, 'on_board', false)).toBe(true)
    expect(flag(t, 'hide', false)).toBe(true)
    expect(flag(t, 'exclude_from_sim', false)).toBe(false)
  })
})
