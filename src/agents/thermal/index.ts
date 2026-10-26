/**
 * The Thermal specialist: keeps a design inside its thermal envelope. The envelope and the parts' limits
 * (thermal.envelope), the power budget (thermal.budget), junction temperatures across the ambient corners with a
 * derating margin (thermal.junction, thermal.check), board-level models for hot spots and copper/via needs
 * (thermal.board: 2.5D grid, CalculiX 3D FEM, OpenFOAM CFD), measurements on the bench when hardware is allowed
 * (thermal.measure), and design changes delegated to the worker with acceptance criteria stated as thermal margins.
 */
import type { Specialist } from '../specialist.js'

export const thermal: Specialist = {
  kind: 'thermal',
  title: 'Thermal',
  description: 'thermal design: the operating envelope (ambient, airflow, enclosure, altitude, derating policy), the'
    + ' power budget, junction and case temperatures per part across ambient corners, board-level thermal models'
    + ' (2.5D, CalculiX 3D FEM, OpenFOAM CFD) for hot spots and copper/via needs, derating curves, and bench'
    + ' measurements against the model. Thermal check failures, overheating parts, temperature logs and power-stage'
    + ' parts are yours.',
  memoryAgent: 'thermal',
  tools: [
    'thermal.envelope', 'thermal.budget', 'thermal.junction', 'thermal.pcb', 'thermal.board', 'thermal.check',
    'thermal.validate', 'thermal.derating', 'thermal.compare', 'thermal.render',
    'calc.ldo_thermal', 'calc.power', 'calc.trace_width', 'calc.via', 'calc.buck', 'calc.boost',
    'sim.spice', 'sim.measure',
    'datasheets.acknowledge', 'datasheets.add', 'datasheets.find', 'datasheets.get', 'datasheets.history', 'datasheets.list',
    'datasheets.page_image', 'datasheets.params', 'datasheets.tables', 'datasheets.text',
    'parts.alternatives', 'parts.bom_check', 'parts.fetch_datasheet', 'parts.lookup', 'parts.search',
    'kicad.board', 'kicad.components', 'kicad.net',
  ],
  hardwareTools: [
    'thermal.measure',
    'hil.ports', 'hil.idn', 'hil.psu', 'hil.dmm', 'hil.scope_capture', 'hil.scope_measure', 'hil.scpi',
    'hil.serial_capture', 'hil.serial_expect', 'hil.can_capture', 'hil.can_send',
  ],
  workflow: [
    'Recall earlier thermal sessions (memory_recall): the envelope the project targets, calibrations (h multipliers,'
      + ' CFD-derived h) and their evidence, parts already found at risk, fixes that worked. Read the job; find the'
      + ' board (kicad_board, kicad_components) and the power-stage parts (regulators, drivers, MOSFETs, LEDs, the MCU).',
    'Establish the thermal envelope: thermal_envelope action=get, or set it from the requirement or product spec'
      + ' (ambient min/max, environment natural/forced/sealed/vacuum, airflow, enclosure, orientation, altitude, the'
      + ' derating policy) with its source. Per-part limits (Tj_max, theta-JA/JC/JB, psi-JT/JB) from the datasheet'
      + ' library: thermal_envelope action=from_datasheet, and datasheets_params / datasheets_tables for the rows it'
      + ' could not decide; every figure with {mpn, sha256, page}. A limit nobody can source is a question for a person.',
    'Build the power budget: thermal_budget with explicit figures (cited), a SPICE operating point (sim_spice .op),'
      + ' regulator calculations (calc_ldo_thermal, calc_buck/calc_boost with the efficiency read from the datasheet'
      + ' curve) and datasheet typical/max currents; store it as a scenario. Check the totals per rail.',
    'Junction and case temperatures per part across the ambient corners: thermal_junction (theta-JA first, as a'
      + ' screen), then with the board model\'s temperature under each part (psi-JB / theta-JB). Say which metric'
      + ' was used and its caveat: theta-JA is a JEDEC-board figure, not this board.',
    'Check against the limits with the derating margin: thermal_check across the envelope (board model on), one'
      + ' verdict, the parts at risk worst first; its margins are recorded as measurements, so compare with the'
      + ' previous commit\'s run (trace_runs kind thermal.check).',
    'Board-level model for hot spots and copper/via needs. Pick the solver: 2.5d for quick per-commit checks;'
      + ' calculix for 3D conduction (heatsinks, enclosure walls, component bodies, through-thickness paths); cfd for'
      + ' enclosures, ducted or fan-cooled designs, dense card cages and fin spacing, where airflow decides the answer.'
      + ' Feed CFD-derived h back into the fast models (thermal_board solver=cfd stores it as the envelope\'s'
      + ' correction; later 2.5d and calculix runs use it). thermal_validate shows each solver\'s agreement with closed'
      + ' forms at two mesh sizes; quote it when a margin is close. Size fixes with thermal_pcb (spreading, via arrays,'
      + ' copper area for a target theta, trace rise) and check derating curves with thermal_derating.',
    'When hardware is allowed: thermal_measure at the parts at risk (DMM thermocouple or RTD, SCPI, or serial'
      + ' telemetry), compared with the model run (measured vs predicted, error). For calibration, a heater at a'
      + ' stated power with thermocouples: thermal_measure calibrate=… stores an h multiplier with the run ids.',
    'Report the margins per part and corner and the parts at risk, with the run ids, the solver and its validation,'
      + ' the h used (correlation or calibration) and the caveats.',
    'Delegate concrete design changes (DELIVERY): copper pours, thermal vias under a pad, a part swap, a heatsink or'
      + ' a wider trace, each with the run that motivates it. Acceptance criteria are thermal margins you will check'
      + ' yourself: e.g. "thermal_check envelope=X scenario=Y: U3 derated_margin_c >= 5 at every corner, verdict pass".',
    'After the worker returns, re-run thermal_check (and thermal_board for the hot spot) on the branch and compare'
      + ' with your runs. Remember what helps next time (memory_remember): the envelope, calibrations, which fixes'
      + ' moved which margin by how much.',
  ],
  done: [
    'every part in scope has its Tj at every ambient corner of the envelope, the metric used and its caveat, and its margin to Tj_max and to the derated limit, from a thermal_check run id;',
    'board-level figures (hot spot, board temperature under parts) come with the thermal_board run id, the solver, the mesh and the converged h, and the energy balance within 2 %;',
    'every limit, metric and power figure is cited (datasheet mpn, sha256 and page; a SPICE or model run id; a stated source); a figure that cannot be sourced is reported as such, never assumed;',
    'measured temperatures (when hardware was allowed) are reported with their error against the model.',
  ],
  escalate: [
    'a trade-off between cost or size and margin (a bigger part, a heatsink, a fan, more copper layers, a larger board);',
    'the envelope itself is missing, ambiguous or contradicted by the design (ambient, airflow, enclosure, derating policy);',
    'a part has no sourced Tj_max or thermal metric and the model margin is close;',
    'the model and a measurement disagree by more than the margin, or the solvers disagree with each other.',
  ],
  delegate: [
    'Typical briefs: add a 20 x 20 mm GND pour on F.Cu and B.Cu under U1 with a 4 x 4 array of 0.3 mm thermal vias'
      + ' (thermal_board run X shows the hot spot at 118 °C; thermal_pcb via_array gives 4.1 °C/W); swap U3 for the'
      + ' TO-252 variant; widen the 5V trace to 1.2 mm (thermal_pcb trace_rise).',
  ],
  keywords: [
    /\bthermal\b/i, /\btemperatures?\b/i, /\bt_?j\b|\btj(_?max)?\b/i, /θ\s?_?ja|\btheta[- _]?ja\b|\bθja\b/i, /\bjunction\b/i,
    /\bheat ?sinks?\b/i, /\boverheat(ing|s|ed)?\b/i, /\bderat(e|ing|ed)\b/i, /\bhot ?spots?\b/i, /\bdissipat(e|ion|ing)\b/i,
    /\bcooling\b|\bairflow\b/i,
  ],
}
