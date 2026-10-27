/**
 * The sample project's verification and design records, written into its project database after onboarding has
 * created it (core/onboard.ts writeFiles): what a person and the agents would otherwise build up over the first
 * stages of the journey, so the tour's tasks start from a project that already has
 *
 *   requirements      docs/spec.md's REQ-* (the same ids and text), each with its acceptance criterion
 *   test_items        one or more per requirement, covering every method: sim, formal, spice, hil, inspection, drc;
 *                     each a real tool call (args checked against the tool's schema by the same code verify.plan uses)
 *   coverage_points   the TRACE_COVER and cover() names the sample's testbenches, cocotb tests and properties emit
 *   ams_specs         the front end's and the buffer's limits, which ams.corners / montecarlo_yield / opamp_check
 *                     judge against
 *   protocol_specs    TRC-TMP1's I2C timing (a FICTIONAL part: its datasheet is docs/datasheets/TRC-TMP1.pdf, not in
 *                     the shared library yet, so every row is `verified: null` until protocol.spec_extract re-cites it)
 *                     and the console UART and status CAN figures (from the spec: the sample's own design choices)
 *   thermal           the envelope "enclosure" (0 to 50 C, still air, vertical, Tj <= Tj_max - 20 C), the parts'
 *                     limits with their sources, the power budget "nominal" from power/ldo.cir's operating point, and
 *                     U1's power derating curve
 *
 * Every write goes through the module that owns the table (verify/db.ts, ams/spec.ts, protocol/spec.ts,
 * thermal/store.ts). Those open the project database at $TRACE_PROJECT_DB, which is set for the duration and restored
 * afterwards. Seeding twice leaves the same rows: existing requirements and test items are updated, specs replaced.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { putSpec } from '../tools/ams/spec.js'
import { putSpecRows, type SpecRowIn } from '../tools/protocol/spec.js'
import { putBudget, putCurve, putEnvelope, putPartLimit } from '../tools/thermal/store.js'
import { VerifyDb, type Expect, type Requirement, type TestItem } from '../tools/verify/db.js'
import { validateToolArgs } from '../tools/verify/run.js'
import type { Json } from '../core/store.js'

const BY = 'trace installer (sample seed)'
const SPEC = 'docs/spec.md'

// ------------------------------------------------------------------ requirements (docs/spec.md)

interface Req { id: string; kind: Requirement['kind']; text: string; acceptance: string; tags: string[] }

export const SAMPLE_REQUIREMENTS: readonly Req[] = [
  { id: 'REQ-PWR-001', kind: 'electrical', text: 'The board shall run from 4.5 V to 13 V at J1.', acceptance: 'The 3V3 rail stays within 3.2 to 3.4 V for VIN from 4.5 V to 13 V.', tags: ['power'] },
  { id: 'REQ-PWR-002', kind: 'electrical', text: 'The 3V3 rail shall supply at least 50 mA.', acceptance: 'U1 dissipates at most 0.6 W at VIN = 12 V with a 43 mA load (power/ldo.cir).', tags: ['power', 'thermal'] },
  { id: 'REQ-ANA-001', kind: 'electrical', text: 'The ADC input shall read the rail as VIN / 4 within ±1 % of full scale.', acceptance: 'ADC_IN = 1.47 to 1.53 V at VIN = 6 V across component, supply and temperature corners.', tags: ['analog'] },
  { id: 'REQ-ANA-002', kind: 'electrical', text: 'The anti-alias filter corner shall be between 850 Hz and 1250 Hz.', acceptance: 'The -3 dB frequency of ADC_IN is 850 to 1250 Hz at mid-scale.', tags: ['analog'] },
  { id: 'REQ-ANA-003', kind: 'electrical', text: 'The buffer U2 shall be stable driving the ADC input.', acceptance: 'Phase margin at least 45 degrees as a follower with 10 pF load.', tags: ['analog'] },
  { id: 'REQ-ANA-004', kind: 'electrical', text: 'The front end noise at ADC_IN shall be below 0.1 LSB.', acceptance: 'Integrated output noise from 1 Hz to 1 MHz is at most 80 µV rms.', tags: ['analog'] },
  { id: 'REQ-TIM-001', kind: 'timing', text: 'A step at J1 shall settle at ADC_IN within 1 ms.', acceptance: 'Settling to 1 % within 1 ms.', tags: ['analog'] },
  { id: 'REQ-IF-001', kind: 'timing', text: 'The I2C bus shall meet fast-mode timing at 400 kHz.', acceptance: 'Every UM10204 fast-mode limit passes on the I2C capture (protocol/i2c-tmp1-read.vcd).', tags: ['interface', 'i2c'] },
  { id: 'REQ-IF-002', kind: 'timing', text: 'The console UART shall run at 115200 baud, 8N1.', acceptance: 'Baud error at most 2 % and no framing errors on the console capture.', tags: ['interface', 'uart'] },
  { id: 'REQ-IF-003', kind: 'electrical', text: 'The I2C pull-ups shall give a rise time of at most 300 ns with 50 pF on the bus.', acceptance: 'Rise time at most 300 ns.', tags: ['interface', 'i2c'] },
  { id: 'REQ-IF-004', kind: 'timing', text: 'The status frame shall go out on CAN at 500 kbit/s once a second.', acceptance: 'The frame with id 0x321 is decoded with a valid CRC.', tags: ['interface', 'can'] },
  { id: 'REQ-FW-001', kind: 'functional', text: 'The firmware shall convert ADC counts to millivolts at the input.', acceptance: '3722 counts read 11998 mV, and the host unit test passes.', tags: ['firmware'] },
  { id: 'REQ-FW-002', kind: 'functional', text: 'The averaging filter shall output the mean of the last four samples.', acceptance: 'The testbench, the cocotb tests and the formal properties all pass.', tags: ['logic'] },
  { id: 'REQ-FW-003', kind: 'timing', text: 'The FPGA build of the logic shall meet timing at 12 MHz.', acceptance: 'The place and route closes with positive slack at 12 MHz on the iCE40 UP5K.', tags: ['logic', 'fpga'] },
  { id: 'REQ-THM-001', kind: 'electrical', text: "U1's junction shall stay at least 20 °C below its maximum at 50 °C ambient.", acceptance: 'Junction temperature at most 105 °C at 50 °C ambient.', tags: ['thermal'] },
  { id: 'REQ-EMC-001', kind: 'emc', text: 'Radiated emissions shall meet CISPR 32 class B with at least 6 dB margin.', acceptance: 'The pre-compliance estimate margin is at least 6 dB from 30 MHz to 1 GHz.', tags: ['emc'] },
  { id: 'REQ-LAY-001', kind: 'functional', text: 'The board shall pass DRC and ERC with no errors.', acceptance: 'KiCad ERC and DRC (with schematic parity) report 0 errors.', tags: ['layout'] },
  { id: 'REQ-LAY-002', kind: 'functional', text: 'Every part shall have an LCSC code and be in stock for 10 boards.', acceptance: 'The BOM check flags no line.', tags: ['build'] },
  { id: 'REQ-HIL-001', kind: 'functional', text: 'On the bench at 12 V the board shall report the rail within 1 %.', acceptance: 'The DMM reads 2.97 to 3.03 V on ADC_IN and the console prints a reading from 11880 to 12120 mV.', tags: ['bench'] },
]

// ------------------------------------------------------------------ the test plan (every method)

interface Plan { id: string; title: string; requirements: string[]; method: TestItem['method']; tool?: string; args?: Record<string, Json>; command?: string[]; expect?: Expect[]; note?: string }

const mid = { vin_dc: 6 }
export const SAMPLE_TESTS: readonly Plan[] = [
  // spice: the analog front end, the buffer, the power stage
  { id: 'TST-ANA-001', title: 'Front end gain across corners (ams.corners, spec set front-end)', requirements: ['REQ-ANA-001', 'REQ-ANA-002'], method: 'spice', tool: 'ams.corners',
    args: { path: 'sim/front-end-corners.cir', spec_set: 'front-end', measurements: [{ name: 'vadc_mid', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }],
      model_corners: [{ name: 'tt', lib: { section: 'tt' } }, { name: 'ff', lib: { section: 'ff' } }, { name: 'ss', lib: { section: 'ss' } }], supplies: [{ param: 'vdd', nominal: 3.3, tol: 0.05 }], temps: [-20, 25, 70] } },
  { id: 'TST-ANA-002', title: 'Filter corner at mid-scale (sim.spice)', requirements: ['REQ-ANA-002'], method: 'spice', tool: 'sim.spice',
    args: { path: 'sim/front-end.cir', params: mid, analyses: ['.op', '.ac dec 50 1 1meg'], measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }] },
    expect: [{ measurement: 'f3db', min: 850, max: 1250 }] },
  { id: 'TST-ANA-003', title: 'Buffer stability as a follower (ams.opamp_check)', requirements: ['REQ-ANA-003'], method: 'spice', tool: 'ams.opamp_check',
    args: { path: 'sim/models/TRC_OPA1.lib', name: 'TRC_OPA1', pins: ['inp', 'inn', 'vcc', 'vee', 'out'], vcc: 3.3, vee: 0, rl: 1e6, cl: 10e-12, spec_set: 'buffer' } },
  { id: 'TST-ANA-004', title: 'Front end noise (ams.noise)', requirements: ['REQ-ANA-004'], method: 'spice', tool: 'ams.noise',
    args: { path: 'sim/noise.cir', output: 'adc_in', source: 'V1', fstart: 1, fstop: 1e6, spec_rms: 80e-6 } },
  { id: 'TST-TIM-001', title: 'Step settles at ADC_IN within 1 ms (sim.spice)', requirements: ['REQ-TIM-001'], method: 'spice', tool: 'sim.spice',
    args: { path: 'sim/front-end.cir', analyses: ['.tran 2u 5m'], measurements: [{ name: 'settle', kind: 'settling', vector: 'v(adc_in)', from: 0.001, band: 0.01 }] },
    expect: [{ measurement: 'settle', max: 0.001 }] },
  { id: 'TST-PWR-001', title: 'LDO dissipation at 12 V (thermal.budget from power/ldo.cir)', requirements: ['REQ-PWR-002'], method: 'spice', tool: 'sim.spice',
    args: { path: 'power/ldo.cir', analyses: ['.op'], measurements: [{ name: 'p_u1', kind: 'value_at', vector: 'v(p_u1)', analysis: 'op' }] },
    expect: [{ measurement: 'p_u1', max: 0.6 }] },
  { id: 'TST-PWR-002', title: '3V3 holds across the input range (sim.sweep)', requirements: ['REQ-PWR-001'], method: 'spice', tool: 'sim.sweep',
    args: { path: 'power/ldo.cir', analyses: ['.op'], axes: [{ param: 'vin', values: [4.5, 12, 13] }], measurements: [{ name: 'v3v3', kind: 'value_at', vector: 'v(3v3)', analysis: 'op' }] },
    note: 'U1 is modelled as ideal regulation above dropout; the bench (TST-HIL-001) is the real proof' },
  { id: 'TST-THM-001', title: "U1's junction at 50 C ambient (calc.ldo_thermal)", requirements: ['REQ-THM-001'], method: 'spice', tool: 'calc.ldo_thermal',
    args: { vin: 12, vout: 3.3, current: 0.0434, iq: 0.005, theta_ja: 90, ambient: 50, tj_max: 125 },
    note: 'a hand calculation through theta-JA; the thermal specialist replaces it with thermal.check on the board model' },
  // sim: logic and protocols
  { id: 'TST-FW-002', title: 'Moving average testbench (sim.logic)', requirements: ['REQ-FW-002'], method: 'sim', tool: 'sim.logic',
    args: { files: ['logic/moving_average.v', 'logic/moving_average_tb.v'], top: 'moving_average_tb', pass: 'ALL TESTS PASSED' } },
  { id: 'TST-FW-003', title: 'Moving average cocotb tests (verify.cocotb)', requirements: ['REQ-FW-002'], method: 'sim', tool: 'verify.cocotb',
    args: { files: ['logic/moving_average.v'], top: 'moving_average', modules: ['logic/test_moving_average.py'] } },
  { id: 'TST-FW-004', title: 'FPGA top against the SPI ADC model (verify.verilator)', requirements: ['REQ-FW-002', 'REQ-FW-003'], method: 'sim', tool: 'sim.logic',
    args: { files: ['logic/moving_average.v', 'logic/spi_adc_slave.v', 'logic/sample_top.v', 'logic/sample_top_tb.v'], top: 'sample_top_tb', pass: 'ALL TESTS PASSED' } },
  { id: 'TST-FW-005', title: 'FPGA timing at 12 MHz (fpga.synth then fpga.pnr)', requirements: ['REQ-FW-003'], method: 'sim', tool: 'fpga.synth',
    args: { family: 'ice40', files: ['logic/moving_average.v', 'logic/sample_top.v'], top: 'sample_top' },
    note: 'synthesis only from verify.run; place and route (fpga.pnr with fpga/sample_top.pcf, clocks clk 12) is the implementation task' },
  { id: 'TST-IF-001', title: 'I2C capture against UM10204 fast mode (protocol.check)', requirements: ['REQ-IF-001'], method: 'sim', tool: 'protocol.check',
    args: { file: 'protocol/i2c-tmp1-read.vcd', protocol: 'i2c', standard: 'fast' } },
  { id: 'TST-IF-002', title: 'Console UART capture (protocol.check)', requirements: ['REQ-IF-002'], method: 'sim', tool: 'protocol.check',
    args: { file: 'protocol/uart-console.csv', protocol: 'uart', signals: { rx: 'tx' }, baud: 115200 } },
  { id: 'TST-IF-003', title: 'I2C pull-up rise time at 50 pF (protocol.bus_analog)', requirements: ['REQ-IF-003'], method: 'spice', tool: 'protocol.bus_analog',
    args: { kind: 'open_drain', vdd: 3.3, rp: 4700, cb: 50e-12, speed: 'fast' } },
  { id: 'TST-IF-004', title: 'CAN status frame decodes (protocol.check)', requirements: ['REQ-IF-004'], method: 'sim', tool: 'protocol.check',
    args: { file: 'protocol/can-status.vcd', protocol: 'can', signals: { can: 'can' }, bitrate: 500000 } },
  { id: 'TST-EMC-001', title: 'I2C edge spectrum against CISPR 32 class B (emc.spectrum)', requirements: ['REQ-EMC-001'], method: 'sim', tool: 'emc.precheck',
    args: { board: 'hardware/trace-sample.kicad_pcb', edges: [{ net: '/SCL', freq_hz: 400000, rise_s: 2e-7, amplitude_v: 3.3 }] },
    note: 'the rule precheck; emc.spectrum and emc.run (openEMS) give the margin in the EMC task' },
  // formal
  { id: 'TST-FW-006', title: 'Moving average properties (verify.formal, bmc)', requirements: ['REQ-FW-002'], method: 'formal', tool: 'verify.formal',
    args: { files: ['logic/moving_average.v', 'logic/moving_average_props.sv'], top: 'moving_average_props', mode: 'bmc', depth: 6 } },
  { id: 'TST-FW-007', title: 'Moving average reaches full scale (verify.formal, cover)', requirements: ['REQ-FW-002'], method: 'formal', tool: 'verify.formal',
    args: { files: ['logic/moving_average.v', 'logic/moving_average_props.sv'], top: 'moving_average_props', mode: 'cover', depth: 10 } },
  // firmware: a command in the repository root
  { id: 'TST-FW-001', title: 'Firmware unit test on the host (make test)', requirements: ['REQ-FW-001'], method: 'sim', command: ['make', '-C', 'firmware', 'all', 'test'] },
  // drc
  { id: 'TST-LAY-001', title: 'KiCad ERC', requirements: ['REQ-LAY-001'], method: 'drc', tool: 'kicad.erc', args: {} },
  { id: 'TST-LAY-002', title: 'KiCad DRC with schematic parity', requirements: ['REQ-LAY-001'], method: 'drc', tool: 'kicad.drc', args: {} },
  { id: 'TST-LAY-003', title: 'Length rules from hardware/trace-sample.kicad_dru (pcb.length_match)', requirements: ['REQ-LAY-001', 'REQ-IF-003'], method: 'drc', tool: 'pcb.length_match',
    args: { project: 'hardware/trace-sample.kicad_pro', groups: [{ name: 'i2c', nets: ['/SDA', '/SCL'], tolerance_mm: 5 }] } },
  // inspection
  { id: 'TST-LAY-004', title: 'BOM: every line in stock at LCSC for 10 boards (parts.bom_check, then a person signs)', requirements: ['REQ-LAY-002'], method: 'inspection',
    note: 'run kicad.bom jlc=true and parts.bom_check boards=10; a person confirms and gives the verdict to verify.run' },
  { id: 'TST-THM-002', title: 'U1 tab temperature on the bench matches the model (thermal/u1-bench-log.csv)', requirements: ['REQ-THM-001'], method: 'inspection',
    note: 'thermal.compare of the 2.5d transient against the log; within 5 C at steady state passes' },
  // hil: needs TRACE_HARDWARE=1 and the bench emulator (trace hil emulate --write-settings --serial)
  { id: 'TST-HIL-001', title: 'ADC_IN on the DMM at 12 V (hil.dmm on bench-dmm)', requirements: ['REQ-HIL-001', 'REQ-PWR-001'], method: 'hil', tool: 'hil.dmm',
    args: { instrument: 'bench-dmm', function: 'vdc' }, note: 'set bench-psu to 12 V, 0.1 A, output on first (hil.psu)' },
  { id: 'TST-HIL-002', title: 'Console reports the rail (hil.serial_expect on bench-uart)', requirements: ['REQ-HIL-001', 'REQ-FW-001'], method: 'hil', tool: 'hil.serial_expect',
    args: { serial: 'bench-uart', steps: [{ send: 'READ', expect: 'adc raw=(?<raw>\\d+) mv=(?<mv>1(18[89]\\d|19\\d\\d|20\\d\\d|21[01]\\d|2120))' }] } },
]

// ------------------------------------------------------------------ coverage points

export const SAMPLE_COVERAGE: readonly { id: string; requirements: string[]; kind: 'functional' | 'cover'; match: string; description: string }[] = [
  { id: 'COV-001', requirements: ['REQ-FW-002'], kind: 'functional', match: 'full_scale', description: 'cocotb: the average reaches full scale' },
  { id: 'COV-002', requirements: ['REQ-FW-002'], kind: 'functional', match: 'back_to_zero', description: 'cocotb: the average returns to zero' },
  { id: 'COV-003', requirements: ['REQ-FW-002'], kind: 'functional', match: 'random_200', description: 'cocotb: 200 random samples with gaps' },
  { id: 'COV-004', requirements: ['REQ-FW-002'], kind: 'functional', match: 'reset_mid_stream', description: 'cocotb: a reset in the middle of a stream' },
  { id: 'COV-005', requirements: ['REQ-FW-002'], kind: 'cover', match: 'reaches_full_scale', description: 'formal cover: the average reaches full scale' },
  { id: 'COV-006', requirements: ['REQ-FW-003'], kind: 'functional', match: 'avg_settled', description: 'sample_top_tb: the average settles at 3722' },
  { id: 'COV-007', requirements: ['REQ-FW-003'], kind: 'functional', match: 'led_on', description: 'sample_top_tb: the LED lights above 10 V' },
  { id: 'COV-008', requirements: ['REQ-IF-002', 'REQ-FW-003'], kind: 'functional', match: 'uart_report', description: 'sample_top_tb: the UART report reads 0E8A' },
]

// ------------------------------------------------------------------ AMS spec sets

export const SAMPLE_AMS: readonly { spec_set: string; measure: string; min?: number; typ?: number; max?: number; unit: string; source: string; conditions?: Record<string, unknown> }[] = [
  { spec_set: 'front-end', measure: 'vadc_mid', min: 1.47, typ: 1.5, max: 1.53, unit: 'V', source: 'REQ-ANA-001', conditions: { vin_dc: 6, temp_c: [-20, 70], vdd: [3.135, 3.465] } },
  { spec_set: 'front-end', measure: 'f3db', min: 850, typ: 1000, max: 1250, unit: 'Hz', source: 'REQ-ANA-002', conditions: { vin_dc: 6 } },
  { spec_set: 'buffer', measure: 'phase_margin_deg', min: 45, unit: 'deg', source: 'REQ-ANA-003', conditions: { gain: 1, cl: '10p', rl: '1meg' } },
  { spec_set: 'buffer', measure: 'gbw_hz', min: 0.8e6, typ: 1e6, unit: 'Hz', source: 'docs/datasheets/TRC-OPA1.pdf p.2 (fictional part)' },
  { spec_set: 'buffer', measure: 'slew_rise_v_per_us', min: 0.45, typ: 0.6, unit: 'V/us', source: 'docs/datasheets/TRC-OPA1.pdf p.2 (fictional part)' },
]

// ------------------------------------------------------------------ protocol specs (unverified)

const tmp1 = (row: string): SpecRowIn['citation'] => ({ source: `docs/datasheets/TRC-TMP1.pdf page 2, ${row} (a FICTIONAL part written for the trace sample; not yet in the datasheet library, so unverified: add it with datasheets.add and re-cite with protocol.spec_extract)` })
const design = (req: string): SpecRowIn['citation'] => ({ source: `${SPEC} ${req}: the sample's own design choice, not a datasheet figure` })

export const SAMPLE_PROTOCOL: readonly { device: string; protocol: 'i2c' | 'uart' | 'can'; role: 'responder' | 'initiator'; rows: SpecRowIn[] }[] = [
  { device: 'TRC-TMP1', protocol: 'i2c', role: 'responder', rows: [
    { parameter: 'f_scl', max: 400, unit: 'kHz', citation: tmp1('fSCL') },
    { parameter: 'thd_sta', min: 0.6, unit: 'us', citation: tmp1('tHD;STA') },
    { parameter: 't_low', min: 1.3, unit: 'us', citation: tmp1('tLOW') },
    { parameter: 't_high', min: 0.6, unit: 'us', citation: tmp1('tHIGH') },
    { parameter: 'tsu_sta', min: 0.6, unit: 'us', citation: tmp1('tSU;STA') },
    { parameter: 'thd_dat', min: 0, max: 0.9, unit: 'us', citation: tmp1('tHD;DAT') },
    { parameter: 'tsu_dat', min: 100, unit: 'ns', citation: tmp1('tSU;DAT') },
    { parameter: 'tsu_sto', min: 0.6, unit: 'us', citation: tmp1('tSU;STO') },
    { parameter: 't_buf', min: 1.3, unit: 'us', citation: tmp1('tBUF') },
    { parameter: 'c_b', max: 400, unit: 'pF', citation: tmp1('Cb') },
  ] },
  { device: 'sample-console', protocol: 'uart', role: 'initiator', rows: [
    { parameter: 'baud', typ: 115200, unit: 'baud', citation: design('REQ-IF-002') },
    { parameter: 'baud_tol', max: 2, unit: '%', citation: design('REQ-IF-002') },
  ] },
  { device: 'sample-status', protocol: 'can', role: 'initiator', rows: [
    { parameter: 'bitrate', typ: 500, unit: 'kbps', citation: design('REQ-IF-004') },
    { parameter: 'sample_point', typ: 87.5, unit: '%', citation: design('REQ-IF-004') },
  ] },
]

// ------------------------------------------------------------------ thermal

const recalled = (what: string): { source: string } => ({ source: `${what}; recalled, not read from a PDF in the library (verified: null): add the datasheet with datasheets.add and cite its page` })
const uniroyal = recalled('UNI-ROYAL 0603WAF series, power derating curve (1/10 W at 70 C to 0 W at 155 C, so 850 C/W element to ambient)')

/** U1's dissipation at 12 V with the 43.4 mA 3V3 load and 5 mA ground current, as power/ldo.cir's .op gives it. */
export const U1_POWER_W = (12 - 3.3) * 0.0434 + 12 * 0.005

function seedThermal(): void {
  putEnvelope({
    name: 'enclosure', ambient_min_c: 0, ambient_max_c: 50, ambient_nominal_c: 25, environment: 'natural', orientation: 'vertical', altitude_m: 0,
    derating: { kind: 'offset', value_c: 20 }, source: 'docs/intent.md section 2: indoors, 0 to 50 C, still air, vertical in a vented enclosure; REQ-THM-001 (20 C margin)',
  })
  putPartLimit('enclosure', {
    ref: 'U1', mpn: 'AMS1117-3.3', package: 'SOT-223', tj_max_c: 125, theta_ja: 90, theta_jc: 15,
    citations: { tj_max_c: recalled('AMS1117 datasheet, absolute maximum ratings: Tj 125 C'), theta_ja: recalled('AMS1117 datasheet, SOT-223 theta-JA 90 C/W'), theta_jc: recalled('AMS1117 datasheet, SOT-223 theta-JC 15 C/W') },
  })
  putPartLimit('enclosure', {
    ref: 'U2', mpn: 'MCP6001T-I/OT', package: 'SOT-23-5', tj_max_c: 150, theta_ja: 220,
    citations: { tj_max_c: recalled('modelled by TRC-OPA1 (docs/datasheets/TRC-OPA1.pdf p.2, a fictional part): Tj(max) 150 C'), theta_ja: recalled('TRC-OPA1 (fictional) p.2: theta-JA 220 C/W') },
  })
  for (const [ref, mpn] of [['R1', '0603WAF3902T5E'], ['R2', '0603WAF1302T5E']] as const) {
    putPartLimit('enclosure', { ref, mpn, package: '0603', tj_max_c: 155, theta_ja: 850, citations: { tj_max_c: uniroyal, theta_ja: uniroyal } })
  }
  putBudget([
    { ref: 'U1', rail: 'VIN', power_w: U1_POWER_W, power_max_w: (13 - 3.3) * 0.05 + 13 * 0.005, method: 'spice',
      citation: { source: 'power/ldo.cir .op: v(p_u1) = (12 - 3.3) V x 43.4 mA + 12 V x 5 mA; max at 13 V, 50 mA (REQ-PWR-002)' } },
    { ref: 'U2', rail: '3V3', power_w: 3.3 * 100e-6, power_max_w: 3.3 * 140e-6, method: 'datasheet', citation: { source: 'TRC-OPA1 (fictional) p.2: IQ 100 uA typ, 140 uA max at 3.3 V' } },
    { ref: 'R1', rail: 'VIN', power_w: (12 / 52e3) ** 2 * 39e3, power_max_w: (13 / 52e3) ** 2 * 39e3, method: 'explicit', citation: { source: 'I^2 R, I = VIN / 52 k' } },
    { ref: 'R2', rail: 'VIN', power_w: (12 / 52e3) ** 2 * 13e3, power_max_w: (13 / 52e3) ** 2 * 13e3, method: 'explicit', citation: { source: 'I^2 R, I = VIN / 52 k' } },
  ], 'nominal')
  putCurve({ ref: 'U1', curve: 'power_vs_ambient', x_unit: 'C', y_unit: 'W', points: [[-40, 1.11], [25, 1.11], [50, 0.83], [105, 0.22], [125, 0]],
    citation: recalled('derived: (Tj_max 125 C - Ta) / theta-JA 90 C/W for the AMS1117 in SOT-223, held at its 25 C value below 25 C') })
}

// ------------------------------------------------------------------ seed

/** Check every test item's arguments against its tool's input schema, as verify.plan does when it plans one
 * (async: the registry is imported on demand). The tests run it; seedSample writes the rows as they are. */
export async function checkSampleTests(): Promise<void> {
  for (const t of SAMPLE_TESTS) if (t.tool) await validateToolArgs(t.tool, t.args ?? {})
}


/** Write the sample's records into `repoDir`/.trace/project.db (which must exist). Returns what it wrote, in plain words. */
export function seedSample(repoDir: string): string[] {
  const db = join(repoDir, '.trace', 'project.db')
  if (!existsSync(db)) throw new Error(`${db} does not exist: onboard the repository first`)
  const prior = process.env.TRACE_PROJECT_DB
  process.env.TRACE_PROJECT_DB = db
  try {
    const lines: string[] = []
    const v = new VerifyDb(repoDir)
    try {
      for (const r of SAMPLE_REQUIREMENTS) {
        const fields = { text: r.text, kind: r.kind, acceptance: r.acceptance, source: SPEC, status: 'accepted' as const, tags: r.tags }
        if (v.requirement(r.id)) v.updateRequirement(r.id, fields)
        else v.addRequirement({ id: r.id, ...fields })
      }
      lines.push(`${SAMPLE_REQUIREMENTS.length} requirements from ${SPEC}, accepted`)
      for (const t of SAMPLE_TESTS) {
        const how = { title: t.title, requirements: t.requirements, method: t.method, tool: t.tool ?? null, args: t.args ?? null, command: t.command ?? null, expect: t.expect ?? [], note: t.note ?? null }
        if (v.test(t.id)) v.updateTest(t.id, how)
        else v.addTest({ id: t.id, title: t.title, requirements: t.requirements, method: t.method, tool: t.tool, args: t.args, command: t.command, expect: t.expect, note: t.note })
      }
      const methods = [...new Set(SAMPLE_TESTS.map((t) => t.method))].sort()
      lines.push(`${SAMPLE_TESTS.length} test items, planned, by method: ${methods.map((m) => `${m} ${SAMPLE_TESTS.filter((t) => t.method === m).length}`).join(', ')}`)
      for (const p of SAMPLE_COVERAGE) v.definePoint(p)
      lines.push(`${SAMPLE_COVERAGE.length} coverage points (the testbenches' TRACE_COVER names and the formal cover)`)
    } finally {
      v.close()
    }
    for (const s of SAMPLE_AMS) putSpec({ ...s, by: BY })
    lines.push(`${SAMPLE_AMS.length} analog limits in spec sets ${[...new Set(SAMPLE_AMS.map((s) => s.spec_set))].join(' and ')}`)
    for (const p of SAMPLE_PROTOCOL) putSpecRows(p.device, p.protocol, p.role, p.rows, BY)
    lines.push(`interface timing for ${SAMPLE_PROTOCOL.map((p) => `${p.device} (${p.protocol})`).join(', ')}: all unverified (a fictional datasheet not yet in the library, and the spec's own figures)`)
    seedThermal()
    lines.push(`thermal: envelope "enclosure" (0 to 50 C, still air, vertical) with limits for U1, U2, R1, R2; budget "nominal" (U1 ${U1_POWER_W.toFixed(3)} W); U1's power derating curve`)
    return lines
  } finally {
    if (prior === undefined) delete process.env.TRACE_PROJECT_DB
    else process.env.TRACE_PROJECT_DB = prior
  }
}
