/**
 * Which guided skill does a stage's step (components/skills/definitions.ts), in one place. A step about a criterion
 * maps by the criterion's id (`<gate>.<key>`, src/core/journey.ts GATES); the mock's and older answers' short ids map
 * by their words. A gate's step is Gate signing; a change's step is its review page; a question's is Question answer.
 * trace's own steps link to its running or queued job when one is about it. A step with no fitting skill gets no
 * link: a wrong link is worse than none.
 */
import type { RunSummary, StageStep } from './types'

/** criterion id → skill id. Only criteria a person does are here; trace's own checks have no skill. */
export const CRITERION_SKILLS: Record<string, string> = {
  'define.accepted': 'requirements-review',
  'define.measurable': 'requirements-review',
  'define.firmware': 'requirements-review',
  'architect.blocks': 'architecture-choice',
  'capture.pins': 'pin-plan-review',
  'layout.renders': 'placement-adjust',
  'signoff.report': 'release-review',
  'fabricate.order.sheet': 'order-submit',
  'fabricate.received.inspected': 'incoming-inspection',
  'fabricate.received.bench': 'bench-setup',
  'certify.lab': 'certification-run',
  'produce.reviews': 'production-release',
  'produce.quote': 'production-release',
}

/** A step's words → skill, for step ids the map above does not know (an older API, the mock). First match wins. */
const WORDS: [RegExp, string][] = [
  [/\bpin plan\b/i, 'pin-plan-review'],
  [/\brequirements?\b.*\b(accept|review|criterion|measur)/i, 'requirements-review'],
  [/\b(block diagram|architecture|key parts)\b/i, 'architecture-choice'],
  [/\b(finish|complete)\b.*\bschematic\b|\bschematic\b.*\b(finish|notes)\b/i, 'schematic-finish'],
  [/\bplacement\b|\brenders?\b.*\bapprov/i, 'placement-adjust'],
  [/\bboard (outline|setup)\b/i, 'board-setup'],
  [/\brelease (report|review)\b/i, 'release-review'],
  [/\border sheet\b/i, 'order-submit'],
  [/\b(inspect|received)\b/i, 'incoming-inspection'],
  [/\bbench\b.*\b(ready|set ?up|wir)/i, 'bench-setup'],
  [/\bbring-?up\b.*\b(run|test)/i, 'bring-up-run'],
]

const SKILL_NAMES: Record<string, string> = {
  'requirements-review': 'Requirements review', 'architecture-choice': 'Architecture choice', 'schematic-finish': 'Schematic finish',
  'pin-plan-review': 'Pin plan review', 'placement-adjust': 'Placement adjust', 'board-setup': 'Board setup', 'release-review': 'Release review',
  'order-submit': 'Order submit', 'incoming-inspection': 'Incoming inspection', 'bench-setup': 'Bench setup', 'bring-up-run': 'Bring-up run',
  'certification-run': 'Certification run', 'production-release': 'Production release', 'gate-signing': 'Gate signing', 'question-answer': 'Question answer',
}

/** The skill id a person's step is done with, or null. */
export function skillOf(step: Pick<StageStep, 'owner' | 'ref' | 'text'>): string | null {
  if (step.owner === 'trace') return null
  const ref = step.ref
  if (ref?.kind === 'gate') return 'gate-signing'
  if (ref?.kind === 'question') return 'question-answer'
  if (ref?.kind === 'change') return null
  if (ref?.kind === 'criterion' && CRITERION_SKILLS[ref.id]) return CRITERION_SKILLS[ref.id]!
  return WORDS.find(([re]) => re.test(step.text))?.[1] ?? null
}

/** The words trace uses for its jobs, matched against a trace step's words (stock, ERC, datasheets, routing, …). */
const JOB_WORDS = ['stock', 'erc', 'electrical rule', 'datasheet', 'route', 'routing', 'drc', 'design rule', 'render', 'simulat', 'spice', 'test plan', 'coverage', 'timing', 'firmware', 'draft']

/** trace's running or queued job a trace step is about, by shared words; null when none clearly is. */
export function jobOf(step: Pick<StageStep, 'owner' | 'text' | 'state'>, jobs: readonly RunSummary[]): RunSummary | null {
  if (step.owner !== 'trace' || step.state === 'done' || step.state === 'waived') return null
  const words = JOB_WORDS.filter((w) => step.text.toLowerCase().includes(w))
  if (!words.length) return null
  const live = jobs.filter((j) => j.state === 'running' || j.state === 'paused' || j.state === 'queued')
  return live.find((j) => words.some((w) => j.title.toLowerCase().includes(w))) ?? null
}

/** The link a step gets on the stage sheet: its review page or gate (from the reader), its skill, or its job. */
export function stepLink(step: StageStep, o: { projectId: string; jobs?: readonly RunSummary[] }): { label: string; to: string } | null {
  if (step.state === 'done' || step.state === 'waived') return null
  if (step.ref?.kind === 'change' && step.to) return { label: 'Review the change', to: step.to }
  const skill = skillOf(step)
  if (skill) return { label: SKILL_NAMES[skill] ?? skill, to: `/p/${o.projectId}/do/${skill}` }
  const job = jobOf(step, o.jobs ?? [])
  if (job) return { label: job.state === 'queued' ? 'Queued job' : 'Watch it', to: `/p/${o.projectId}/runs/${job.id}` }
  return null
}
