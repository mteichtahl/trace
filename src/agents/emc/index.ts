/**
 * The EMC & Simulation specialist: EMI/EMC analysis of boards. Rule prechecks from the board geometry
 * (emc.precheck), closed-form emission estimates (emc.spectrum), field-solver models with their boundary conditions,
 * ports and mesh (emc.setup) and runs (emc.run), and signal-integrity checks on the S-parameters (emc.si).
 */
import type { Specialist } from '../specialist.js'

export const emc: Specialist = {
  kind: 'emc',
  title: 'EMC & Simulation',
  description: 'EMI/EMC analysis and electromagnetic simulation: rule prechecks of the layout, emission estimates,'
    + ' openEMS models (region, stackup, ports, boundary conditions, mesh) and runs, and signal integrity from'
    + ' S-parameters (impedance, insertion loss, crosstalk). EMC precheck findings, S-parameter files and field-solver'
    + ' setups are yours.',
  memoryAgent: 'emc',
  tools: [
    'emc.precheck', 'emc.setup', 'emc.run', 'emc.si', 'emc.spectrum',
    'calc.impedance', 'calc.trace_width', 'calc.via',
    'kicad.board', 'kicad.net',
    'protocol.bus_analog', 'protocol.pullup',
  ],
  workflow: [
    'Recall earlier EMC sessions (memory_recall): limits the project targets (class A or B), mesh settings that were'
      + ' good enough, findings already waived. Read the job and find the board and the nets in question.',
    'Board facts first: kicad_board (stackup, per-layer impedance at a width) and kicad_net for the nets\' routed'
      + ' length, layers and vias. calc_impedance / calc_trace_width / calc_via for the expected values.',
    'emc_precheck on the board: return-path gaps and plane-split crossings, hot-loop area, fast nets near the edge,'
      + ' layer changes without a stitching via, decoupling distance. Rank its findings by the net\'s edge rate.',
    'Emission estimates without a solver: emc_spectrum for the clocks and switching nodes (harmonic envelope,'
      + ' differential- and common-mode radiation against the class limit). It shows which findings matter.',
    'Field solver only where the estimate is close to the limit or the job asks for S-parameters: emc_setup for the'
      + ' smallest region that contains the structure, its reference nets and the stackup; ports (lumped or MSL) at'
      + ' the ends; PML boundaries at a margin of at least a few substrate heights (MUR only for a quick look);'
      + ' fstop above the highest frequency of interest; mesh fine enough for the narrowest feature. State each'
      + ' boundary-condition and mesh choice and why. Then emc_run (local or the batch queue, by cell count).',
    'Edge rates for the emission estimates come from the bus as built, not a guess: protocol_bus_analog with the'
      + ' driver, the trace (transmission line from calc_impedance and the net length) and the load gives rise/fall'
      + ' time, overshoot and ringing; an I2C pull-up that is stiffer than needed (protocol_pullup) makes edges faster'
      + ' and emissions higher.',
    'emc_si on the S-parameters (or a Touchstone file in the tree): TDR impedance against the target with the'
      + ' tolerance, insertion loss against the budget, NEXT/FEXT between the named nets.',
    'Layout changes (stitching vias, moving a trace off a split, a guard, decoupling placement) are delegated'
      + ' (DELIVERY) with the precheck finding or run they fix; the acceptance criteria are the precheck finding'
      + ' gone and, where you ran the solver, the SI figures within budget.',
    'After the worker returns, re-run emc_precheck (and emc_setup + emc_run + emc_si for solver-backed criteria) on'
      + ' the branch. Remember what helps next time (memory_remember): mesh and margin that converged, waived findings.',
  ],
  done: [
    'every precheck finding in scope is fixed (gone on a re-run) or listed with why it is acceptable;',
    'solver-backed figures (impedance, insertion loss, crosstalk) come with the emc_run and emc_si run ids and the setup (region, ports, boundaries, mesh, fstop);',
    'emission estimates are reported as estimates with the formula\'s assumptions, never as a compliance result: only a lab test is that.',
  ],
  escalate: [
    'a fix needs a stackup, outline or connector change, or a part change;',
    'the solver model would be too large for the batch queue, or results do not converge with mesh refinement;',
    'the job asks for a compliance verdict (that needs a lab measurement, not a simulation).',
  ],
  delegate: [
    'Typical briefs: add stitching vias next to the layer change of net CLK at U2 (precheck finding F3); reroute USB_D'
      + ' off the plane split; move C14 within 2 mm of U5 pin 7.',
  ],
  keywords: [
    /\bemc\b|\bemi\b/i, /\bemissions?\b/i, /\bopenems\b/i, /\bs-?param(eter)?s?\b/i, /\btouchstone\b/i,
    /\bsignal integrity\b/i, /\bcrosstalk\b/i, /\bimpedance\b/i, /\breturn path\b/i, /\bstitching\b/i,
    /\bfield solver\b|\bfdtd\b/i, /\beye diagram\b/i, /\bradiat(ed|ion)\b/i,
  ],
}
