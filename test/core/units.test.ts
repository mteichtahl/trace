/** units.ts: value parsing (KiCad and SPICE readings), engineering formatting, and the IEC 60063 E-series. */
import { describe, expect, it } from 'vitest'
import { eng, nearest, parseValue, preferred, seriesValues, sig, ValueError } from '../../src/core/units.js'

describe('parseValue', () => {
  it('reads prefixes, units and RKM notation', () => {
    const cases: [string | number, number][] = [
      ['3m', 3e-3], ['23.2k', 23200], ['330u', 330e-6], ['330µ', 330e-6], ['4k7', 4700], ['2R2', 2.2], ['1M5', 1.5e6],
      ['10M', 10e6], ['100nF', 100e-9], ['10MEG', 10e6], ['1meg', 1e6], ['3.3V', 3.3], ['20 A', 20], ['1e-3', 1e-3],
      ['-5', -5], ['47pF', 47e-12], ['2u2', 2.2e-6], [' 12 kHz ', 12e3], ['10Ω', 10], ['1G', 1e9], [42, 42],
    ]
    for (const [s, v] of cases) expect(parseValue(s)).toBeCloseTo(v, 15 - Math.max(0, Math.ceil(Math.log10(Math.abs(v)))))
  })
  it('reads SPICE M as milli and MEG as mega', () => {
    expect(parseValue('1M', { spice: true })).toBeCloseTo(1e-3, 15)
    expect(parseValue('1MEG', { spice: true })).toBe(1e6)
    expect(parseValue('1M5', { spice: true })).toBeCloseTo(1.5e-3, 15)
  })
  it('refuses anything that is not clearly a value', () => {
    for (const s of ['', 'abc', '4k7k', '1.2.3', 'k', '10 furlongs']) expect(() => parseValue(s)).toThrow(ValueError)
    expect(() => parseValue(Number.NaN)).toThrow(ValueError)
    expect(() => parseValue(Number.POSITIVE_INFINITY)).toThrow(ValueError)
  })
})

describe('eng and sig', () => {
  it('formats with engineering prefixes', () => {
    expect(eng(20.71, 'A')).toBe('20.7 A')
    expect(eng(0.0104, 's')).toBe('10.4 ms')
    expect(eng(3.3e-4, 'F')).toBe('330 µF')
    expect(eng(4700, 'Ω')).toBe('4.7 kΩ')
    expect(eng(0, 'V')).toBe('0 V')
    expect(eng(-2.5e6, 'Hz')).toBe('-2.5 MHz')
    expect(eng(12.345, '%')).toBe('12.3 %')
    expect(eng(null)).toBe('—')
    expect(eng(Number.POSITIVE_INFINITY, 'V')).toBe('Infinity')
    expect(sig(123456, 3)).toBe('123000')
    expect(sig(0.000123456, 2)).toBe('0.00012')
  })
})

describe('E-series', () => {
  it('has the right lengths and IEC 60063 values', () => {
    expect(preferred('E6')).toHaveLength(6)
    expect(preferred('E12')).toHaveLength(12)
    expect(preferred('E24')).toHaveLength(24)
    expect(preferred('E48')).toHaveLength(48)
    expect(preferred('E96')).toHaveLength(96)
    expect(preferred('E24')).toContain(9.1)
    expect(preferred('E96')).toContain(4.99)
    expect(preferred('E48')).toContain(4.87)
  })
  it('picks the nearest value by ratio', () => {
    expect(nearest(4800, 'E12')).toBe(4700)
    expect(nearest(5000, 'E24')).toBe(5100)
    expect(nearest(0.95, 'E6')).toBe(1)
    expect(nearest(9.6e-9, 'E12')).toBeCloseTo(10e-9, 20)
    expect(nearest(3.01e3, 'E96')).toBe(3010)
    expect(() => nearest(0)).toThrow(ValueError)
  })
  it('lists values in a range inclusive', () => {
    expect(seriesValues('E6', 1e3, 1e4)).toEqual([1000, 1500, 2200, 3300, 4700, 6800, 10000])
    expect(seriesValues('E12', 1.2e-9, 2.2e-9).map((v) => v * 1e9)).toEqual([1.2, 1.5, 1.8, 2.2].map((v) => expect.closeTo(v, 9)))
  })
})
