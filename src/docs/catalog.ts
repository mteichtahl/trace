/**
 * Scribe's documents (docs/scribe.md): the four documents every project keeps, their sections in order, what each
 * section is written from, which figures and values it carries, and the writing rules each document is held to.
 * This is the one source of truth: the skeleton a document starts from (`skeleton`), the checks (./checks.ts) and
 * Scribe's prompt all read it. Pure data and functions, no I/O.
 */
import { STAGE_IDS, type StageId } from '../core/journey-catalog.js'
import type { FigureKind } from './diagrams.js'

export const DOC_KINDS = ['hld', 'lld', 'protocol', 'guide'] as const
export type DocKind = (typeof DOC_KINDS)[number]

/** The records a section is written from. A change to one marks every section that names it as stale. */
export const SOURCE_KINDS = [
  'intent', 'requirements', 'decisions', 'architecture', 'parts', 'schematic', 'pin-plan', 'board', 'enclosure',
  'firmware', 'protocol-specs', 'protocol-runs', 'power', 'thermal', 'load', 'tests', 'fabrication', 'journey',
] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** The engineering values a document tabulates; each row carries its basis and source (./markers.ts). */
export const VALUE_KINDS = ['power', 'thermal', 'load'] as const
export type ValueKind = (typeof VALUE_KINDS)[number]

/** How a value was arrived at. `pending` is the only basis allowed without a number and a source. */
export const BASES = ['estimated', 'simulated', 'measured', 'pending'] as const
export type Basis = (typeof BASES)[number]

export interface SectionDef {
  id: string
  title: string
  /** What the section must say: Scribe's brief for it, in a sentence or two. */
  brief: string
  /** The first stage by which it must be written (no longer pending). */
  due: StageId
  sources: readonly SourceKind[]
  /** Figures it carries; `required` ones must be present once the section is due. */
  figures?: readonly { kind: FigureKind; required?: boolean }[]
  values?: readonly ValueKind[]
}

export interface DocDef {
  kind: DocKind
  title: string
  /** Path in the project repository. */
  file: string
  /** always, or only once the design has an interface to describe. */
  when: 'always' | 'interfaces'
  /** The stage it is created at. */
  from: StageId
  /** Who reads it, in words: sets the voice. */
  audience: string
  /** Writing rules beyond the shared ones (WRITING_RULES), for this document only. */
  rules: readonly string[]
  sections: readonly SectionDef[]
}

/** Rules every document follows; checks.ts enforces the ones a program can check. */
export const WRITING_RULES: readonly string[] = [
  'Plain, clear words. Every acronym is spelled out where it first appears, "Inter-Integrated Circuit (I2C)", or listed in the glossary.',
  'Part numbers, pin and net names, file names and commands go in `code`, so they are never mistaken for words.',
  'Write only between the section markers. Never change text outside them: it belongs to a person.',
  'No source, no number. A value not worked out yet is "pending", never a guess.',
  'Every figure has a marker naming its kind and source, and an italic caption saying what it shows.',
  'Diagrams are generated from trace\'s records, not drawn freehand: the same records the app\'s views are drawn from.',
  'A diagram must read on a printed page: more than five boxes run top to bottom (flowchart TB), labels stay short (the detail goes in the table beside it), and one diagram shows one idea.',
  'A section with nothing to say yet holds one line: "_Pending: <what it needs>._"',
  'Say what changed and why in the pull request, not in the document; the revision table records the release.',
  'Only the Journey section says where the project is (its stage, its gates); every other section describes the design as it is, so a gate signed never leaves it out of date.',
]

const S = (id: string, title: string, due: StageId, sources: readonly SourceKind[], brief: string, extra: Partial<SectionDef> = {}): SectionDef =>
  ({ id, title, due, sources, brief, ...extra })

export const DOCS: Readonly<Record<DocKind, DocDef>> = {
  hld: {
    kind: 'hld', title: 'High level design', file: 'docs/design/high-level-design.md', when: 'always', from: 'architect',
    audience: 'an engineer or reviewer new to the project, who needs the whole picture in ten minutes',
    rules: ['Explain what and why; leave how to the low level design.', 'Every requirement appears in the traceability table.'],
    sections: [
      S('overview', 'Overview', 'architect', ['intent', 'board'], 'What the product is, who it is for and what it must do, in one paragraph, with the hero render once there is a board.', { figures: [{ kind: 'render-iso' }] }),
      S('context', 'System context', 'architect', ['intent', 'architecture'], 'The product and everything it connects to: power, people, other systems.', { figures: [{ kind: 'system-context', required: true }] }),
      S('requirements', 'Requirements', 'architect', ['requirements'], 'The requirements grouped by kind, each with its testable criterion, and the traceability from requirement to block.'),
      S('architecture', 'Architecture', 'architect', ['architecture', 'decisions'], 'The blocks and how they connect, and the architecture chosen against the options compared.', { figures: [{ kind: 'block-diagram', required: true }] }),
      S('data-flow', 'Data flow', 'architect', ['architecture'], 'How data moves from inputs to outputs through the blocks.', { figures: [{ kind: 'data-flow', required: true }] }),
      S('key-parts', 'Key parts', 'architect', ['parts', 'decisions'], 'The key parts, why each was chosen, and their stock.'),
      S('power-summary', 'Power and thermal summary', 'prove', ['power', 'thermal'], 'The power budget at a glance and the tightest margins.', { values: ['power', 'thermal'] }),
      S('mechanical', 'Mechanical summary', 'layout', ['enclosure', 'board'], 'Size, mounting and the case, with the in-case render.', { figures: [{ kind: 'render-in-case' }] }),
      S('journey', 'Journey', 'architect', ['journey'], 'Where the project is: stages, gates signed and what comes next.', { figures: [{ kind: 'journey-flow', required: true }] }),
      S('decisions', 'Key decisions', 'architect', ['decisions'], 'Each decision that shaped the design, the options and the reason.'),
      S('risks', 'Risks and open questions', 'architect', ['decisions', 'requirements'], 'What could still go wrong and who owns each open question.'),
      S('glossary', 'Glossary', 'architect', [], 'Every acronym and term used in this document.'),
    ],
  },
  lld: {
    kind: 'lld', title: 'Low level design', file: 'docs/design/low-level-design.md', when: 'always', from: 'capture',
    audience: 'the engineer who builds, debugs or changes the board and its firmware',
    rules: ['Be exact: part numbers, pins, values and units.', 'Every circuit block names the requirements it serves.'],
    sections: [
      S('modules', 'Modules', 'capture', ['architecture', 'schematic'], 'Each block in detail: its circuit, its parts and the requirements it serves.', { figures: [{ kind: 'module-diagram', required: true }, { kind: 'schematic-sheet' }] }),
      S('pin-plan', 'Pin plan', 'capture', ['pin-plan'], 'Every used pin: net, function and peripheral, and the boot and debug pins.', { figures: [{ kind: 'pin-plan', required: true }] }),
      S('power-tree', 'Power tree', 'capture', ['schematic', 'power'], 'Every rail from source to load, with regulators and protection.', { figures: [{ kind: 'power-tree', required: true }] }),
      S('power-budget', 'Power budget', 'prove', ['power'], 'Current per rail at typical and worst case, regulator headroom, battery life where it applies.', { values: ['power'] }),
      S('thermal', 'Thermal', 'prove', ['thermal'], 'The hottest parts, temperature rise and margin to each part\'s rating.', { values: ['thermal'] }),
      S('loads', 'Loads and ratings', 'layout', ['load', 'board'], 'Connector and track current against ratings, bus loading.', { values: ['load'] }),
      S('interfaces', 'Interfaces', 'capture', ['schematic', 'protocol-specs'], 'Each interface: connector, signals, levels and the protocol specification section that covers it.', { figures: [{ kind: 'data-flow' }] }),
      S('firmware', 'Firmware', 'capture', ['firmware', 'pin-plan', 'protocol-specs'], 'Structure, start-up and main loop, and how each interface is driven.', { figures: [{ kind: 'firmware-flow' }] }),
      S('board', 'Board', 'layout', ['board', 'fabrication'], 'Stackup, placement, routing rules and the fabrication choices, with the board renders.', { figures: [{ kind: 'render-top', required: true }, { kind: 'render-bottom', required: true }, { kind: 'render-iso' }] }),
      S('mechanical', 'Mechanical', 'layout', ['enclosure', 'board'], 'The case: dimensions, clearances, mounting and cut-outs, and how it assembles.', { figures: [{ kind: 'mech-drawing', required: true }, { kind: 'render-exploded' }, { kind: 'render-in-case' }] }),
      S('verification', 'Verification', 'prove', ['tests', 'requirements'], 'What was simulated and tested, the results, and which requirement each proves.'),
      S('glossary', 'Glossary', 'capture', [], 'Every acronym and term used in this document.'),
    ],
  },
  protocol: {
    kind: 'protocol', title: 'Protocol specification', file: 'docs/design/protocol-specification.md', when: 'interfaces', from: 'capture',
    audience: 'an engineer writing firmware or software that talks to the product',
    rules: ['Every timing figure cites its datasheet or the standard.', 'Every message layout gives field, bits, range and unit.'],
    sections: [
      S('scope', 'Scope', 'capture', ['architecture', 'protocol-specs'], 'Which interfaces this covers, and which side of each the product is.'),
      S('physical', 'Physical layer', 'capture', ['schematic', 'protocol-specs'], 'Signals, levels, pull-ups, speeds and connectors per interface.'),
      S('messages', 'Messages', 'capture', ['protocol-specs', 'firmware'], 'Each message or register: layout, fields, ranges and units.', { figures: [{ kind: 'message-layout' }] }),
      S('sequences', 'Sequences', 'capture', ['protocol-specs', 'firmware'], 'Start-up, normal exchanges and error handling, step by step.', { figures: [{ kind: 'sequence', required: true }, { kind: 'state-machine' }] }),
      S('timing', 'Timing', 'prove', ['protocol-specs', 'protocol-runs'], 'Timing limits against what was simulated or measured.', { figures: [{ kind: 'timing-diagram', required: true }, { kind: 'decoded-trace' }] }),
      S('errors', 'Errors and recovery', 'capture', ['protocol-specs', 'firmware'], 'What can go wrong on each interface and how the product recovers.'),
      S('glossary', 'Glossary', 'capture', [], 'Every acronym and term used in this document.'),
    ],
  },
  guide: {
    kind: 'guide', title: 'User guide', file: 'docs/design/user-guide.md', when: 'always', from: 'layout',
    audience: 'the person who sets up and uses the product, who may not be an engineer',
    rules: ['Short sentences, one step per line, the reader\'s words not the designer\'s.', 'Every warning says what happens and what to do.'],
    sections: [
      S('about', 'About', 'layout', ['intent'], 'What the product does and what is in the box, with a render.', { figures: [{ kind: 'render-iso' }] }),
      S('safety', 'Safety', 'layout', ['requirements', 'power'], 'Power, heat and handling warnings that apply.'),
      S('setup', 'Setting up', 'layout', ['enclosure', 'board', 'schematic'], 'Assembly and connection, step by step.', { figures: [{ kind: 'render-exploded' }, { kind: 'setup-flow' }] }),
      S('using', 'Using it', 'signoff', ['firmware', 'requirements'], 'Everyday use: controls, indicators and what they mean.'),
      S('specifications', 'Specifications', 'signoff', ['requirements', 'power', 'thermal'], 'The figures a user needs: supply, current, temperature range, size.', { values: ['power', 'thermal'] }),
      S('troubleshooting', 'Troubleshooting', 'signoff', ['firmware', 'tests'], 'Symptoms, causes and fixes.', { figures: [{ kind: 'troubleshooting-flow', required: true }] }),
      S('glossary', 'Glossary', 'layout', [], 'Every acronym and term used in this guide.'),
    ],
  },
}

const ORDER = new Map<StageId, number>(STAGE_IDS.map((s, i) => [s, i]))

/** Whether `stage` has reached (or passed) `due`. */
export function reached(stage: StageId, due: StageId): boolean {
  return (ORDER.get(stage) ?? 0) >= (ORDER.get(due) ?? 0)
}

/** The documents a project keeps at `stage`: those it has reached, the protocol specification only with interfaces. */
export function docsFor(stage: StageId, hasInterfaces: boolean): DocDef[] {
  return DOC_KINDS.map((k) => DOCS[k]).filter((d) => reached(stage, d.from) && (d.when === 'always' || hasInterfaces))
}

export interface SkeletonContext {
  project: string
  revision: string
  commit: string
  /** ISO date the skeleton is written. */
  date: string
}

/** A new document: front matter, title, and every section pending with what it needs. */
export function skeleton(kind: DocKind, ctx: SkeletonContext): string {
  const d = DOCS[kind]
  const front = ['---', `project: ${ctx.project}`, `document: ${d.title}`, `revision: ${ctx.revision}`, `commit: ${ctx.commit}`, `updated: ${ctx.date}`, '---']
  const body = d.sections.flatMap((s) => [
    `<!-- scribe:section id="${s.id}" -->`, `## ${s.title}`, '', `_Pending: ${s.brief}_`, `<!-- scribe:end id="${s.id}" -->`, '',
  ])
  return [...front, '', `# ${ctx.project}: ${d.title}`, '', ...body].join('\n')
}
