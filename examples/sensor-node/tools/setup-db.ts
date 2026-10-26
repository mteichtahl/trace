/**
 * Writes the sample's settings into its project database, .trace/project.db, the way `trace config set` would:
 * through config.setValue, which checks every value against the settings schema before storing it.
 *
 *   electronics.projects  the KiCad project the kicad.* tools and `trace check` use
 *   electronics.models    SPICE models included in every simulation (the BAT54S clamp diode)
 *   firmware.targets      the C module, built and unit-tested on the host with make
 *   thermal               the envelope "bench" (0 to 60 C, natural convection, horizontal), the parts' thermal
 *                         limits with their sources, the power budget "nominal" and R4's power derating curve
 *                         (src/tools/thermal/store.ts tables), so thermal.check has a real board to run on
 *   protocol_specs        the SPI interface of an ADC reading ADC_IN, "SPI-ADC-12 (fixture)", and the MCU's SPI
 *                         master, "sensor-mcu (fixture)": no real datasheet is in the shared library, so both are
 *                         marked fixtures with illustrative figures (verified: null), for protocol.check,
 *                         protocol.compat and protocol.diagram (README section 7)
 *
 * Run once from the repository root: `npx tsx examples/sensor-node/tools/setup-db.ts` (or bundle it with esbuild and
 * run the bundle with node). The database is rebuilt from
 * scratch, so it holds these settings and no run history. .trace/rules.md is the owner's to write and is left empty.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, setValue } from '../../../src/core/config.js'
import { open, PROJECT_SCHEMA } from '../../../src/core/store.js'
import { putSpecRows } from '../../../src/tools/protocol/spec.js'
import { putBudget, putCurve, putEnvelope, putPartLimit } from '../../../src/tools/thermal/store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB = join(ROOT, '.trace', 'project.db')
const BY = 'examples/sensor-node/tools/setup-db.ts'

mkdirSync(dirname(DB), { recursive: true })
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
// The database must exist before settings are written: it is what marks this folder as a project root.
const db = open(DB, { wal: false })
db.exec(PROJECT_SCHEMA)
db.close()

setValue('electronics.projects', ['hardware/sensor-node.kicad_pro'], ROOT, BY)
setValue('electronics.models', ['sim/models'], ROOT, BY)
setValue('firmware.targets', [{
  name: 'adc-convert',
  path: 'firmware',
  preset: 'make',
  build: 'make all test',
  artifact: 'build/libadc.a',
  env: {},
}], ROOT, BY)

// ---- thermal: the envelope, the limits, the budget (every figure with its source)
process.env.TRACE_PROJECT_DB = DB
putEnvelope({
  name: 'bench', ambient_min_c: 0, ambient_max_c: 60, environment: 'natural', orientation: 'horizontal', altitude_m: 0,
  derating: { kind: 'offset', value_c: 20 }, source: 'examples/sensor-node: a bench instrument, 0 to 60 C ambient, still air',
})
// UNI-ROYAL 0603WAF thick-film chip resistors: rated 1/10 W at 70 C, derated linearly to 0 W at 155 C (the series
// datasheet's power derating curve). The element limit is 155 C, and the curve implies (155 - 70) C / 0.1 W = 850 C/W
// from element to ambient. The datasheet is not in the library here: recalled, verified: null.
const uniroyal = 'UNI-ROYAL 0603WAF series datasheet, power derating curve (1/10 W at 70 C to 0 W at 155 C); recalled, verified: null (add the PDF with datasheets.add and cite its page)'
for (const [ref, mpn] of [['R1', '0603WAF3902T5E'], ['R2', '0603WAF1302T5E'], ['R4', '0603WAF6800T5E']] as const) {
  putPartLimit('bench', { ref, mpn, package: '0603', tj_max_c: 155, theta_ja: 850, citations: { tj_max_c: { source: uniroyal }, theta_ja: { source: `${uniroyal}; (155 - 70) / 0.1` } } })
}
// KT-0603R: its datasheet gives an operating ambient range and no junction figures, so D2 has no Tj_max here and the
// check reports it as unknown rather than guessing one.
putPartLimit('bench', { ref: 'D2', mpn: 'KT-0603R', package: '0603', notes: 'no junction temperature or thermal resistance in the datasheet: add them from a source before relying on a verdict' })
putCurve({ ref: 'R4', curve: 'power_vs_ambient', x_unit: 'C', y_unit: 'W', points: [[-55, 0.1], [70, 0.1], [155, 0]], citation: { source: uniroyal } })
// the operating point: 12 V across R1 + R2 (52 k: 231 uA, calc.divider), and the LED at (3.3 - 1.8) / 680 = 2.2 mA
// (calc.led_resistor, Vf 1.8 V typical as README section 1 chose it)
putBudget([
  { ref: 'R1', rail: 'VIN', power_w: (12 / 52e3) ** 2 * 39e3, power_max_w: null, method: 'explicit', citation: { source: 'I^2 R with I = 12 V / 52 k (calc.divider, README section 1)' } },
  { ref: 'R2', rail: 'VIN', power_w: (12 / 52e3) ** 2 * 13e3, power_max_w: null, method: 'explicit', citation: { source: 'I^2 R with I = 12 V / 52 k (calc.divider, README section 1)' } },
  { ref: 'R4', rail: '3V3', power_w: (1.5 / 680) ** 2 * 680, power_max_w: null, method: 'explicit', citation: { source: 'I^2 R with I = (3.3 - 1.8) V / 680 (calc.led_resistor, README section 1)' } },
  { ref: 'D2', rail: '3V3', power_w: 1.8 * (1.5 / 680), power_max_w: null, method: 'explicit', citation: { source: 'Vf x I = 1.8 V x 2.2 mA (calc.led_resistor, README section 1)' } },
], 'nominal')

// ---- protocol: the SPI ADC on ADC_IN and the MCU that reads it. No SPI ADC datasheet is in the shared library, so
// these are fixtures: illustrative figures of the size such parts have, not any real part's, and every row says so.
const fixture = (what: string): { source: string } => ({ source: `fixture: ${what}; illustrative, not a real part's datasheet (verified: null)` })
const adc = fixture('SPI-ADC-12, a generic 12-bit SPI ADC for examples/sensor-node')
putSpecRows('SPI-ADC-12 (fixture)', 'spi', 'responder', [
  { parameter: 'f_sck', max: 2, unit: 'MHz', citation: adc },
  { parameter: 't_sck_high', min: 200, unit: 'ns', citation: adc },
  { parameter: 't_sck_low', min: 200, unit: 'ns', citation: adc },
  { parameter: 'tcss', min: 100, unit: 'ns', citation: adc },
  { parameter: 'tcsh', min: 50, unit: 'ns', citation: adc },
  { parameter: 'tcsd', min: 500, unit: 'ns', citation: adc },
  { parameter: 'tsu', min: 50, unit: 'ns', citation: adc },
  { parameter: 'th', min: 50, unit: 'ns', citation: adc },
  { parameter: 'tv', max: 125, unit: 'ns', citation: adc },
  { parameter: 'tho', min: 10, unit: 'ns', citation: adc },
  { parameter: 'modes', value: [0, 3], citation: adc },
  { parameter: 'word_bits', value: [16], citation: adc },
], BY)
const mcu = fixture('sensor-mcu, the SPI master of a small MCU for examples/sensor-node')
putSpecRows('sensor-mcu (fixture)', 'spi', 'initiator', [
  { parameter: 'f_sck', max: 8, unit: 'MHz', citation: mcu },
  { parameter: 'tv', max: 15, unit: 'ns', citation: mcu },
  { parameter: 'tho', min: 0, unit: 'ns', citation: mcu },
  { parameter: 'tsu_mi', min: 20, unit: 'ns', citation: mcu },
  { parameter: 'th_mi', min: 5, unit: 'ns', citation: mcu },
  { parameter: 'tcss', min: 500, unit: 'ns', citation: mcu },
  { parameter: 'tcsh', min: 500, unit: 'ns', citation: mcu },
  { parameter: 'tcsd', min: 1000, unit: 'ns', citation: mcu },
  { parameter: 'modes', value: [0, 1, 2, 3], citation: mcu },
], BY)

const rules = join(ROOT, '.trace', 'rules.md')
if (!existsSync(rules)) writeFileSync(rules, '')

const cfg = load(ROOT)
console.log(JSON.stringify({ root: cfg.root, electronics: cfg.electronics, firmware: cfg.firmware, thermal: { envelope: 'bench', budget: 'nominal' }, protocol: ['SPI-ADC-12 (fixture)', 'sensor-mcu (fixture)'] }, null, 1))
