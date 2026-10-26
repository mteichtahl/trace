/**
 * Which specialist a job goes to. `route` is pure and deterministic; `routeJob` adds the last resort, one small
 * classification call to the model, when nothing deterministic decided.
 *
 * Precedence:
 *   1. explicit   a kind the caller named (API task `agent`, `trace remote task --agent`, a pick that already routed)
 *   2. label      agent:verify / agent:impl / agent:ams / agent:emc / agent:render / agent:thermal on the issue or PR (labels.agent_*)
 *   3. evidence   failing check or job names and their logs, and the changed files (EVIDENCE below)
 *   4. keyword    words in the issue, PR or task text (each specialist's `keywords`)
 *   5. model      one turn, no tools, schema-constrained output (Classifier), unless agents.route_with_model is off
 *   6. default    agents.default
 *
 * Only enabled specialists (agents.enabled) are candidates; a label or explicit kind that is not enabled is noted and
 * skipped. Confidence: 1 for explicit and label, 0.5–0.95 for evidence by its margin over the runner-up, 0.35–0.75
 * for keywords, the model's own figure capped at 0.8, and 0.2 for the default. A tie at a level is no decision: the
 * next level decides (keywords break an evidence tie).
 *
 * No I/O here and no Agent SDK import: the harness bundle (GitHub Actions) routes with `route` alone.
 */
import { z } from 'zod'
import type { TraceConfig } from '../core/config.js'
import { type Route, SPECIALIST_KINDS, type SpecialistKind, SpecialistKindSchema } from './kinds.js'
import { SPECIALISTS } from './index.js'
import { type Composed, Composer, type Layers, NO_LAYERS } from '../prompts/resolve.js'

export interface CheckEvidence {
  /** The failing check run's or job's name. */
  name: string
  /** The tail of its log, when known. */
  log?: string | undefined
}

export interface RouteInput {
  /** A kind named by the caller: decides, when enabled. */
  kind?: SpecialistKind | undefined
  labels?: readonly string[] | undefined
  /** Failing checks or jobs. */
  checks?: readonly CheckEvidence[] | undefined
  /** Paths changed by the PR. */
  files?: readonly string[] | undefined
  /** Title, body, or the task's request. */
  text?: string | undefined
}

export type RouteConfig = Pick<TraceConfig, 'labels' | 'agents'>

// ------------------------------------------------------------------ the evidence rules

interface Rule { kind: SpecialistKind; re: RegExp; weight: number; what: string; except?: RegExp }

/** Check or job names, after `_ . / -` become spaces. */
const CHECK_NAME_RULES: readonly Rule[] = [
  { kind: 'verify', re: /\b(verif\w*|tests?|tb|testbench(es)?|sim(ulation)?|cocotb|verilator|iverilog|formal|sby|symbiyosys|coverage|erc)\b/i, weight: 3, what: 'test, simulation, formal or coverage check' },
  { kind: 'impl', re: /\b(drc|pnr|place(ment)?|route|routing|timing|synth(esis)?|yosys|nextpnr|bitstream|fpga|layout)\b/i, weight: 3, what: 'synthesis, place/route, timing or DRC check' },
  { kind: 'ams', re: /\b(spice|ngspice|ams|analog|corners?|monte ?carlo|montecarlo|yield|noise)\b/i, weight: 3, what: 'SPICE, corners or yield check' },
  { kind: 'emc', re: /\b(emc|emi|si|openems|s ?param\w*|crosstalk|precheck|impedance)\b/i, weight: 3, what: 'EMC or signal-integrity check' },
  { kind: 'render', re: /\b(render\w*|turntable)\b/i, weight: 3, what: 'render job' },
  { kind: 'thermal', re: /\b(thermal|temperature|tj|junction|derating|heat ?sink|overheat\w*)\b/i, weight: 3, what: 'thermal check' },
]

/** What the failing logs say. */
const LOG_RULES: readonly Rule[] = [
  { kind: 'verify', re: /%Error|%Fatal|\$fatal|assertion (failed|violat\w*)|\bFAILED\b.*\btest|cocotb.*\bFAIL|\bsby\b.*\b(FAIL|UNKNOWN)\b|coverage (below|gap)|ERC (error|violation)s?/i, weight: 2, what: 'test, assertion, formal or coverage failure in the log' },
  { kind: 'impl', re: /timing (fail\w*|violat\w*)|negative slack|max frequency .*FAIL|\bunrouted\b|unconnected (items|pads)|DRC (error|violation)s?|failed to route|nextpnr.*ERROR|setup violation/i, weight: 2, what: 'timing, routing or DRC failure in the log' },
  { kind: 'ams', re: /ams[._]spec|spec (miss|fail\w*)|out of spec|phase margin|ngspice.*(error|fail)|yield (below|under)|worst corner/i, weight: 2, what: 'analog spec miss in the log' },
  { kind: 'emc', re: /emc[._]precheck|return[- ]path|plane split|emission|crosstalk|insertion loss|openems/i, weight: 2, what: 'EMC precheck or SI finding in the log' },
  { kind: 'thermal', re: /thermal[._](check|board|junction)|\bderated[_ ]margin|\btj\b.*(exceed|above|over)|junction temperature|over[- ]?temperature|thermal (shutdown|runaway)|\bat-risk\b/i, weight: 2, what: 'thermal check failure or over-temperature in the log' },
]

/** Changed paths. Each rule counts once per job, however many files match it. */
const TESTS = /((^|\/)(tb|tests?|testbench(es)?|verif(ication)?|cocotb|formal)\/|(^|\/)tb_[^/]*$|_tb\.[a-z]+$)/i
const FILE_RULES: readonly Rule[] = [
  { kind: 'verify', re: /\.sby$/i, weight: 3, what: 'SymbiYosys files' },
  { kind: 'verify', re: TESTS, weight: 2, what: 'testbenches or tests' },
  { kind: 'verify', re: /(\.(ucdb|gcda)$|(^|\/)coverage[^/]*\.(dat|info|xml)$)/i, weight: 2, what: 'coverage data' },
  // design sources, not testbenches (those count above, once)
  { kind: 'verify', re: /\.(s?v|vhdl?)$/i, except: TESTS, weight: 1, what: 'HDL sources' },
  { kind: 'impl', re: /\.(pcf|lpf|cst|sdc|xdc|pdc|ccf)$/i, weight: 3, what: 'FPGA constraints' },
  { kind: 'impl', re: /\.kicad_pcb$/i, weight: 2, what: 'a KiCad board' },
  { kind: 'impl', re: /\.(dsn|ses)$/i, weight: 2, what: 'autorouter files' },
  { kind: 'ams', re: /\.(cir|sp|spi|spice|asc)$/i, weight: 3, what: 'SPICE netlists' },
  { kind: 'ams', re: /\.(lib|mod|subckt)$/i, weight: 2, what: 'SPICE models' },
  { kind: 'emc', re: /\.s\d+p$/i, weight: 3, what: 'S-parameter (Touchstone) files' },
  { kind: 'emc', re: /(^|\/)(emc|emi|openems|si)\//i, weight: 2, what: 'EMC or SI files' },
  { kind: 'thermal', re: /\.thermal$|(^|\/)(thermal|temperature)[^/]*\.(csv|log|txt|dat)$|(^|\/)(temp|temps|temperature)[-_]?log[^/]*$/i, weight: 3, what: 'thermal files or temperature logs' },
  { kind: 'thermal', re: /(^|\/)thermal\//i, weight: 2, what: 'thermal models or results' },
  { kind: 'thermal', re: /(^|\/)[^/]*(ldo|regulator|buck|boost|mosfet|heatsink|power[-_]?stage)[^/]*\.(kicad_sch|kicad_pcb|kicad_sym|kicad_mod)$/i, weight: 2, what: 'power-stage parts' },
]

// ------------------------------------------------------------------ route

const kindsOf = (cfg: RouteConfig): readonly SpecialistKind[] => SPECIALIST_KINDS.filter((k) => cfg.agents.enabled.includes(k))
const normName = (s: string): string => s.replace(/[_./-]+/g, ' ')
const round = (x: number): number => Math.round(x * 100) / 100

/** The kind a label names (labels.agent_<kind>), or null. */
export function labelKind(label: string, cfg: RouteConfig): SpecialistKind | null {
  const l = label.trim().toLowerCase()
  return SPECIALIST_KINDS.find((k) => cfg.labels[`agent_${k}`].toLowerCase() === l) ?? null
}

interface Scored { scores: Map<SpecialistKind, number>; why: Map<SpecialistKind, string[]> }

function scored(): Scored { return { scores: new Map(), why: new Map() } }
function add(s: Scored, kind: SpecialistKind, w: number, why: string): void {
  s.scores.set(kind, (s.scores.get(kind) ?? 0) + w)
  const list = s.why.get(kind) ?? []
  if (!list.includes(why)) list.push(why)
  s.why.set(kind, list)
}

/** The leader among the candidates, with its margin over the runner-up; null on a tie or no score. */
function leader(s: Scored, kinds: readonly SpecialistKind[]): { kind: SpecialistKind; top: number; margin: number } | null {
  const ranked = kinds.map((k) => [k, s.scores.get(k) ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const [first, second] = ranked
  if (!first) return null
  if (second && second[1] === first[1]) return null
  return { kind: first[0], top: first[1], margin: (first[1] - (second?.[1] ?? 0)) / first[1] }
}

/** Evidence from failing checks, their logs and the changed files. */
export function evidenceScores(input: RouteInput): Scored {
  const s = scored()
  for (const c of input.checks ?? []) {
    const name = normName(c.name)
    for (const r of CHECK_NAME_RULES) if (r.re.test(name)) add(s, r.kind, r.weight, `failing check "${c.name.slice(0, 80)}" (${r.what})`)
    if (c.log) for (const r of LOG_RULES) if (r.re.test(c.log)) add(s, r.kind, r.weight, `${r.what} ("${c.name.slice(0, 80)}")`)
  }
  const files = input.files ?? []
  for (const r of FILE_RULES) {
    const hits = files.filter((f) => r.re.test(f) && !r.except?.test(f))
    if (hits.length) add(s, r.kind, r.weight, `changed ${hits.length === 1 ? hits[0] : `${hits.length} files of ${r.what}`}${hits.length === 1 ? ` (${r.what})` : ''}`)
  }
  return s
}

/** Keywords in the text, one point per distinct keyword. */
export function keywordScores(text: string, kinds: readonly SpecialistKind[] = SPECIALIST_KINDS): Scored {
  const s = scored()
  for (const k of kinds) {
    for (const re of SPECIALISTS[k].keywords) {
      const m = re.exec(text)
      if (m) add(s, k, 1, m[0].toLowerCase())
    }
  }
  return s
}

/**
 * The deterministic route: explicit, label, evidence, keyword, else the default (source 'default', which routeJob
 * hands to the model). Pure.
 */
export function route(input: RouteInput, cfg: RouteConfig): Route {
  const kinds = kindsOf(cfg)
  const notes: string[] = []
  if (input.kind) {
    if (kinds.includes(input.kind)) return { kind: input.kind, reason: `asked for the ${input.kind} specialist`, confidence: 1, source: 'explicit' }
    notes.push(`${input.kind} was asked for but is not enabled (agents.enabled)`)
  }
  const labelled = (input.labels ?? []).map((l) => [l, labelKind(l, cfg)] as const).filter((x): x is readonly [string, SpecialistKind] => x[1] !== null)
  const usable = labelled.filter(([, k]) => kinds.includes(k))
  for (const [l, k] of labelled) if (!kinds.includes(k)) notes.push(`label ${l} names ${k}, which is not enabled`)
  const first = usable[0]
  if (first) {
    const others = usable.slice(1).map(([l]) => l)
    return { kind: first[1], reason: `label ${first[0]}${others.length ? ` (also labelled ${others.join(', ')}; the first wins)` : ''}`, confidence: others.length ? 0.9 : 1, source: 'label' }
  }
  const text = input.text ?? ''
  const ev = evidenceScores(input)
  const kw = keywordScores(text, kinds)
  const evLead = leader(ev, kinds)
  if (evLead) {
    return {
      kind: evLead.kind, reason: (ev.why.get(evLead.kind) ?? []).slice(0, 4).join('; '),
      confidence: round(Math.min(0.95, 0.5 + 0.45 * evLead.margin)), source: 'evidence',
    }
  }
  // an evidence tie: keywords among the tied kinds break it
  const evTop = Math.max(0, ...kinds.map((k) => ev.scores.get(k) ?? 0))
  const tied = evTop > 0 ? kinds.filter((k) => (ev.scores.get(k) ?? 0) === evTop) : []
  if (tied.length) {
    const kwLead = leader(kw, tied)
    if (kwLead) {
      return {
        kind: kwLead.kind,
        reason: `${(ev.why.get(kwLead.kind) ?? []).slice(0, 2).join('; ')}; tied with ${tied.filter((k) => k !== kwLead.kind).join(', ')}, broken by the words ${(kw.why.get(kwLead.kind) ?? []).join(', ')}`,
        confidence: 0.5, source: 'evidence',
      }
    }
    notes.push(`the evidence is tied between ${tied.join(', ')}`)
  } else {
    const kwLead = leader(kw, kinds)
    if (kwLead) {
      return {
        kind: kwLead.kind, reason: `the words ${(kw.why.get(kwLead.kind) ?? []).slice(0, 5).map((w) => JSON.stringify(w)).join(', ')}`,
        confidence: round(Math.min(0.75, 0.35 + 0.4 * kwLead.margin)), source: 'keyword',
      }
    }
  }
  return { kind: cfg.agents.default, reason: [`nothing points to a specialist: the default (agents.default)`, ...notes].join('; ').slice(0, 500), confidence: 0.2, source: 'default' }
}

// ------------------------------------------------------------------ the model, as a last resort

export const ClassificationSchema = z.object({
  kind: SpecialistKindSchema,
  reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
}).strict()
export type Classification = z.infer<typeof ClassificationSchema>

/** The JSON Schema the classification call's output is constrained to (the Agent SDK's outputFormat). */
export const CLASSIFICATION_SCHEMA = z.toJSONSchema(ClassificationSchema) as Record<string, unknown>

/** One classification: the prompt in, the model's structured output (unvalidated) out. */
export type Classifier = (prompt: string) => Promise<unknown>

const MAX_TEXT = 6000

/** The classification prompt (router.classify, router.contract in the prompt catalog): the enabled specialists and the job's text and evidence. */
export function composeClassification(input: RouteInput, cfg: RouteConfig, layers: Layers = NO_LAYERS): Composed {
  const kinds = kindsOf(cfg)
  const p = new Composer(layers)
  const evidence = [
    ...(input.labels?.length ? [`labels: ${input.labels.join(', ')}`] : []),
    ...(input.checks?.length ? [`failing checks: ${input.checks.map((c) => c.name).join(', ')}`] : []),
    ...(input.files?.length ? [`changed files: ${input.files.slice(0, 40).join(', ')}${input.files.length > 40 ? ', …' : ''}`] : []),
  ]
  return p.add('router.classify').add('router.contract', {
    specialists: kinds.map((k) => `- ${k}: ${SPECIALISTS[k].title}: ${SPECIALISTS[k].description}`),
    evidence: evidence.length ? evidence : [p.text('router.evidence.none')],
    job: (input.text ?? '').slice(0, MAX_TEXT),
  }).done()
}

export function classificationPrompt(input: RouteInput, cfg: RouteConfig, layers: Layers = NO_LAYERS): string {
  return composeClassification(input, cfg, layers).text
}

/**
 * The full route: `route`, then, when it fell to the default and agents.route_with_model is on, the model. A
 * classifier failure or an answer naming a disabled specialist leaves the default (with the reason saying so).
 */
export async function routeJob(input: RouteInput, cfg: RouteConfig, classify?: Classifier | null, layers: Layers = NO_LAYERS): Promise<Route> {
  const r = route(input, cfg)
  if (r.source !== 'default' || !classify || !cfg.agents.route_with_model) return r
  try {
    const c = ClassificationSchema.parse(await classify(classificationPrompt(input, cfg, layers)))
    if (!cfg.agents.enabled.includes(c.kind)) return { ...r, reason: `${r.reason}; the model chose ${c.kind}, which is not enabled`.slice(0, 500) }
    return { kind: c.kind, reason: `the model: ${c.reason}`.slice(0, 500), confidence: round(Math.min(0.8, c.confidence)), source: 'model' }
  } catch (e) {
    return { ...r, reason: `${r.reason}; the model could not decide (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`.slice(0, 500) }
  }
}

// ------------------------------------------------------------------ the classifier on the Agent SDK

const ResultMessage = z.object({ type: z.literal('result'), subtype: z.string(), structured_output: z.unknown().optional(), result: z.string().optional() }).loose()

/** The part of the Agent SDK's query() the classifier uses (injected: the router never imports the SDK). */
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>

/**
 * A Classifier on the Agent SDK: no tools, no MCP servers, no settings files, output constrained to
 * CLASSIFICATION_SCHEMA. maxTurns is 2 because the SDK returns structured output through a tool call of its own.
 */
export function sdkClassifier(query: QueryFn, o: { model?: string | undefined; cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Classifier {
  return async (prompt) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('the classification took too long')), o.timeoutMs ?? 90_000)
    timer.unref()
    try {
      let out: unknown
      for await (const m of query({
        prompt,
        options: {
          ...(o.model ? { model: o.model } : {}),
          ...(o.cwd ? { cwd: o.cwd } : {}),
          ...(o.env ? { env: o.env } : {}),
          tools: [], mcpServers: {}, settingSources: [], maxTurns: 2, abortController: abort,
          outputFormat: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA },
        },
      })) {
        const r = ResultMessage.safeParse(m)
        if (!r.success) continue
        if (r.data.subtype !== 'success') throw new Error(`the classification stopped (${r.data.subtype})`)
        out = r.data.structured_output ?? (r.data.result ? JSON.parse(r.data.result) as unknown : undefined)
      }
      if (out === undefined) throw new Error('no classification came back')
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}
