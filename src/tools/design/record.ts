/**
 * The design record as people see it: the agents' proposals (src/tools/design/db.ts, in the repository) with people's
 * decisions (src/tools/design/decisions.ts, in the journey record) laid over them, and the checks the guided skills'
 * quality bars and the screens read from it. Pure functions over rows, tested on their own.
 *
 *   intentView        each live statement with its state: accepted (a person accepted these words), edited (a
 *                     person's own words), proposed (an agent's, not yet decided), rejected; and the flags the Intent
 *                     builder shows: needs a number, vague word, conflict, not testable
 *   linksView         each requirement's derived_from links to live statements
 *   architectureView  the options with their blocks, connections, trace's scores and recommendation; the criteria
 *                     (fixed by a person, or trace's proposal); the chosen option (a person's decision) and why
 *   pinCheck          the pin plan against the schematic's netlist (kicad-cli's, as kicad.netlist or design.pins
 *                     check stored it: nets.tsv, "<net>\t<ref>.<pin> …"): each planned pin on the net it names, no
 *                     planned net missing, no peripheral instance claimed by two uses, reserved pins kept
 *
 * "The firmware pin configuration matches the schematic" is checked as: the pin plan (which the firmware track agrees
 * and which is the firmware's configuration) against the schematic's netlist. The firmware source itself (a CubeMX
 * .ioc, a Rust HAL setup) is not read.
 */
import { limitsOf } from '../verify/extract.js'
import { type DesignDecision, fingerprint, standing } from './decisions.js'
import { type ArchBlockRow, type DesignRows, type IntentStatementRow, INTENT_TOPICS, type PinRow, TOPIC_NAMES } from './db.js'

// ------------------------------------------------------------------ intent

export type IntentState = 'accepted' | 'edited' | 'proposed' | 'rejected'
export type IntentFlag = 'needs_number' | 'vague' | 'conflict' | 'not_testable' | 'interface_incomplete' | 'no_owner'

export interface IntentView extends IntentStatementRow {
  /** the words that stand: the person's when edited */
  words: string
  state: IntentState
  /** who decided and when (ISO), when a person did */
  decided: { by: string; at: string; reason?: string | undefined } | null
  /** a person accepted it, then an agent changed the words: it needs deciding again */
  changed_since: boolean
  flags: IntentFlag[]
  /** the person left it uncovered by any requirement, with this reason */
  uncovered: string | null
}

/** The topics where a statement is about a quantity, so it needs a number with its unit. */
const QUANTITY_TOPICS = new Set(['environment', 'power', 'performance', 'physical', 'build'])
/** Words that say nothing measurable on their own (docs/user-journey.md Intent builder). */
export const VAGUE_WORDS = /\b(fast|faster|quick(ly)?|small|smaller|tiny|compact|low[- ]power|low[- ]cost|cheap|robust|reliable|rugged|lightweight|high[- ]performance|long[- ]lasting|long battery life|efficient|accurate|precise|responsive|easy|simple|good|best|large|big|soon|minimal|sufficient|adequate)\b/i

const iso = (t: number): string => new Date(t * 1000).toISOString()
/** A number with its unit: the extractor's limits (3.3 V, ±2 %), or any number followed by a unit word (2 km, 2 years,
 * 2,000 mAh, 15 minutes, IP67 is not one). */
const NUMBER_UNIT = /(^|[^\w.])[-+±]?\d[\d,]*(\.\d+)?\s?(%|°\s?[CF]|[A-Za-zµΩ]{1,12})\b/
const quantity = (s: { words: string; limits: readonly unknown[] }): boolean => s.limits.length > 0 || limitsOf(s.words).length > 0 || NUMBER_UNIT.test(s.words)
const FIVE = ['type', 'connector', 'protocol', 'rate', 'direction'] as const

/** Live statements (not withdrawn by their agent), with people's decisions over them. Rejected ones are kept, marked. */
export function intentView(rows: DesignRows, decisions: readonly DesignDecision[]): IntentView[] {
  const dec = standing(decisions, 'intent')
  const unc = standing(decisions, 'intent.uncovered')
  const live = rows.intent.filter((s) => s.status !== 'withdrawn')
  const base = live.map((s) => {
    const d = dec.get(s.id)
    const seen = typeof d?.detail.text === 'string' ? d.detail.text : null
    const edited = d?.choice === 'edited' && typeof d.detail.edited === 'string' ? d.detail.edited : null
    // an accepted statement whose words an agent changed afterwards is proposed again
    const changed = d?.choice === 'accepted' && seen !== null && seen !== s.text
    const state: IntentState = d?.choice === 'rejected' ? 'rejected' : edited !== null ? 'edited' : d?.choice === 'accepted' && !changed ? 'accepted' : 'proposed'
    const u = unc.get(s.id)
    return {
      ...s, words: edited ?? s.text, state, changed_since: changed,
      decided: d ? { by: d.by, at: iso(d.at), ...(typeof d.detail.reason === 'string' ? { reason: d.detail.reason } : {}) } : null,
      uncovered: u && u.choice === 'left_out' ? String(u.detail.reason ?? '') : null, flags: [] as IntentFlag[],
    }
  })
  const alive = new Map(base.filter((s) => s.state !== 'rejected').map((s) => [s.id, s]))
  for (const s of base) {
    if (s.state === 'rejected') continue
    if (s.kind === 'statement') {
      if (QUANTITY_TOPICS.has(s.topic) && !quantity(s)) s.flags.push('needs_number')
      if (VAGUE_WORDS.test(s.words) && !quantity(s)) s.flags.push('vague')
      if (s.testable === false) s.flags.push('not_testable')
      if (s.topic === 'interfaces' && FIVE.some((k) => !s.interface?.[k]?.trim())) s.flags.push('interface_incomplete')
    }
    if (s.kind === 'question' && !s.owner?.trim()) s.flags.push('no_owner')
    if (openConflicts(s, alive).length) s.flags.push('conflict')
  }
  return base
}

/**
 * The statements `s` conflicts with that still stand against it. A conflict is resolved when a person gives way on
 * one side: rejects it, rewords it, or accepts it with a reason saying why both hold. Accepting both as worded does
 * not resolve it (Submit intent accepts every statement left undecided, which must not clear a conflict).
 */
function openConflicts(s: IntentView, alive: ReadonlyMap<string, IntentView>): string[] {
  const gave = (x: IntentView): boolean => x.state === 'edited' || (x.state === 'accepted' && Boolean(x.decided?.reason))
  const others = new Set([...s.conflicts, ...[...alive.values()].filter((o) => o.conflicts.includes(s.id)).map((o) => o.id)])
  return [...others].filter((id) => { const o = alive.get(id); return o && o.id !== s.id && !gave(s) && !gave(o) })
}

/** The Intent builder's shape: the topic reached, the topics answered, the statements and the open questions. */
export function intentDraft(view: readonly IntentView[]) {
  const live = view.filter((s) => s.state !== 'rejected')
  const answered = INTENT_TOPICS.filter((t) => live.some((s) => s.topic === t && s.kind !== 'question'))
  const next = INTENT_TOPICS.findIndex((t) => !answered.includes(t))
  const FLAG: Partial<Record<IntentFlag, { state: 'needs_number' | 'vague' | 'conflict'; flag: string }>> = {
    conflict: { state: 'conflict', flag: 'Conflict' }, needs_number: { state: 'needs_number', flag: 'Needs a number' }, vague: { state: 'vague', flag: 'Vague word' },
    interface_incomplete: { state: 'needs_number', flag: 'Interface not fully given' }, not_testable: { state: 'vague', flag: 'Cannot be tested as worded' },
  }
  return {
    topic: next === -1 ? INTENT_TOPICS.length - 1 : next,
    answered: answered.map((t) => t),
    statements: live.filter((s) => s.kind !== 'question').map((s) => {
      const f = s.flags.map((x) => FLAG[x]).find(Boolean)
      const state = f ? f.state : s.state === 'accepted' || s.state === 'edited' ? 'accepted' as const : 'draft' as const
      const words = s.kind === 'dont_care' ? `Don't care: ${s.words}` : s.kind === 'unknown' ? `Unknown, decide by ${s.decide_by ?? '?'}: ${s.words}` : s.words
      return { id: s.id, topic: TOPIC_NAMES[s.topic], text: words, state, ...(f ? { flag: f.flag } : {}) }
    }),
    questions: live.filter((s) => s.kind === 'question').map((s) => ({ id: s.id, text: s.words, owner: s.owner ?? 'no owner yet' })),
  }
}

/** Each requirement's links to statements that are not withdrawn (rejected ones still show where a requirement came from). */
export function linksView(rows: DesignRows): { requirement: string; intent: string }[] {
  const ids = new Set(rows.intent.filter((s) => s.status !== 'withdrawn').map((s) => s.id))
  return rows.links.filter((l) => !l.removed && ids.has(l.intent)).map((l) => ({ requirement: l.requirement, intent: l.intent }))
}

// ------------------------------------------------------------------ requirements: people's decisions over the table

/** What a decision on a requirement is made on: its words and its acceptance criterion. */
export interface RequirementWords { text: string; acceptance: string | null }
/** A requirement row as far as its decision needs it: its words, acceptance, status and when an agent last changed it. */
export interface RequirementNow extends RequirementWords { status: string; updated: number | null }

/**
 * Whether a person's decision on a requirement still stands on the row as it is now. A decision keeps the words and
 * acceptance it was made on (detail.text, detail.acceptance), and an agent's later change of either reopens it, the
 * way intent decisions do (a decision kept with words only is checked on its words). A decision
 * recorded before the words were kept stands until an agent proposes the requirement again after it (status
 * proposed, changed after the decision).
 */
export function decisionStands(d: DesignDecision, now: RequirementNow | undefined): boolean {
  if (!now) return true
  if (typeof d.detail.text === 'string') return d.detail.text === now.text && (!('acceptance' in d.detail) || d.detail.acceptance === now.acceptance)
  return !(now.status === 'proposed' && now.updated !== null && now.updated > d.at)
}

/**
 * A requirement's standing decision: accepted, or struck with the reason. Given the rows as they are now, a decision
 * an agent's change has reopened is left out, so the requirement is the person's to decide again.
 */
export function requirementDecisions(decisions: readonly DesignDecision[], rows?: ReadonlyMap<string, RequirementNow>): Map<string, { choice: 'accepted' | 'struck'; reason: string | null; by: string; at: string }> {
  const m = new Map<string, { choice: 'accepted' | 'struck'; reason: string | null; by: string; at: string }>()
  for (const [id, d] of standing(decisions, 'requirement')) {
    if (rows && !decisionStands(d, rows.get(id))) continue
    m.set(id, { choice: d.choice === 'struck' ? 'struck' : 'accepted', reason: typeof d.detail.reason === 'string' ? d.detail.reason : null, by: d.by, at: iso(d.at) })
  }
  return m
}

// ------------------------------------------------------------------ architecture

export interface CriterionView { id: string; name: string; weight: number; description: string | null }
export interface ScoreView { option: string; criterion: string; score: number; reason: string; by: 'trace' | 'person' }
export interface OptionView {
  id: string; name: string; summary: string; recommended: boolean; why: string | null; gives_up: string | null; risks: string[]
  blocks: { id: string; name: string; role: string | null; parts: { mpn: string; role?: string | undefined; key?: boolean | undefined }[]; serves: string[]; x: number; y: number }[]
  connections: { id: string; from: string; to: string; kind: string; label: string }[]
  /** weighted total of its scores on the criteria (the person's where given, else trace's), 0 when unscored */
  total: number
}
export interface ArchitectureView {
  options: OptionView[]
  criteria: CriterionView[]
  /** the criteria a person fixed before scoring (with when), or null: trace's proposed criteria are shown */
  fixed: { by: string; at: string } | null
  scores: ScoreView[]
  recommended: string | null
  chosen: { option: string; reason: string; deciding: string[]; by: string; at: string; against: boolean } | null
  /** the option the block diagram draws: chosen, else recommended, else the first */
  current: string | null
}

/** Lay out blocks that have no position: in rows of three, in the order given. */
function placed(blocks: readonly ArchBlockRow[]): OptionView['blocks'] {
  const rows = Math.ceil(blocks.length / 3)
  return blocks.map((b, i) => {
    const row = Math.floor(i / 3)
    const inRow = Math.min(3, blocks.length - row * 3)
    return {
      id: b.id, name: b.name, role: b.role, parts: b.parts, serves: b.requirements,
      x: b.x ?? (inRow === 1 ? 0.5 : (i % 3) / (inRow - 1)), y: b.y ?? (rows === 1 ? 0.5 : row / (rows - 1)),
    }
  })
}

export function architectureView(rows: DesignRows, decisions: readonly DesignDecision[]): ArchitectureView {
  const fixedDec = standing(decisions, 'architecture.criteria').get('architecture') ?? null
  const choiceDec = standing(decisions, 'architecture.choice').get('architecture') ?? null
  const fixedList = Array.isArray(fixedDec?.detail.criteria) ? (fixedDec.detail.criteria as unknown[]).flatMap((c) => {
    const x = c as { id?: unknown; name?: unknown; weight?: unknown; description?: unknown }
    return typeof x.id === 'string' ? [{ id: x.id, name: typeof x.name === 'string' ? x.name : x.id, weight: typeof x.weight === 'number' ? x.weight : 1, description: typeof x.description === 'string' ? x.description : null }] : []
  }) : null
  const criteria: CriterionView[] = fixedList ?? rows.criteria.filter((c) => c.status !== 'withdrawn').map((c) => ({ id: c.id, name: c.name, weight: c.weight, description: c.description }))
  const personScores: ScoreView[] = Array.isArray(choiceDec?.detail.scores) ? (choiceDec.detail.scores as unknown[]).flatMap((x) => {
    const s = x as { option?: unknown; criterion?: unknown; score?: unknown; reason?: unknown }
    return typeof s.option === 'string' && typeof s.criterion === 'string' && typeof s.score === 'number' ? [{ option: s.option, criterion: s.criterion, score: s.score, reason: typeof s.reason === 'string' ? s.reason : '', by: 'person' as const }] : []
  }) : []
  const scores: ScoreView[] = [...personScores, ...rows.scores.filter((s) => !personScores.some((p) => p.option === s.option && p.criterion === s.criterion)).map((s) => ({ option: s.option, criterion: s.criterion, score: s.score, reason: s.reason, by: 'trace' as const }))]
  const live = rows.options.filter((o) => o.status !== 'withdrawn')
  const options: OptionView[] = live.map((o) => {
    const mine = scores.filter((s) => s.option === o.id)
    const total = criteria.reduce((n, c) => n + (mine.find((s) => s.criterion === c.id)?.score ?? 0) * c.weight, 0)
    return {
      id: o.id, name: o.name, summary: o.summary, recommended: o.recommended, why: o.why, gives_up: o.gives_up, risks: o.risks,
      blocks: placed(rows.blocks.filter((b) => b.option === o.id && b.status !== 'withdrawn')),
      connections: rows.connections.filter((c) => c.option === o.id && c.status !== 'withdrawn').map((c) => ({ id: c.id, from: c.from, to: c.to, kind: c.kind, label: c.label })),
      total: Math.round(total * 100) / 100,
    }
  })
  const recommended = options.find((o) => o.recommended)?.id ?? null
  const chosenId = typeof choiceDec?.detail.option === 'string' ? choiceDec.detail.option : null
  const chosen = choiceDec && chosenId ? {
    option: chosenId, reason: String(choiceDec.detail.reason ?? ''), deciding: Array.isArray(choiceDec.detail.deciding) ? (choiceDec.detail.deciding as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    by: choiceDec.by, at: iso(choiceDec.at), against: recommended !== null && chosenId !== recommended,
  } : null
  return {
    options, criteria, fixed: fixedDec ? { by: fixedDec.by, at: iso(fixedDec.at) } : null, scores, recommended, chosen,
    current: chosen && options.some((o) => o.id === chosen.option) ? chosen.option : recommended ?? options[0]?.id ?? null,
  }
}

// ------------------------------------------------------------------ the pin plan against the schematic

/** nets.tsv (kicad.netlist's artifact) read back: net → its pins as "<ref>.<pin>". */
export function parseNets(tsv: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const line of tsv.split('\n')) {
    const [net, nodes] = line.split('\t')
    if (net) m.set(net, (nodes ?? '').split(' ').filter(Boolean))
  }
  return m
}

export interface PinFinding {
  id: string
  /** pin: <part>.<pin>, or peripheral:<instance>, or net:<name> */
  target: string
  kind: 'no_net' | 'no_function' | 'unsupported' | 'unknown_alternates' | 'claimed_twice' | 'function_twice' | 'reserved' | 'mismatch' | 'not_on_schematic' | 'missing_pin'
  severity: 'blocks' | 'fix'
  text: string
}

const bare = (net: string): string => net.replace(/^.*\//, '')
const sameNet = (a: string, b: string): boolean => a === b || bare(a) === bare(b)
const USED = (p: PinRow): boolean => p.status !== 'withdrawn' && p.kind !== 'spare' && p.kind !== 'nc'

/**
 * Check the pin plan on its own (and against the netlist when given): every finding with what to do about it, in
 * plain words. `nets` absent: the schematic part of the check (mismatch, not_on_schematic) is not done.
 */
export function pinCheck(pins: readonly PinRow[], nets?: ReadonlyMap<string, readonly string[]> | null): PinFinding[] {
  const out: PinFinding[] = []
  const live = pins.filter((p) => p.status !== 'withdrawn')
  const at = (p: PinRow): string => `${p.part} pin ${p.pin}${p.name ? ` (${p.name})` : ''}`
  for (const p of live.filter(USED)) {
    const id = `pin:${p.part}.${p.pin}`
    if (!p.net?.trim()) out.push({ id: `${id}:no_net`, target: id, kind: 'no_net', severity: 'blocks', text: `${at(p)} is used but names no net.` })
    if (p.kind === 'signal' || p.kind === 'analog' || p.kind === 'clock') {
      if (!p.function?.trim()) out.push({ id: `${id}:no_function`, target: id, kind: 'no_function', severity: 'blocks', text: `${at(p)} is used but has no function for the firmware.` })
      else if (!p.alternates.length) out.push({ id: `${id}:unknown_alternates`, target: id, kind: 'unknown_alternates', severity: 'fix', text: `${at(p)}: the functions the part allows on this pin are not recorded, so ${p.function} cannot be checked against its datasheet.` })
      else if (!p.alternates.some((a) => a.toLowerCase() === p.function?.toLowerCase())) out.push({ id: `${id}:unsupported`, target: id, kind: 'unsupported', severity: 'blocks', text: `${at(p)} cannot carry ${p.function}: the part allows ${p.alternates.join(', ')} there.` })
    }
    if (p.reserved && p.kind !== p.reserved) out.push({ id: `${id}:reserved`, target: id, kind: 'reserved', severity: 'blocks', text: `${at(p)} is the part's ${p.reserved} pin but is planned as ${p.function ?? p.kind}: keep its role or waive the change.` })
  }
  // one peripheral instance, one use; one function, one pin
  const uses = new Map<string, Set<string>>()
  const fns = new Map<string, PinRow[]>()
  for (const p of live.filter(USED)) {
    if (p.peripheral) { const k = `${p.part}:${p.peripheral}`; uses.set(k, new Set([...(uses.get(k) ?? []), (p.use ?? '').trim().toLowerCase() || '(no use given)'])) }
    if (p.function && !/^gpio/i.test(p.function) && p.kind !== 'power') { const k = `${p.part}:${p.function.toUpperCase()}`; fns.set(k, [...(fns.get(k) ?? []), p]) }
  }
  for (const [k, set] of uses) {
    const [part, inst] = k.split(':') as [string, string]
    if (set.size > 1) out.push({ id: `peripheral:${k}:claimed_twice`, target: `peripheral:${part}.${inst}`, kind: 'claimed_twice', severity: 'blocks', text: `${part}'s ${inst} is claimed by ${set.size} uses: ${[...set].join(', ')}.` })
  }
  for (const [k, list] of fns) {
    if (list.length > 1) out.push({ id: `function:${k}:twice`, target: `peripheral:${k.replace(':', '.')}`, kind: 'function_twice', severity: 'blocks', text: `${list[0]?.function} is planned on ${list.length} pins of ${list[0]?.part}: ${list.map((p) => p.pin).join(', ')}.` })
  }
  if (nets) {
    const onPin = new Map<string, string>()
    for (const [net, nodes] of nets) for (const n of nodes) onPin.set(n, net)
    const parts = new Set(live.map((p) => p.part))
    for (const p of live) {
      const id = `pin:${p.part}.${p.pin}`
      const actual = onPin.get(`${p.part}.${p.pin}`)
      if (USED(p) && p.net?.trim()) {
        if (actual === undefined) out.push({ id: `${id}:not_on_schematic`, target: id, kind: 'not_on_schematic', severity: 'blocks', text: `${at(p)} should be on ${p.net}, but the schematic connects nothing to it.` })
        else if (!sameNet(actual, p.net)) out.push({ id: `${id}:mismatch`, target: id, kind: 'mismatch', severity: 'blocks', text: `${at(p)} should be on ${p.net}; the schematic has it on ${actual}.` })
      } else if (!USED(p) && actual !== undefined && !/^(unconnected-|Net-\()/i.test(bare(actual))) {
        out.push({ id: `${id}:mismatch`, target: id, kind: 'mismatch', severity: 'fix', text: `${at(p)} is planned as ${p.kind}, but the schematic puts it on ${actual}.` })
      }
    }
    // pins the schematic connects on a planned part that the plan does not name
    for (const [node, net] of onPin) {
      const [part, pin] = [node.slice(0, node.lastIndexOf('.')), node.slice(node.lastIndexOf('.') + 1)]
      if (!parts.has(part) || live.some((p) => p.part === part && p.pin === pin) || /^(unconnected-|Net-\()/i.test(bare(net))) continue
      out.push({ id: `pin:${part}.${pin}:missing_pin`, target: `pin:${part}.${pin}`, kind: 'missing_pin', severity: 'fix', text: `${part} pin ${pin} is on ${net} in the schematic but is not in the pin plan.` })
    }
  }
  return out
}

/** What one part's pin plan agreement binds to: its live rows, so a later change shows the agreement is stale. */
export function pinPlanPrint(pins: readonly PinRow[], part: string): string {
  return fingerprint(pins.filter((p) => p.part === part && p.status !== 'withdrawn').map((p) => [p.pin, p.function, p.peripheral, p.use, p.net, p.kind, p.reserved]))
}
