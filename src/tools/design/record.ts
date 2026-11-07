/**
 * The design record as people see it: the agents' proposals (src/tools/design/db.ts, in the repository) with people's
 * decisions (src/tools/design/decisions.ts, in the journey record) laid over them, and the checks the guided skills'
 * quality bars and the screens read from it. Pure functions over rows, tested on their own.
 *
 *   intentView        each live statement with its state: accepted (a person accepted these words, or signed a gate
 *                     after an agent last wrote them, or stated them), edited (a person's own words), proposed (an
 *                     agent's, not yet decided), rejected; and the flags the Intent builder shows: needs a number, vague
 *                     word, conflict, not testable
 *   statedRows        the statements a person stated themselves (the Intent builder's chat notes them in the person's
 *                     draft; Submit intent records them): kept in their decisions, read as rows beside the agents'
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
import { type ArchBlockRow, type BlockPart, type DesignRows, type IntentInterface, type IntentStatementRow, INTENT_KINDS, INTENT_TOPICS, type IntentTopic, type PinRow, STAGES, TOPIC_NAMES } from './db.js'

// ------------------------------------------------------------------ intent

export type IntentState = 'accepted' | 'edited' | 'proposed' | 'rejected'
export type IntentFlag = 'needs_number' | 'vague' | 'conflict' | 'not_testable' | 'interface_incomplete' | 'no_owner'

export interface IntentView extends IntentStatementRow {
  /** the words that stand: the person's when edited */
  words: string
  state: IntentState
  /** who decided and when (ISO), when a person did; `gate`: by signing that gate over these words */
  decided: { by: string; at: string; reason?: string | undefined; gate?: string | undefined } | null
  /** a person accepted it, then an agent changed the words: it needs deciding again */
  changed_since: boolean
  flags: IntentFlag[]
  /** the person left it uncovered by any requirement, with this reason */
  uncovered: string | null
  /**
   * what a person stated themselves, so a drafter does not take it as inferred: who; whether the words that stand are
   * theirs (they stated or reworded them); the interface fields they gave (set in an edit, or read from their words).
   * null when every word and field is an agent's.
   */
  person: { by: string; words: boolean; fields: InterfaceField[] } | null
}

/** The topics where a statement that states a quantity needs a number with its unit. */
const QUANTITY_TOPICS = new Set(['environment', 'power', 'performance', 'physical', 'build'])
/** Words that say nothing measurable on their own (docs/user-journey.md Intent builder). */
export const VAGUE_WORDS = /\b(fast|faster|quick(ly)?|small|smaller|tiny|compact|low[- ]power|low[- ]cost|cheap|robust|reliable|rugged|lightweight|high[- ]performance|long[- ]lasting|long battery life|efficient|accurate|precise|responsive|easy|simple|good|best|large|big|soon|minimal|sufficient|adequate)\b/i

const iso = (t: number): string => new Date(t * 1000).toISOString()
/** A number with its unit: the extractor's limits (3.3 V, ±2 %), or any number followed by a unit word (2 km, 2 years,
 * 2,000 mAh, 15 minutes, IP67 is not one). */
const NUMBER_UNIT = /(^|[^\w.])[-+±]?\d[\d,]*(\.\d+)?(\s|-)?(%|°\s?[CF]|(?!(?:and|or|of|to|the|a|an|in|on|at|for|with|from|by|per|than|is|are|if|when)\b)[A-Za-zµΩ]{1,12})\b/
/** A number written as a word, with a unit after it (two years, ten minutes). */
const WORD_NUMBER_UNIT = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred|thousand)[\s-](?!(?:and|or|of|to|the|a|an|in|on|at|for|with|from|by|than|is|are)\b)[a-z]{2,12}\b/i
const quantity = (s: { words: string; limits: readonly unknown[] }): boolean => s.limits.length > 0 || limitsOf(s.words).length > 0 || NUMBER_UNIT.test(s.words) || WORD_NUMBER_UNIT.test(s.words)
/** A number on its own, not part of a name like ESP32 or IP67. */
const BARE_NUMBER = /(^|[^\w.])[-+±]?\d[\d,]*(\.\d+)?(?![\w.]*\d)/
/** A range with one end: "between 10 and" with no number after. */
const ONE_ENDED = /\bbetween\s+[-+±]?\d[\d,.]*\s*\S*\s+and\b(?!\s+[-+±]?\d)/i
/** A measurable property named without its value (docs/user-journey.md: every quantity has a number and a unit). */
const PROPERTY = /\b(battery life|run ?time|lifetime|operating temperature|temperature range|ambient temperature|storage temperature|humidity|(low|high|max(imum)?|min(imum)?|peak|idle|sleep|standby|quiescent) current|current (draw|consumption)|power (draw|consumption|budget)|voltage|board size|enclosure size|size|dimensions|thickness|weight|mass|latency|response time|accuracy|precision|range|update rate|refresh rate|sample rate|sampling rate|data rate|throughput|bandwidth|battery capacity)\b/i
/** A statement that states a quantity without its number or unit: a bare number, a range with one end, or a measurable
 * property or a vague size word with no number. A statement that is not about a quantity (24-hour format, the time
 * shown as HH:MM, one USB-C cable) is not flagged. */
const needsNumber = (s: { words: string; limits: readonly unknown[] }): boolean => {
  if (ONE_ENDED.test(s.words)) return true
  if (quantity(s)) return false
  return BARE_NUMBER.test(s.words) || PROPERTY.test(s.words) || VAGUE_WORDS.test(s.words)
}
/** The five fields of an interface statement, in the order the person reads them. */
export const INTERFACE_FIELDS = ['type', 'connector', 'protocol', 'rate', 'direction'] as const
export type InterfaceField = (typeof INTERFACE_FIELDS)[number]

/** The fields of an interface left empty, in order. */
export const missingFields = (i: IntentInterface | null | undefined): InterfaceField[] => INTERFACE_FIELDS.filter((k) => !i?.[k]?.trim())

/** The fields given, trimmed, without the empty ones (so laying one set over another never blanks a field). */
export function givenFields(x: unknown): IntentInterface {
  const out: IntentInterface = {}
  if (!x || typeof x !== 'object') return out
  for (const k of INTERFACE_FIELDS) { const v = (x as Record<string, unknown>)[k]; if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, k === 'direction' ? 40 : 120) }
  return out
}

// what an interface statement's words say of its five fields. The agent fills the fields as it drafts a statement; a
// person who rewords it fills them from their words here, so the check reads the statement as it now stands (test-esp32
// #20). Only what the words plainly say is taken: a field the words leave out stays as it was
const TYPES: [RegExp, string][] = [
  [/\bUSB\b[^,;]{0,30}?\b(device|host)\b/i, 'USB $1'], [/\bI\s?[2²]\s?C\b/i, 'I2C'], [/\bSPI\b/, 'SPI'], [/\bQSPI\b/, 'QSPI'],
  [/\bI2S\b/i, 'I2S'], [/\bUART\b/i, 'UART'], [/\bRS[- ]?485\b/i, 'RS-485'], [/\bRS[- ]?232\b/i, 'RS-232'], [/\bCAN(?:[- ]?FD)?\b/, 'CAN'],
  [/\bLoRa(?:WAN)?\b/i, 'LoRa radio'], [/\bWi-?Fi\b/i, 'Wi-Fi'], [/\b(Bluetooth|BLE)\b/i, 'Bluetooth'], [/\bEthernet\b/i, 'Ethernet'],
  [/\b(JTAG|SWD)\b/, '$1'], [/\bGPIO\b/i, 'GPIO'], [/\bPWM\b/, 'PWM'], [/\banalog(?:ue)? (input|output)\b/i, 'analog $1'], [/\bUSB\b/, 'USB'],
  [/\bantenna\b/i, 'antenna'], [/\bpower (input|output)\b/i, 'power $1'], [/\bbutton\b/i, 'button'], [/\bdisplay\b/i, 'display'],
]
const CONNECTORS: RegExp[] = [
  /\b(?:USB[- ]?C|type[- ]C)(?: (?:receptacle|socket|plug|connector))?/i, /\bmicro[- ]?USB(?: (?:receptacle|socket|connector))?/i,
  /\b[uU]\.FL\b(?: (?:connector|socket))?/, /\bIPEX\b(?: (?:connector|socket))?/i, /\bR?P?-?SMA\b(?: (?:connector|jack|socket))?/, /\bRJ-?45\b(?: (?:jack|socket|connector))?/i,
  /\bM(?:8|12)\b(?: \d+-pin)?(?: connector)?/, /\b(?:Qwiic|STEMMA QT)\b(?: connector)?/i, /\bJST[- ][A-Z]{1,4}\b(?: \d+-pin)?(?: connector)?/,
  /\b\d+[- ]pin (?:\d+(?:\.\d+)? ?mm )?(?:pin )?(?:header|socket|connector|terminal block)/i, /\b(?:pin header|terminal block|screw terminals?|edge connector|pogo pads?|test pads?|PCB antenna|chip antenna|on-board antenna|trace antenna|ribbon cable|FPC connector|FFC connector)\b/i,
  /\b(?:soldered|no connector|on[- ]board|wired direct(?:ly)?)\b/i,
]
const PROTOCOLS: RegExp[] = [
  /\bUSB ?[123]\.\d(?: (?:full|high|low|super)[- ]speed)?/i, /\b(?:full|high|low)[- ]speed USB\b/i, /\bUSB (?:CDC|HID|MSC|PD|power delivery)\b/i,
  /\bLoRaWAN(?: ?\d(?:\.\d)+)?(?: [A-Z]{2}\d{3})?/i, /\b(?:802\.11 ?[a-z/]+|Wi-?Fi ?[4-7])\b/i, /\b(?:Bluetooth (?:LE|Low Energy|Classic)(?: ?\d(?:\.\d)?)?|BLE ?\d(?:\.\d)?)\b/i,
  /\bI\s?[2²]\s?C (?:standard|fast|fast[- ]plus|high[- ]speed)(?: mode)?/i, /\bSPI mode \d\b/i, /\b(?:CAN ?2\.0[AB]?|CAN[- ]FD|CANopen|J1939)\b/i,
  /\b(?:Modbus(?: RTU| TCP)?|DMX512|MQTT|HTTPS?|TCP\/IP|NMEA ?0183|SBUS|DShot\d*)\b/i, /\b[5-9][NEO][12]\b/, /\b(?:10|100|1000)BASE-T\w*\b/i,
]
const BUS_PROTOCOL = new Set(['I2C', 'SPI', 'QSPI', 'I2S', 'UART', 'RS-485', 'RS-232', 'CAN', 'Ethernet', 'Wi-Fi', 'Bluetooth', 'JTAG', 'SWD'])
const RATE = /(?:^|[^\w.])(?:up to |at )?(\d[\d,]*(?:\.\d+)?)\s?((?:[kKMG]i?)?(?:bit\/s|bits?\/s|bps|b\/s|baud|Bd|Hz|B\/s|bytes?\/s|sps|samples\/s))(?![\w/])/
const DIRECTION: [RegExp, string][] = [
  [/\b(both directions|bidirectional|bi-directional|two[- ]way|in and out|input and output|half[- ]duplex|full[- ]duplex)\b/i, 'both'],
  [/\b(input only|inputs?|inbound|receive only|in only|into the board)\b/i, 'in'],
  [/\b(output only|outputs?|outbound|transmit only|out only|out of the board)\b/i, 'out'],
]
/** A labelled field in the words ("rate: 400 kHz", "Direction = in"), up to the next comma, semicolon or full stop. */
const labelled = (words: string, k: InterfaceField): string | undefined => new RegExp(`\\b${k}\\s*[:=]\\s*([^,;\\n]+?)(?=[,;\\n]|\\.(?:\\s|$)|$)`, 'i').exec(words)?.[1]?.trim() || undefined

/**
 * The fields an interface statement's words give: a field labelled in the words ("rate: 400 kHz") first, else what
 * the words plainly name (an I2C bus, a USB-C receptacle, USB 2.0 full speed, 12 Mbit/s, both directions). Pure; a
 * field the words do not give is left out.
 */
export function interfaceFromWords(words: string): IntentInterface {
  const out: IntentInterface = {}
  const type = labelled(words, 'type') ?? TYPES.map(([re, name]) => { const m = re.exec(words); return m ? name.replace('$1', m[1] ?? '') : null }).find((x) => x !== null) ?? undefined
  if (type) out.type = type
  const connector = labelled(words, 'connector') ?? CONNECTORS.map((re) => re.exec(words)?.[0]?.trim()).find(Boolean)
  if (connector) out.connector = connector
  const protocol = labelled(words, 'protocol') ?? PROTOCOLS.map((re) => re.exec(words)?.[0]?.trim()).find(Boolean) ?? (type && BUS_PROTOCOL.has(type) ? type : undefined)
  if (protocol) out.protocol = protocol
  const rateLabel = labelled(words, 'rate')
  const r = RATE.exec(words)
  const rate = rateLabel ?? (r ? `${r[1]} ${r[2]}` : /\b(not applicable|no data|n\/a)\b/i.exec(words)?.[0])
  if (rate) out.rate = rate
  const direction = labelled(words, 'direction') ?? DIRECTION.map(([re, d]) => (re.test(words) ? d : null)).find((x) => x !== null) ?? undefined
  if (direction) out.direction = direction
  return givenFields(out)
}

/**
 * An interface statement's fields after a person's decision: the fields the person set first; then for each other
 * field, what their new words give, unless the field as it was still appears in those words (an agent's "power input"
 * stands over a bare "USB" read from "USB-C power input"); then the field as it was. Pure.
 */
export function decidedFields(was: IntentInterface | null, words: string | null, given: unknown): IntentInterface {
  const before = givenFields(was)
  const read = words ? interfaceFromWords(words) : {}
  const out: IntentInterface = {}
  for (const k of INTERFACE_FIELDS) {
    const b = before[k]?.toLowerCase(), r = read[k]?.toLowerCase()
    const kept = b !== undefined && words !== null && (words.toLowerCase().includes(b) || (r !== undefined && b.includes(r)))
    const v = kept ? before[k] : read[k] ?? before[k]
    if (v !== undefined) out[k] = v
  }
  return { ...out, ...givenFields(given) }
}

/**
 * The statements people stated themselves, as rows: the Intent builder's chat notes each statement it drafts from the
 * person's answers in their draft (no job, no branch, no change), and Submit intent records it in the journey record as
 * a decision of kind intent, choice `stated`, with its words, topic and kind. The agents' rows are proposals in the
 * repository (db.ts) that people decide on; these are a person's own words, so they live with people's decisions and
 * are live at once. Read beside the agents' rows wherever intent is read (intentView, linksView, designOf).
 *
 * `drafted` is the same shape laid over a throwaway copy of the record while the statement is still in the draft (the
 * quality bar's preview, actions-skills.ts): a proposed statement, not yet decided. Never recorded.
 *
 * Each statement's newest stated (or drafted) decision gives its row, even once a later decision on it (an edit, a
 * rejection) supersedes that one. An id an agent's row already has is the agent's. Pure.
 */
export function statedRows(agents: readonly Pick<IntentStatementRow, 'id'>[], decisions: readonly DesignDecision[]): IntentStatementRow[] {
  const have = new Set(agents.map((s) => s.id))
  const latest = new Map<string, DesignDecision>()
  for (const d of decisions) if (d.kind === 'intent' && (d.choice === 'stated' || d.choice === 'drafted') && !have.has(d.target)) latest.set(d.target, d)
  return [...latest.values()].flatMap((d): IntentStatementRow[] => {
    const x = d.detail
    const topic = INTENT_TOPICS.find((t) => t === x.topic)
    const text = typeof x.text === 'string' ? x.text.trim() : ''
    if (!topic || !text) return []
    const kind = INTENT_KINDS.find((k) => k === x.kind) ?? 'statement'
    // an interface's fields: the ones given, else what its words plainly say
    const iface = topic === 'interfaces' && kind === 'statement' ? { ...interfaceFromWords(text), ...givenFields(x.interface) } : null
    return [{
      id: d.target, topic: topic as IntentTopic, kind, text, source: { kind: 'person', ref: d.by }, interface: iface, limits: [],
      decide_by: STAGES.find((st) => st === x.decide_by) ?? null, owner: typeof x.owner === 'string' && x.owner.trim() ? x.owner.trim() : null,
      conflicts: [], testable: null, status: 'proposed', created: d.at, updated: d.at, by: d.by,
    }]
  })
}

/** The design rows with the statements people stated themselves beside the agents' (statedRows). Pure. */
export function withStated(rows: DesignRows, decisions: readonly DesignDecision[]): DesignRows {
  const stated = statedRows(rows.intent, decisions)
  return stated.length ? { ...rows, intent: [...rows.intent, ...stated] } : rows
}

/** A person's gate signature, as intentView reads it: the gate's name, who, when (seconds). */
export interface GateSign { gate: string; by: string; at: number }

/**
 * The gate signatures that are a person's own (a signature carried into a new revision is a copy, dated when it was
 * copied, not a person signing what the record held then), for intentView.
 */
export function ownSignatures(r: { signatures: readonly { gate: string; by: string; at: number; notes?: string | null | undefined }[]; gates: readonly { id: string; name: string }[] } | null): GateSign[] {
  if (!r) return []
  const name = new Map(r.gates.map((g) => [g.id, g.name]))
  return r.signatures.filter((s) => !/^Carried from revision /.test(s.notes ?? '')).map((s) => ({ gate: name.get(s.gate) ?? s.gate, by: s.by, at: s.at }))
}

/**
 * Live statements (not withdrawn by their agent), with people's decisions over them. Rejected ones are kept, marked.
 *
 * An agent's line that no person decided on, or whose words an agent changed after a person accepted them, is
 * proposed, until a person decides on it, or signs a gate after the words were last written (`signed`): the gate is
 * signed over the record that holds them (test-esp32 log #209: a budget raised through a reviewed change, and a setup
 * access point added by an accepted docs change, stayed "proposed" though every gate since was signed over them). The
 * first such signature is the decision shown.
 */
export function intentView(rows: DesignRows, decisions: readonly DesignDecision[], signed: readonly GateSign[] = []): IntentView[] {
  const dec = standing(decisions, 'intent')
  const unc = standing(decisions, 'intent.uncovered')
  const own = new Set(statedRows(rows.intent, decisions).map((s) => s.id))
  const live = withStated(rows, decisions).intent.filter((s) => s.status !== 'withdrawn')
  const base = live.map((s) => {
    // a statement still in the person's draft (drafted) is not decided yet
    const d0 = dec.get(s.id)
    const d = d0?.choice === 'drafted' ? undefined : d0
    const seen = typeof d?.detail.text === 'string' ? d.detail.text : null
    const edited = d?.choice === 'edited' && typeof d.detail.edited === 'string' ? d.detail.edited : null
    // a person's own statement (stated) is accepted in their words
    const accepted = d?.choice === 'accepted' || d?.choice === 'stated'
    // an accepted statement whose words an agent changed afterwards is proposed again
    const wasChanged = accepted && seen !== null && seen !== s.text
    const decidedState: IntentState = d?.choice === 'rejected' ? 'rejected' : edited !== null ? 'edited' : accepted && !wasChanged ? 'accepted' : 'proposed'
    // a gate a person signed after an agent last wrote the words (and after any decision of theirs) accepts them
    const sign = decidedState === 'proposed' ? [...signed].sort((a, b) => a.at - b.at).find((g) => g.at >= s.updated && (!d || g.at >= d.at)) : undefined
    const state: IntentState = sign ? 'accepted' : decidedState
    const changed = wasChanged && !sign
    // the person's fields of an interface (set beside an edit, or filled from their new words) stand over the agent's
    // while their decision does
    const personFields = (decidedState === 'edited' || decidedState === 'accepted') && d?.choice !== 'stated' && d?.detail.interface && typeof d.detail.interface === 'object' ? givenFields(d.detail.interface) : null
    const fields = personFields ? { ...givenFields(s.interface), ...personFields } : s.interface
    const u = unc.get(s.id)
    return {
      ...s, interface: fields, words: edited ?? s.text, state, changed_since: changed, person: own.has(s.id) ? { by: s.by ?? '', words: true, fields: INTERFACE_FIELDS.filter((k) => fields?.[k]) } : personOf(d, edited !== null, s.interface, personFields),
      decided: sign ? { by: sign.by, at: iso(sign.at), gate: sign.gate } : d ? { by: d.by, at: iso(d.at), ...(typeof d.detail.reason === 'string' ? { reason: d.detail.reason } : {}) } : null,
      uncovered: u && u.choice === 'left_out' ? String(u.detail.reason ?? '') : null, flags: [] as IntentFlag[],
    }
  })
  const alive = new Map(base.filter((s) => s.state !== 'rejected').map((s) => [s.id, s]))
  for (const s of base) {
    if (s.state === 'rejected') continue
    if (s.kind === 'statement') {
      if (QUANTITY_TOPICS.has(s.topic) && needsNumber(s)) s.flags.push('needs_number')
      if (VAGUE_WORDS.test(s.words) && !quantity(s)) s.flags.push('vague')
      if (s.testable === false) s.flags.push('not_testable')
      if (s.topic === 'interfaces' && missingFields(s.interface).length) s.flags.push('interface_incomplete')
    }
    if (s.kind === 'question' && !s.owner?.trim()) s.flags.push('no_owner')
    if (openConflicts(s, alive).length) s.flags.push('conflict')
  }
  return base
}

/**
 * What a person stated of an agent's statement (IntentView.person; one a person stated is theirs in full). Of a
 * person's decision on an agent's statement: the words when they reworded it; the interface fields their decision
 * holds that differ from the agent's (the decision keeps all five fields, the agent's kept as they were, record
 * decidedFields), so a field the person typed in an Edit, or their new words gave, is theirs (test-esp32 R22: a pitch
 * and a bus rate typed in an Edit were drafted as "inferred: the interface record"). Pure.
 */
function personOf(d: DesignDecision | undefined, reworded: boolean, was: IntentInterface | null, decided: IntentInterface | null): IntentView['person'] {
  if (!d || d.choice === 'rejected') return null
  const agent = givenFields(was)
  const fields = decided ? INTERFACE_FIELDS.filter((k) => decided[k] !== undefined && decided[k]?.toLowerCase() !== agent[k]?.toLowerCase()) : []
  return reworded || fields.length ? { by: d.by, words: reworded, fields } : null
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
      const f0 = s.flags.map((x) => FLAG[x]).find(Boolean)
      // an incomplete interface says which fields it lacks
      const f = f0 && f0.flag === FLAG.interface_incomplete?.flag ? { ...f0, flag: `Missing ${missingFields(s.interface).join(', ')}` } : f0
      const state = f ? f.state : s.state === 'accepted' || s.state === 'edited' ? 'accepted' as const : 'draft' as const
      const words = s.kind === 'dont_care' ? `Don't care: ${s.words}` : s.kind === 'unknown' ? `Unknown, decide by ${s.decide_by ?? '?'}: ${s.words}` : s.words
      // an interface's five fields, and the ones still empty, so the panel shows them beside the words and Edit can set them
      const fields = s.topic === 'interfaces' && s.kind === 'statement' ? { interface: { ...givenFields(s.interface) }, missing: missingFields(s.interface) } : {}
      return { id: s.id, topic: TOPIC_NAMES[s.topic], text: words, state, ...(f ? { flag: f.flag } : {}), ...fields }
    }),
    questions: live.filter((s) => s.kind === 'question').map((s) => ({ id: s.id, text: s.words, owner: s.owner ?? 'no owner yet' })),
  }
}

/** Each requirement's links to statements that are not withdrawn (rejected ones still show where a requirement came from). */
export function linksView(rows: DesignRows, decisions: readonly DesignDecision[] = []): { requirement: string; intent: string }[] {
  const ids = new Set(withStated(rows, decisions).intent.filter((s) => s.status !== 'withdrawn').map((s) => s.id))
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
  if (typeof d.detail.text === 'string') {
    if (d.detail.text === now.text && (!('acceptance' in d.detail) || d.detail.acceptance === now.acceptance)) return true
    // an agent that wrote the person's own edit into the row changed nothing the person decided
    const e = editedOf(d)
    return Boolean(e && (e.text !== undefined || e.acceptance !== undefined) && (e.text ?? d.detail.text) === now.text && (e.acceptance ?? (typeof d.detail.acceptance === 'string' ? d.detail.acceptance : null)) === now.acceptance)
  }
  return !(now.status === 'proposed' && now.updated !== null && now.updated > d.at)
}

/** The kinds a requirement can be (src/tools/verify/db.ts REQ_KINDS). */
export const REQUIREMENT_KINDS = ['functional', 'electrical', 'timing', 'emc'] as const

/**
 * A person's own wording of a requirement, kept with their decision (Requirements review: Edit, or trace's chat with
 * decide_requirement): its words, its acceptance criterion, the method that checks it, its kind. Each field left out
 * keeps the agent's. The agents' row is never changed: the edit is laid over it wherever the requirement is read.
 */
export interface RequirementWording { text?: string; acceptance?: string; method?: string; kind?: string }

/** The person's wording a decision on a requirement keeps, or null when it keeps none. */
export function editedOf(d: Pick<DesignDecision, 'detail'>): RequirementWording | null {
  const e = d.detail.edited
  if (!e || typeof e !== 'object') return null
  const out: RequirementWording = {}
  for (const k of ['text', 'acceptance', 'method', 'kind'] as const) {
    const v = (e as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** The requirement rows as a decision on one is checked against them (decisionStands). */
export const requirementsNow = (all: readonly Record<string, unknown>[]): Map<string, RequirementNow> =>
  new Map(all.map((q) => [String(q.id), { text: String(q.text), acceptance: q.acceptance === null || q.acceptance === undefined ? null : String(q.acceptance), status: String(q.status), updated: typeof q.updated === 'number' ? q.updated : null }]))

/**
 * A requirement's standing decision: accepted (with the person's own wording, when they edited it), or struck with the
 * reason. Given the rows as they are now, a decision an agent's change has reopened is left out, so the requirement is
 * the person's to decide again.
 */
export function requirementDecisions(decisions: readonly DesignDecision[], rows?: ReadonlyMap<string, RequirementNow>): Map<string, { choice: 'accepted' | 'struck'; reason: string | null; by: string; at: string; edited?: RequirementWording }> {
  const m = new Map<string, { choice: 'accepted' | 'struck'; reason: string | null; by: string; at: string; edited?: RequirementWording }>()
  for (const [id, d] of standing(decisions, 'requirement')) {
    if (rows && !decisionStands(d, rows.get(id))) continue
    const edited = d.choice === 'struck' ? null : editedOf(d)
    m.set(id, { choice: d.choice === 'struck' ? 'struck' : 'accepted', reason: typeof d.detail.reason === 'string' ? d.detail.reason : null, by: d.by, at: iso(d.at), ...(edited ? { edited } : {}) })
  }
  return m
}

// ------------------------------------------------------------------ architecture

export interface CriterionView {
  id: string; name: string; weight: number; description: string | null
  /** the name it was fixed with, when its words were changed after the fix (the weight stays the fixed one) */
  was?: string
  /** requirements its words name that changed after the words were written: the numbers it quotes may be old */
  stale?: { requirements: string[]; since: string }
}
export interface ScoreView { option: string; criterion: string; score: number; reason: string; by: 'trace' | 'person' }
export interface OptionView {
  id: string; name: string; summary: string; recommended: boolean; why: string | null; gives_up: string | null; risks: string[]
  blocks: { id: string; name: string; role: string | null; parts: BlockPart[]; serves: string[]; x: number; y: number }[]
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

/**
 * The criteria as they read now. Fixed criteria keep their ids and weights, so the choice made on them stands, but
 * their words follow the record: a criterion reworded after the fix (a requirement's number changed) reads as reworded,
 * with the name it was fixed with. A criterion whose words name a requirement that changed after the words were written
 * says so: the numbers it quotes may be old. After a budget change test-esp32's deciding criteria still read "Cost
 * against 8 USD/board and 100 USD project" (run 2, #173), because the fixed list was a copy of the words.
 */
function criteriaNow(rows: DesignRows, fixed: CriterionView[] | null, fixedAt: number | null): CriterionView[] {
  const live = rows.criteria.filter((c) => c.status !== 'withdrawn')
  const base = fixed ?? live.map((c) => ({ id: c.id, name: c.name, weight: c.weight, description: c.description }))
  const reqs = new Map((rows.requirements ?? []).map((r) => [r.id, r.updated]))
  return base.map((c) => {
    const row = live.find((r) => r.id === c.id)
    const reworded = fixed !== null && fixedAt !== null && row !== undefined && row.updated > fixedAt && (row.name !== c.name || (c.description !== null && row.description !== c.description))
    const out: CriterionView = reworded ? { ...c, name: row.name, description: row.description, was: c.name } : { ...c, description: c.description ?? row?.description ?? null }
    // when its words were written: the row's time, or the fix's for a fixed copy not reworded since
    const wordsAt = reworded || fixed === null ? row?.updated ?? null : fixedAt
    if (wordsAt === null) return out
    const words = `${out.name} ${out.description ?? ''}`
    const changed = [...reqs.keys()].filter((id) => (reqs.get(id) ?? 0) > wordsAt && new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(words))
    if (changed.length) out.stale = { requirements: changed, since: iso(Math.max(...changed.map((id) => reqs.get(id) ?? 0))) }
    return out
  })
}

export function architectureView(rows: DesignRows, decisions: readonly DesignDecision[]): ArchitectureView {
  const fixedDec = standing(decisions, 'architecture.criteria').get('architecture') ?? null
  const choiceDec = standing(decisions, 'architecture.choice').get('architecture') ?? null
  const fixedList = Array.isArray(fixedDec?.detail.criteria) ? (fixedDec.detail.criteria as unknown[]).flatMap((c) => {
    const x = c as { id?: unknown; name?: unknown; weight?: unknown; description?: unknown }
    return typeof x.id === 'string' ? [{ id: x.id, name: typeof x.name === 'string' ? x.name : x.id, weight: typeof x.weight === 'number' ? x.weight : 1, description: typeof x.description === 'string' ? x.description : null }] : []
  }) : null
  const criteria: CriterionView[] = criteriaNow(rows, fixedList, fixedDec?.at ?? null)
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

/**
 * The option that scores higher than `option` on the criteria, when one does (the highest), with both weighted totals:
 * choosing an option that scores lower than another needs a reason of the person's own, as choosing against the
 * recommendation does, since the recommendation may itself not be the top score (test-esp32 #96: A taken over C, 42.5
 * against 44.0, with no reason asked). `scores` are the person's own, laid over the view's. Null when nothing scores
 * higher, or nothing is scored.
 */
export function outscoredBy(a: Pick<ArchitectureView, 'options' | 'criteria' | 'scores'>, option: string, scores: readonly { option: string; criterion: string; score: number }[] = []): { option: OptionView; total: number; mine: number } | null {
  if (!a.criteria.length) return null
  const scoreOf = (o: string, c: string): number | undefined => scores.find((s) => s.option === o && s.criterion === c)?.score ?? a.scores.find((s) => s.option === o && s.criterion === c)?.score
  const scored = (o: string): boolean => a.criteria.some((c) => scoreOf(o, c.id) !== undefined)
  const total = (o: string): number => Math.round(a.criteria.reduce((n, c) => n + (scoreOf(o, c.id) ?? 0) * c.weight, 0) * 100) / 100
  if (!a.options.some((o) => o.id === option)) return null
  const mine = total(option)
  const best = a.options.filter((o) => o.id !== option && scored(o.id)).map((o) => ({ option: o, total: total(o.id) })).sort((x, y) => y.total - x.total)[0]
  return best && best.total > mine ? { ...best, mine } : null
}

/** "Option C scores higher (44 against 42.5)": why a reason is asked for. */
export const outscoredWords = (o: { option: { id: string }; total: number; mine: number }): string => `Option ${o.option.id} scores higher (${o.total} against ${o.mine})`

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
  kind: 'no_net' | 'no_function' | 'unsupported' | 'unknown_alternates' | 'claimed_twice' | 'function_twice' | 'reserved' | 'mismatch' | 'not_on_schematic' | 'missing_pin' | 'mate_order' | 'mate_unknown' | 'strap_pull'
  severity: 'blocks' | 'fix'
  text: string
}

// ------------------------------------------------------------------ off-board parts and their connectors

/** An off-board part of the architecture going ahead, with what it plugs into when recorded. */
export interface MatedPart { mpn: string; block: string; mates: BlockPart['mates'] | null }

/** The off-board parts of the option the diagram draws (chosen, else recommended): what mateCheck checks. */
export function matedParts(a: Pick<ArchitectureView, 'options' | 'current'> | null | undefined): MatedPart[] {
  const o = a?.options.find((x) => x.id === a.current)
  return (o?.blocks ?? []).flatMap((b) => b.parts.filter((p) => p.off_board).map((p) => ({ mpn: p.mpn, block: b.name, mates: p.mates?.connector && p.mates.pins?.length ? p.mates : null })))
}

const GROUND_PIN = /^(A|D|P|S)?GND\d*$|^(VSS|VSSA|0V|GROUND|COM|V-)$/
const POWER_PIN = /^(VCC|VDD|VDDIO|VIN|VBUS|VBAT|VSYS|VS|PWR|POWER|V\+|\d+V\d*|\d*V\d+|\d+(\.\d+)?V)$/

/** A pin's name as a role to compare: ground, power, or the bare name ("/I2C_SCL" is I2CSCL). */
function pinRole(name: string): string {
  const n = name.trim().toUpperCase().replace(/^.*\//, '').replace(/^\+/, '')
  if (GROUND_PIN.test(n)) return 'ground'
  if (POWER_PIN.test(n) || /^(VCC|VDD)[_-]?\w*$/.test(n) || /^\+?\d+V\d*$/.test(name.trim().toUpperCase())) return 'power'
  return n.replace(/[^A-Z0-9]/g, '')
}
const SUPPLY = new Set(['ground', 'power'])
/** Whether a connector pin (its name, function or net) and a module pin are the same: equal roles, or one signal name
 * ending the other ("I2C_SCL" and "SCL"). */
function samePin(c: PinRow, m: string): boolean {
  const mr = pinRole(m)
  const names = [c.name, c.function, c.net].filter((x): x is string => Boolean(x?.trim())).map(pinRole)
  return names.some((cr) => cr === mr || (!SUPPLY.has(cr) && !SUPPLY.has(mr) && cr.length > 0 && mr.length > 0 && (cr.endsWith(mr) || mr.endsWith(cr))))
}

/**
 * Each off-board part against the connector it plugs into, pin by pin on a straight cable: the part's pin order from
 * its datasheet (its block's mates) beside the pin plan's rows of that connector. test-esp32 #169: the OLED module's
 * datasheet gives pin 1 VCC, pin 2 GND, the reverse of J2's GND, VCC, SCL, SDA, and no check caught it: the module's
 * supply would be reversed. A supply pin meeting another pin blocks; a signal meeting the wrong signal is to fix; a
 * part whose order or connector is not recorded is to fix too, since nothing can be checked. Pure.
 */
export function mateCheck(parts: readonly MatedPart[], pins: readonly PinRow[]): PinFinding[] {
  const out: PinFinding[] = []
  const live = pins.filter((p) => p.status !== 'withdrawn')
  for (const p of parts) {
    const key = p.mpn.replace(/[^\w.-]+/g, '-')
    if (!p.mates) {
      out.push({ id: `mate:${key}:unknown`, target: `part:${p.mpn}`, kind: 'mate_unknown', severity: 'fix', text: `${p.mpn} (${p.block}) sits off the board, but the connector it plugs into and its pin order from its datasheet are not recorded (design.architecture set_blocks, the part's mates), so a reversed supply on its cable cannot be caught.` })
      continue
    }
    const { connector, pins: order, source } = p.mates
    const rows = live.filter((r) => r.part === connector)
    const theirs = `${order.map((n, i) => `${i + 1} ${n}`).join(', ')}${source ? ` (its datasheet ${source})` : ''}`
    if (!rows.length) {
      out.push({ id: `mate:${connector}:${key}:unknown`, target: `pin:${connector}`, kind: 'mate_unknown', severity: 'fix', text: `${p.mpn} plugs into ${connector}, but ${connector} has no pins in the pin plan, so its order cannot be checked against the part's: ${theirs}.` })
      continue
    }
    const at = (n: number): PinRow | undefined => rows.find((r) => r.pin === String(n))
    const label = (r: PinRow): string => r.name ?? r.function ?? r.net ?? r.kind
    const count = Math.max(order.length, ...rows.map((r) => Number(r.pin)).filter(Number.isFinite))
    const wrong: { n: number; ours: string; theirs: string; supply: boolean }[] = []
    for (let n = 1; n <= count; n++) {
      const c = at(n)
      const m = order[n - 1]
      if (!c && !m) continue
      if (c && m && samePin(c, m)) continue
      const ours = c ? label(c) : 'no pin'
      const supply = [ours, ...(c ? [c.net ?? '', c.function ?? ''] : []), m ?? ''].some((x) => SUPPLY.has(pinRole(x)))
      wrong.push({ n, ours, theirs: m ?? 'no pin', supply })
    }
    if (!wrong.length) continue
    const ours = [...rows].sort((a, b) => Number(a.pin) - Number(b.pin) || a.pin.localeCompare(b.pin)).map((r) => `${r.pin} ${label(r)}`).join(', ')
    const supply = wrong.some((w) => w.supply)
    out.push({
      id: `mate:${connector}:${key}:order`, target: `pin:${connector}.${wrong[0]?.n}`, kind: 'mate_order', severity: supply ? 'blocks' : 'fix',
      text: `${connector}'s pins are ${ours}; ${p.mpn}, which plugs into it, has ${theirs}. ${wrong.map((w) => `Pin ${w.n}: ${connector}'s ${w.ours} meets the part's ${w.theirs}`).join('; ')}. On a straight cable ${supply ? 'its supply is on the wrong pins' : 'these signals cross'}: change ${connector}'s order, choose a part whose order matches, or waive it naming the cable that crosses them.`,
    })
  }
  return out
}

const bare = (net: string): string => net.replace(/^.*\//, '')
const sameNet = (a: string, b: string): boolean => a === b || bare(a) === bare(b)
const USED = (p: PinRow): boolean => p.status !== 'withdrawn' && p.kind !== 'spare' && p.kind !== 'nc'

/**
 * Check the pin plan on its own (and against the netlist when given): every finding with what to do about it, in
 * plain words. `nets` absent: the schematic part of the check (mismatch, not_on_schematic) is not done. `mated`: the
 * architecture's off-board parts, each against the connector it plugs into (mateCheck).
 */
export function pinCheck(pins: readonly PinRow[], nets?: ReadonlyMap<string, readonly string[]> | null, mated?: readonly MatedPart[]): PinFinding[] {
  const out: PinFinding[] = mated ? mateCheck(mated, pins) : []
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
    out.push(...strapPulls(live, nets))
  }
  return out
}

/** A supply or ground net, by its name: +3V3, 3V3, VCC, VDD_IO, VBUS, GND, AGND, VSS. */
const RAIL_NET = /^(\+?\d+(\.\d+)?V\d*|\+?\d*V\d+|VCC\w*|VDD\w*|VBUS|VBAT|VSYS|VIN|\w*GND\w*|VSS\w*)$/i
/** A resistor's reference: R7, R12A (not RN arrays or RV pots, whose pins are not one resistor). */
const RESISTOR = /^R\d+[A-Z]?$/

/**
 * Boot strapping pins (reserved: boot) that something else on the board drives, with no resistor from their net to a
 * supply or ground (test-esp32 #104: ESP32 IO0 on the auto-reset transistor's collector, held only by the chip's
 * internal pull of about 45 kOhm). The level read at reset then rests on the weak internal pull against whatever
 * leaks or couples onto the net. A strap left unconnected, or tied straight to a rail, is not a finding.
 */
export function strapPulls(pins: readonly PinRow[], nets: ReadonlyMap<string, readonly string[]>): PinFinding[] {
  const onPin = new Map<string, string>()
  for (const [net, nodes] of nets) for (const n of nodes) onPin.set(n, net)
  const refOf = (node: string): string => node.slice(0, node.lastIndexOf('.'))
  const out: PinFinding[] = []
  for (const p of pins.filter((x) => x.status !== 'withdrawn' && x.reserved === 'boot')) {
    const net = onPin.get(`${p.part}.${p.pin}`)
    if (net === undefined || /^(unconnected-|Net-\()/i.test(bare(net)) || RAIL_NET.test(bare(net))) continue
    const others = (nets.get(net) ?? []).filter((n) => n !== `${p.part}.${p.pin}`)
    if (!others.length) continue
    // a resistor on the net whose other pin is on a rail: the external pull
    const pulled = others.some((n) => {
      const ref = refOf(n)
      if (!RESISTOR.test(ref)) return false
      return [...onPin].some(([node, other]) => refOf(node) === ref && node !== n && other !== net && RAIL_NET.test(bare(other)))
    })
    if (pulled) continue
    const id = `pin:${p.part}.${p.pin}`
    const name = `${p.part} pin ${p.pin}${p.name ? ` (${p.name})` : ''}`
    const on = [...new Set(others.map(refOf))]
    out.push({
      id: `${id}:strap_pull`, target: id, kind: 'strap_pull', severity: 'fix',
      text: `${name} is a boot strapping pin on ${bare(net)} with ${on.join(', ')}, and no resistor pulls ${bare(net)} to a supply or ground: its level at reset rests on the part's weak internal pull. Add an external pull (10 kOhm is usual) or waive it with the reason.`,
    })
  }
  return out
}

/** What one part's pin plan agreement binds to: its live rows, so a later change shows the agreement is stale. */
export function pinPlanPrint(pins: readonly PinRow[], part: string): string {
  return fingerprint(pins.filter((p) => p.part === part && p.status !== 'withdrawn').map((p) => [p.pin, p.function, p.peripheral, p.use, p.net, p.kind, p.reserved]))
}
