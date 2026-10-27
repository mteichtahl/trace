/**
 * Generates the trace-sample KiCad project: schematic, board, project file and project library tables, into
 * hardware/ (routed) or, with UNROUTED=1, into layout/ (the same placement with no tracks or vias: pcb.autoroute's
 * input). It grew from trace's examples/sensor-node generator. To the sensor-node front end it adds the 12 V to 3.3 V
 * regulator U1 with its capacitors, the buffer U2 and the I2C/UART headers J2 and J3 with pull-ups.
 *
 * Run from the repository root: `npx tsx tools/generate.ts` (and `UNROUTED=1 npx tsx tools/generate.ts`). The
 * committed KiCad files are this script's output, finished by KiCad itself: the board's ground pour is filled by
 * `kicad-cli pcb drc --refill-zones --save-board`. It ends by running ERC and DRC (with schematic parity) and fails
 * unless both report zero errors (for layout/, every unrouted connection is expected and not counted).
 *
 * The symbols and footprints are copied from KiCad's own standard libraries (so ERC and DRC check them against the
 * library), and placement and routing are written out as coordinates, so the whole design is one readable file.
 * U1 uses the AP1117-15 symbol (AMS1117-3.3 shares its pinout) and U2 the MCP6L91T-EOT symbol (the MCP6001's
 * SOT-23-5 pinout); their Value fields carry the real part numbers.
 *
 * Needs KiCad 10 (kicad-cli on PATH, its libraries at $KICAD_SHARE or /usr/share/kicad).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** UNROUTED=1: the same board with no tracks or vias, into layout/ (pcb.autoroute's input). */
const UNROUTED = process.env.UNROUTED === '1'
const OUT = resolve(HERE, '..', UNROUTED ? 'layout' : 'hardware')
const NAME = 'trace-sample'
const SHARE = process.env.KICAD_SHARE ?? ['/usr/share/kicad', '/usr/local/share/kicad', '/Applications/KiCad/KiCad.app/Contents/SharedSupport']
  .find((d) => existsSync(join(d, 'symbols'))) ?? '/usr/share/kicad'
const CLI = process.env.KICAD_CLI ?? 'kicad-cli'

/** A stable UUID from a name, so regenerating gives the same file. */
function uuid(name: string): string {
  const h = createHash('sha256').update(`trace-sample/${name}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The text of the balanced S-expression starting at `start`. */
function balanced(text: string, start: number): string {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(`unbalanced expression at ${start}`)
}

/** A symbol from a standard library, renamed "Lib:Name" as a schematic embeds it. */
function libSymbol(lib: string, name: string): string {
  const text = readFileSync(join(SHARE, 'symbols', `${lib}.kicad_sym`), 'utf8')
  const at = text.indexOf(`\n\t(symbol "${name}"\n`)
  if (at < 0) throw new Error(`${lib}:${name} not found in ${SHARE}/symbols`)
  const s = balanced(text, at + 2)
  return s.replace(`(symbol "${name}"`, `(symbol "${lib}:${name}"`).split('\n').map((l) => `\t${l}`).join('\n')
}

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const n = (x: number): string => String(Math.round(x * 1e4) / 1e4)

// ------------------------------------------------------------------ the parts

interface Part {
  ref: string
  lib: string
  sym: string
  value: string
  footprint: string
  fields: Record<string, string>
  /** schematic position (mm, on the 1.27 mm grid) */
  sch: [number, number]
  /** board position and rotation */
  pcb: [number, number, number]
  /** pad number → net */
  pads: Record<string, string>
  /** schematic: a side pin's power symbol reached by a wire [out, then down/up] (default 2.54, 2.54) */
  powerRoute?: Record<string, [number, number]>
  description: string
}

const R0603 = 'Resistor_SMD:R_0603_1608Metric'
const C0603 = 'Capacitor_SMD:C_0603_1608Metric'
const C0805 = 'Capacitor_SMD:C_0805_2012Metric'
const uniroyal = (mpn: string, lcsc: string): Record<string, string> => ({ MPN: mpn, Manufacturer: 'UNI-ROYAL', LCSC: lcsc })

const PARTS: Part[] = [
  // ---- input: the monitored 12 V rail, which also powers the board
  { ref: 'J1', lib: 'Connector_Generic', sym: 'Conn_01x02', value: 'VIN_12V', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    fields: { MPN: 'PZ254V-11-02P', Manufacturer: 'XFCN', LCSC: 'C492401' }, sch: [38.1, 63.5], pcb: [103, 110, 0],
    pads: { 1: 'VIN', 2: 'GND' }, description: 'Supply and sensed input, 4.5-13 V' },
  // ---- the sense chain: divider, anti-alias RC, clamp, buffer
  { ref: 'R1', lib: 'Device', sym: 'R', value: '39k', footprint: R0603, fields: uniroyal('0603WAF3902T5E', 'C23153'),
    sch: [63.5, 50.8], pcb: [108, 110, 0], pads: { 1: 'VIN', 2: 'DIV' }, description: 'Divider top, 1 %' },
  { ref: 'R2', lib: 'Device', sym: 'R', value: '13k', footprint: R0603, fields: uniroyal('0603WAF1302T5E', 'C22797'),
    sch: [63.5, 76.2], pcb: [112, 114, 0], pads: { 1: 'DIV', 2: 'GND' }, description: 'Divider bottom, 1 %' },
  { ref: 'R3', lib: 'Device', sym: 'R', value: '6k2', footprint: R0603, fields: uniroyal('0603WAF6201T5E', 'C4260'),
    sch: [88.9, 50.8], pcb: [116, 110, 0], pads: { 1: 'DIV', 2: 'FILT' }, description: 'Anti-alias filter R (with the divider\'s 9.75k source: 15.95k)' },
  { ref: 'C1', lib: 'Device', sym: 'C', value: '10n', footprint: C0603,
    fields: { MPN: 'CL10B103KB8NNNC', Manufacturer: 'Samsung Electro-Mechanics', LCSC: 'C1589' },
    sch: [114.3, 76.2], pcb: [121, 113, 0], pads: { 1: 'FILT', 2: 'GND' }, description: 'Anti-alias filter C, X7R 50 V' },
  { ref: 'D1', lib: 'Diode', sym: 'BAT54S', value: 'BAT54S', footprint: 'Package_TO_SOT_SMD:SOT-23',
    fields: { MPN: 'BAT54S-7-F', Manufacturer: 'Diodes Incorporated', LCSC: 'C83574' },
    sch: [139.7, 63.5], pcb: [126, 113, 0], pads: { 1: 'GND', 2: '+3V3', 3: 'FILT' }, description: 'Buffer input clamp to GND and 3V3' },
  { ref: 'U2', lib: 'Amplifier_Operational', sym: 'MCP6L91T-EOT', value: 'MCP6001T-I/OT', footprint: 'Package_TO_SOT_SMD:SOT-23-5',
    fields: { MPN: 'MCP6001T-I/OT', Manufacturer: 'Microchip Tech', LCSC: 'C116490' },
    sch: [190.5, 63.5], pcb: [132, 111, 0], pads: { 1: 'ADC_IN', 2: 'GND', 3: 'FILT', 4: 'ADC_IN', 5: '+3V3' },
    description: 'Unity-gain buffer driving the ADC pin (1 MHz rail-to-rail CMOS op-amp)' },
  { ref: 'C2', lib: 'Device', sym: 'C', value: '100n', footprint: C0603,
    fields: { MPN: 'CC0603KRX7R9BB104', Manufacturer: 'YAGEO', LCSC: 'C14663' },
    sch: [215.9, 88.9], pcb: [136.5, 107.6, 0], pads: { 1: '+3V3', 2: 'GND' }, description: '3V3 decoupling at the buffer' },
  // ---- power: 12 V to 3V3 linear regulator
  { ref: 'C3', lib: 'Device', sym: 'C', value: '10u', footprint: C0805,
    fields: { MPN: 'CL21A106KAYNNNE', Manufacturer: 'Samsung Electro-Mechanics', LCSC: 'C15850' },
    sch: [63.5, 127], pcb: [105.95, 132.5, 0], pads: { 1: 'VIN', 2: 'GND' }, description: 'Regulator input capacitor, X5R 25 V' },
  { ref: 'U1', lib: 'Regulator_Linear', sym: 'AP1117-15', value: 'AMS1117-3.3', footprint: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2',
    fields: { MPN: 'AMS1117-3.3', Manufacturer: 'Advanced Monolithic Systems', LCSC: 'C6186' },
    sch: [101.6, 127], pcb: [112, 127, 0], pads: { 1: 'GND', 2: '+3V3', 3: 'VIN' },
    description: '12 V to 3.3 V LDO, 1 A, SOT-223: the board\'s heat source' },
  { ref: 'C4', lib: 'Device', sym: 'C', value: '10u', footprint: C0805,
    fields: { MPN: 'CL21A106KAYNNNE', Manufacturer: 'Samsung Electro-Mechanics', LCSC: 'C15850' },
    sch: [139.7, 139.7], pcb: [119, 127, 0], pads: { 1: '+3V3', 2: 'GND' }, description: 'Regulator output capacitor, X5R 25 V' },
  // ---- to the MCU board, and the expansion header for an I2C/UART probe
  { ref: 'J2', lib: 'Connector_Generic', sym: 'Conn_01x08', value: 'MCU', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Vertical',
    fields: { MPN: 'PZ254V-11-08P', Manufacturer: 'XFCN', LCSC: 'C492407' }, sch: [279.4, 63.5], pcb: [156, 104, 0],
    pads: { 1: '+3V3', 2: 'GND', 3: 'SDA', 4: 'SCL', 5: 'TX', 6: 'RX', 7: 'ADC_IN', 8: 'LED' },
    powerRoute: { 2: [12.7, 25.4] }, description: 'To the MCU: 3V3, GND, I2C, UART, ADC_IN, LED' },
  { ref: 'J3', lib: 'Connector_Generic', sym: 'Conn_01x06', value: 'EXPANSION', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical',
    fields: { MPN: 'PZ254V-11-06P', Manufacturer: 'XFCN', LCSC: 'C492405' }, sch: [279.4, 127], pcb: [148, 104, 0],
    pads: { 1: '+3V3', 2: 'GND', 3: 'SDA', 4: 'SCL', 5: 'TX', 6: 'RX' }, powerRoute: { 2: [12.7, 20.32] },
    description: 'Expansion: an I2C sensor probe (TRC-TMP1) and the MCU console UART' },
  { ref: 'R5', lib: 'Device', sym: 'R', value: '4k7', footprint: R0603, fields: uniroyal('0603WAF4701T5E', 'C23162'),
    sch: [241.3, 114.3], pcb: [142, 107, 90], pads: { 1: '+3V3', 2: 'SDA' }, description: 'I2C SDA pull-up (protocol.pullup)' },
  { ref: 'R6', lib: 'Device', sym: 'R', value: '4k7', footprint: R0603, fields: uniroyal('0603WAF4701T5E', 'C23162'),
    sch: [254, 114.3], pcb: [139.5, 109.5, 90], pads: { 1: '+3V3', 2: 'SCL' }, description: 'I2C SCL pull-up (protocol.pullup)' },
  { ref: 'R4', lib: 'Device', sym: 'R', value: '680', footprint: R0603, fields: uniroyal('0603WAF6800T5E', 'C23228'),
    sch: [215.9, 139.7], pcb: [153, 124.5, 0], pads: { 1: 'LED', 2: 'LED_A' }, description: 'LED series resistor, about 1.9 mA from a 3V3 GPIO' },
  { ref: 'D2', lib: 'Device', sym: 'LED', value: 'RED', footprint: 'LED_SMD:LED_0603_1608Metric',
    fields: { MPN: 'KT-0603R', Manufacturer: 'Hubei KENTO Elec', LCSC: 'C2286' },
    sch: [241.3, 152.4], pcb: [156, 124.5, 180], pads: { 1: 'GND', 2: 'LED_A' }, description: 'Status LED' },
]

/** The Datasheet field: the clamp's vendor document, else KiCad's "~" (the parts' PDFs live in the datasheet library). */
const datasheetOf = (p: Part): string => (p.sym === 'BAT54S' ? 'https://www.diodes.com/assets/Datasheets/ds11005.pdf' : '~')

/** Pin end points of each symbol (schematic coordinates, y down) relative to its position, and the way each pin
 * points out of the symbol (labels and power symbols continue in that direction). */
type Dir = 'up' | 'down' | 'left' | 'right'
const PIN_OFFSETS: Record<string, Record<string, [number, number, Dir]>> = {
  R: { 1: [0, -3.81, 'up'], 2: [0, 3.81, 'down'] },
  C: { 1: [0, -3.81, 'up'], 2: [0, 3.81, 'down'] },
  LED: { 1: [-3.81, 0, 'left'], 2: [3.81, 0, 'right'] },
  BAT54S: { 1: [-7.62, 0, 'left'], 2: [7.62, 0, 'right'], 3: [0, 5.08, 'down'] },
  Conn_01x02: { 1: [-5.08, 0, 'left'], 2: [-5.08, 2.54, 'left'] },
  Conn_01x06: Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [k, [-5.08, -5.08 + 2.54 * (k - 1), 'left']])) as Record<string, [number, number, Dir]>,
  Conn_01x08: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [k, [-5.08, -7.62 + 2.54 * (k - 1), 'left']])) as Record<string, [number, number, Dir]>,
  'AP1117-15': { 1: [0, 7.62, 'down'], 2: [7.62, 0, 'right'], 3: [-7.62, 0, 'left'] },
  'MCP6L91T-EOT': { 1: [7.62, 0, 'right'], 2: [-2.54, 7.62, 'down'], 3: [-7.62, -2.54, 'left'], 4: [-7.62, 2.54, 'left'], 5: [-2.54, -7.62, 'up'] },
}

// ------------------------------------------------------------------ the schematic

const ROOT = uuid('root')
const effects = '(effects (font (size 1.27 1.27)))'
const hidden = (k: string, v: string, x: number, y: number): string =>
  `\t\t(property ${q(k)} ${q(v)} (at ${n(x)} ${n(y)} 0) (show_name no) (do_not_autoplace no) (hide yes) ${effects})`

function symbolInstance(lib: string, sym: string, ref: string, value: string, footprint: string, x: number, y: number,
  pins: string[], extra: Record<string, string>, datasheet = '~', description = '', rot = 0): string {
  const id = uuid(`sym/${ref}`)
  return [
    `\t(symbol (lib_id ${q(`${lib}:${sym}`)}) (at ${n(x)} ${n(y)} ${rot}) (unit 1) (body_style 1)`,
    '\t\t(exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (dnp no)',
    `\t\t(uuid ${q(id)})`,
    libProperty(lib, sym, 'Reference', ref, x, y, rot),
    libProperty(lib, sym, 'Value', value, x, y, rot),
    hidden('Footprint', footprint, x, y),
    hidden('Datasheet', datasheet, x, y),
    hidden('Description', description, x, y),
    ...Object.entries(extra).map(([k, v]) => hidden(k, v, x, y)),
    ...pins.map((p) => `\t\t(pin ${q(p)} (uuid ${q(uuid(`pin/${ref}/${p}`))}))`),
    `\t\t(instances (project ${q(NAME)} (path ${q(`/${ROOT}`)} (reference ${q(ref)}) (unit 1))))`,
    '\t)',
  ].join('\n')
}

/** A Reference or Value property placed where the library symbol puts it (library y is up, schematic y is down; the
 * offset turns with the symbol, counter-clockwise on screen), with the library's text effects. */
function libProperty(lib: string, sym: string, key: 'Reference' | 'Value', value: string, x: number, y: number, rot = 0): string {
  const text = libSymbol(lib, sym)
  const at = text.indexOf(`(property ${q(key)} `)
  if (at < 0) throw new Error(`${lib}:${sym} has no ${key}`)
  const prop = balanced(text, at)
  const pos = /\(at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\)/.exec(prop)
  const eff = prop.indexOf('(effects')
  if (!pos || eff < 0) throw new Error(`${lib}:${sym} ${key} has no position or effects`)
  const effectsText = balanced(prop, eff).replace(/\s+/g, ' ')
  const hide = /\(hide yes\)/.test(prop.slice(0, eff)) ? ' (hide yes)' : ''
  const [ox, oy] = turn(Number(pos[1]), -Number(pos[2]), rot)
  return `\t\t(property ${q(key)} ${q(value)} (at ${n(x + ox)} ${n(y + oy)} ${(Number(pos[3]) + rot) % 180}) (show_name no) (do_not_autoplace no)${hide} ${effectsText})`
}

/** A screen offset (y down) turned counter-clockwise by a multiple of 90 degrees. */
function turn(dx: number, dy: number, rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360
  return r === 90 ? [dy, -dx] : r === 180 ? [-dx, -dy] : r === 270 ? [-dy, dx] : [dx, dy]
}

/** A local label on a pin end, its text running away from the symbol: pins above go up, below go down, left go left. */
function label(text: string, x: number, y: number, dir: Dir): string {
  const [angle, justify] = { up: [90, 'left bottom'], down: [270, 'right bottom'], left: [180, 'right bottom'], right: [0, 'left bottom'] }[dir]
  return `\t(label ${q(text)} (at ${n(x)} ${n(y)} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid ${q(uuid(`label/${text}/${x}/${y}`))}))`
}

function wire(a: [number, number], b: [number, number]): string {
  return `\t(wire (pts (xy ${n(a[0])} ${n(a[1])}) (xy ${n(b[0])} ${n(b[1])})) (stroke (width 0) (type default)) (uuid ${q(uuid(`wire/${a.join(',')}/${b.join(',')}`))}))`
}

function schematic(): string {
  const out: string[] = []
  let pwr = 0
  /** A power symbol on a pin end. On a side pin it sits upright at the end of an L of wire: out from the pin, then
   * down to GND or up to +3V3. */
  const power = (sym: 'GND' | '+3V3', x: number, y: number, dir: Dir, route: [number, number] = [2.54, 2.54]): void => {
    pwr++
    let at: [number, number] = [x, y]
    if (dir === 'left' || dir === 'right') {
      const corner: [number, number] = [x + (dir === 'left' ? -route[0] : route[0]), y]
      at = [corner[0], y + (sym === 'GND' ? route[1] : -route[1])]
      out.push(wire([x, y], corner), wire(corner, at))
    }
    out.push(symbolInstance('power', sym, `#PWR${String(pwr).padStart(2, '0')}`, sym, '', at[0], at[1], ['1'], {}, '',
      sym === 'GND' ? 'Power symbol creates a global label with name "GND" , ground' : 'Power symbol creates a global label with name "+3V3"'))
  }
  for (const p of PARTS) {
    const offs = PIN_OFFSETS[p.sym]
    if (!offs) throw new Error(`no pin map for ${p.sym}`)
    const ds = datasheetOf(p)
    out.push(symbolInstance(p.lib, p.sym, p.ref, p.value, p.footprint, p.sch[0], p.sch[1], Object.keys(offs), p.fields, ds, p.description))
    for (const [pin, [dx, dy, dir]] of Object.entries(offs)) {
      const net = p.pads[pin]
      if (!net) throw new Error(`${p.ref}.${pin} has no net`)
      const x = p.sch[0] + dx
      const y = p.sch[1] + dy
      if (net === 'GND' || net === '+3V3') power(net, x, y, dir, p.powerRoute?.[pin])
      else out.push(label(net, x, y, dir))
    }
  }
  // VIN and GND come in through J1: PWR_FLAGs tell ERC they are driven from off the board (3V3 is U1's output).
  for (const [i, net] of (['VIN', 'GND'] as const).entries()) {
    const x = 40.64 + i * 20.32
    const y = 177.8
    out.push(symbolInstance('power', 'PWR_FLAG', `#FLG0${i + 1}`, 'PWR_FLAG', '', x, y, ['1'], {}, '~',
      'Special symbol for telling ERC where power comes from'))
    out.push(wire([x, y], [x + 7.62, y]))
    if (net === 'GND') power(net, x + 7.62, y, 'down')
    else out.push(label(net, x + 7.62, y, 'right'))
  }
  const libs = [['Amplifier_Operational', 'MCP6L91T-EOT'], ['Connector_Generic', 'Conn_01x02'], ['Connector_Generic', 'Conn_01x06'], ['Connector_Generic', 'Conn_01x08'],
    ['Device', 'C'], ['Device', 'LED'], ['Device', 'R'], ['Diode', 'BAT54S'], ['Regulator_Linear', 'AP1117-15'],
    ['power', '+3V3'], ['power', 'GND'], ['power', 'PWR_FLAG']] as const
  return [
    '(kicad_sch',
    '\t(version 20260306)',
    '\t(generator "eeschema")',
    '\t(generator_version "10.0")',
    `\t(uuid ${q(ROOT)})`,
    '\t(paper "A3")',
    '\t(title_block (title "trace-sample: 12 V rail monitor with a 3.3 V LDO, buffered ADC input and I2C/UART header") (rev "A") (company "trace sample")',
    '\t\t(comment 1 "Generated by tools/generate.ts; see README.md"))',
    '\t(lib_symbols',
    ...libs.map(([l, s]) => libSymbol(l, s)),
    '\t)',
    ...out,
    '\t(sheet_instances (path "/" (page "1")))',
    '\t(embedded_fonts no)',
    ')',
    '',
  ].join('\n')
}

// ------------------------------------------------------------------ the board

/** A library footprint placed on the board: library id, position, reference, value, fields, link to its symbol, and
 * the net of each pad. Pad and text angles in a board file are absolute, so the footprint's rotation is added. */
function footprint(p: Part): string {
  const [lib, fpName] = p.footprint.split(':') as [string, string]
  let t = readFileSync(join(SHARE, 'footprints', `${lib}.pretty`, `${fpName}.kicad_mod`), 'utf8').replace(/\r\n/g, '\n').trimEnd()
  const [x, y, rot] = p.pcb
  t = t.replace(`(footprint ${q(fpName)}`, `(footprint ${q(p.footprint)}`)
  t = t.replace(/\n\t\((version|generator|generator_version) [^\n]*\)/g, '')
  t = t.replace('\n\t(layer "F.Cu")', `\n\t(layer "F.Cu")\n\t(uuid ${q(uuid(`fp/${p.ref}`))})\n\t(at ${n(x)} ${n(y)}${rot ? ` ${rot}` : ''})`)
  t = t.replace('(property "Reference" "REF**"', `(property "Reference" ${q(p.ref)}`)
  t = t.replace(`(property "Value" ${q(fpName)}`, `(property "Value" ${q(p.value)}`)
  t = t.replace('(property "Datasheet" ""', `(property "Datasheet" ${q(datasheetOf(p))}`)
  t = t.replace('(property "Description" ""', `(property "Description" ${q(p.description)}`)
  if (rot) {
    // every (at x y [a]) below the footprint's own: pads and texts carry absolute angles
    let first = true
    t = t.replace(/\(at (-?[\d.]+) (-?[\d.]+)(?: (-?[\d.]+))?\)/g, (m, ax: string, ay: string, aa: string | undefined) => {
      if (first) {
        first = false
        return m
      }
      const a = ((Number(aa ?? 0) + rot) % 360 + 360) % 360
      return `(at ${ax} ${ay}${a ? ` ${a}` : ''})`
    })
  }
  const props = ([['Datasheet', datasheetOf(p)], ['Description', p.description],
    ...Object.entries(p.fields)] as [string, string][])
    .filter(([k]) => !new RegExp(`\\(property ${q(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `).test(t))
    .map(([k, v]) => `\t(property ${q(k)} ${q(v)} (at 0 0 ${rot}) (layer "F.Fab") (hide yes) (uuid ${q(uuid(`fp/${p.ref}/${k}`))}) (effects (font (size 1 1) (thickness 0.15))))`)
  const link = [`\t(path ${q(`/${uuid(`sym/${p.ref}`)}`)})`, '\t(sheetname "/")', `\t(sheetfile ${q(`${NAME}.kicad_sch`)})`]
  t = t.replace('\n\t(attr ', `\n${[...props, ...link].join('\n')}\n\t(attr `)
  // nets on pads: after each pad's (layers …) line
  t = t.replace(/(\n\t\(pad "([^"]+)"[\s\S]*?\n\t\t\(layers [^\n]*\))/g, (m, block: string, num: string) => {
    const net = p.pads[num]
    if (!net) throw new Error(`${p.ref} pad ${num} has no net`)
    return `${block}\n\t\t(net ${q(boardNet(net))})`
  })
  for (const num of Object.keys(p.pads)) if (!t.includes(`(pad ${q(num)}`)) throw new Error(`${p.footprint} has no pad ${num}`)
  // Library footprints carry no UUIDs on their texts, graphics and pads; KiCad would invent random ones on save.
  // Give each a stable one so regenerating the board reproduces the same file.
  // (KiCad wants the uuid after an item's other fields, so it goes in just before the item's closing parenthesis.)
  let item = 0
  const head = /\n\t\((property|fp_line|fp_rect|fp_circle|fp_arc|fp_poly|fp_curve|fp_text|fp_text_box|pad)\b/g
  let outText = ''
  let last = 0
  for (let m = head.exec(t); m; m = head.exec(t)) {
    const start = m.index + 2
    const block = balanced(t, start)
    if (block.includes('(uuid ')) continue
    outText += t.slice(last, start) + block.slice(0, -1).trimEnd() + ` (uuid ${q(uuid(`fp/${p.ref}/item/${item++}`))}))`
    last = start + block.length
    head.lastIndex = last
  }
  t = outText + t.slice(last)
  return t.split('\n').map((l) => `\t${l}`).join('\n')
}

/** The board's net name: KiCad names a local-label net after its sheet ("/ADC_IN"); power nets are global. */
const boardNet = (net: string): string => (net === 'GND' || net === '+3V3' ? net : `/${net}`)

type Pt = [number, number]
const W = 0.25
let tracks = 0
const seg = (a: Pt, b: Pt, net: string, layer = 'F.Cu'): string =>
  `\t(segment (start ${n(a[0])} ${n(a[1])}) (end ${n(b[0])} ${n(b[1])}) (width ${W}) (layer ${q(layer)}) (net ${q(boardNet(net))}) (uuid ${q(uuid(`seg/${tracks++}`))}))`
const via = (at: Pt, net: string): string =>
  `\t(via (at ${n(at[0])} ${n(at[1])}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${q(boardNet(net))}) (uuid ${q(uuid(`via/${at[0]}/${at[1]}`))}))`
const path = (pts: Pt[], net: string, layer = 'F.Cu'): string[] => pts.slice(1).map((p, i) => seg(pts[i] as Pt, p, net, layer))

/** Copper: signals on F.Cu; 3V3 runs as a B.Cu trunk from the regulator to both headers; the buffer's output joins
 * its inverting input through a short B.Cu link; every SMD ground pad has its own via into the B.Cu pour. The
 * layout/ copy of this board has none of this copper (pcb.autoroute routes it). */
function routing(): string[] {
  return [
    // VIN: J1.1 to R1.1, and down the left edge to C3 and the regulator's input
    ...path([[103, 110], [107.175, 110]], 'VIN'),
    ...path([[103, 110], [101.4, 110], [101.4, 132.5], [105, 132.5], [105, 129.3], [108.85, 129.3]], 'VIN'),
    // DIV: R1.2 to R3.1, with R2.1 teed off
    ...path([[108.825, 110], [111.175, 110], [115.175, 110]], 'DIV'),
    ...path([[111.175, 110], [111.175, 114]], 'DIV'),
    // FILT: R3.2 along y = 110, tees down to C1.1 and D1.3, into the buffer's + input (U2.3)
    ...path([[116.825, 110], [120.225, 110], [126.9375, 110], [128.3, 110], [128.3, 111.95], [130.8625, 111.95]], 'FILT'),
    ...path([[120.225, 110], [120.225, 113]], 'FILT'),
    ...path([[126.9375, 110], [126.9375, 113]], 'FILT'),
    // ADC_IN: U2.1 (out) to U2.4 (-) through B.Cu, then U2.4 down and along y = 119.24 to J2.7
    ...path([[130.8625, 110.05], [130.8625, 108.6]], 'ADC_IN'),
    via([130.8625, 108.6], 'ADC_IN'),
    ...path([[130.8625, 108.6], [131.9, 108.6], [131.9, 113.6], [133.1375, 113.6]], 'ADC_IN', 'B.Cu'),
    via([133.1375, 113.6], 'ADC_IN'),
    ...path([[133.1375, 111.95], [133.1375, 113.6], [133.1375, 119.24], [156, 119.24]], 'ADC_IN'),
    // +3V3: U1's two "2" pads, C4.1, a via into the B.Cu trunk, branches to D1.2, U2.5 (and C2), the pull-ups, J3.1, J2.1
    ...path([[108.85, 127], [115.15, 127], [118.05, 127], [118.05, 125.2]], '+3V3'),
    via([118.05, 125.2], '+3V3'),
    ...path([[118.05, 125.2], [118.05, 117], [125.0625, 117], [134.5, 117], [145, 117], [145, 109.3], [145, 104], [148, 104], [156, 104]], '+3V3', 'B.Cu'),
    ...path([[125.0625, 113.95], [125.0625, 115.6]], '+3V3'), via([125.0625, 115.6], '+3V3'),
    ...path([[125.0625, 115.6], [125.0625, 117]], '+3V3', 'B.Cu'),
    ...path([[133.1375, 110.05], [134.5, 110.05]], '+3V3'), via([134.5, 110.05], '+3V3'),
    ...path([[134.5, 110.05], [134.5, 117]], '+3V3', 'B.Cu'),
    ...path([[134.5, 110.05], [134.5, 107.6], [135.725, 107.6]], '+3V3'),
    ...path([[142, 107.825], [142, 109.3]], '+3V3'), via([142, 109.3], '+3V3'),
    ...path([[139.5, 110.325], [138, 110.325]], '+3V3'), via([138, 110.325], '+3V3'),
    ...path([[138, 110.325], [138, 109.3], [142, 109.3], [145, 109.3]], '+3V3', 'B.Cu'),
    // I2C and UART: J3 to J2 straight across; the pull-ups R5 (SDA) and R6 (SCL) teed off on the J3 side
    ...path([[148, 109.08], [156, 109.08]], 'SDA'),
    ...path([[148, 111.62], [156, 111.62]], 'SCL'),
    ...path([[148, 114.16], [156, 114.16]], 'TX'),
    ...path([[148, 116.7], [156, 116.7]], 'RX'),
    ...path([[148, 109.08], [144.5, 109.08], [144.5, 106.175], [142, 106.175]], 'SDA'),
    ...path([[148, 111.62], [140.5, 111.62], [140.5, 108.675], [139.5, 108.675]], 'SCL'),
    // LED: J2.8 to R4.1, R4.2 to D2's anode
    ...path([[156, 121.78], [152.175, 121.78], [152.175, 124.5]], 'LED'),
    ...path([[153.825, 124.5], [155.2125, 124.5]], 'LED_A'),
    // ground vias
    ...path([[112.825, 114], [114.2, 114]], 'GND'), via([114.2, 114], 'GND'),
    ...path([[121.775, 113], [121.775, 114.8]], 'GND'), via([121.775, 114.8], 'GND'),
    ...path([[125.0625, 112.05], [123.6, 112.05]], 'GND'), via([123.6, 112.05], 'GND'),
    ...path([[130.8625, 111], [129.4, 111]], 'GND'), via([129.4, 111], 'GND'),
    ...path([[137.275, 107.6], [137.275, 105.9]], 'GND'), via([137.275, 105.9], 'GND'),
    ...path([[108.85, 124.7], [106.7, 124.7]], 'GND'), via([106.7, 124.7], 'GND'),
    ...path([[106.9, 132.5], [106.9, 134.4]], 'GND'), via([106.9, 134.4], 'GND'),
    ...path([[119.95, 127], [119.95, 129]], 'GND'), via([119.95, 129], 'GND'),
    ...path([[156.7875, 124.5], [158.2, 124.5]], 'GND'), via([158.2, 124.5], 'GND'),
  ]
}

const LAYERS = `\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(9 "F.Adhes" user "F.Adhesive")
\t\t(11 "B.Adhes" user "B.Adhesive")
\t\t(13 "F.Paste" user)
\t\t(15 "B.Paste" user)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen")
\t\t(1 "F.Mask" user)
\t\t(3 "B.Mask" user)
\t\t(17 "Dwgs.User" user "User.Drawings")
\t\t(19 "Cmts.User" user "User.Comments")
\t\t(21 "Eco1.User" user "User.Eco1")
\t\t(23 "Eco2.User" user "User.Eco2")
\t\t(25 "Edge.Cuts" user)
\t\t(27 "Margin" user)
\t\t(31 "F.CrtYd" user "F.Courtyard")
\t\t(29 "B.CrtYd" user "B.Courtyard")
\t\t(35 "F.Fab" user)
\t\t(33 "B.Fab" user)
\t)`

const STACKUP = `\t(setup
\t\t(stackup
\t\t\t(layer "F.SilkS" (type "Top Silk Screen"))
\t\t\t(layer "F.Paste" (type "Top Solder Paste"))
\t\t\t(layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
\t\t\t(layer "F.Cu" (type "copper") (thickness 0.035))
\t\t\t(layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
\t\t\t(layer "B.Cu" (type "copper") (thickness 0.035))
\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))
\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen"))
\t\t\t(copper_finish "None")
\t\t\t(dielectric_constraints no)
\t\t)
\t\t(pad_to_mask_clearance 0)
\t\t(allow_soldermask_bridges_in_footprints no)
\t)`

const BOARD: [number, number, number, number] = [100, 100, 160, 140]

function board(): string {
  const [x0, y0, x1, y1] = BOARD
  const m = 0.5
  return [
    '(kicad_pcb',
    '\t(version 20260206)',
    '\t(generator "pcbnew")',
    '\t(generator_version "10.0")',
    '\t(general (thickness 1.6) (legacy_teardrops no))',
    '\t(paper "A4")',
    '\t(title_block (title "trace-sample") (rev "A") (company "trace sample"))',
    LAYERS,
    STACKUP,
    ...PARTS.map(footprint),
    ...(UNROUTED ? [] : routing()),
    `\t(zone (net "GND") (layer "B.Cu") (uuid ${q(uuid('zone/gnd'))}) (name "GND pour") (hatch edge 0.5)`,
    '\t\t(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no)',
    '\t\t(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 0))',
    `\t\t(polygon (pts (xy ${n(x0 + m)} ${n(y0 + m)}) (xy ${n(x1 - m)} ${n(y0 + m)}) (xy ${n(x1 - m)} ${n(y1 - m)}) (xy ${n(x0 + m)} ${n(y1 - m)})))`,
    '\t)',
    `\t(gr_rect (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid ${q(uuid('edge'))}))`,
    `\t(gr_text "TRACE SAMPLE rev A" (at ${n((x0 + x1) / 2)} ${n(y0 + 2)} 0) (layer "F.SilkS") (uuid ${q(uuid('title'))}) (effects (font (size 1 1) (thickness 0.15))))`,
    '\t(embedded_fonts no)',
    ')',
    '',
  ].join('\n')
}

// ------------------------------------------------------------------ project file and library tables

function projectFile(): string {
  const pro = JSON.parse(readFileSync(join(SHARE, 'template', 'kicad.kicad_pro'), 'utf8')) as {
    board: { design_settings: { rules: Record<string, number> } }
    meta: { filename: string }
    net_settings: { classes: Record<string, unknown>[] }
  }
  pro.meta.filename = `${NAME}.kicad_pro`
  // Rules a low-cost 2-layer fab (JLCPCB standard) builds comfortably.
  pro.board.design_settings.rules = {
    min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.5, min_through_hole_diameter: 0.3,
    min_via_annular_width: 0.1, min_copper_edge_clearance: 0.5, min_hole_clearance: 0.25, min_hole_to_hole: 0.25,
  }
  pro.net_settings.classes = [{
    name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, microvia_diameter: 0.3,
    microvia_drill: 0.1, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, bus_width: 12, wire_width: 6,
    line_style: 0, priority: 2147483647, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)', tuning_profile: '',
  }]
  return `${JSON.stringify(pro, null, 2)}\n`
}

function libTable(kind: 'sym' | 'fp', names: readonly string[]): string {
  const dir = kind === 'sym' ? '${KICAD10_SYMBOL_DIR}' : '${KICAD10_FOOTPRINT_DIR}'
  const ext = kind === 'sym' ? '.kicad_sym' : '.pretty'
  return [`(${kind}_lib_table`, '\t(version 7)',
    ...names.map((l) => `\t(lib (name ${q(l)}) (type "KiCad") (uri ${q(`${dir}/${l}${ext}`)}) (options "") (descr ""))`), ')', ''].join('\n')
}

// ------------------------------------------------------------------ write, fill, check

function cli(args: string[]): string {
  try {
    return execFileSync(CLI, args, { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    throw new Error(`kicad-cli ${args.slice(0, 3).join(' ')} failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  }
}

function main(): void {
  mkdirSync(OUT, { recursive: true })
  const sch = join(OUT, `${NAME}.kicad_sch`)
  const pcb = join(OUT, `${NAME}.kicad_pcb`)
  writeFileSync(join(OUT, `${NAME}.kicad_pro`), projectFile())
  writeFileSync(join(OUT, 'sym-lib-table'), libTable('sym', ['Amplifier_Operational', 'Connector_Generic', 'Device', 'Diode', 'Regulator_Linear', 'power']))
  writeFileSync(join(OUT, 'fp-lib-table'), libTable('fp', ['Capacitor_SMD', 'Connector_PinHeader_2.54mm', 'LED_SMD', 'Package_TO_SOT_SMD', 'Resistor_SMD']))
  writeFileSync(sch, schematic())
  writeFileSync(pcb, board())
  // KiCad fills the pour and saves the board in its own form
  cli(['pcb', 'drc', '--refill-zones', '--save-board', '--format', 'json', '-o', join(OUT, 'fill-drc.json'), pcb])
  rmSync(join(OUT, 'fill-drc.json'), { force: true })
  rmSync(join(OUT, `${NAME}.kicad_prl`), { force: true })
  // ERC and DRC
  const report = (args: string[], file: string): { errors: number; warnings: number; lines: string[] } => {
    const out = join(OUT, file)
    cli([...args.slice(0, -1), '--format', 'json', '--severity-all', '-o', out, args[args.length - 1] as string])
    const r = JSON.parse(readFileSync(out, 'utf8')) as { sheets?: { violations: V[] }[]; violations?: V[]; unconnected_items?: V[]; schematic_parity?: V[] }
    rmSync(out, { force: true })
    type V = { severity: string; type: string; description: string; items: { description: string }[] }
    const vs: V[] = [...(r.sheets ?? []).flatMap((s) => s.violations), ...(r.violations ?? []), ...(r.unconnected_items ?? []), ...(r.schematic_parity ?? [])]
    return { errors: vs.filter((v) => v.severity === 'error').length, warnings: vs.filter((v) => v.severity === 'warning').length,
      lines: vs.map((v) => `${v.severity} ${v.type}: ${v.description} [${v.items.map((i) => i.description).join('; ')}]`) }
  }
  const erc = report(['sch', 'erc', sch], 'erc.json')
  const drc = report(['pcb', 'drc', '--schematic-parity', pcb], 'drc.json')
  rmSync(join(OUT, `${NAME}.kicad_prl`), { force: true })
  for (const l of [...erc.lines, ...drc.lines]) if (!(UNROUTED && l.startsWith('error unconnected_items'))) console.log(l)
  console.log(`ERC: ${erc.errors} errors, ${erc.warnings} warnings; DRC: ${drc.errors} errors, ${drc.warnings} warnings`)
  // the unrouted copy (layout/) has every connection open by design: there only the other errors count
  const drcErrors = UNROUTED ? drc.lines.filter((l) => l.startsWith('error') && !l.startsWith('error unconnected_items')).length : drc.errors
  if (erc.errors || drcErrors) process.exit(1)
}

main()
