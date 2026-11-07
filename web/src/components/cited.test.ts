import { describe, expect, it } from 'vitest'
import { citations, datasheetWords } from './cited'

// test-esp32 #39: the architecture's reasons cited "sha256 0ac83c83 p27", "bom_check 1b4a0c446d474f70", calc_ldo_thermal
describe('an agent\'s citations', () => {
  const said = (text: string) => citations(text).map((c) => (c.kind === 'text' ? c.text : c.kind === 'datasheet' ? `[${datasheetWords(c)}]` : c.kind === 'run' ? `[${c.label} (run ${c.run})]` : `[${c.label}]`)).join('')

  it('reads a datasheet citation as the part\'s datasheet and its page', () => {
    expect(said('ESP32 379 mA peak 802.11b, ESP32-WROOM-32E sha256 0ac83c83 p27; CH340C 12 mA max at 3.3 V, sha256 5cb6dc87 p9'))
      .toBe('ESP32 379 mA peak 802.11b, [ESP32-WROOM-32E datasheet, page 27]; CH340C 12 mA max at 3.3 V, [datasheet page 9]')
    expect(said('(calc_ldo_thermal; AMS1117-3.3 sha256 189a2651 p2)')).toBe('([LDO heat calculation]; [AMS1117-3.3 datasheet, page 2])')
    expect(said('drawing (sha256 6ae33d50, p1, no text layer)')).toBe('drawing ([datasheet page 1], no text layer)')
    expect(citations('TLV62569 sha256 a2a1ca02 p4')).toMatchObject([{ kind: 'datasheet', mpn: 'TLV62569', page: 4 }])
  })

  it('reads a run citation as what the run is, with the run', () => {
    expect(said('All board key parts in stock for 10 boards, 4.52 USD/board (bom_check 1b4a0c446d474f70, 2026-11-06).'))
      .toBe('All board key parts in stock for 10 boards, 4.52 USD/board ([stock check (run 1b4a0c446d474f70)], 2026-11-06).')
    expect(said('two layers (kicad_board run `01efaaf3713c4d62`)')).toBe('two layers ([board read (run 01efaaf3713c4d62)])')
    expect(said('worst case 3.20-3.44 V (calc_regulator_feedback)')).toBe('worst case 3.20-3.44 V ([feedback divider calculation])')
  })

  it('leaves everything else as it is', () => {
    const text = 'Cost (REQ-f3f79d 9 USD/board, REQ-4ce9e8 275 USD): fits both limits; 802.11b at 3.3 V.'
    expect(citations(text)).toEqual([{ kind: 'text', text }])
    expect(said('a_b 1234567890abcdef')).toBe('a_b 1234567890abcdef')
  })
})
