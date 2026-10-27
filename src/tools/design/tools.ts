/**
 * The design record tools, for the agents (src/tools/design/db.ts holds the tables): they propose, people decide.
 *
 *   design.intent        add / update / withdraw intent statements (topic, words, source, interface, limits, don't
 *                        care, unknown with the stage it is decided by, open questions with an owner, conflicts), link
 *                        and unlink requirements to the statements they are derived from, list (with people's
 *                        decisions where the journey is in scope: accepted, edited, rejected, left uncovered)
 *   design.architecture  the options compared (one recommended, why, what it gives up, risks), the criteria and trace's
 *                        scores with a reason each, the blocks of an option (role, key part numbers, requirements
 *                        served, place on the diagram) and what flows between them; list (with the person's chosen
 *                        option and fixed criteria, where in scope)
 *   design.pins          the pin plan of a microcontroller or FPGA (pin → function, peripheral instance, use, net,
 *                        reserved role, alternate functions the part allows); list; check: the plan on its own and
 *                        against the schematic's netlist (kicad-cli), recorded as a run with its findings
 *   design.sheets        which requirements each schematic sheet serves, and its block (or why it serves none); list
 *
 * Nothing here accepts, chooses or agrees for a person: those are the Intent builder, Requirements review,
 * Architecture choice and Pin plan review (skill.submit, design.decide), which write the journey record. Every write
 * here lands in the checkout's .trace/project.db, committed with the work like requirements.
 */
import { z } from 'zod'
import { loadJourney } from '../../core/journey.js'
import { type AnyTool, ToolError, defineTool } from '../../core/registry.js'
import { readSchematic } from '../kicad/schematic.js'
import { netlist } from '../kicad/schematic.js'
import { needSch, resolveProject } from '../kicad/project.js'
import { recorded } from '../kicad/record.js'
import { type DesignDecision, loadDesignDecisions } from './decisions.js'
import {
  CONNECTION_KINDS, INTENT_KINDS, INTENT_TOPICS, InterfaceSchema, LimitSchema, PIN_KINDS, PROPOSAL_STATUS, RESERVED_ROLES, STAGES, SourceSchema, withDesign,
} from './db.js'
import { architectureView, intentView, linksView, pinCheck } from './record.js'

const Id = z.string().regex(/^[A-Za-z][\w.-]{0,63}$/, 'letters, digits, ".", "_" and "-", starting with a letter')

/** People's decisions from the journey record, when this session has the project's journey in scope; else none. */
async function decisions(): Promise<{ list: DesignDecision[]; note: string | null }> {
  try {
    const { journeyScope } = await import('../journey/tools.js')
    const s = journeyScope()
    const list = (await s.journey.read((db) => (loadJourney(db) ? loadDesignDecisions(db) : []))).result
    return { list, note: null }
  } catch {
    return { list: [], note: 'People\'s decisions (accepted, chosen, agreed) are in the journey record, which this session cannot read: every row shows as proposed.' }
  }
}

// ------------------------------------------------------------------ design.intent

const IntentIn = z.object({
  id: Id.optional().describe('default: a new random INT-xxxxxx'),
  topic: z.enum(INTENT_TOPICS),
  kind: z.enum(INTENT_KINDS).default('statement').describe('statement; dont_care (the topic does not matter here); unknown (decided later: give decide_by); question (open, with an owner)'),
  text: z.string().min(3).max(2000).describe('the statement in plain words, as the person said it where they did'),
  source: SourceSchema.optional().describe('where it came from: the person\'s words, the brief, a document (with page), the imported design'),
  interface: InterfaceSchema.optional().describe('interfaces: type, connector, protocol, rate, direction'),
  limits: z.array(LimitSchema).max(20).optional().describe('the numbers in it, e.g. [{"name":"board_width","max":50,"unit":"mm"}]'),
  decide_by: z.enum(STAGES).optional().describe('unknown: the stage it must be decided by'),
  owner: z.string().max(200).optional().describe('question: who answers it'),
  conflicts: z.array(Id).max(20).optional().describe('statements it cannot hold together with'),
  testable: z.boolean().optional().describe('false when it cannot become a testable requirement as worded'),
}).strict()

export const intentTool = defineTool({
  name: 'design.intent',
  description: 'The product intent in the project database: statements by topic (purpose, environment, power, interfaces, performance, physical, compliance, build, constraints, references) with their source, and each requirement\'s link to the statement it is derived from. add / update / withdraw statements (proposals: a person accepts or edits them in the Intent builder and Requirements review), link / unlink a requirement to statements, list them with people\'s decisions where readable. Never mark anything accepted yourself.',
  input: z.object({
    action: z.enum(['add', 'update', 'withdraw', 'link', 'unlink', 'list']),
    statements: z.array(IntentIn).max(100).optional().describe('add: the statements'),
    id: Id.optional().describe('update / withdraw: which statement'),
    set: IntentIn.partial().omit({ id: true }).optional().describe('update: the fields to change'),
    requirement: z.string().min(1).max(64).optional().describe('link / unlink: the requirement'),
    intent: z.array(Id).max(20).optional().describe('link: the statements it is derived from; unlink: the one to drop'),
    replace: z.boolean().default(false).describe('link: drop the requirement\'s other links'),
    topic: z.enum(INTENT_TOPICS).optional().describe('list: only this topic'),
  }),
  run: async (a) => {
    if (a.action === 'list') {
      const d = await decisions()
      return withDesign((x) => {
        const rows = x.rows()
        const view = intentView(rows, d.list).filter((s) => !a.topic || s.topic === a.topic)
        return { total: view.length, statements: view, links: linksView(rows), ...(d.note ? { note: d.note } : {}) }
      })
    }
    return withDesign((x) => {
      switch (a.action) {
        case 'add': {
          if (!a.statements?.length) throw new ToolError('add: give statements')
          const added = x.addIntent(a.statements)
          return { added: added.map((s) => s.id), statements: added, next: 'Proposed: a person accepts, edits or rejects each in the Intent builder.' }
        }
        case 'update':
          if (!a.id || !a.set) throw new ToolError('update: give id and set')
          return { statement: x.updateIntent(a.id, a.set), note: 'If a person had accepted it, the changed words need their decision again.' }
        case 'withdraw':
          if (!a.id) throw new ToolError('withdraw: give id')
          return { statement: x.updateIntent(a.id, { status: 'withdrawn' }) }
        case 'link':
          if (!a.requirement || !a.intent?.length) throw new ToolError('link: give requirement and intent')
          return { requirement: a.requirement, derived_from: x.link(a.requirement, a.intent, a.replace).map((l) => l.intent) }
        case 'unlink':
          if (!a.requirement || a.intent?.length !== 1) throw new ToolError('unlink: give requirement and one intent')
          return { requirement: a.requirement, removed: x.unlink(a.requirement, a.intent[0] as string) }
      }
      throw new ToolError(`unknown action ${a.action}`)
    })
  },
})

// ------------------------------------------------------------------ design.architecture

const Part = z.object({ mpn: z.string().min(1).max(80), role: z.string().max(120).optional(), key: z.boolean().optional().describe('a key part: its stock is checked at the architecture gate') }).strict()
const Block = z.object({
  id: Id, name: z.string().min(1).max(80), role: z.string().max(300).optional(),
  parts: z.array(Part).max(20).optional(),
  requirements: z.array(z.string().min(1).max(64)).max(100).optional().describe('the requirement ids it serves'),
  x: z.number().min(0).max(1).optional().describe('where on the diagram, 0 (left) to 1 (right)'),
  y: z.number().min(0).max(1).optional().describe('0 (top) to 1 (bottom)'),
}).strict()

export const architectureTool = defineTool({
  name: 'design.architecture',
  description: 'The architecture record in the project database, for Architecture choice: options compared (set_option: name, summary, recommended with why and what it gives up, risks), the criteria to score them on with weights (set_criteria), trace\'s score of each option on each criterion with a one-line reason (set_scores, 1 worst to 5 best), the blocks of an option (set_blocks: name, role, key part numbers, the requirements each serves, place on the diagram) and what flows between them (set_connections: a rail and its voltage, a bus, an RF path), list. Propose at least two options. A person fixes the criteria and chooses; never record a choice yourself.',
  input: z.object({
    action: z.enum(['set_option', 'withdraw_option', 'set_criteria', 'set_scores', 'set_blocks', 'set_connections', 'list']),
    option: z.object({
      id: Id.describe('A, B, …'), name: z.string().min(1).max(120), summary: z.string().min(10).max(2000),
      recommended: z.boolean().default(false), why: z.string().max(2000).optional(), gives_up: z.string().max(1000).optional(), risks: z.array(z.string().max(300)).max(20).optional(),
    }).strict().optional().describe('set_option'),
    id: Id.optional().describe('withdraw_option / set_blocks / set_connections: the option'),
    criteria: z.array(z.object({ id: Id, name: z.string().min(1).max(80), weight: z.number().min(0).max(10).default(1), description: z.string().max(500).optional(), status: z.enum(PROPOSAL_STATUS).optional() }).strict()).max(20).optional(),
    scores: z.array(z.object({ option: Id, criterion: Id, score: z.number().min(1).max(5), reason: z.string().min(5).max(500) }).strict()).max(200).optional(),
    blocks: z.array(Block).max(40).optional(),
    connections: z.array(z.object({ id: Id.optional(), from: Id, to: Id, kind: z.enum(CONNECTION_KINDS), label: z.string().min(1).max(120).describe('what flows: "3.3 V, 150 mA", "SPI, 8 MHz"') }).strict()).max(100).optional(),
  }),
  run: async (a) => {
    if (a.action === 'list') {
      const d = await decisions()
      return withDesign((x) => ({ ...architectureView(x.rows(), d.list), ...(d.note ? { note: d.note } : {}) }))
    }
    return withDesign((x) => {
      switch (a.action) {
        case 'set_option': if (!a.option) throw new ToolError('set_option: give option'); return { option: x.setOption(a.option) }
        case 'withdraw_option': {
          if (!a.id) throw new ToolError('withdraw_option: give id')
          const o = x.rows().options.find((r) => r.id === a.id)
          if (!o) throw new ToolError(`no option ${a.id}`)
          return { option: x.setOption({ ...o, why: o.why ?? undefined, gives_up: o.gives_up ?? undefined, recommended: false, status: 'withdrawn' }) }
        }
        case 'set_criteria': if (!a.criteria?.length) throw new ToolError('set_criteria: give criteria'); return { criteria: x.setCriteria(a.criteria) }
        case 'set_scores': if (!a.scores?.length) throw new ToolError('set_scores: give scores'); return { scores: x.setScores(a.scores) }
        case 'set_blocks': if (!a.id || !a.blocks) throw new ToolError('set_blocks: give id (the option) and blocks'); return { option: a.id, blocks: x.setBlocks(a.id, a.blocks) }
        case 'set_connections': if (!a.id || !a.connections) throw new ToolError('set_connections: give id (the option) and connections'); return { option: a.id, connections: x.setConnections(a.id, a.connections) }
      }
      throw new ToolError(`unknown action ${a.action}`)
    })
  },
})

// ------------------------------------------------------------------ design.pins

const Pin = z.object({
  part: z.string().min(1).max(40).describe('the schematic reference: U1'),
  pin: z.string().min(1).max(20).describe('the pin number as the symbol has it'),
  name: z.string().max(40).optional().describe('the part\'s pin name: PA9'),
  function: z.string().max(60).optional().describe('what the firmware uses it as: USART1_TX, GPIO_OUT, ADC1_IN5'),
  peripheral: z.string().max(40).optional().describe('the peripheral instance: USART1'),
  use: z.string().max(120).optional().describe('what the instance serves: GPS, debug console'),
  net: z.string().max(120).optional().describe('the schematic net it must be on'),
  kind: z.enum(PIN_KINDS).default('signal'),
  reserved: z.enum(RESERVED_ROLES).optional().describe('the role the part gives this pin (boot, reset, debug), from its datasheet'),
  alternates: z.array(z.string().max(60)).max(40).optional().describe('the functions the part allows on this pin, from its datasheet'),
  constraints: z.string().max(500).optional(), note: z.string().max(500).optional(),
  status: z.enum(PROPOSAL_STATUS).optional().describe('withdrawn: take the pin out of the plan'),
}).strict()

export const pinsTool = defineTool({
  name: 'design.pins',
  description: 'The pin plan in the project database: for each microcontroller or FPGA pin, the function the firmware gives it, its peripheral instance and what that serves, the net it must be on, the role the part reserves for it (boot, reset, debug) and the alternate functions its datasheet allows there. set (rows by part and pin), list, or check: the plan on its own (every used pin has a net and a function the pin supports, no peripheral instance claimed by two uses, reserved pins keep their role) and against the schematic\'s netlist through kicad-cli (each pin on the net it names). check is a recorded run (findings as its artifact). A person agrees the plan in Pin plan review.',
  input: z.object({
    action: z.enum(['set', 'list', 'check']),
    pins: z.array(Pin).max(500).optional().describe('set: the pins'),
    part: z.string().max(40).optional().describe('list / check: only this part'),
    project: z.string().optional().describe('check: the KiCad project (omit for the configured or only one)'),
  }),
  run: async (a) => {
    if (a.action === 'set') {
      if (!a.pins?.length) throw new ToolError('set: give pins')
      return withDesign((x) => {
        const rows = x.setPins(a.pins ?? [])
        return { pins: rows.filter((p) => a.pins?.some((q) => q.part === p.part && q.pin === p.pin)), findings: pinCheck(rows.filter((p) => !a.part || p.part === a.part)) }
      })
    }
    const pins = withDesign((x) => x.rows().pins.filter((p) => (!a.part || p.part === a.part) && p.status !== 'withdrawn'))
    if (a.action === 'list') return { total: pins.length, pins, findings: pinCheck(pins) }
    if (!pins.length) throw new ToolError('check: the pin plan is empty (design.pins set first)')
    const p = await resolveProject(a.project)
    return recorded('design.pins_check', p.sch ?? p.name, a, async (run) => {
      const nl = await netlist(needSch(p))
      const nets = new Map([...nl.nets].map(([n, ns]) => [n, ns.map((x) => `${x.ref}.${x.pin}`)]))
      const findings = pinCheck(pins, nets)
      run.artifact('nets.tsv', [...nets].map(([n, ns]) => `${n}\t${ns.join(' ')}`).join('\n'))
      run.artifact('pin-findings.json', JSON.stringify(findings), 'application/json')
      const blocks = findings.filter((f) => f.severity === 'blocks').length
      run.measure('pins', pins.length)
      run.measure('findings', findings.length)
      run.measure('blocking', blocks)
      return {
        status: blocks ? 'fail' as const : 'pass' as const,
        summary: blocks ? `Pin plan: ${blocks} of ${findings.length} findings block` : `Pin plan matches the schematic${findings.length ? ` (${findings.length} to fix or waive)` : ''}`,
        result: { project: p.name, pins: pins.length, findings, matches: blocks === 0 },
      }
    })
  },
})

// ------------------------------------------------------------------ design.sheets

export const sheetsTool = defineTool({
  name: 'design.sheets',
  description: 'Which requirements each schematic sheet serves, and the block it implements (or, for a sheet that serves none, why: connectors only, mounting). set one sheet (its .kicad_sch path in the repository), or list them beside the schematic\'s own sheets.',
  input: z.object({
    action: z.enum(['set', 'list']),
    sheet: z.string().min(1).max(300).regex(/\.kicad_sch$/, 'a .kicad_sch path').optional().describe('set: the sheet file, relative to the repository'),
    block: z.string().max(64).optional(),
    requirements: z.array(z.string().min(1).max(64)).max(100).default([]),
    reason: z.string().max(500).optional().describe('set with no requirements: why it serves none'),
    project: z.string().optional().describe('list: the KiCad project whose sheets to show beside the record'),
  }),
  run: async (a) => {
    if (a.action === 'set') {
      if (!a.sheet) throw new ToolError('set: give sheet')
      return withDesign((x) => ({ sheet: x.setSheet({ sheet: a.sheet as string, block: a.block, requirements: a.requirements, reason: a.reason }) }))
    }
    const rows = withDesign((x) => x.rows().sheets)
    let files: string[] = []
    try {
      const p = await resolveProject(a.project)
      const sch = readSchematic(needSch(p), p.name)
      const { relative, dirname, resolve } = await import('node:path')
      const { candidates } = await import('../kicad/project.js')
      const { root } = await candidates()
      files = [...new Set([sch.root, ...sch.sheets.map((s) => resolve(dirname(sch.root), s.file))])].map((f) => relative(root, f))
    } catch { /* no KiCad project here: the record only */ }
    return { sheets: rows, ...(files.length ? { unnamed: files.filter((f) => !rows.some((r) => r.sheet === f)) } : {}) }
  },
})

export const tools: AnyTool[] = [intentTool, architectureTool, pinsTool, sheetsTool] as unknown as AnyTool[]
