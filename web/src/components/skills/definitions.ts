/**
 * The twenty guided skills as data (docs/user-journey.md, "Guided skills for every person's task"): each skill's
 * stage, its Focus-mode variant, the picture each step opens with, its steps in order and its quality bar. The route
 * /p/:id/do/:skill reads this table; skills with their own screen (Intent builder, Question answer, Schematic finish,
 * Placement adjust, Waiver, Change request, Bring-up run) add to it, the rest render from it alone.
 *
 * Every skill's bar also holds the shared rule: a decision that differs from the recommendation has a reason. It is
 * appended to each list by `checksOf()` so the table stays as the journey document writes it.
 */

export type SkillVariant = 'stepped' | 'conversational' | 'checklist'
export type PictureKind = 'sheet' | 'board' | 'block-diagram' | 'pin-map' | 'bench-wiring' | 'traceability' | 'render' | 'report' | 'order-sheet' | 'none'

export interface SkillStep {
  id: string
  title: string
  /** one line on what the person does in this step */
  detail: string
  /** the picture this step opens with (defaults to the skill's) */
  picture?: PictureKind
  /** a powered step (checklist skills): the big Stop shows */
  powered?: boolean
}

export interface SkillCheck {
  id: string
  /** short, for the quality bar */
  text: string
  /** the step where it is fixed (the bar's item jumps there) */
  step?: string
}

export interface SkillDef {
  id: string
  name: string
  /** the journey stage it belongs to ("Any" for waiver, change, question) */
  stage: string
  variant: SkillVariant
  picture: PictureKind
  /** what it guides the person through */
  guides: string
  /** what it produces */
  produces: string
  steps: SkillStep[]
  checks: SkillCheck[]
  /** where the person edits in KiCad: the "Edit in KiCad and push" line and the push toast */
  kicad?: boolean
  /** submit words */
  submit?: string
}

const DECISION_REASON: SkillCheck = { id: 'reasons', text: 'Every choice against the recommendation has a reason' }

export const SKILLS: SkillDef[] = [
  {
    id: 'design-import', name: 'Design import', stage: 'Start', variant: 'stepped', picture: 'sheet',
    guides: 'Bringing an existing design into trace', produces: 'An intent, a requirements baseline, an architecture record and gate records for the earlier stages, with the project placed at its entry stage.',
    steps: [
      { id: 'point', title: 'Point at the design', detail: 'The KiCad project, plus any firmware, docs and test results in the repository.' },
      { id: 'intent', title: 'Review the inferred intent', detail: 'Each statement beside the sheet, part or document it came from; correct it, or mark it unknown.', picture: 'traceability' },
      { id: 'requirements', title: 'Review the inferred requirements', detail: 'Through Requirements review, each marked stated or inferred.', picture: 'traceability' },
      { id: 'assessment', title: 'See the assessment', detail: "Every gate's checks run against the design as it stands, with pass or fail per criterion.", picture: 'report' },
      { id: 'entry', title: 'Confirm the entry stage', detail: 'The first failing gate, or Bring up for a board already built; trace recommends one and says why.', picture: 'none' },
    ],
    checks: [
      { id: 'confirmed', text: 'Every inferred requirement confirmed or struck', step: 'requirements' },
      { id: 'entry', text: 'Entry stage matches the first failing gate, or why not', step: 'entry' },
      { id: 'earlier', text: 'Earlier gates signed on the import evidence', step: 'entry' },
    ],
  },
  {
    id: 'intent-builder', name: 'Intent builder', stage: 'Define', variant: 'conversational', picture: 'none',
    guides: 'Writing the product intent', produces: 'The intent document in the project record, and the candidate requirements that open Requirements review.',
    steps: [
      { id: 'purpose', title: 'Purpose', detail: 'What the product does, in one sentence, and who uses it.' },
      { id: 'environment', title: 'Environment', detail: 'Operating and storage temperature, enclosure, ingress protection, vibration, where it is installed.' },
      { id: 'power', title: 'Power', detail: 'Source, input voltage range, power budget, battery life if any, behaviour on brown-out.' },
      { id: 'interfaces', title: 'Interfaces', detail: 'Each one with type, connector, protocol, rate and direction.' },
      { id: 'performance', title: 'Performance', detail: 'The numbers that define success: accuracy, latency, resolution, range, throughput.' },
      { id: 'physical', title: 'Physical', detail: 'Board size limits, mounting, height, connector positions, and the enclosure.' },
      { id: 'compliance', title: 'Compliance', detail: 'Target standards and class, safety, markings.' },
      { id: 'build', title: 'Build', detail: 'Quantity per run, target unit cost, assembly preference.' },
      { id: 'constraints', title: 'Constraints', detail: 'Parts or vendors that must be used or avoided, reuse of earlier designs.' },
      { id: 'references', title: 'References', detail: 'Attached specs, datasheets, sketches, prior boards.' },
    ],
    checks: [
      { id: 'answered', text: 'Every topic answered or marked' },
      { id: 'quantities', text: 'Every quantity has a number and unit' },
      { id: 'vague', text: 'No vague words' },
      { id: 'interfaces', text: 'Interfaces fully specified', step: 'interfaces' },
      { id: 'conflicts', text: 'No conflicts' },
      { id: 'testable', text: 'Each statement testable' },
      { id: 'owners', text: 'Open questions have an owner' },
    ],
    submit: 'Submit intent',
  },
  {
    id: 'requirements-review', name: 'Requirements review', stage: 'Define', variant: 'stepped', picture: 'traceability',
    guides: "Accepting, editing or striking each proposed requirement", produces: 'The requirements baseline, ready for the baseline gate.',
    steps: [
      { id: 'source', title: 'Read the source', detail: 'The candidate beside the sentence or table row it was drawn from.' },
      { id: 'decide', title: 'Decide', detail: 'Accept, edit, merge with another, or strike with a reason.' },
      { id: 'testable', title: 'Make it testable', detail: 'One criterion with a number, a unit, its conditions and the method that will verify it.' },
      { id: 'classify', title: 'Classify', detail: 'Kind (functional, electrical, timing, EMC, mechanical) and priority (must or should).' },
      { id: 'conflicts', title: 'Resolve conflicts', detail: 'Pairs that cannot both hold, and which one gives.' },
      { id: 'cover', title: 'Cover the intent', detail: 'Every intent statement maps to a requirement, or is left out with a reason.' },
    ],
    checks: [
      { id: 'criterion', text: 'One testable criterion each', step: 'testable' },
      { id: 'conflicts', text: 'No conflicts or duplicates', step: 'conflicts' },
      { id: 'sources', text: 'Every requirement cites its source', step: 'source' },
      { id: 'covered', text: 'Every intent statement covered', step: 'cover' },
      { id: 'struck', text: 'Struck requirements keep their reason', step: 'decide' },
    ],
  },
  {
    id: 'architecture-choice', name: 'Architecture choice', stage: 'Architect', variant: 'stepped', picture: 'block-diagram',
    guides: 'Comparing the proposed architectures and picking one', produces: 'The chosen architecture, the decision record with rejected options, and the key-parts list.',
    steps: [
      { id: 'criteria', title: 'Agree the criteria', detail: 'Cost, risk, part availability, power, size and schedule; add, remove or weight them before any scores.', picture: 'none' },
      { id: 'read', title: 'Read each option', detail: 'Block diagram, key parts with stock and price, how each requirement is met, and the risks.' },
      { id: 'score', title: 'Score', detail: 'Each option on each criterion, with a one-line reason per score.' },
      { id: 'choose', title: 'Choose and state why', detail: 'trace recommends one; take it or pick another, and name the deciding criteria.' },
      { id: 'map', title: 'Map', detail: 'Every requirement maps to a block in the chosen option.' },
      { id: 'parts', title: 'Accept the key parts', detail: 'Each key part follows the in-stock order, or its exception is written.' },
    ],
    checks: [
      { id: 'two', text: 'At least two options compared', step: 'read' },
      { id: 'fixed', text: 'Criteria fixed before scoring', step: 'criteria' },
      { id: 'scored', text: 'Every score has a reason', step: 'score' },
      { id: 'mapped', text: 'Every requirement maps to a block', step: 'map' },
      { id: 'stock', text: 'Every key part in stock or excepted', step: 'parts' },
    ],
  },
  {
    id: 'schematic-finish', name: 'Schematic finish', stage: 'Capture', variant: 'stepped', picture: 'sheet', kicad: true,
    guides: "Correcting and completing trace's drafted sheets", produces: 'The finished schematic at a recorded commit, with its change log against the draft, ready for the schematic gate.',
    steps: [
      { id: 'walk', title: 'Walk each sheet', detail: "The block it implements, the requirements it serves, and trace's open notes." },
      { id: 'notes', title: 'Resolve the notes', detail: 'Confirm, correct or replace each one.' },
      { id: 'push', title: 'Edit in KiCad and push', detail: 'trace re-runs the electrical rule check, the datasheet-limit check and the parts check on every push.' },
      { id: 'changes', title: 'Explain the changes', detail: 'Every difference from the draft gets a one-line reason.' },
      { id: 'findings', title: 'Clear the findings', detail: 'Fix or waive each rule-check finding and each datasheet conflict.' },
      { id: 'sourcing', title: 'Check sourcing', detail: 'Every part has MPN and LCSC fields and follows the in-stock order.' },
    ],
    checks: [
      { id: 'notes', text: 'No draft notes open', step: 'notes' },
      { id: 'changes', text: 'Every change has a reason', step: 'changes' },
      { id: 'erc', text: 'ERC run on the final push', step: 'push' },
      { id: 'datasheet', text: 'No datasheet conflict open', step: 'findings' },
      { id: 'mpn', text: 'MPN and LCSC on every part', step: 'sourcing' },
      { id: 'serves', text: 'Every sheet names its requirements', step: 'walk' },
    ],
  },
  {
    id: 'pin-plan-review', name: 'Pin plan review', stage: 'Capture', variant: 'stepped', picture: 'pin-map',
    guides: 'Agreeing each microcontroller pin between schematic and firmware', produces: 'The pin plan, checked again after any pin swap in Layout.',
    steps: [
      { id: 'map', title: 'See the map', detail: 'Every pin with its net, the function the firmware expects, and the alternate functions the part allows.' },
      { id: 'conflicts', title: 'Resolve conflicts', detail: 'Two functions on one peripheral, a function a pin cannot carry, a boot or debug pin reused.' },
      { id: 'room', title: 'Keep room', detail: 'Spare pins brought to test points or a header where you want them.' },
      { id: 'agree', title: 'Agree', detail: 'Schematic and firmware pin configuration checked against the same plan.' },
    ],
    checks: [
      { id: 'functions', text: 'Every used pin has a net and a supported function', step: 'map' },
      { id: 'instances', text: 'No peripheral claimed twice', step: 'conflicts' },
      { id: 'boot', text: 'Boot, reset and debug pins keep their roles', step: 'conflicts' },
      { id: 'match', text: 'Firmware matches the schematic', step: 'agree' },
    ],
  },
  {
    id: 'waiver', name: 'Waiver', stage: 'Any', variant: 'stepped', picture: 'none',
    guides: 'Waiving a requirement, finding or check', produces: 'A waiver record linked to what it waives, listed at every later gate until it closes.',
    steps: [
      { id: 'what', title: 'Name what is waived', detail: "The requirement, finding or test, with its evidence and trace's recommendation." },
      { id: 'reason', title: 'Give the reason', detail: 'Why it cannot or need not be met or checked now.' },
      { id: 'risk', title: 'State the risk', detail: 'What goes wrong if the reason is mistaken, and how bad that would be.' },
      { id: 'caught', title: 'Say where it is caught instead', detail: 'A later stage, a bench test, or nowhere (accepted for good).' },
      { id: 'scope', title: 'Set the scope', detail: 'This revision only, or until a named condition changes.' },
    ],
    checks: [
      { id: 'what', text: 'What is waived is named', step: 'what' },
      { id: 'reason', text: 'Reason given, not just "not needed"', step: 'reason' },
      { id: 'risk', text: 'Risk and severity given', step: 'risk' },
      { id: 'safety', text: 'A safety waiver names where it is verified', step: 'caught' },
      { id: 'scope', text: 'Scope named', step: 'scope' },
    ],
    submit: 'Take the waiver',
  },
  {
    id: 'change-request', name: 'Change request', stage: 'Any', variant: 'stepped', picture: 'traceability',
    guides: 'Proposing a deliberate change to the design', produces: 'An approved or rejected change request; on approval, the project returns to the earliest affected stage.',
    steps: [
      { id: 'state', title: 'State the change', detail: 'What changes (a requirement, a part, a block, the firmware) and why.', picture: 'none' },
      { id: 'impact', title: 'See the impact', detail: 'The stages that reopen, the gates to re-sign, the evidence that goes stale, the cost and time.' },
      { id: 'scope', title: 'Choose the scope', detail: 'This revision (if not released) or the next; hardware and firmware, or firmware only.', picture: 'none' },
      { id: 'submit', title: 'Submit for approval', detail: 'An admin approves or rejects it at a gate.', picture: 'none' },
    ],
    checks: [
      { id: 'reason', text: 'The change and its reason are stated', step: 'state' },
      { id: 'impact', text: 'Impact shown and acknowledged', step: 'impact' },
      { id: 'released', text: 'A released revision is never edited', step: 'scope' },
    ],
    submit: 'Submit for approval',
  },
  {
    id: 'board-setup', name: 'Board setup', stage: 'Layout', variant: 'stepped', picture: 'board', kicad: true,
    guides: 'Outline, stackup, mounting and fixed parts', produces: "The board file with outline, stackup, rules and fixed parts, ready for trace to place the rest.",
    steps: [
      { id: 'outline', title: 'Outline', detail: 'Size and shape from the intent, corner radii, cut-outs and keep-out zones.' },
      { id: 'stackup', title: 'Stackup', detail: "Layer count, thickness, copper weights and dielectric, from JLCPCB's standard stackups unless there is a reason not to.", picture: 'none' },
      { id: 'mounting', title: 'Mounting', detail: 'Hole positions, sizes and clearances.' },
      { id: 'fixed', title: 'Fixed parts', detail: 'Connectors, switches, LEDs and anything the enclosure places, each with its position and side.' },
      { id: 'rules', title: 'Rules', detail: 'Minimum track, gap, via and annular ring set to what JLCPCB can build.', picture: 'none' },
    ],
    checks: [
      { id: 'outline', text: 'Outline closed and within the size limits', step: 'outline' },
      { id: 'stackup', text: 'Stackup complete, impedance widths met', step: 'stackup' },
      { id: 'fixed', text: 'Every fixed part has a mechanical reason', step: 'fixed' },
      { id: 'rules', text: "Rules within JLCPCB's capability", step: 'rules' },
    ],
  },
  {
    id: 'placement-adjust', name: 'Placement adjust', stage: 'Layout', variant: 'stepped', picture: 'board', kicad: true,
    guides: 'Moving parts trace placed', produces: 'The placed board at a recorded commit, ready for autorouting.',
    steps: [
      { id: 'blocks', title: 'Review by block', detail: "Each block's group, its critical parts and trace's reasons for where they sit." },
      { id: 'critical', title: 'Check the critical items', detail: 'Decoupling at its pins, crystal near its pins, switching loops tight, connectors on the edge, thermal room.' },
      { id: 'push', title: 'Move parts in KiCad and push', detail: 'The placement check and floorplan re-run on every push.' },
      { id: 'moves', title: 'Explain the moves', detail: 'Each moved part gets a one-line reason: mechanical, thermal, routing, assembly.' },
      { id: 'lock', title: 'Lock', detail: 'Lock what must not move before routing starts.' },
    ],
    checks: [
      { id: 'moves', text: 'Every moved part has a reason', step: 'moves' },
      { id: 'check', text: 'Placement check passes or is waived', step: 'push' },
      { id: 'fixed', text: 'Fixed parts have not moved', step: 'critical' },
      { id: 'locked', text: 'Parts the router must not move are locked', step: 'lock' },
    ],
  },
  {
    id: 'case-design', name: 'Case design', stage: 'Layout', variant: 'stepped', picture: 'render',
    guides: 'Choosing how the case is made and what room the board needs', produces: "The case script and settings, the case's STEP, STL and 3MF files, a fit check for the layout gate, and the order sheet for JLC3DP.",
    steps: [
      { id: 'process', title: 'Process and material', detail: "trace recommends MJF PA12-HP at JLC3DP and says why; pick another print process or CNC, within the service's size and wall limits.", picture: 'report' },
      { id: 'clearances', title: 'Clearances', detail: '0.5 mm from board edge to wall and 1.0 mm above the tallest part by default; give a part more room (a mating face, a heatsink) with its reason.', picture: 'board' },
      { id: 'case', title: 'Review the case', detail: 'The case around the board, its openings for edge connectors and its screws; change it by its settings, in chat, by editing mechanical/case.py, or by handing in a STEP.' },
      { id: 'fit', title: 'Fit check', detail: 'Every clash and every gap under its clearance, by part, with the design rules of the process; fix each, or waive it.', picture: 'report' },
      { id: 'order', title: 'Order files', detail: 'The files to upload, the options and the quantity, on an order sheet a person submits and pays at JLC3DP.', picture: 'order-sheet' },
    ],
    checks: [
      { id: 'process', text: "Process and material within JLC3DP's limits", step: 'process' },
      { id: 'clearances', text: 'Every clearance change has a reason', step: 'clearances' },
      { id: 'fit', text: 'Fit check passes or each clash is waived', step: 'fit' },
      { id: 'rules', text: "Within the process's design rules", step: 'fit' },
    ],
  },
  {
    id: 'gate-signing', name: 'Gate signing', stage: 'Every gate', variant: 'stepped', picture: 'traceability',
    guides: 'Reviewing the evidence before signing', produces: "The gate record and the start of the next stage's work.",
    steps: [
      { id: 'criteria', title: 'See the criteria', detail: "Each criterion, met, not met or waived, and trace's recommendation." },
      { id: 'evidence', title: 'Open the evidence', detail: 'The run or record behind each criterion; opening it is recorded.' },
      { id: 'waivers', title: 'Acknowledge the waivers', detail: 'Every waiver taken in this stage, its reason, risk and where it is caught.' },
      { id: 'notes', title: 'Note concerns', detail: 'Anything you are uneasy about but will not block on.' },
      { id: 'sign', title: 'Sign or return', detail: 'Sign, or send the stage back with what must change.' },
    ],
    checks: [
      { id: 'met', text: 'Every criterion met or waived', step: 'criteria' },
      { id: 'opened', text: 'Evidence opened for every criterion', step: 'evidence' },
      { id: 'acknowledged', text: 'Every waiver acknowledged', step: 'waivers' },
      { id: 'admin', text: 'The signer is an admin' },
    ],
  },
  {
    id: 'release-review', name: 'Release review', stage: 'Sign-off', variant: 'stepped', picture: 'report',
    guides: 'Reading the release report', produces: 'The approved release report, stored with the package.',
    steps: [
      { id: 'coverage', title: 'Coverage', detail: 'Every requirement verified or waived, with the waivers listed by severity.', picture: 'traceability' },
      { id: 'emc', title: 'EMC and signal integrity', detail: 'Prechecks and estimates against the compliance target, each labelled a pre-compliance estimate.' },
      { id: 'bom', title: 'Parts list', detail: 'Cost per board and for the build quantity, stock today, lifecycle, single-source parts.' },
      { id: 'fab', title: 'Fabrication', detail: "Board options, DRC against JLCPCB's capability, which parts JLCPCB places and which are placed by hand.", picture: 'board' },
      { id: 'changes', title: 'Changes since the last revision', detail: 'What changed and why, for a revision after the first.' },
      { id: 'decide', title: 'Decide', detail: 'Release, or return to the stage the concern belongs to.', picture: 'none' },
    ],
    checks: [
      { id: 'areas', text: 'Each of the five areas acknowledged' },
      { id: 'untested', text: 'No requirement untested; failing only waived', step: 'coverage' },
      { id: 'single', text: 'Single-source and not-active parts acknowledged', step: 'bom' },
      { id: 'cost', text: 'Expected cost for the build quantity stated', step: 'bom' },
    ],
  },
  {
    id: 'order-submit', name: 'Order submit', stage: 'Fabricate', variant: 'stepped', picture: 'order-sheet',
    guides: 'Placing the order on JLCPCB', produces: 'The order record, linked to the release; trace tracks it from the order number.',
    steps: [
      { id: 'stock', title: 'Re-check stock', detail: 'Stock and price for the build quantity, and any change since sign-off.' },
      { id: 'package', title: 'Download the package', detail: 'Gerbers, parts list and placement file from the release.', picture: 'none' },
      { id: 'options', title: 'Enter the options', detail: 'Each board option as the order sheet lists it, confirmed one by one.' },
      { id: 'matching', title: "Review JLCPCB's part matching", detail: 'Each line matched the intended LCSC part; record any part JLCPCB will not place.' },
      { id: 'pay', title: 'Pay and record', detail: 'The order number, the paid cost and the quoted ship date.', picture: 'none' },
    ],
    checks: [
      { id: 'stock', text: 'Stock re-checked today', step: 'stock' },
      { id: 'options', text: 'Every option matches the order sheet', step: 'options' },
      { id: 'matching', text: 'Every line matched or acknowledged', step: 'matching' },
      { id: 'recorded', text: 'Order number, cost and ship date recorded', step: 'pay' },
    ],
  },
  {
    id: 'incoming-inspection', name: 'Incoming inspection', stage: 'Fabricate', variant: 'checklist', picture: 'render',
    guides: 'Checking delivered boards against the release', produces: 'The inspection record per board, and the boards cleared for bring-up.',
    steps: [
      { id: 'count', title: 'Count', detail: 'Boards received against boards ordered.' },
      { id: 'look', title: 'Look', detail: 'A photo of each side of each board, against the release render.' },
      { id: 'faults', title: 'Record faults', detail: 'Bridges, missing or rotated parts, damage, each against its board and reference.' },
      { id: 'hand', title: 'Fit hand-placed parts', detail: 'The parts JLCPCB did not place, with their positions.' },
      { id: 'label', title: 'Label', detail: 'A serial for each board.' },
    ],
    checks: [
      { id: 'count', text: 'Count recorded; every board has a serial and photos', step: 'label' },
      { id: 'faults', text: 'Every fault against a board and reference', step: 'faults' },
      { id: 'hand', text: 'Every unplaced part fitted or marked', step: 'hand' },
    ],
  },
  {
    id: 'bench-setup', name: 'Bench setup', stage: 'Bring up', variant: 'checklist', picture: 'bench-wiring',
    guides: 'Wiring instruments and buses', produces: 'The saved bench configuration, ready for the bring-up run.',
    steps: [
      { id: 'needs', title: 'See what the plan needs', detail: 'The instruments, buses and probe points the bring-up and hardware tests call for.' },
      { id: 'connect', title: 'Connect and identify', detail: 'Each instrument answers its identity query; serial and CAN ports are found.' },
      { id: 'limits', title: 'Set the supply limits', detail: 'Voltage and current limits per channel, below the board\'s absolute maximum.' },
      { id: 'wire', title: 'Wire to the board', detail: 'Each probe, supply and bus connection matched to its net and test point.' },
      { id: 'record', title: 'Record the bench', detail: 'The configuration is saved so tests reuse it.' },
    ],
    checks: [
      { id: 'limits', text: 'Every supply has voltage and current limits', step: 'limits' },
      { id: 'idn', text: 'Every instrument answers its identity query', step: 'connect' },
      { id: 'wired', text: 'Every connection matched to a net', step: 'wire' },
      { id: 'hardware', text: 'Hardware use on this bench machine only' },
    ],
  },
  {
    id: 'bring-up-run', name: 'Bring-up run', stage: 'Bring up', variant: 'checklist', picture: 'bench-wiring',
    guides: 'Powering up and running the hardware tests', produces: 'Bench results in the coverage matrix and the issues that open the next revision.',
    steps: [
      { id: 'inspect', title: 'Inspect', detail: 'Solder bridges, missing or rotated parts and polarity, against the render and placement file.', picture: 'render' },
      { id: 'unpowered', title: 'Unpowered checks', detail: 'Resistance from each rail to ground, to catch shorts before power.' },
      { id: 'rails', title: 'Power each rail', detail: 'One at a time, current-limited, voltage and current read back against the expected values.', powered: true },
      { id: 'clocks', title: 'Clocks and reset', detail: 'Oscillators running, reset released.', powered: true },
      { id: 'firmware', title: 'Firmware', detail: 'Build and flash, then confirm the board talks.', powered: true },
      { id: 'tests', title: 'Run the hardware tests', detail: "The plan's hardware items, in order, each recorded against its requirement.", powered: true },
      { id: 'failures', title: 'Record failures', detail: 'Each failure becomes an issue routed to a specialist, with the evidence attached.' },
    ],
    checks: [
      { id: 'limits', text: 'Each step passed its limits before the next' },
      { id: 'shorts', text: 'No rail powered with a short or without a limit', step: 'unpowered' },
      { id: 'results', text: 'Every hardware test has a result', step: 'tests' },
      { id: 'issues', text: 'Every failure is a linked issue', step: 'failures' },
    ],
    submit: 'Finish bring-up',
  },
  {
    id: 'certification-run', name: 'Certification run', stage: 'Certify', variant: 'stepped', picture: 'report',
    guides: 'Preparing for, attending and recording the lab test', produces: "Compliance evidence against the requirements, and the Certify gate's record.",
    steps: [
      { id: 'pack', title: 'Read the test pack', detail: 'The standards and classes, the test setups, the firmware test modes, the pre-compliance margins.' },
      { id: 'book', title: 'Book', detail: 'The lab, the dates and the test plan agreed with the lab.', picture: 'none' },
      { id: 'prepare', title: 'Prepare', detail: 'Boards and firmware for the test modes, cables and support equipment.', picture: 'bench-wiring' },
      { id: 'results', title: 'Record results', detail: "Each test's result against its requirement, with the lab's report attached." },
      { id: 'failures', title: 'Handle failures', detail: "Each failure raises a change request with the lab's data.", picture: 'none' },
    ],
    checks: [
      { id: 'recorded', text: 'Lab, standard and setups recorded first', step: 'book' },
      { id: 'every', text: 'Every compliance requirement has a result or change', step: 'results' },
      { id: 'report', text: "The lab's report is stored", step: 'results' },
    ],
  },
  {
    id: 'production-release', name: 'Production release', stage: 'Produce', variant: 'stepped', picture: 'board',
    guides: 'Handing the design to volume manufacture', produces: 'The production release, and the start of Sustain.',
    steps: [
      { id: 'dfm', title: 'Review for manufacture', detail: 'Panelisation, fiducials, part orientation and spacing for volume assembly: fixed or waived.' },
      { id: 'dft', title: 'Review for test', detail: 'Every requirement that needs a production test has a test point and a step; programming access is reachable.' },
      { id: 'procedure', title: 'Write the procedure', detail: 'The manufacturing test and programming procedure, with pass limits.', picture: 'report' },
      { id: 'golden', title: 'Prove it on a golden board', detail: 'The procedure run end to end on a known-good board.', picture: 'bench-wiring' },
      { id: 'quote', title: 'Quote', detail: 'The volume quote at the production quantity, with its lead time.', picture: 'none' },
    ],
    checks: [
      { id: 'findings', text: 'DFM and DFT findings closed or waived', step: 'dfm' },
      { id: 'golden', text: 'Procedure passed on the golden board', step: 'golden' },
      { id: 'stored', text: 'Files, procedure, image and quote stored together', step: 'quote' },
    ],
  },
  {
    id: 'question-answer', name: 'Question answer', stage: 'Any', variant: 'conversational', picture: 'none',
    guides: 'Answering a question an agent raised', produces: 'The answer on the agent\'s job, and when it lasts, a rule or a requirement change.',
    steps: [
      { id: 'context', title: 'See the context', detail: 'What the agent is doing, what the question blocks, and the sources it already searched.' },
      { id: 'pick', title: 'Pick or write', detail: 'Choose the recommended option, another one, or write an answer.' },
      { id: 'specific', title: 'Make it specific', detail: 'A quantity gets a number and unit; a choice names the option; a fact names its source.' },
      { id: 'lasts', title: 'Say whether it lasts', detail: 'A one-off answer, or a rule for the project.' },
    ],
    checks: [
      { id: 'resolves', text: 'The answer resolves what it blocks', step: 'pick' },
      { id: 'units', text: 'Quantities have numbers and units', step: 'specific' },
      { id: 'source', text: 'A stated fact cites its source', step: 'specific' },
      { id: 'requirement', text: 'A requirement change goes through review', step: 'lasts' },
    ],
    submit: 'Send the answer',
  },
]

export const SKILL_BY_ID: Record<string, SkillDef> = Object.fromEntries(SKILLS.map((s) => [s.id, s]))

/** A skill's quality bar with the shared reason rule appended (not for the conversational intent, which has its own). */
export const checksOf = (s: SkillDef): SkillCheck[] => (s.id === 'intent-builder' ? s.checks : [...s.checks, DECISION_REASON])

/** The picture a step opens with. */
export const pictureOf = (s: SkillDef, stepId: string): PictureKind => s.steps.find((x) => x.id === stepId)?.picture ?? s.picture

export const PICTURE_WORDS: Record<PictureKind, string> = {
  sheet: 'the schematic sheet',
  board: 'the board',
  'block-diagram': 'the block diagram',
  'pin-map': 'the pin map',
  'bench-wiring': 'the bench wiring view',
  traceability: 'the traceability view',
  render: 'the board render',
  report: 'the report',
  'order-sheet': 'the order sheet',
  none: '',
}

/** The skill named by a slug, or a readable name for one not in the table. */
export const skillName = (slug: string): string => SKILL_BY_ID[slug]?.name ?? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')
