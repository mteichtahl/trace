/**
 * trace's built-in journey catalog (docs/user-journey.md): the four project templates, their stages, every gate and
 * criterion trace knows, and which criteria each template has. It is the code's definition: each installation is
 * seeded with it and its admins may change their templates within it (src/core/templates.ts); a journey keeps the
 * definition it started from. A leaf module, so the template code and the journey code can both build on it.
 */
// ------------------------------------------------------------------ templates

export const TEMPLATES = ['board', 'fpga', 'firmware', 'mixed'] as const
export type Template = (typeof TEMPLATES)[number]
export const LATER_STAGES = ['certify', 'produce', 'sustain'] as const
export type LaterStage = (typeof LATER_STAGES)[number]
export const STAGE_IDS = ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup', ...LATER_STAGES] as const
export type StageId = (typeof STAGE_IDS)[number]

export const TEMPLATE_NAMES: Readonly<Record<Template, string>> = { board: 'Board', fpga: 'FPGA', firmware: 'Firmware', mixed: 'Mixed' }

export const STAGE_NAMES: Readonly<Record<StageId, string>> = {
  define: 'Define', architect: 'Architect', capture: 'Capture', prove: 'Prove', layout: 'Layout', signoff: 'Sign-off',
  release: 'Release', fabricate: 'Fabricate', bringup: 'Bring up', certify: 'Certify', produce: 'Produce', sustain: 'Sustain',
}

export const STAGES_OF: Readonly<Record<Template, readonly StageId[]>> = {
  board: ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'],
  fpga: ['define', 'architect', 'prove', 'signoff', 'release', 'fabricate', 'bringup'],
  firmware: ['define', 'architect', 'prove', 'release', 'bringup'],
  mixed: ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'],
}

/** Who moves a criterion: a person (through a guided skill) or trace (a checker tool). */
export type Owner = 'person' | 'trace'

/**
 * `after`: the criteria (keys of the same gate) whose work this one reviews; a person's criterion is not the next step
 * until they are met (the renders are approved once the board is routed, not before trace has drawn anything).
 */
export interface CriterionDef { key: string; text: string; owner: Owner; evidence: string; in?: readonly Template[]; after?: readonly string[] }
export interface GateDef { id: string; stage: StageId; name: string; criteria: readonly CriterionDef[] }

const ALL = TEMPLATES
const HARDWARE: readonly Template[] = ['board', 'fpga', 'mixed']
const BOARDS: readonly Template[] = ['board', 'mixed']
const FIRMWARE: readonly Template[] = ['firmware', 'mixed']
const LOGIC: readonly Template[] = ['fpga', 'mixed']

/** Every gate trace knows, in journey order, with each criterion and the templates it applies to (all, when unsaid). */
export const GATES: readonly GateDef[] = [
  { id: 'define', stage: 'define', name: 'requirements baseline', criteria: [
    { key: 'accepted', text: 'Every requirement is accepted or struck.', owner: 'person', evidence: 'the requirements list' },
    { key: 'measurable', text: 'Every requirement has a criterion that can be measured, with a number and a unit.', owner: 'person', evidence: 'the requirements list' },
    { key: 'firmware', text: 'The firmware requirements are accepted with the rest.', owner: 'person', evidence: 'the firmware requirements', in: FIRMWARE },
  ] },
  { id: 'architect', stage: 'architect', name: 'architecture review', criteria: [
    { key: 'blocks', text: 'The blocks and key parts are approved.', owner: 'person', evidence: 'the block diagram and key parts list' },
    { key: 'mapped', text: 'Every requirement maps to at least one block.', owner: 'trace', evidence: 'the requirement to block map' },
    { key: 'stock', text: 'Every key part is in stock for the build quantity, or its exception is signed.', owner: 'trace', evidence: 'the stock check', in: HARDWARE },
    { key: 'peripherals', text: 'Every interface has a peripheral on the microcontroller, and no peripheral is claimed twice.', owner: 'trace', evidence: 'the peripheral budget', in: FIRMWARE },
  ] },
  { id: 'capture', stage: 'capture', name: 'schematic review', criteria: [
    { key: 'erc', text: 'The electrical rule check is clean, or each finding is waived with a reason.', owner: 'trace', evidence: 'the electrical rule check report' },
    { key: 'datasheets', text: 'No conflict with a part\'s datasheet is left open.', owner: 'trace', evidence: 'the datasheet limit check' },
    { key: 'stock', text: 'Every part is in stock for the build quantity, or its exception is signed.', owner: 'trace', evidence: 'the parts list stock check' },
    { key: 'pins', text: 'The pin plan matches the schematic.', owner: 'person', evidence: 'the pin plan' },
    { key: 'alternates', text: 'No two functions claim the same pin\'s alternate function.', owner: 'trace', evidence: 'the pin plan check', in: ['mixed'] },
  ] },
  { id: 'prove', stage: 'prove', name: 'design proven', criteria: [
    { key: 'verified', text: 'Every requirement that can be checked before layout is verified or waived.', owner: 'trace', evidence: 'the coverage matrix' },
    { key: 'failing', text: 'No test item is failing.', owner: 'trace', evidence: 'the test plan results' },
    { key: 'logic', text: 'The logic builds for the chip and meets its timing.', owner: 'trace', evidence: 'the synthesis and timing report', in: LOGIC },
    { key: 'firmware', text: 'The firmware builds cleanly and its unit tests pass.', owner: 'trace', evidence: 'the firmware build and test run', in: FIRMWARE },
    { key: 'size', text: 'The firmware fits in the chip\'s flash and memory.', owner: 'trace', evidence: 'the firmware size report', in: FIRMWARE },
  ] },
  { id: 'layout', stage: 'layout', name: 'layout review', criteria: [
    { key: 'routed', text: 'Every connection is routed.', owner: 'trace', evidence: 'the routing report' },
    { key: 'drc', text: 'The design rule check is clean, or each finding is waived.', owner: 'trace', evidence: 'the design rule check report' },
    { key: 'lengths', text: 'Matched-length groups are within tolerance.', owner: 'trace', evidence: 'the length-match report' },
    { key: 'fit', text: 'The board fits its enclosure, or each clash is waived.', owner: 'trace', evidence: 'the fit check' },
    { key: 'renders', text: 'The board renders are approved.', owner: 'person', evidence: 'the board renders', after: ['routed', 'drc'] },
    { key: 'pins', text: 'The pin plan still matches after any pin swaps.', owner: 'trace', evidence: 'the pin plan check', in: ['mixed'] },
  ] },
  { id: 'signoff', stage: 'signoff', name: 'release approval', criteria: [
    { key: 'coverage', text: 'Every requirement is verified or waived.', owner: 'trace', evidence: 'the coverage matrix' },
    { key: 'emc', text: 'The radio interference prechecks are run and within the target.', owner: 'trace', evidence: 'the interference precheck', in: BOARDS },
    { key: 'bom', text: 'The parts list is checked for cost and stock at the build quantity.', owner: 'trace', evidence: 'the parts list check' },
    { key: 'docs', text: 'The project\'s documents are current: every one the release needs is there, every section due is written, and they pass the documents check.', owner: 'trace', evidence: 'the documents check' },
    { key: 'report', text: 'The release report is reviewed: coverage, interference estimates, parts list and open waivers.', owner: 'person', evidence: 'the release report', after: ['coverage', 'emc', 'bom', 'docs'] },
  ] },
  { id: 'fabricate.order', stage: 'fabricate', name: 'order approval', criteria: [
    { key: 'package', text: 'The release package is built and stored.', owner: 'trace', evidence: 'the release package' },
    { key: 'stock', text: 'Stock and prices are checked again today, and every line is available.', owner: 'trace', evidence: 'today\'s stock check' },
    { key: 'sheet', text: 'The order sheet matches the release.', owner: 'person', evidence: 'the order sheet' },
  ] },
  { id: 'fabricate.received', stage: 'fabricate', name: 'boards received', criteria: [
    { key: 'inspected', text: 'The boards are received and inspected.', owner: 'person', evidence: 'the inspection record' },
    { key: 'bench', text: 'The bring-up plan, test scripts and bench are ready.', owner: 'person', evidence: 'the bring-up plan and bench setup' },
    { key: 'firmware', text: 'The bring-up firmware is built and tagged with the hardware revision.', owner: 'trace', evidence: 'the firmware release build', in: ['mixed'] },
  ] },
  { id: 'bringup', stage: 'bringup', name: 'revision accepted', criteria: [
    { key: 'package', text: 'The release package is built and stored.', owner: 'trace', evidence: 'the release package', in: ['firmware'] },
    { key: 'verified', text: 'Every requirement is verified on hardware, or carried to the next revision as an issue.', owner: 'trace', evidence: 'the coverage matrix with bench results' },
    { key: 'firmware', text: 'The firmware requirements are verified on hardware.', owner: 'trace', evidence: 'the bench results', in: FIRMWARE },
  ] },
  { id: 'certify', stage: 'certify', name: 'certification', criteria: [
    { key: 'lab', text: 'Every compliance requirement passed at the lab, or a change request is raised.', owner: 'person', evidence: 'the lab results' },
  ] },
  { id: 'produce', stage: 'produce', name: 'production release', criteria: [
    { key: 'reviews', text: 'The manufacture and test reviews are closed or waived.', owner: 'person', evidence: 'the manufacture and test review' },
    { key: 'golden', text: 'The test procedure ran on the golden board and every step passed.', owner: 'trace', evidence: 'the golden board run' },
    { key: 'quote', text: 'The volume quote is recorded.', owner: 'person', evidence: 'the volume quote' },
  ] },
]

export interface TemplateCriterion { id: string; text: string; owner: Owner; evidence: string }
export interface TemplateGate { id: string; stage: StageId; name: string; criteria: TemplateCriterion[] }
export interface TemplateStage { id: StageId; name: string; optional: boolean; gates: TemplateGate[] }

/** The stages, gates and criteria a template (with its later stages) gives a project, in journey order. */
export function templateStages(template: Template, later: readonly LaterStage[] = []): TemplateStage[] {
  const ids = [...STAGES_OF[template], ...LATER_STAGES.filter((s) => later.includes(s))]
  return ids.map((id) => ({
    id, name: STAGE_NAMES[id], optional: (LATER_STAGES as readonly string[]).includes(id),
    gates: GATES.filter((g) => g.stage === id).map((g) => ({
      id: g.id, stage: g.stage, name: g.name,
      criteria: g.criteria.filter((c) => (c.in ?? ALL).includes(template)).map((c) => ({ id: `${g.id}.${c.key}`, text: c.text, owner: c.owner, evidence: c.evidence })),
    })),
  }))
}

