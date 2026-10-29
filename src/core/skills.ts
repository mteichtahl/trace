/**
 * The twenty guided skills as the API knows them: each skill's steps and its quality bar's checks, by id. The app's
 * table (web/src/components/skills/definitions.ts, with the shared "reasons" check appended by checksOf) is the
 * source of the words; a test (test/api/skills.test.ts) keeps the ids here equal to it, so the checker below answers
 * exactly the checks the screens show.
 */
export interface SkillStepDef { id: string; title: string }
export interface SkillCheckDef { id: string; text: string; step?: string }
export interface SkillDef { id: string; name: string; stage: string; steps: SkillStepDef[]; checks: SkillCheckDef[] }

export const SKILL_DEFS: readonly SkillDef[] = [
  {
    id: 'design-import', name: 'Design import', stage: 'Start',
    steps: [{ id: 'point', title: 'Point at the design' }, { id: 'intent', title: 'Review the inferred intent' }, { id: 'requirements', title: 'Review the inferred requirements' }, { id: 'assessment', title: 'See the assessment' }, { id: 'entry', title: 'Confirm the entry stage' }],
    checks: [
      { id: 'confirmed', text: 'Every inferred requirement confirmed or struck', step: 'requirements' },
      { id: 'entry', text: 'Entry stage matches the first failing gate, or why not', step: 'entry' },
      { id: 'earlier', text: 'Earlier gates signed on the import evidence', step: 'entry' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'intent-builder', name: 'Intent builder', stage: 'Define',
    steps: [{ id: 'purpose', title: 'Purpose' }, { id: 'environment', title: 'Environment' }, { id: 'power', title: 'Power' }, { id: 'interfaces', title: 'Interfaces' }, { id: 'performance', title: 'Performance' }, { id: 'physical', title: 'Physical' }, { id: 'compliance', title: 'Compliance' }, { id: 'build', title: 'Build' }, { id: 'constraints', title: 'Constraints' }, { id: 'references', title: 'References' }],
    checks: [
      { id: 'answered', text: 'Every topic answered or marked' },
      { id: 'quantities', text: 'Every quantity has a number and unit' },
      { id: 'vague', text: 'No vague words' },
      { id: 'interfaces', text: 'Interfaces fully specified', step: 'interfaces' },
      { id: 'conflicts', text: 'No conflicts' },
      { id: 'testable', text: 'Each statement testable' },
      { id: 'owners', text: 'Open questions have an owner' },
    ],
  },
  {
    id: 'requirements-review', name: 'Requirements review', stage: 'Define',
    steps: [{ id: 'source', title: 'Read the source' }, { id: 'decide', title: 'Decide' }, { id: 'testable', title: 'Make it testable' }, { id: 'classify', title: 'Classify' }, { id: 'conflicts', title: 'Resolve conflicts' }, { id: 'cover', title: 'Cover the intent' }],
    checks: [
      { id: 'criterion', text: 'One testable criterion each', step: 'testable' },
      { id: 'conflicts', text: 'No conflicts or duplicates', step: 'conflicts' },
      { id: 'sources', text: 'Every requirement cites its source', step: 'source' },
      { id: 'covered', text: 'Every intent statement covered', step: 'cover' },
      { id: 'struck', text: 'Struck requirements keep their reason', step: 'decide' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'architecture-choice', name: 'Architecture choice', stage: 'Architect',
    steps: [{ id: 'criteria', title: 'Agree the criteria' }, { id: 'read', title: 'Read each option' }, { id: 'score', title: 'Score' }, { id: 'choose', title: 'Choose and state why' }, { id: 'map', title: 'Map' }, { id: 'parts', title: 'Accept the key parts' }],
    checks: [
      { id: 'two', text: 'At least two options compared', step: 'read' },
      { id: 'fixed', text: 'Criteria fixed before scoring', step: 'criteria' },
      { id: 'scored', text: 'Every score has a reason', step: 'score' },
      { id: 'mapped', text: 'Every requirement maps to a block', step: 'map' },
      { id: 'stock', text: 'Every key part in stock or excepted', step: 'parts' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'schematic-finish', name: 'Schematic finish', stage: 'Capture',
    steps: [{ id: 'walk', title: 'Walk each sheet' }, { id: 'notes', title: 'Resolve the notes' }, { id: 'push', title: 'Edit in KiCad and push' }, { id: 'changes', title: 'Explain the changes' }, { id: 'findings', title: 'Clear the findings' }, { id: 'sourcing', title: 'Check sourcing' }],
    checks: [
      { id: 'notes', text: 'No draft notes open', step: 'notes' },
      { id: 'changes', text: 'Every change has a reason', step: 'changes' },
      { id: 'erc', text: 'ERC run on the final push', step: 'push' },
      { id: 'datasheet', text: 'No datasheet conflict open', step: 'findings' },
      { id: 'mpn', text: 'MPN and LCSC on every part', step: 'sourcing' },
      { id: 'serves', text: 'Every sheet names its requirements', step: 'walk' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'pin-plan-review', name: 'Pin plan review', stage: 'Capture',
    steps: [{ id: 'map', title: 'See the map' }, { id: 'conflicts', title: 'Resolve conflicts' }, { id: 'room', title: 'Keep room' }, { id: 'agree', title: 'Agree' }],
    checks: [
      { id: 'functions', text: 'Every used pin has a net and a supported function', step: 'map' },
      { id: 'instances', text: 'No peripheral claimed twice', step: 'conflicts' },
      { id: 'boot', text: 'Boot, reset and debug pins keep their roles', step: 'conflicts' },
      { id: 'match', text: 'Firmware matches the schematic', step: 'agree' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'waiver', name: 'Waiver', stage: 'Any',
    steps: [{ id: 'what', title: 'Name what is waived' }, { id: 'reason', title: 'Give the reason' }, { id: 'risk', title: 'State the risk' }, { id: 'caught', title: 'Say where it is caught instead' }, { id: 'scope', title: 'Set the scope' }],
    checks: [
      { id: 'what', text: 'What is waived is named', step: 'what' },
      { id: 'reason', text: 'Reason given, not just "not needed"', step: 'reason' },
      { id: 'risk', text: 'Risk and severity given', step: 'risk' },
      { id: 'safety', text: 'A safety waiver names where it is verified', step: 'caught' },
      { id: 'scope', text: 'Scope named', step: 'scope' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'change-request', name: 'Change request', stage: 'Any',
    steps: [{ id: 'state', title: 'State the change' }, { id: 'impact', title: 'See the impact' }, { id: 'scope', title: 'Choose the scope' }, { id: 'submit', title: 'Submit for approval' }],
    checks: [
      { id: 'reason', text: 'The change and its reason are stated', step: 'state' },
      { id: 'impact', text: 'Impact shown and acknowledged', step: 'impact' },
      { id: 'released', text: 'A released revision is never edited', step: 'scope' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'board-setup', name: 'Board setup', stage: 'Layout',
    steps: [{ id: 'outline', title: 'Outline' }, { id: 'stackup', title: 'Stackup' }, { id: 'mounting', title: 'Mounting' }, { id: 'fixed', title: 'Fixed parts' }, { id: 'rules', title: 'Rules' }],
    checks: [
      { id: 'outline', text: 'Outline closed and within the size limits', step: 'outline' },
      { id: 'stackup', text: 'Stackup complete, impedance widths met', step: 'stackup' },
      { id: 'fixed', text: 'Every fixed part has a mechanical reason', step: 'fixed' },
      { id: 'rules', text: 'Rules within JLCPCB\'s capability', step: 'rules' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'placement-adjust', name: 'Placement adjust', stage: 'Layout',
    steps: [{ id: 'blocks', title: 'Review by block' }, { id: 'critical', title: 'Check the critical items' }, { id: 'push', title: 'Move parts in KiCad and push' }, { id: 'moves', title: 'Explain the moves' }, { id: 'lock', title: 'Lock' }],
    checks: [
      { id: 'moves', text: 'Every moved part has a reason', step: 'moves' },
      { id: 'check', text: 'Placement check passes or is waived', step: 'push' },
      { id: 'fixed', text: 'Fixed parts have not moved', step: 'critical' },
      { id: 'locked', text: 'Parts the router must not move are locked', step: 'lock' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'case-design', name: 'Case design', stage: 'Layout',
    steps: [{ id: 'process', title: 'Process and material' }, { id: 'clearances', title: 'Clearances' }, { id: 'case', title: 'Review the case' }, { id: 'fit', title: 'Fit check' }, { id: 'order', title: 'Order files' }],
    checks: [
      { id: 'process', text: "Process and material within JLC3DP's limits", step: 'process' },
      { id: 'clearances', text: 'Every clearance change has a reason', step: 'clearances' },
      { id: 'fit', text: 'Fit check passes or each clash is waived', step: 'fit' },
      { id: 'rules', text: "Within the process's design rules", step: 'fit' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'gate-signing', name: 'Gate signing', stage: 'Every gate',
    steps: [{ id: 'criteria', title: 'See the criteria' }, { id: 'evidence', title: 'Open the evidence' }, { id: 'waivers', title: 'Acknowledge the waivers' }, { id: 'notes', title: 'Note concerns' }, { id: 'sign', title: 'Sign or return' }],
    checks: [
      { id: 'met', text: 'Every criterion met or waived', step: 'criteria' },
      { id: 'opened', text: 'Evidence opened for every criterion', step: 'evidence' },
      { id: 'acknowledged', text: 'Every waiver acknowledged', step: 'waivers' },
      { id: 'admin', text: 'The signer is an admin' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'release-review', name: 'Release review', stage: 'Sign-off',
    steps: [{ id: 'coverage', title: 'Coverage' }, { id: 'emc', title: 'EMC and signal integrity' }, { id: 'bom', title: 'Parts list' }, { id: 'fab', title: 'Fabrication' }, { id: 'changes', title: 'Changes since the last revision' }, { id: 'decide', title: 'Decide' }],
    checks: [
      { id: 'areas', text: 'Each of the five areas acknowledged' },
      { id: 'untested', text: 'No requirement untested; failing only waived', step: 'coverage' },
      { id: 'single', text: 'Single-source and not-active parts acknowledged', step: 'bom' },
      { id: 'cost', text: 'Expected cost for the build quantity stated', step: 'bom' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'order-submit', name: 'Order submit', stage: 'Fabricate',
    steps: [{ id: 'stock', title: 'Re-check stock' }, { id: 'package', title: 'Download the package' }, { id: 'options', title: 'Enter the options' }, { id: 'matching', title: 'Review JLCPCB\'s part matching' }, { id: 'pay', title: 'Pay and record' }],
    checks: [
      { id: 'stock', text: 'Stock re-checked today', step: 'stock' },
      { id: 'options', text: 'Every option matches the order sheet', step: 'options' },
      { id: 'matching', text: 'Every line matched or acknowledged', step: 'matching' },
      { id: 'recorded', text: 'Order number, cost and ship date recorded', step: 'pay' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'incoming-inspection', name: 'Incoming inspection', stage: 'Fabricate',
    steps: [{ id: 'count', title: 'Count' }, { id: 'look', title: 'Look' }, { id: 'faults', title: 'Record faults' }, { id: 'hand', title: 'Fit hand-placed parts' }, { id: 'label', title: 'Label' }],
    checks: [
      { id: 'count', text: 'Count recorded; every board has a serial and photos', step: 'label' },
      { id: 'faults', text: 'Every fault against a board and reference', step: 'faults' },
      { id: 'hand', text: 'Every unplaced part fitted or marked', step: 'hand' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'bench-setup', name: 'Bench setup', stage: 'Bring up',
    steps: [{ id: 'needs', title: 'See what the plan needs' }, { id: 'connect', title: 'Connect and identify' }, { id: 'limits', title: 'Set the supply limits' }, { id: 'wire', title: 'Wire to the board' }, { id: 'record', title: 'Record the bench' }],
    checks: [
      { id: 'limits', text: 'Every supply has voltage and current limits', step: 'limits' },
      { id: 'idn', text: 'Every instrument answers its identity query', step: 'connect' },
      { id: 'wired', text: 'Every connection matched to a net', step: 'wire' },
      { id: 'hardware', text: 'Hardware use on this bench machine only' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'bring-up-run', name: 'Bring-up run', stage: 'Bring up',
    steps: [{ id: 'inspect', title: 'Inspect' }, { id: 'unpowered', title: 'Unpowered checks' }, { id: 'rails', title: 'Power each rail' }, { id: 'clocks', title: 'Clocks and reset' }, { id: 'firmware', title: 'Firmware' }, { id: 'tests', title: 'Run the hardware tests' }, { id: 'failures', title: 'Record failures' }],
    checks: [
      { id: 'limits', text: 'Each step passed its limits before the next' },
      { id: 'shorts', text: 'No rail powered with a short or without a limit', step: 'unpowered' },
      { id: 'results', text: 'Every hardware test has a result', step: 'tests' },
      { id: 'issues', text: 'Every failure is a linked issue', step: 'failures' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'certification-run', name: 'Certification run', stage: 'Certify',
    steps: [{ id: 'pack', title: 'Read the test pack' }, { id: 'book', title: 'Book' }, { id: 'prepare', title: 'Prepare' }, { id: 'results', title: 'Record results' }, { id: 'failures', title: 'Handle failures' }],
    checks: [
      { id: 'recorded', text: 'Lab, standard and setups recorded first', step: 'book' },
      { id: 'every', text: 'Every compliance requirement has a result or change', step: 'results' },
      { id: 'report', text: 'The lab\'s report is stored', step: 'results' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'production-release', name: 'Production release', stage: 'Produce',
    steps: [{ id: 'dfm', title: 'Review for manufacture' }, { id: 'dft', title: 'Review for test' }, { id: 'procedure', title: 'Write the procedure' }, { id: 'golden', title: 'Prove it on a golden board' }, { id: 'quote', title: 'Quote' }],
    checks: [
      { id: 'findings', text: 'DFM and DFT findings closed or waived', step: 'dfm' },
      { id: 'golden', text: 'Procedure passed on the golden board', step: 'golden' },
      { id: 'stored', text: 'Files, procedure, image and quote stored together', step: 'quote' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
  {
    id: 'question-answer', name: 'Question answer', stage: 'Any',
    steps: [{ id: 'context', title: 'See the context' }, { id: 'pick', title: 'Pick or write' }, { id: 'specific', title: 'Make it specific' }, { id: 'lasts', title: 'Say whether it lasts' }],
    checks: [
      { id: 'resolves', text: 'The answer resolves what it blocks', step: 'pick' },
      { id: 'units', text: 'Quantities have numbers and units', step: 'specific' },
      { id: 'source', text: 'A stated fact cites its source', step: 'specific' },
      { id: 'requirement', text: 'A requirement change goes through review', step: 'lasts' },
      { id: 'reasons', text: 'Every choice against the recommendation has a reason' },
    ],
  },
]

export const SKILL_IDS = SKILL_DEFS.map((s) => s.id)
export const skillDef = (id: string): SkillDef | undefined => SKILL_DEFS.find((s) => s.id === id)
