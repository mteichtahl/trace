/**
 * What a reopen for changed requirements makes stale, stage by stage (test-esp32 log #62, #71, #112, #114, #116).
 *
 * A requirement changed after the baseline takes the project back to Define, and every gate from there is signed
 * again (src/api/pending-changes.ts backToDefine): that rule stands. What it no longer does is start every stage's
 * work again. In the test run one acceptance limit changed (REQ-39855b, ±3 % to 3.1-3.6 V) and re-signing each gate
 * started that stage's agents from the top: a new "propose the architecture" job, a schematic job, a docs job each
 * time, and each gate locked until they finished and their changes were accepted, about US$20 and an hour for a
 * change the architecture and the schematic did not depend on. Now a stage whose work the change does not reach keeps
 * its evidence (core carryStage) and is signed again straight away; a stage it reaches has its agent redo only that.
 *
 *   requirementReopens  the reopens for changed requirements since a stage's gates were last signed, each with what
 *                       it took back (core ReopenDetail); null when there is none, or one was for anything else (a
 *                       failure, a changed decision, a new revision): then the stage's work starts in full as before
 *   readTrace           what the changed requirements reach in the default branch's record: how each was edited
 *                       (its words or only its acceptance criterion, against the words a person agreed before the
 *                       reopen), the blocks of the chosen architecture, the schematic sheets and the test items that
 *                       name it (arch_blocks, sheet_requirements, test_items)
 *   stageScope          pure: whether the change reaches a stage's work, what it reaches, and why, in words
 *   resignPlan          pure: each gate to sign again after the reopen, and whether its evidence stands (the
 *                       Overview's list, journey.get `resign`)
 *   scopedRequest       a stage's work request led by what stands and what to redo
 *   reopenHeadline      that job's title, what it does in a line (never the request's opening, cut short)
 *
 * The design stages are traced to requirements (architecture blocks, schematic sheets), so a change of a
 * requirement's words reaches the ones that name it. A change of its acceptance criterion alone reaches none of them:
 * the design is chosen and drawn for what the requirement asks, and Prove checks it against the new criterion; a
 * test that fails there sends the circuit back, as any failing test does. The layout is not traced to requirements,
 * so a change of any requirement's words lays it out again. Prove and Sign-off check every requirement: any change
 * reaches them, and Prove runs again only the tests of the changed requirements.
 */
import type { DatabaseSync } from 'node:sqlite'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import type { CriterionRow, Evidence, JourneyRecord, ReopenDetail, StageId } from '../core/journey.js'
import { loadDesignDecisions, standing } from '../tools/design/decisions.js'
import { readDesignRows } from '../tools/design/db.js'
import { architectureView } from '../tools/design/record.js'
import { type Context, withRecordDb } from './action-kit.js'
import { hasTable } from './record-read.js'

/** How a requirement changed since a person agreed it: its words, only its acceptance criterion, struck, or new. */
export type Edit = 'words' | 'acceptance' | 'struck' | 'new'

/** One reopen for changed requirements, as its decision kept it. */
export interface Reopen { at: number; stage: StageId; from: StageId; requirements: string[]; rewound: ReopenDetail['rewound'] }

/** What the changed requirements reach in the default branch's record (readTrace). */
export interface Trace {
  edits: Record<string, Edit[]>
  /** requirement → the blocks of the chosen architecture that serve it; null: no architecture is chosen */
  blocks: Record<string, string[]> | null
  /** requirement → the schematic sheets that serve it; null: no sheet is on record */
  sheets: Record<string, string[]> | null
  /** requirement → its test items */
  tests: Record<string, string[]>
}

/** Whether a stage keeps its work after the change: `kept`, why in words, and what the change reaches in it. */
export interface StageScope { stage: StageId; kept: boolean; why: string; reach: string[] }

const ordOf = (r: Pick<JourneyRecord, 'stages'>, s: string | null | undefined): number => r.stages.find((x) => x.id === s)?.ord ?? -1

const asDetail = (v: unknown): ReopenDetail | null => {
  if (!v || typeof v !== 'object') return null
  const d = v as Partial<ReopenDetail>
  if (!Array.isArray(d.requirements) || !d.requirements.length || !Array.isArray(d.rewound) || typeof d.from !== 'string' || typeof d.at !== 'number') return null
  return d as ReopenDetail
}

/**
 * The reopens for changed requirements `stage` has to be signed again after: each reopen of an earlier stage since a
 * gate of `stage` was last signed. Null when there is none, or when one of them was for anything else (a failure, a
 * changed decision, or one written before reopens kept what they took back) or a new revision started since: the
 * stage then starts its work in full, as before. Newest first. Pure.
 */
export function requirementReopens(r: JourneyRecord, stage: StageId): Reopen[] | null {
  const ord = ordOf(r, stage)
  const gates = new Set(r.gates.filter((g) => g.stage === stage).map((g) => g.id))
  if (!gates.size) return null
  // since a gate of it was last signed, or (never signed) since it started: a reopen before then took nothing of it
  const signed = Math.max(r.stages.find((s) => s.id === stage)?.started ?? 0, ...r.decisions.filter((d) => d.kind === 'gate.signed' && gates.has(d.ref ?? '')).map((d) => d.at))
  if (!signed) return null
  const since = r.decisions.filter((d) => d.at > signed)
  if (since.some((d) => d.kind === 'revision.started')) return null
  const reopens = since.filter((d) => d.kind === 'stage.reopened' && ordOf(r, d.stage) < ord)
  if (!reopens.length) return null
  const out: Reopen[] = []
  for (const d of reopens) {
    const x = asDetail(d.detail)
    if (!x) return null
    out.push({ at: x.at as number, stage: d.stage as StageId, from: x.from, requirements: x.requirements, rewound: x.rewound })
  }
  return out.reverse()
}

const GONE = new Set(['rejected', 'obsolete'])
const strs = (v: unknown): string[] => {
  try { const x: unknown = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [] } catch { return [] }
}

/**
 * What the changed requirements `ids` reach in the record `db` (the default branch's, as withRecordDb gives it):
 * how each changed since the decision a person made on it before `at` (the first reopen), and what names it.
 */
export function readTrace(db: DatabaseSync, ids: readonly string[], at: number): Trace {
  const decisions = loadDesignDecisions(db)
  const rows = new Map((hasTable(db, 'requirements') ? db.prepare('SELECT id, text, acceptance, status FROM requirements').all() as Record<string, unknown>[] : [])
    .map((q) => [String(q.id), { text: String(q.text), acceptance: q.acceptance === null || q.acceptance === undefined ? null : String(q.acceptance), status: String(q.status) }]))
  const now = standing(decisions, 'requirement')
  const edits: Record<string, Edit[]> = {}
  for (const id of ids) {
    const before = decisions.filter((d) => d.kind === 'requirement' && d.target === id && d.at < at).at(-1)
    const row = rows.get(id)
    const after = now.get(id)
    if (!before || before.choice === 'struck') edits[id] = ['new']
    else if (!row || GONE.has(row.status) || (after && after.at >= at && after.choice === 'struck')) edits[id] = ['struck']
    // a decision kept without its words: what was agreed cannot be compared, so it counts as changed
    else if (typeof before.detail.text !== 'string') edits[id] = ['words']
    else {
      const e: Edit[] = []
      if (before.detail.text !== row.text) e.push('words')
      if (!('acceptance' in before.detail) || before.detail.acceptance !== row.acceptance) e.push('acceptance')
      edits[id] = e
    }
  }
  const design = readDesignRows(db)
  const arch = architectureView(design, decisions)
  const chosen = arch.chosen ? arch.options.find((o) => o.id === arch.chosen!.option) : undefined
  const by = <T>(items: readonly T[], reqs: (t: T) => readonly string[], name: (t: T) => string): Record<string, string[]> => {
    const m: Record<string, string[]> = {}
    for (const t of items) for (const q of reqs(t)) if (ids.includes(q)) (m[q] ??= []).push(name(t))
    return m
  }
  const tests = hasTable(db, 'test_items') ? db.prepare('SELECT id, requirements FROM test_items ORDER BY id').all() as Record<string, unknown>[] : []
  return {
    edits,
    blocks: chosen ? by(chosen.blocks, (b) => b.serves, (b) => b.name) : null,
    sheets: design.sheets.length ? by(design.sheets, (s) => s.requirements, (s) => s.sheet) : null,
    tests: by(tests, (t) => strs(t.requirements), (t) => String(t.id)),
  }
}

const and = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** How each changed requirement changed, in words: "REQ-39855b's acceptance criterion changed". */
export function editWords(ids: readonly string[], t: Pick<Trace, 'edits'>): string {
  // [one, many] words for each kind of edit, the first that fits each requirement
  const groups: [string, string, (e: Edit[]) => boolean][] = [
    ['is new', 'are new', (e) => e.includes('new')],
    ['was struck', 'were struck', (e) => e.includes('struck')],
    ['changed its words', 'changed their words', (e) => e.includes('words')],
    ['changed only its acceptance criterion', 'changed only their acceptance criteria', (e) => e.length === 1 && e[0] === 'acceptance'],
    ['reads as it was agreed', 'read as they were agreed', (e) => !e.length],
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const [one, many, test] of groups) {
    const these = ids.filter((id) => !seen.has(id) && test(t.edits[id] ?? ['words']))
    these.forEach((id) => seen.add(id))
    if (these.length) out.push(`${and(these)} ${these.length > 1 ? many : one}`)
  }
  return out.join('; ')
}

const DESIGN: readonly StageId[] = ['architect', 'capture', 'layout']

/**
 * Whether the change of `ids` reaches `stage`'s work, given what earlier stages of the plan keep (`earlier`, in
 * order). A design stage is done again when one before it is; Prove and Sign-off when any requirement changed or a
 * design stage is done again. Pure.
 */
export function stageScope(stage: StageId, ids: readonly string[], t: Trace, earlier: readonly StageScope[] = []): StageScope {
  const edits = (id: string): Edit[] => t.edits[id] ?? ['words']
  const design = ids.filter((id) => edits(id).some((e) => e !== 'acceptance'))
  const changed = ids.filter((id) => edits(id).length)
  const redo = (why: string, reach: string[] = []): StageScope => ({ stage, kept: false, why, reach })
  const kept = (what: string, untraced: string): StageScope => {
    const only = ids.filter((id) => edits(id).length === 1 && edits(id)[0] === 'acceptance')
    const same = ids.filter((id) => !edits(id).length)
    const free = design.filter((id) => !only.includes(id))
    const parts = [
      only.length ? `only the acceptance criterion of ${and(only)} changed, and Prove checks the design against it` : '',
      free.length ? `${untraced} ${and(free)}` : '',
      same.length ? `${and(same)} ${same.length > 1 ? 'read' : 'reads'} as agreed before` : '',
    ].filter(Boolean)
    return { stage, kept: true, why: `${what} stands: ${parts.join('; ')}.`, reach: [] }
  }
  const before = earlier.find((s) => !s.kept && DESIGN.includes(s.stage))
  const name = STAGE_NAMES[stage]
  switch (stage) {
    case 'architect': {
      if (!t.blocks) return redo('no architecture is chosen on the default branch yet')
      const reach = design.filter((id) => edits(id).includes('new') || t.blocks![id]?.length)
      if (reach.length) return redo(`${and(reach)} changed, and ${and([...new Set(reach.flatMap((id) => t.blocks![id] ?? ['no block yet']))])} of the chosen architecture ${reach.length > 1 || (t.blocks[reach[0]!]?.length ?? 0) > 1 ? 'serve' : 'serves'} ${reach.length > 1 ? 'them' : 'it'}`, reach)
      return kept('The chosen architecture', 'no block of the chosen architecture serves')
    }
    case 'capture': {
      if (before) return redo(`the ${STAGE_NAMES[before.stage].toLowerCase()} work it builds on is done again`)
      if (!t.sheets) return redo('no schematic sheet is on record with the requirements it serves')
      const reach = design.filter((id) => edits(id).includes('new') || t.sheets![id]?.length)
      if (reach.length) return redo(`${and(reach)} changed, and the schematic sheets ${and([...new Set(reach.flatMap((id) => t.sheets![id] ?? []))]) || 'that serve it'} serve ${reach.length > 1 ? 'them' : 'it'}`, reach)
      return kept('The schematic', 'no schematic sheet serves')
    }
    case 'layout': {
      if (before) return redo(`the ${STAGE_NAMES[before.stage].toLowerCase()} work it builds on is done again`)
      if (design.length) return redo(`${and(design)} changed its words, and the board is not traced to requirements`, design)
      return kept('The board', 'the board is not traced to')
    }
    case 'prove': {
      const tests = [...new Set(changed.flatMap((id) => t.tests[id] ?? []))]
      if (before) return redo(`the ${STAGE_NAMES[before.stage].toLowerCase()} work it checks is done again`, tests)
      if (changed.length) {
        const none = changed.filter((id) => !(t.tests[id]?.length))
        return redo(`${editWords(changed, t)}: ${tests.length ? `${tests.join(', ')} ${tests.length > 1 ? 'are' : 'is'} run again` : ''}${tests.length && none.length ? '; ' : ''}${none.length ? `${and(none)} ${none.length > 1 ? 'have' : 'has'} no test yet` : ''}`, tests)
      }
      return kept('The verification', '')
    }
    case 'signoff': {
      const again = earlier.find((s) => !s.kept)
      if (again) return redo(`${STAGE_NAMES[again.stage]} is done again`)
      if (changed.length) return redo(`${and(changed)} changed, and the release report covers every requirement`)
      return kept('The release report', '')
    }
    default:
      return redo(`${name} is always done again after a change of requirements`)
  }
}

/** The stage's work request, led by what the change reaches in it (`s`) and how the requirements changed. */
export function scopedRequest(request: string, s: StageScope, ids: readonly string[], t: Pick<Trace, 'edits'>): string {
  const name = STAGE_NAMES[s.stage]
  return [
    `${name} is open again because requirements changed after the baseline (${editWords(ids, t)}). Its work on the default branch was done and accepted before the change; only part of it may be stale: ${s.why}${s.why.endsWith('.') ? '' : '.'}`,
    `Read what is on the default branch first and keep what the change does not reach. Redo only what it reaches${s.reach.length ? ` (${s.reach.join(', ')})` : ''}, record the criteria again with your checks, and say in your result what you kept and why.`,
    '',
    request,
  ].join('\n')
}

/**
 * The job's headline for a stage opened again after a change of requirements (its request leads with why it is open
 * again, not with what it does: test-esp32 #196, "Sign-off is open again because … only par" on the gate page and the
 * Overview). `kept`: its work stands and it finishes what is left (finishRequest); else it redoes what the change
 * reaches (scopedRequest). Pure.
 */
export function reopenHeadline(stage: StageId, kept: boolean): string {
  return `${STAGE_NAMES[stage]}: ${kept ? 'finish what is left after the requirement change' : 'redo what the requirement change reaches'}`
}

/** The request for a stage whose work stands but still has criteria to meet (it was in progress when the change came). */
export function finishRequest(request: string, s: StageScope, left: readonly CriterionRow[]): string {
  return [
    `${STAGE_NAMES[s.stage]} is open again after a change of requirements that does not reach its work: ${s.why}`,
    `Its work on the default branch stands; do not redo it. What is still to do: ${left.map((c) => c.text.replace(/\.$/, '').toLowerCase()).join('; ')}. Do only that, and say in your result what you kept.`,
    '',
    request,
  ].join('\n')
}

/** One gate to sign again after a reopen: `agree` (the reopened stage's, the changed requirements agreed first), `kept` (its evidence stands), `redo` (its work is done again), or `signed` (signed again already). */
export interface ResignGate { gate: string; name: string; stage: StageId; state: 'agree' | 'kept' | 'redo' | 'signed'; why: string }
export interface ResignPlan { requirements: string[]; edits: string; gates: ResignGate[] }

/**
 * What the Overview's list is drawn from, without reading the design record (so journey.get reads it only when there
 * is a list to show): the newest reopen for changed requirements and every reopen with it that the stage the project
 * was in is signed again after; their requirements (`ids`) and the first one's time (`at`); the stages from the one
 * reopened (`target`, an order) to the latest the project was in (`top`), and their gates. Null when the newest reopen
 * was for anything else, or every one of those gates is signed again. Pure.
 */
export function resignBasis(r: JourneyRecord): { ids: string[]; at: number; target: number; top: number; gates: JourneyRecord['gates']; live: (gate: string) => boolean } | null {
  const last = [...r.decisions].reverse().find((d) => d.kind === 'stage.reopened' || d.kind === 'revision.started')
  const d = last?.kind === 'stage.reopened' ? asDetail(last.detail) : null
  if (!last || !d) return null
  const reopens = requirementReopens(r, d.from) ?? [{ at: d.at as number, stage: last.stage as StageId, from: d.from, requirements: d.requirements, rewound: d.rewound }]
  const top = Math.max(...reopens.map((x) => ordOf(r, x.from)))
  const target = ordOf(r, last.stage)
  const live = (g: string): boolean => r.signatures.some((s) => s.gate === g && s.supersededAt === null && s.revision === r.journey.revision)
  const gates = r.gates.filter((g) => { const o = ordOf(r, g.stage); return o >= target && o <= top })
  if (!gates.length || gates.every((g) => live(g.id))) return null
  return { ids: [...new Set(reopens.flatMap((x) => x.requirements))], at: Math.min(...reopens.map((x) => x.at)), target, top, gates, live }
}

/** Each stage's scope after the reopened one (`target`, an order) up to `top`, in order (stageScope). Pure. */
export function scopesTo(r: Pick<JourneyRecord, 'stages'>, target: number, top: number, ids: readonly string[], t: Trace): StageScope[] {
  const scopes: StageScope[] = []
  for (const s of r.stages.filter((x) => x.ord > target && x.ord <= top)) scopes.push(stageScope(s.id, ids, t, scopes))
  return scopes
}

/**
 * The gates to sign again after the newest reopen for changed requirements, from the stage it reopened to the stage
 * the project was in, each with whether its evidence stands (stageScope). Null when the newest reopen was for
 * anything else, or every one of those gates is signed again. Pure: `trace` reads the record for the requirements.
 */
export function resignPlan(r: JourneyRecord, trace: (ids: string[], at: number) => Trace | null): ResignPlan | null {
  const b = resignBasis(r)
  if (!b) return null
  const t = trace(b.ids, b.at)
  if (!t) return null
  const { ids, gates, live } = b
  const scopes = scopesTo(r, b.target, b.top, ids, t)
  return {
    requirements: ids, edits: editWords(ids, t),
    gates: gates.map((g) => {
      const sc = scopes.find((x) => x.stage === g.stage)
      const state: ResignGate['state'] = live(g.id) ? 'signed' : !sc ? 'agree' : sc.kept ? 'kept' : 'redo'
      const why = !sc ? `Agree ${and(ids)} again in Requirements review, then sign it.`
        : sc.kept ? `${sc.why} Sign it again; nothing is redone.` : `Done again: ${sc.why}.`
      return { gate: g.id, name: g.name, stage: g.stage, state, why }
    }),
  }
}

/** The stage a gate's signature opens again after a reopen for changed requirements, and what the change reaches in it. */
export interface ReopenedWork { stage: StageId; scope: StageScope; reopens: Reopen[]; ids: string[]; trace: Trace }

/**
 * The stage signing `gate` opens (the stage after it with a gate, as core advance passes Release), when that stage is
 * opened again after reopens for changed requirements, with what the change reaches in it (stageScope, from the
 * default branch's record). Null when the signature closes no stage or opens none of those, or the record cannot be
 * read: the stage's work then starts in full, as before.
 */
export async function reopenedWork(ctx: Context, repo: string, r: JourneyRecord, gate: string): Promise<ReopenedWork | null> {
  const g = r.gates.find((x) => x.id === gate)
  const live = (id: string): boolean => r.signatures.some((s) => s.gate === id && s.supersededAt === null && s.revision === r.journey.revision)
  if (!g || r.gates.some((x) => x.stage === g.stage && x.id !== gate && !live(x.id))) return null
  const next = r.stages.filter((s) => s.ord > ordOf(r, g.stage) && r.gates.some((x) => x.stage === s.id)).sort((a, b) => a.ord - b.ord)[0]
  const reopens = next ? requirementReopens(r, next.id) : null
  if (!next || !reopens) return null
  const ids = [...new Set(reopens.flatMap((x) => x.requirements))]
  const at = Math.min(...reopens.map((x) => x.at))
  const trace = await withRecordDb(ctx, repo, (db) => readTrace(db, ids, at)).catch(() => null)
  if (!trace) return null
  const scope = scopesTo(r, Math.min(...reopens.map((x) => ordOf(r, x.stage))), next.ord, ids, trace).at(-1)
  return scope && scope.stage === next.id ? { stage: next.id, scope, reopens, ids, trace } : null
}

/** The evidence a stage keeps: what its reopens took back (newest first; core carryStage keeps its own gates'). */
export const keptOf = (reopens: readonly Reopen[]): { id: string; evidence: Evidence[] }[] => reopens.flatMap((x) => x.rewound)
