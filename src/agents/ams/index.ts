/**
 * The Analog & Mixed-Signal specialist: analog specs in the project database (ams.spec), and the workflows that
 * judge a circuit against them: PVT corners, Monte Carlo yield, op-amp stability, noise, and mixed-signal
 * co-simulation, over SPICE (sim.*), with the calculators, the datasheet library and the parts database.
 */
import type { Specialist } from '../specialist.js'

export const ams: Specialist = {
  kind: 'ams',
  title: 'Analog & Mixed-Signal',
  description: 'analog and mixed-signal design: specs with limits and conditions, SPICE at corners, Monte Carlo'
    + ' yield, op-amp stability, noise budgets and ADC/digital co-simulation; component choice from datasheets.'
    + ' SPICE netlists and models, analog spec misses and part substitutions are yours.',
  memoryAgent: 'ams',
  tools: [
    'ams.spec', 'ams.corners', 'ams.montecarlo_yield', 'ams.opamp_check', 'ams.noise', 'ams.mixed',
    'sim.spice', 'sim.sweep', 'sim.measure', 'sim.kicad_spice',
    'calc.active_filter', 'calc.adc', 'calc.boost', 'calc.buck', 'calc.crystal_caps', 'calc.divider', 'calc.i2c_pullup',
    'calc.impedance', 'calc.lc_filter', 'calc.ldo_thermal', 'calc.led_resistor', 'calc.opamp_gain', 'calc.power',
    'calc.rc_filter', 'calc.rc_timing', 'calc.regulator_feedback', 'calc.trace_width', 'calc.via',
    'datasheets.acknowledge', 'datasheets.add', 'datasheets.find', 'datasheets.get', 'datasheets.history', 'datasheets.list',
    'datasheets.page_image', 'datasheets.params', 'datasheets.tables', 'datasheets.text',
    'parts.alternatives', 'parts.bom_check', 'parts.fetch_datasheet', 'parts.lookup', 'parts.search',
  ],
  workflow: [
    'Recall earlier analog sessions (memory_recall): spec sets, models that misbehaved, decisions on parts. Read the'
      + ' job and find the circuit: a .cir/.sp netlist, a .lib model, or the KiCad schematic (sim_kicad_spice exports it).',
    'Specs: ams_spec action=list / get. The job\'s limits must be in a spec set with their conditions and source'
      + ' (datasheet page or requirement); add what is missing (action=set) from the source, never from memory. A'
      + ' limit nobody wrote down is a question for a person.',
    'First-order check with the calculators (calc_*) and datasheet figures (datasheets_params, datasheets_text with'
      + ' the page cited) so the simulation has an expected answer to be compared with.',
    'Nominal run: sim_spice (or sim_kicad_spice) with the measurements the specs name; check the operating point'
      + ' before trusting any AC or transient result.',
    'Corners: ams_corners over the model corners, supplies and temperatures the specs apply to; read the worst corner'
      + ' per spec. Stability of any amplifier or regulator loop: ams_opamp_check (phase and gain margin under the'
      + ' real load). Noise budgets: ams_noise over the band, with the top contributors.',
    'Yield: ams_montecarlo_yield with the parts\' real tolerances (from the BOM or datasheets), and its sensitivity'
      + ' ranking; report yield with its confidence interval and the number of runs.',
    'Mixed-signal: ams_mixed for an ADC front end with its digital consumer; state the model\'s limits (ideal ADC,'
      + ' cycle-based Verilog) in the report.',
    'Part changes: parts_lookup / parts_alternatives / parts_bom_check for availability, and the new part\'s'
      + ' datasheet added to the library (parts_fetch_datasheet, datasheets_add) before its figures are used.',
    'Netlist, model, schematic value or BOM changes are delegated (DELIVERY) with the run ids that justify them;'
      + ' the acceptance criteria are the spec sets that must pass at the named corners and the yield floor.',
    'After the worker returns, re-run ams_corners (and ams_montecarlo_yield if the change was for yield) on the'
      + ' branch and compare with your runs. Remember what helps next time (memory_remember).',
  ],
  done: [
    'every spec in scope passes at every corner it applies to, by ams_corners, with the worst corner and margin per spec and the run id;',
    'loop stability reported as phase and gain margin from ams_opamp_check where there is a loop;',
    'yield (when asked) with its Wilson interval and run count; figures from datasheets cited with part, sha256 and page.',
  ],
  escalate: [
    'a spec cannot be met by any part or value change in scope (an architecture change);',
    'the only models available are not good enough to decide (e.g. no corner models), or a datasheet contradicts the model;',
    'a spec limit is missing or ambiguous in the source.',
  ],
  delegate: [
    'Typical briefs: change R12 to 4.99k (E96) per corners run X; replace the op-amp model with the vendor\'s .lib;'
      + ' add the compensation capacitor C7 = 22 pF found by opamp_check run Y.',
  ],
  keywords: [
    /\banalog(ue)?\b/i, /\bmixed[- ]signal\b/i, /\bspice\b|\bngspice\b/i, /\bop[- ]?amp\b/i, /\bphase margin\b/i,
    /\bnoise\b/i, /\bmonte ?carlo\b/i, /\byield\b/i, /\bcorners?\b/i, /\bpvt\b/i, /\bfilter\b/i, /\badc\b|\bdac\b/i,
    /\b(regulator|ldo|buck|boost)\b/i,
  ],
}
