/**
 * New project's rules (docs/ui-design.md, "Creating a project"), pure so the screen and its tests share them: the
 * checks each of the six steps must pass before Continue, the part ceiling from an account class (a Guest can only
 * review; admins are on every project), the template trace recommends, and the repository name from the project name.
 */
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

export const slug = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

export interface Check { id: string; text: string; ok: boolean; step: StepId }

/** Every check across the steps (the quality bar shows those of the steps reached). */
export function checks(d: NewProjectDraft, o: { taken: string[] }): Check[] {
  const name = d.name.trim()
  const desc = d.description.trim()
  return [
    { id: 'name', step: 'about', text: 'Name not used by another project', ok: name.length >= 2 && !o.taken.map((t) => t.toLowerCase()).includes(name.toLowerCase()) },
    { id: 'desc', step: 'about', text: 'Description is a full sentence', ok: desc.length === 0 || (/[.!?]$/.test(desc) && desc.length <= 280) },
    { id: 'template', step: 'start', text: 'Template chosen', ok: !!d.template && !!d.start },
    { id: 'repo', step: 'repository', text: 'Repository reachable', ok: /^[A-Za-z0-9-]+$/.test(d.repository.owner) && /^[A-Za-z0-9._-]+$/.test(d.repository.name) && !!d.repository.branch.trim() },
    { id: 'parts', step: 'people', text: 'Everyone has a part', ok: d.people.every((p) => p.part === 'reviewer' || p.class !== 'guest') },
    { id: 'quantity', step: 'build', text: 'Build quantity set', ok: Number.isInteger(d.build.quantity) && d.build.quantity >= 1 && (d.build.budget === undefined || d.build.budget >= 0) },
  ]
}

/** Continue on a step: all of that step's checks pass. */
export const stepOk = (d: NewProjectDraft, step: StepId, o: { taken: string[] }): boolean => checks(d, o).filter((c) => c.step === step).every((c) => c.ok)

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
