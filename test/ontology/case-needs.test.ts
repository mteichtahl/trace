/**
 * What a requirement asks of the case beyond the bare board (src/ontology/case-needs.ts), read from its words: the
 * test-esp32 run's requirements (#135: the case was built for the bare board, with no window for the OLED and no room
 * for the module on J2) are named, and its other requirements are not.
 */
import { describe, expect, it } from 'vitest'
import { caseNeed, caseNeedWords } from '../../src/ontology/case-needs.js'

// test-esp32's requirements, as the run recorded them: [text, accepted when]
const CASE = ['A two-part 3D-printed case is in scope, with the OLED visible through a window and the USB-C connector reachable from outside.', "The case has 2 printed parts; its window exposes 100 % of the OLED's 128 x 64 active area; a USB-C plug inserts fully into the receptacle with the case closed."] as const
const HEADER = ['The display connects on a 4-pin 2.54 mm header (3.3 V, GND, SCL, SDA); the ESP32 is I2C controller sending to the display at 400 kHz, address 0x3C.', 'SCL frequency <= 400 kHz and the bus meets UM10204 fast-mode timing.'] as const
const OTHERS: readonly (readonly [string, string])[] = [
  ['The case is no larger than 60 x 45 x 20 mm.', 'Assembled case outer dimensions <= 60 mm x 45 mm x 20 mm.'],
  ['The board draws at most 500 mA from USB at 5 V, including Wi-Fi transmit bursts, so it runs from any USB 2.0 port.', 'Peak VBUS input current <= 500 mA at 5 V, measured over 60 s of Wi-Fi transmit with the display fully lit (60 s window inferred).'],
  ['The OLED shows the Wi-Fi connection status.', 'With the access point switched off, the displayed Wi-Fi status changes from connected to disconnected within 2 s.'],
  ['The USB-C receptacle (through-hole mounting legs) has 5.1 kOhm pull-downs from CC1 and from CC2 to GND.', 'Netlist: CC1 and CC2 each reach GND through one 5.1 kOhm resistor.'],
  // run 2's REQ-1db18b: a budget naming the module it leaves out
  ['USD 100 covers the boards and assembly for all 10 units; case printing and the OLED module are outside this budget.', 'Order total for 10 units <= USD 100, excluding case printing and the OLED module.'],
  ['The ESP32 module connects to the USB connector through a CH340C bridge.', 'Enumerates as a CH340 device.'],
]

describe('what a requirement asks of the case', () => {
  it('a display seen through a window needs the window and the display in the case', () => {
    expect(caseNeed(...CASE)).toEqual({ window: true, offBoard: 'display' })
    expect(caseNeedWords(caseNeed(...CASE))).toBe('a window in the case, with the display behind it')
    expect(caseNeed('The status LEDs are visible through the lid.')).toEqual({ window: true, offBoard: null })
    expect(caseNeedWords(caseNeed('The lid has a window for the display.'))).toBe('a window in the case, with the display behind it')
    // run 2: the display's size between "the" and "display"
    expect(caseNeedWords(caseNeed('The case has one USB-C opening and a window for the 0.96 inch display.'))).toBe('a window in the case, with the display behind it')
  })

  it('a display, module or battery on a header, connector or cable sits off the board', () => {
    expect(caseNeedWords(caseNeed(...HEADER))).toBe('the display off the board, in the case')
    expect(caseNeed('A BME280 sensor module plugs into J4.').offBoard).toBe('module')
    expect(caseNeed('It runs for 8 hours from a 1000 mAh LiPo pack on a JST connector.').offBoard).toBe('battery')
  })

  it('names nothing for the board\'s own parts, sizes, or a time window', () => {
    for (const [text, acceptance] of OTHERS) expect(caseNeedWords(caseNeed(text, acceptance)), text).toBeNull()
  })
})
