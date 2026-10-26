/**
 * Generates the sensor-node KiCad project (hardware/): schematic, board, project file and project library tables.
 *
 * Run once from the repository root with `npx tsx examples/sensor-node/tools/generate.ts`. The committed KiCad files
 * are this script's output, finished by KiCad itself: the board's ground pour is filled by
 * `kicad-cli pcb drc --refill-zones --save-board`, so the file on disk is what KiCad would save. The script ends by
 * running ERC and DRC (with schematic parity) and fails unless both report zero errors.
 *
 * Why a script: the symbols and footprints are copied from KiCad's own standard libraries (so ERC and DRC can check
 * them against the library), and the board's placement and routing are written out as coordinates, so the whole
 * design can be read and re-made from one file. The circuit and the reasons for each value are in ../README.md.
 *
 * Needs KiCad 10 (kicad-cli on PATH, its libraries at $KICAD_SHARE or /usr/share/kicad).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'hardware')
const NAME = 'sensor-node'
const SHARE = process.env.KICAD_SHARE ?? ['/usr/share/kicad', '/usr/local/share/kicad', '/Applications/KiCad/KiCad.app/Contents/SharedSupport']
  .find((d) => existsSync(join(d, 'symbols'))) ?? '/usr/share/kicad'
const CLI = process.env.KICAD_CLI ?? 'kicad-cli'

/** A stable UUID from a name, so regenerating gives the same file. */
function uuid(name: string): string {
  const h = createHash('sha256').update(`sensor-node/${name}`).digest('hex')
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
const uniroyal = (mpn: string, lcsc: string): Record<string, string> => ({ MPN: mpn, Manufacturer: 'UNI-ROYAL', LCSC: lcsc })

const PARTS: Part[] = [
  { ref: 'J1', lib: 'Connector_Generic', sym: 'Conn_01x02', value: 'SENSOR_IN', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    fields: { MPN: 'PZ254V-11-02P', Manufacturer: 'XFCN', LCSC: 'C492401' }, sch: [40.64, 88.9], pcb: [103, 111, 0],
    pads: { 1: 'VIN', 2: 'GND' }, description: 'Sensor input, 0-12 V' },
  { ref: 'R1', lib: 'Device', sym: 'R', value: '39k', footprint: R0603, fields: uniroyal('0603WAF3902T5E', 'C23153'),
    sch: [63.5, 76.2], pcb: [108, 111, 0], pads: { 1: 'VIN', 2: 'DIV' }, description: 'Divider top, 1 %' },
  { ref: 'R2', lib: 'Device', sym: 'R', value: '13k', footprint: R0603, fields: uniroyal('0603WAF1302T5E', 'C22797'),
    sch: [63.5, 101.6], pcb: [112, 115, 0], pads: { 1: 'DIV', 2: 'GND' }, description: 'Divider bottom, 1 %' },
  { ref: 'R3', lib: 'Device', sym: 'R', value: '6k2', footprint: R0603, fields: uniroyal('0603WAF6201T5E', 'C4260'),
    sch: [88.9, 76.2], pcb: [116, 111, 0], pads: { 1: 'DIV', 2: 'ADC_IN' }, description: 'Anti-alias filter R (with the divider\'s 9.75k source: 15.95k)' },
  { ref: 'C1', lib: 'Device', sym: 'C', value: '10n', footprint: C0603,
    fields: { MPN: 'CL10B103KB8NNNC', Manufacturer: 'Samsung Electro-Mechanics', LCSC: 'C1589' },
    sch: [114.3, 101.6], pcb: [121, 114, 0], pads: { 1: 'ADC_IN', 2: 'GND' }, description: 'Anti-alias filter C, X7R 50 V' },
  { ref: 'D1', lib: 'Diode', sym: 'BAT54S', value: 'BAT54S', footprint: 'Package_TO_SOT_SMD:SOT-23',
    fields: { MPN: 'BAT54S-7-F', Manufacturer: 'Diodes Incorporated', LCSC: 'C83574' },
    sch: [149.86, 88.9], pcb: [126, 114, 0], pads: { 1: 'GND', 2: '+3V3', 3: 'ADC_IN' }, description: 'ADC input clamp to GND and 3V3' },
  { ref: 'C2', lib: 'Device', sym: 'C', value: '100n', footprint: C0603,
    fields: { MPN: 'CC0603KRX7R9BB104', Manufacturer: 'YAGEO', LCSC: 'C14663' },
    sch: [175.26, 101.6], pcb: [133, 105.92, 0], pads: { 1: '+3V3', 2: 'GND' }, description: '3V3 decoupling at the clamp' },
  { ref: 'J2', lib: 'Connector_Generic', sym: 'Conn_01x04', value: 'MCU', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical',
    fields: { MPN: 'PZ254V-11-04P', Manufacturer: 'XFCN', LCSC: 'C2691448' }, sch: [220.98, 88.9], pcb: [137, 105.92, 0],
    pads: { 1: '+3V3', 2: 'GND', 3: 'ADC_IN', 4: 'LED' }, powerRoute: { 2: [12.7, 10.16] }, description: 'To the MCU: 3V3, GND, ADC_IN, LED' },
  { ref: 'R4', lib: 'Device', sym: 'R', value: '680', footprint: R0603, fields: uniroyal('0603WAF6800T5E', 'C23228'),
    sch: [190.5, 127], pcb: [131.5, 119, 0], pads: { 1: 'LED', 2: 'LED_A' }, description: 'LED series resistor, about 1.9 mA from a 3V3 GPIO' },
  { ref: 'D2', lib: 'Device', sym: 'LED', value: 'RED', footprint: 'LED_SMD:LED_0603_1608Metric',
    fields: { MPN: 'KT-0603R', Manufacturer: 'Hubei KENTO Elec', LCSC: 'C2286' },
    sch: [175.26, 139.7], pcb: [136, 119, 180], pads: { 1: 'GND', 2: 'LED_A' }, description: 'Status LED' },
]

/** Pin end points of each symbol (schematic coordinates, y down) relative to its position, and the way each pin
 * points out of the symbol (labels and power symbols continue in that direction). */
type Dir = 'up' | 'down' | 'left' | 'right'
const PIN_OFFSETS: Record<string, Record<string, [number, number, Dir]>> = {
  R: { 1: [0, -3.81, 'up'], 2: [0, 3.81, 'down'] },
  C: { 1: [0, -3.81, 'up'], 2: [0, 3.81, 'down'] },
  LED: { 1: [-3.81, 0, 'left'], 2: [3.81, 0, 'right'] },
  BAT54S: { 1: [-7.62, 0, 'left'], 2: [7.62, 0, 'right'], 3: [0, 5.08, 'down'] },
  Conn_01x02: { 1: [-5.08, 0, 'left'], 2: [-5.08, 2.54, 'left'] },
  Conn_01x04: { 1: [-5.08, -2.54, 'left'], 2: [-5.08, 0, 'left'], 3: [-5.08, 2.54, 'left'], 4: [-5.08, 5.08, 'left'] },
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
    const ds = p.sym === 'BAT54S' ? 'https://www.diodes.com/assets/Datasheets/ds11005.pdf' : '~'
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
  // The supplies come in through J2 (and J1 for ground): PWR_FLAGs tell ERC they are driven from off the board.
  for (const [i, net] of (['+3V3', 'GND'] as const).entries()) {
    const x = 40.64 + i * 20.32
    const y = 127
    out.push(symbolInstance('power', 'PWR_FLAG', `#FLG0${i + 1}`, 'PWR_FLAG', '', x, y, ['1'], {}, '~',
      'Special symbol for telling ERC where power comes from'))
    out.push(wire([x, y], [x + 7.62, y]))
    power(net, x + 7.62, y, net === 'GND' ? 'down' : 'up')
  }
  const libs = [['Connector_Generic', 'Conn_01x02'], ['Connector_Generic', 'Conn_01x04'], ['Device', 'C'], ['Device', 'LED'], ['Device', 'R'],
    ['Diode', 'BAT54S'], ['power', '+3V3'], ['power', 'GND'], ['power', 'PWR_FLAG']] as const
  return [
    '(kicad_sch',
    '\t(version 20260306)',
    '\t(generator "eeschema")',
    '\t(generator_version "10.0")',
    `\t(uuid ${q(ROOT)})`,
    '\t(paper "A4")',
    '\t(title_block (title "Sensor node: 12 V sensor input to a 3.3 V ADC") (rev "A") (company "trace example")',
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
  const props = ([['Datasheet', p.sym === 'BAT54S' ? 'https://www.diodes.com/assets/Datasheets/ds11005.pdf' : '~'], ['Description', p.description],
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

/** Copper: signals on F.Cu; 3V3 crosses the ADC line on B.Cu; every SMD ground pad has its own via into the B.Cu pour. */
function routing(): string[] {
  return [
    // VIN: J1.1 to R1.1
    ...path([[103, 111], [107.175, 111]], 'VIN'),
    // DIV: R1.2 to R3.1, with R2.1 teed off at x = 111.175
    ...path([[108.825, 111], [111.175, 111], [115.175, 111]], 'DIV'),
    ...path([[111.175, 111], [111.175, 115]], 'DIV'),
    // ADC_IN: R3.2 along y = 111 to J2.3, with C1.1 and D1.3 teed off
    ...path([[116.825, 111], [120.225, 111], [126.9375, 111], [137, 111]], 'ADC_IN'),
    ...path([[120.225, 111], [120.225, 114]], 'ADC_IN'),
    ...path([[126.9375, 111], [126.9375, 114]], 'ADC_IN'),
    // +3V3: D1.2 down to a via, along B.Cu to J2.1; C2.1 joins through a via at the corner
    ...path([[125.0625, 114.95], [125.0625, 116.6]], '+3V3'),
    via([125.0625, 116.6], '+3V3'),
    ...path([[125.0625, 116.6], [131, 116.6], [131, 105.92], [137, 105.92]], '+3V3', 'B.Cu'),
    via([131, 105.92], '+3V3'),
    ...path([[131, 105.92], [132.225, 105.92]], '+3V3'),
    // LED: J2.4 to R4.1, R4.2 to D2 anode
    ...path([[137, 113.54], [129.5, 113.54], [129.5, 119], [130.675, 119]], 'LED'),
    ...path([[132.325, 119], [135.2125, 119]], 'LED_A'),
    // ground vias
    ...path([[112.825, 115], [114.2, 115]], 'GND'), via([114.2, 115], 'GND'),
    ...path([[121.775, 114], [121.775, 115.8]], 'GND'), via([121.775, 115.8], 'GND'),
    ...path([[125.0625, 113.05], [123.6, 113.05]], 'GND'), via([123.6, 113.05], 'GND'),
    ...path([[133.775, 105.92], [133.775, 104.2]], 'GND'), via([133.775, 104.2], 'GND'),
    ...path([[136.7875, 119], [138.2, 119]], 'GND'), via([138.2, 119], 'GND'),
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

const BOARD: [number, number, number, number] = [100, 100, 140, 125]

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
    '\t(title_block (title "Sensor node") (rev "A") (company "trace example"))',
    LAYERS,
    STACKUP,
    ...PARTS.map(footprint),
    ...routing(),
    `\t(zone (net "GND") (layer "B.Cu") (uuid ${q(uuid('zone/gnd'))}) (name "GND pour") (hatch edge 0.5)`,
    '\t\t(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no)',
    '\t\t(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 0))',
    `\t\t(polygon (pts (xy ${n(x0 + m)} ${n(y0 + m)}) (xy ${n(x1 - m)} ${n(y0 + m)}) (xy ${n(x1 - m)} ${n(y1 - m)}) (xy ${n(x0 + m)} ${n(y1 - m)})))`,
    '\t)',
    `\t(gr_rect (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid ${q(uuid('edge'))}))`,
    `\t(gr_text "SENSOR NODE rev A" (at ${n((x0 + x1) / 2)} ${n(y0 + 2)} 0) (layer "F.SilkS") (uuid ${q(uuid('title'))}) (effects (font (size 1 1) (thickness 0.15))))`,
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
  writeFileSync(join(OUT, 'sym-lib-table'), libTable('sym', ['Connector_Generic', 'Device', 'Diode', 'power']))
  writeFileSync(join(OUT, 'fp-lib-table'), libTable('fp', ['Capacitor_SMD', 'Connector_PinHeader_2.54mm', 'LED_SMD', 'Package_TO_SOT_SMD', 'Resistor_SMD']))
  writeFileSync(sch, schematic())
  writeFileSync(pcb, board())
  // KiCad fills the pour and saves the board in its own form
  cli(['pcb', 'drc', '--refill-zones', '--save-board', '--format', 'json', '-o', join(OUT, 'fill-drc.json'), pcb])
  rmSync(join(OUT, 'fill-drc.json'), { force: true })
  rmSync(join(OUT, `${NAME}.kicad_prl`), { force: true })
  // the checks the README promises
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
  for (const l of [...erc.lines, ...drc.lines]) console.log(l)
  console.log(`ERC: ${erc.errors} errors, ${erc.warnings} warnings; DRC: ${drc.errors} errors, ${drc.warnings} warnings`)
  if (erc.errors || drc.errors) process.exit(1)
}

main()
