/**
 * New project's rules (docs/ui-design.md, "Creating a project"), pure so the screen and its tests share them: the
 * checks each of the six steps must pass before Continue, the part ceiling from an account class (a Guest can only
 * review; admins are on every project), the template trace recommends, and the repository name from the project name.
 */
import { money } from '@/lib/format'
import type { PersonClass, Template } from '@/lib/types'
import type { NewProjectDraft } from '@/lib/types-s1'

export const STEPS = [
  { id: 'about', title: 'About', sub: 'Name, description, icon' },
  { id: 'start', title: 'How it starts', sub: 'An idea or a KiCad design; the template' },
  { id: 'repository', title: 'Repository', sub: 'New or existing' },
  { id: 'people', title: 'People', sub: 'Who works on it, and their part' },
  { id: 'build', title: 'Build and budget', sub: 'Quantity, budget, later stages' },
  { id: 'review', title: 'Review', sub: 'What will be set up' },
] as const
export type StepId = (typeof STEPS)[number]['id']

/** The Review step's line for Build and budget: every value set on that step, and what was left unset. */
export function buildWords(b: NewProjectDraft['build']): string {
  const later = Object.entries(b.later).filter(([, on]) => on).map(([k]) => k)
  return [
    `${b.quantity} boards per build`,
    b.unitCost !== undefined ? `a target unit cost of ${money(b.unitCost)}` : 'no target unit cost',
    b.budget !== undefined ? `a build budget of ${money(b.budget)} per revision` : 'no build budget',
    b.cloudBudget !== undefined ? `a cloud-work allowance of ${money(b.cloudBudget)}` : 'no cloud-work allowance',
  ].join(', ') + (later.length ? `, with ${later.join(' and ')}` : '') + `; ${b.fab}.`
}

export const slug = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

export interface Check { id: string; text: string; ok: boolean; step: StepId }

/** What projects.repo_check answers of the repository the wizard would use (src/api/actions-projects.ts). */
export interface RepoCheck {
  repo: string
  /** on GitHub already; null when GitHub could not be asked (projects.create asks again) */
  exists: boolean | null
  /** the project trace knows there: retiring a project keeps its repository and its record */
  project: { name: string | null; retired: boolean } | null
  suggestion: string | null
  /** what to say when it is taken */
  text: string | null
}

/** What the check of the repository needs: its answer for this repository, or undefined while it is being asked. */
export interface CheckContext { taken: string[]; repo?: RepoCheck | undefined }

/** The repository the draft names, the way projects.create takes it. */
export const repoOf = (d: NewProjectDraft): string => `${d.repository.owner}/${d.repository.name || slug(d.name)}`

/**
 * Whether the repository can be used as the draft says. A new one must not be on GitHub yet (test-esp32 log #78: it
 * was shown "reachable" because the name was well formed, though run 1's retired project still held it); an existing
 * one must be there, and not a retired project's (that project is restored instead). An answer for another name, or
 * none yet, is not met.
 */
export function repoOk(d: NewProjectDraft, c: RepoCheck | undefined): boolean {
  const wellFormed = /^[A-Za-z0-9-]+$/.test(d.repository.owner) && /^[A-Za-z0-9._-]+$/.test(d.repository.name || slug(d.name)) && !!d.repository.branch.trim()
  if (!wellFormed || !c || c.repo.toLowerCase() !== repoOf(d).toLowerCase()) return false
  if (c.project?.retired) return false
  return d.repository.mode === 'new' ? c.exists !== true : c.exists !== false
}

/** Every check across the steps (the quality bar shows those of the steps reached). */
export function checks(d: NewProjectDraft, o: CheckContext): Check[] {
  const name = d.name.trim()
  const desc = d.description.trim()
  return [
    { id: 'name', step: 'about', text: 'Name not used by another project', ok: name.length >= 2 && !o.taken.map((t) => t.toLowerCase()).includes(name.toLowerCase()) },
    // the description is optional: with none there is nothing to check, so the bar does not show it as met (test-esp32
    // log #1, #79: "Description is a full sentence" was ticked with the box empty)
    ...(desc.length ? [{ id: 'desc', step: 'about' as const, text: 'Description is a full sentence', ok: /[.!?]$/.test(desc) && desc.length <= 280 }] : []),
    { id: 'template', step: 'start', text: 'Template chosen', ok: !!d.template && !!d.start },
    { id: 'repo', step: 'repository', text: d.repository.mode === 'new' ? 'Repository name free on GitHub' : 'Repository reachable', ok: repoOk(d, o.repo) },
    { id: 'parts', step: 'people', text: 'Everyone has a part', ok: d.people.every((p) => p.part === 'reviewer' || p.class !== 'guest') },
    { id: 'quantity', step: 'build', text: 'Build quantity set', ok: Number.isInteger(d.build.quantity) && d.build.quantity >= 1 && (d.build.budget === undefined || d.build.budget >= 0) && (d.build.cloudBudget === undefined || d.build.cloudBudget >= 0) },
  ]
}

/** Continue on a step: all of that step's checks pass. */
export const stepOk = (d: NewProjectDraft, step: StepId, o: CheckContext): boolean => checks(d, o).filter((c) => c.step === step).every((c) => c.ok)

/** The parts a person may have on a project, by account class. Admins are not chosen: they are on every project. */
export function partsFor(cls: PersonClass | 'new'): ('contributor' | 'reviewer')[] {
  if (cls === 'guest') return ['reviewer']
  if (cls === 'admin') return []
  return ['contributor', 'reviewer']
}

/** The template trace recommends, with why. */
export function recommendTemplate(text: string, start: NewProjectDraft['start']): { template: Template; why: string } {
  const fpga = /\b(fpga|cpld|verilog|vhdl|lattice|xilinx)/i.test(text)
  const fw = /\b(firmware|mcu|microcontroller|stm32|esp32|rp2040|nrf|lora|ble|usb)/i.test(text)
  if (fpga && fw) return { template: 'mixed', why: 'It mentions both an FPGA and firmware' }
  if (fpga) return { template: 'fpga', why: 'It mentions an FPGA' }
  if (start === 'design' && fw) return { template: 'mixed', why: 'An existing design with a microcontroller has firmware to track' }
  return { template: 'board', why: fw ? 'A board with a microcontroller: the firmware track comes with the Board template' : 'A board, from the description' }
}
