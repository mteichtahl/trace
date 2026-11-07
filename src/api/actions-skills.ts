/**
 * The guided skills (docs/ui-design.md "Focus mode: guided skills"): where this person is in one, the quality bar
 * checked from the record, their draft, and Submit.
 *
 *   skill.get     read    { skill } → { skill, name, stage, steps, step, checks, met, total, draft, summary, … }:
 *                         the steps; `checks` per quality-bar item (src/api/skill-checks.ts), each met | not_met |
 *                         waived with `detail`, or `unavailable` (what has to be recorded first); `step` and `draft`
 *                         from this person's draft. Skill-specific: `question` (Question answer: the oldest open
 *                         question for this person), `waivable` (Waiver: the criteria not met, the failing
 *                         requirements, the open findings), `findings` and `sheets` (Schematic finish, Board setup,
 *                         Placement adjust: the latest checks'), `gate` (Gate signing: the gate of the current stage),
 *                         `intent` (Intent builder: the statements by topic, with their flags, and the open questions),
 *                         `items` (Requirements review: the requirements to decide and the intent lines no requirement
 *                         covers; Pin plan review: the pin plan's findings), `architecture` and `recommendation`
 *                         (Architecture choice: every option, the criteria, the scores, trace's recommendation).
 *                         The design decisions in the person's draft are laid over the record before the bar is
 *                         checked, so it shows what Submit would record; one that cannot be recorded is listed in
 *                         `pending_errors`
 *   skill.draft   read    { skill, step, data | null }: keep this person's draft in the journey store (null discards
 *                         it). Read access: a reviewer can draft a waiver to discuss, never submit it
 *   skill.drafts  read    this person's drafts on the project, newest first (the "Continue: … step 4 of 6" card)
 *   skill.submit  write   { skill, draft }: the draft is kept, the bar checked again from the record; any check not
 *                         met is refused with what is missing. Then the skill's own effect where an action exists
 *                         (Waiver → waiver.add, Question answer → question.answer, Change request → a task for the
 *                         agents; Intent builder, Requirements review, Architecture choice and Pin plan review → their
 *                         design decisions, as design.decide records them: src/api/actions-design.ts), a decision
 *                         logged for every skill, and the draft discarded. The answer says what it recorded
 *                         (`recorded`, the decisions in words) and every gate criterion it set (`criteria`: id, text,
 *                         met or not_met, and for one not met `why` and the skill's `step` that fixes it). When one
 *                         it set is still not met the draft is kept instead (`draft_kept`), so the skill's page says
 *                         what is left and the person carries on (test-esp32 #89)
 */
import type { DatabaseSync } from 'node:sqlite'
import { filesRead } from '../ontology/lineage.js'
import { z } from 'zod'
import { recordAnswered } from './process-metrics.js'
import {
  type AgentFacts, type Evidence, type JourneyRecord, type OptionWaiver, SEVERITIES, STAGE_NAMES, type StageId, type Viewer, addWaiver, answerQuestion, decide, getDraft, loadJourney, loadOrders, mergeAgentFacts, putDraft,
  STAGE_IDS, applyChange, changeReason, changeWords, outOfDate, questionIsFor, returnGate, reviewWaitsOn, setCriterion,
} from '../core/journey.js'
import { SKILL_IDS, skillDef } from '../core/skills.js'
import { isAdmin } from '../core/access.js'
import { ActionError, type Context, Repo, agentFacts, agentFactsStore, def, hashOf, label, plainly, storeAt, openProjectDb, withJourneyDb, withProjectDb, withRecordDb, writeJourney } from './action-kit.js'
import { type QuoteRow, allQuotes, loadAgentQuotes, loadQuotes } from '../core/quotes.js'
import { type Lasts, askedBy, carryOn, designBefore, ruleFromAnswer, viewerOf, waivedWords } from './actions-journey.js'
import { docsAfterDesign } from './docs-follow.js'
import { REQUIREMENTS_FROM_INTENT, draftRequirements } from './drafting.js'

/** What Intent builder's Submit says when the project's agent is still being set up (src/api/agent-queue.ts). */
export const QUEUED_DRAFTING = 'This project\'s agent is still being set up, so the drafting is queued: the Verification agent drafts the candidate requirements for Requirements review by itself once the agent is ready. You need not submit again.'
import { type DesignDecision, loadDesignDecisions, recordDesignDecision, standing } from '../tools/design/decisions.js'
import type { DesignRows } from '../tools/design/db.js'
import { type RequirementWords, architectureView, decidedFields, intentDraft, intentView, linksView, outscoredBy, outscoredWords, matedParts, pinCheck } from '../tools/design/record.js'
import { type PendingDecision, type StatedInput, Decision, Stated, changesStage, prepare } from './actions-design.js'
import { kicadFiles } from './actions-record.js'
import { artifactText, checkFindings, designOf, hasTable, latestNetlist, latestRun, requirementEvidence, runResult, stockLines, struckRequirements } from './record-read.js'
import { keyPartsView } from '../tools/design/key-parts.js'
import { BenchStore, type InstrumentId, type Reading, idsFromRuns, latestByQuantity, loadIds, loadReadings, unionIds, unionReadings } from '../core/bench.js'
import { loadBoards } from '../core/boards.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { boardView, readingView } from './actions-build.js'
import { caseStaleness } from './case-read.js'
import { artifactJson } from '../ontology/mech.js'
import type { CaseOptions } from '../tools/mech/tools.js'

/** The skills that read the bench. */
const HARDWARE_SKILLS = new Set(['bench-setup', 'bring-up-run', 'incoming-inspection'])

async function liveBenchOf(ctx: Context, repo: string): Promise<{ readings: Reading[]; ids: InstrumentId[] }> {
  try {
    return (await new BenchStore(storeAt(ctx, PROJECTS_PREFIX), repo, { scratch: ctx.deps.scratch }).read((db) => ({ readings: loadReadings(db), ids: loadIds(db) }))).result
  } catch { return { readings: [], ids: [] } }
}

/**
 * The bench as the checklist skills draw it (BenchReadout, docs/ui-design.md "Checklist on a picture"): for Bring-up
 * run, the board on the bench now (the one with the newest reading), each of its newest readings against its limits,
 * and the checklist ticked by trace from those readings; for Bench setup, each instrument ticked when it answered its
 * identity query. Readings arrive as the bench takes them (the live copy's writes are live events).
 */
function skillBench(skill: string, i: CheckInput) {
  const rs = i.readings ?? []
  if (skill === 'bench-setup') {
    const ids = new Map((i.ids ?? []).map((x) => [x.instrument, x]))
    return {
      powered: false, readouts: [],
      checklist: i.instruments.map((x) => ({ id: `idn-${x.name}`, text: `${x.name} answers its identity query${ids.get(x.name)?.model ? ` (${[ids.get(x.name)?.manufacturer, ids.get(x.name)?.model].filter(Boolean).join(' ')})` : ''}`, by: 'trace' as const, done: Boolean(ids.get(x.name)?.ok) })),
    }
  }
  const board = rs.length ? (rs[rs.length - 1] as Reading).board : null
  const mine = board ? latestByQuantity(rs.filter((r) => r.board === board)) : []
  return {
    board, powered: mine.some((r) => r.step !== 'inspect' && r.step !== 'unpowered'),
    readouts: mine.map((r) => ({ id: r.id, label: `${r.quantity}${r.instrument ? ` (${r.instrument})` : ''}`, value: r.value, unit: r.unit ?? '', ...(r.min !== null ? { min: r.min } : {}), ...(r.max !== null ? { max: r.max } : {}), step: r.step, at: new Date(r.at * 1000).toISOString() })),
    checklist: mine.map((r) => ({ id: `r-${r.id}`, text: `${r.quantity}${r.min !== null || r.max !== null ? ` within ${r.min ?? '…'} to ${r.max ?? '…'} ${r.unit ?? ''}`.trimEnd() : ''}`, by: 'trace' as const, done: r.pass, powered: r.step !== 'inspect' && r.step !== 'unpowered' })),
    readings: rs.filter((r) => r.board === board).map(readingView),
  }
}
import { type CheckInput, type CheckResult, checkSkill, questionParts, questionsFirst, questionsOn } from './skill-checks.js'
import { changeImpact } from './change-impact.js'
import { type ReleaseRecord, decisionOf, noteOf, releaseRecommendation, releaseView } from './release-review.js'
import { type OrderRecord, type RunRow, matchedOf, orderSigned, orderView, releaseSignedAt } from './order-submit.js'

/** The skills whose Submit records design decisions. */
const DESIGN_SKILLS = new Set(['intent-builder', 'requirements-review', 'architecture-choice', 'pin-plan-review'])
/** The skills whose submission can meet or waive a criterion past Define, so can land the last of a stage's design work. */
const DESIGN_SETTLING = new Set(['architecture-choice', 'pin-plan-review', 'question-answer', 'waiver'])

const SkillId = z.string().regex(/^[a-z][a-z-]{1,40}$/).refine((s) => SKILL_IDS.includes(s), 'one of the twenty guided skills')
const Data = z.record(z.string(), z.unknown())

/** The gate a person signs now: the first unsigned gate of the current stage. */
const currentGate = (r: JourneyRecord | null): string | null => {
  if (!r) return null
  return r.gates.find((g) => g.stage === r.journey.currentStage && !r.signatures.some((s) => s.gate === g.id && s.supersededAt === null && s.revision === r.journey.revision))?.id ?? null
}

/** Everything the checks read, from the record database (repository + live journey), for this person and skill. */
/**
 * Requirements review's rows as the record holds them before the person's draft is laid over it: the review lists
 * every requirement not yet accepted in the record, so one the draft accepts or strikes stays on screen with its
 * decision (and Undo) rather than dropping out of the list once the draft is saved (test-esp32 #28); and the decision a
 * person made before an agent changed the requirement, so the review shows what changed (test-esp32 #63).
 */
interface ReviewBefore { requirements: CheckInput['requirements']; decisions: DesignDecision[] }

/** The newest verify.report run that finished with its report.md, or null. */
export function releaseReportRun(db: DatabaseSync): { id: string } | null {
  if (!hasTable(db, 'runs') || !hasTable(db, 'artifacts')) return null
  const r = db.prepare("SELECT r.id FROM runs r JOIN artifacts a ON a.run_id = r.id AND a.name = 'report.md' WHERE r.kind = 'verify.report' AND r.status IN ('pass','fail') ORDER BY r.started DESC LIMIT 1").get() as { id: string } | undefined
  return r ? { id: String(r.id) } : null
}

async function inputFor(ctx: Context, repo: string, skill: string, draftOverride?: Record<string, unknown>, o: { question?: string | undefined } = {}): Promise<CheckInput & { draftRow: { step: number; saved: string } | null; facts: AgentFacts; pendingErrors: string[]; reviewBefore: ReviewBefore | null; releaseReport: { id: string } | null }> {
  const viewer: Viewer = await viewerOf(ctx.principal, repo)
  // drafts are the journey store's own (never copied into the repository), so they are read from it
  const row = await withJourneyDb(ctx, repo, (db) => getDraft(db, viewer.hash, skill))
  // the agents' questions and checks (src/core/agent-facts.ts), merged in as every view of the journey does
  const facts = await agentFacts(ctx, repo)
  // Schematic finish names every sheet's requirements: the schematic files of the default branch
  const sheetFiles = skill === 'schematic-finish' ? await kicadFiles(ctx, repo).then((f) => f.sch, () => null) : null
  // what the bench measured and who answered, as taken (the bench's live copy beside the facts: src/core/bench.ts)
  const bench = HARDWARE_SKILLS.has(skill) ? await liveBenchOf(ctx, repo) : { readings: [], ids: [] }
  // Order submit: the quotes agents recorded from people's words, beside the person's own (src/core/quotes.ts)
  const agentQuoted = skill === 'order-submit' ? await agentFactsStore(ctx, repo).read((db) => loadAgentQuotes(db)).then((x) => x.result, () => [] as QuoteRow[]) : []
  const input: Awaited<ReturnType<typeof inputFor>> = await withRecordDb(ctx, repo, (db) => {
    const own = loadJourney(db)
    const r = own ? mergeAgentFacts(own, facts) : null
    const draft = draftOverride ?? (row?.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : null)
    // this skill's own pending decisions, laid over the record (this copy of it is thrown away after): the bar shows
    // what Submit would record. One a decision cannot be (it names nothing, or lacks its reason) is left out, and the
    // check it feeds stays not met
    const pendingErrors: string[] = []
    const reviewBefore = skill === 'requirements-review' ? { requirements: requirementEvidence(db, r), decisions: loadDesignDecisions(db) } : null
    for (const d of draft ? (() => { const x = designOf(db); return pendingDecisions(skill, draft, x.rows, x.decisions, { acceptRest: false }) })() : []) {
      try {
        const des = designOf(db)
        recordDesignDecision(db, prepare(d, des.rows, requirementTexts(db), des.decisions), { label: viewer.label, hash: viewer.hash })
      } catch (e) { pendingErrors.push(e instanceof Error ? e.message : String(e)) }
    }
    // a review is not submitted over an open question about what it agrees: it names the one to answer first
    const asked = questionsFirst(skill, questionsOn(skill, r, designOf(db).rows))
    if (asked) pendingErrors.push(asked)
    const live = requirementEvidence(db, r)
    const struck = struckRequirements(db)
    const erc = checkFindings(db, 'erc', r)
    const drc = checkFindings(db, 'drc', r)
    const bomRun = latestRun(db, 'kicad.bom')
    const boardRun = latestRun(db, 'kicad.board')
    const placement = latestRun(db, 'pcb.placement_check')
    // the newest build that finished with a fit (an errored or running one has no result to read)
    const caseRow = hasTable(db, 'runs') ? db.prepare("SELECT id, status, summary FROM runs WHERE kind='mech.build' AND status IN ('pass','fail') ORDER BY started DESC LIMIT 1").get() as { id: string; status: string; summary: string | null } | undefined : undefined
    const caseRun = caseRow ? { id: String(caseRow.id), status: String(caseRow.status), summary: caseRow.summary === null ? null : String(caseRow.summary) } : null
    // the case designs that could work (mech.options), for the process step
    const optRow = hasTable(db, 'runs') ? db.prepare("SELECT id FROM runs WHERE kind='mech.options' AND status IN ('pass','fail') ORDER BY started DESC LIMIT 1").get() as { id: string } | undefined : undefined
    const optJson = optRow ? artifactJson(db, String(optRow.id), 'options.json') as CaseOptions | null : null
    let instruments: CheckInput['instruments'] = []
    try {
      const v = hasTable(db, 'settings') ? db.prepare("SELECT value FROM settings WHERE key='hil.instruments'").get() as { value?: string } | undefined : undefined
      const parsed: unknown = v?.value ? JSON.parse(v.value) : []
      if (Array.isArray(parsed)) instruments = parsed as CheckInput['instruments']
    } catch { /* unreadable settings: no instruments */ }
    const tests = hasTable(db, 'test_items') ? (db.prepare('SELECT id, method, status FROM test_items').all() as Record<string, unknown>[]).map((t) => ({ id: String(t.id), method: String(t.method), status: String(t.status) })) : []
    // an agent's question first: a stuck report is dismissed with a reason (stuck.dismiss), it has nothing to choose
    const open = r?.questions.filter((q) => q.answeredAt === null && questionIsFor(q, viewer)) ?? []
    // the question asked for (an "Answer it" link names it: test-esp32 #107, where both links opened the oldest), else
    // the one the draft was written for, else the oldest; one asked for that is not open for this person falls through
    const want = o.question ?? (typeof draft?.question === 'string' ? draft.question : undefined)
    const question = (want ? open.find((q) => q.id === want) : undefined) ?? open.find((q) => q.kind !== 'stuck') ?? open[0] ?? null
    const fab = latestRun(db, 'kicad.fab')
    const fabResult = fab ? runResult(db, fab.id) : null
    const handPlaced = Array.isArray(fabResult?.hand_placed) ? (fabResult.hand_placed as unknown[]).filter((x): x is string => typeof x === 'string') : null
    // Release review: what its steps show (release-review.ts)
    const release: ReleaseRecord | null = skill === 'release-review' ? (() => {
      const pre = latestRun(db, 'emc.precheck')
      const findings = pre ? artifactJson(db, pre.id, 'findings.json') : null
      const parts = latestRun(db, 'parts.bom_check')
      return {
        precheck: pre ? { id: pre.id, status: pre.status, summary: pre.summary, started: pre.started, findings: Array.isArray(findings) ? findings : null } : null,
        estimates: ['emc.run', 'emc.si'].flatMap((k) => { const x = latestRun(db, k); return x ? [{ id: x.id, kind: k, status: x.status, summary: x.summary, started: x.started }] : [] }),
        parts: parts ? { id: parts.id, status: parts.status, summary: parts.summary, started: parts.started, result: runResult(db, parts.id) } : null,
        drcRun: drc.run ? { id: drc.run.id, started: drc.run.started } : null,
      }
    })() : null
    // Order submit: what its steps show (order-submit.ts)
    const order: OrderRecord | null = skill === 'order-submit' ? (() => {
      const runRow = (x: { id: string; status: string; summary: string | null; started: number } | null): RunRow | null => (x ? { id: x.id, status: x.status, summary: x.summary, started: x.started, result: runResult(db, x.id) } : null)
      const parts = latestRun(db, 'parts.bom_check')
      // the parts check the release was approved on: the newest at or before the release approval's signature
      const signedAt = releaseSignedAt(r)
      const before = signedAt !== null && hasTable(db, 'runs') ? db.prepare("SELECT id, status, summary, started FROM runs WHERE kind='parts.bom_check' AND started <= ? ORDER BY started DESC LIMIT 1").get(signedAt) as { id: string; status: string; summary: string | null; started: number } | undefined : undefined
      const args = fab && hasTable(db, 'runs') ? (() => { try { return JSON.parse(String((db.prepare('SELECT args FROM runs WHERE id=?').get(fab.id) as { args?: unknown } | undefined)?.args ?? '{}')) as Record<string, unknown> } catch { return {} } })() : {}
      return {
        parts: runRow(parts),
        signedParts: before ? runRow({ id: String(before.id), status: String(before.status), summary: before.summary === null ? null : String(before.summary), started: Number(before.started) }) : null,
        fab: fab ? { ...runRow(fab)!, result: fabResult, outDir: typeof args.out_dir === 'string' ? args.out_dir : null, bomCsv: artifactText(db, fab.id, 'bom.csv') } : null,
        board: boardRun ? { id: boardRun.id, result: runResult(db, boardRun.id) } : null,
      }
    })() : null
    return {
      boards: loadBoards(db), handPlaced, release, order, ids: unionIds(idsFromRuns(db), bench.ids), readings: unionReadings(loadReadings(db), bench.readings),
      r, viewer, requirements: live, struck,
      erc: erc.findings ? { findings: erc.findings, errors: erc.report.errors } : null,
      drc: drc.findings ? { findings: drc.findings, errors: drc.report.errors } : null,
      bom: bomRun ? runResult(db, bomRun.id) : null, board: boardRun ? runResult(db, boardRun.id) : null,
      placement: placement ? { status: placement.status, summary: placement.summary } : null,
      caseBuild: caseRun ? { id: caseRun.id, status: caseRun.status, summary: caseRun.summary, result: runResult(db, caseRun.id) } : null,
      caseOptions: optRow && optJson ? { id: String(optRow.id), options: optJson } : null,
      instruments, tests, orders: r ? loadOrders(db) : [], quotes: skill === 'order-submit' ? allQuotes(loadQuotes(db), agentQuoted) : [], draft, gate: currentGate(r), question,
      design: designOf(db), nets: latestNetlist(db)?.nets ?? null, sheetFiles, ...(skill === 'architecture-choice' ? { stockLines: stockLines(db) } : {}),
      draftRow: row ? { step: row.step, saved: row.saved } : null, facts, pendingErrors, reviewBefore,
      // the release report Release review approves: the newest verify.report run that finished
      releaseReport: skill === 'release-review' ? releaseReportRun(db) : null,
    }
  })
  // Case design's fit: the build's recorded inputs against the default branch's files now
  if (skill === 'case-design' && input.caseBuild?.result) input.caseStale = await caseStaleness(ctx, repo, input.caseBuild.result.inputs)
  // Change request: what each cited run was made from, so the impact leaves out what the change cannot touch
  if (skill === 'change-request' && input.r) input.evidenceFiles = await evidenceFiles(ctx, repo, input.r)
  return input
}

/** The files each run the journey cites as evidence was made from (lineage); null when the run record cannot be read. */
async function evidenceFiles(ctx: Context, repo: string, r: JourneyRecord): Promise<Map<string, string[]> | null> {
  const runs = [...new Set(r.criteria.flatMap((c) => c.evidence.filter((e) => e.kind === 'run').map((e) => e.ref)))]
  if (!runs.length) return null
  try {
    return await withProjectDb(ctx, repo, (path) => {
      const db = openProjectDb(path)
      try { return new Map(runs.map((id) => [id, filesRead(db, [id])])) } finally { db.close() }
    })
  } catch {
    return null
  }
}


/** Each requirement's words and acceptance as the record has them: a decision on one keeps what it was made on. */
const requirementTexts = (db: import('node:sqlite').DatabaseSync): Map<string, RequirementWords> => new Map(hasTable(db, 'requirements') ? (db.prepare('SELECT id, text, acceptance FROM requirements').all() as { id: string; text: string; acceptance: string | null }[]).map((x) => [String(x.id), { text: String(x.text), acceptance: x.acceptance === null ? null : String(x.acceptance) }]) : [])
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A number followed by its unit (2 layers, 5.1 kΩ, ±10 %, 40 °C, 0.5 Hz). */
const NUMBER_WITH_UNIT = /\d[\d.,]*\s?(%|°\s?[CF]|[A-Za-zµΩ])/
/**
 * The requirements baseline gate's criteria a person moves, as Requirements review leaves the record: every
 * requirement accepted (struck ones are already out of the list), and every accepted one with a number and a unit in
 * its criterion. The firmware ones are accepted with the rest. Pure.
 */
export function baselineCriteria(requirements: readonly { status: string; acceptance?: string | null }[]): [string, boolean][] {
  const accepted = requirements.length > 0 && requirements.every((q) => q.status === 'accepted')
  const measurable = accepted && requirements.every((q) => NUMBER_WITH_UNIT.test(q.acceptance ?? ''))
  return [['define.accepted', accepted], ['define.measurable', measurable], ['define.firmware', accepted]]
}

/**
 * The design decisions a submission recorded, counted in words ("2 requirements accepted, 1 struck, 1 intent line
 * left out"), or undefined when it recorded none. Pure.
 */
export function recordedWords(decisions: readonly { kind: string; choice: string }[]): string | undefined {
  const n = (kind: string, choice?: string): number => decisions.filter((d) => d.kind === kind && (choice === undefined || d.choice === choice)).length
  const count = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`
  const words = [
    n('requirement', 'accepted') ? `${count(n('requirement', 'accepted'), 'requirement')} accepted` : '',
    n('requirement', 'struck') ? `${count(n('requirement', 'struck'), 'requirement')} struck` : '',
    n('intent.uncovered') ? `${count(n('intent.uncovered'), 'intent line')} left out` : '',
    n('intent') ? `${count(n('intent'), 'intent statement')} decided` : '',
    n('architecture.choice') ? 'the architecture chosen' : '',
    n('pins.agreed') ? `${count(n('pins.agreed'), "part's pin plan", "parts' pin plans")} agreed` : '',
  ].filter(Boolean)
  return words.length ? words.join(', ') : undefined
}

/** A gate criterion a submission set, as Submit's answer says it (`criteria`): not met with why and the step to fix it. */
export interface CriterionSet { id: string; text: string; status: 'met' | 'not_met'; why?: string; step?: string }

/**
 * Why each of the requirements baseline gate's criteria Requirements review sets is not met, naming the requirements
 * and what to do (test-esp32 #89: the review was submitted, the gate still said "Every requirement is accepted or
 * struck: not met" and nothing said which one). `asked`: the requirement ids an open question names, which the bar
 * lets through undecided. Pure.
 */
export function baselineWhy(requirements: readonly { id: string; status: string; acceptance?: string | null }[], asked: (id: string) => boolean): Record<string, { why: string; step: string }> {
  if (!requirements.length) return Object.fromEntries(['define.accepted', 'define.measurable', 'define.firmware'].map((id) => [id, { why: 'No requirements are recorded yet.', step: 'source' }]))
  const open = requirements.filter((q) => q.status !== 'accepted')
  const waiting = open.filter((q) => asked(q.id))
  const undecided = open.filter((q) => !asked(q.id))
  const names = (xs: readonly { id: string }[]): string => xs.map((q) => q.id).join(', ')
  const parts = [
    waiting.length ? `${names(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} on an open question: answer it, then accept or strike ${waiting.length === 1 ? 'it' : 'them'} here` : '',
    undecided.length ? `${names(undecided)} ${undecided.length === 1 ? 'is' : 'are'} not accepted or struck yet: decide ${undecided.length === 1 ? 'it' : 'each'} in Decide` : '',
  ].filter(Boolean)
  const out: Record<string, { why: string; step: string }> = {}
  if (open.length) {
    const why = `${parts.join('; ')}.`
    out['define.accepted'] = { why, step: 'decide' }
    out['define.firmware'] = { why, step: 'decide' }
    out['define.measurable'] = { why: 'It is checked once every requirement is accepted or struck.', step: 'decide' }
  } else {
    const vague = requirements.filter((q) => !NUMBER_WITH_UNIT.test(q.acceptance ?? ''))
    if (vague.length) out['define.measurable'] = { why: `${names(vague)} ${vague.length === 1 ? 'has' : 'have'} no number with a unit in ${vague.length === 1 ? 'its' : 'their'} acceptance criterion: give one in Make it testable.`, step: 'testable' }
  }
  return out
}

/**
 * What the requirements baseline gate's criteria were checked on, as their evidence (test-esp32 #32: the evidence said
 * only that it was checked against the record): the review that was submitted and its counts, then each requirement
 * with its decision and its acceptance criterion, and each one struck with why. Pure.
 */
export function baselineEvidence(requirements: readonly { id: string; text: string; status: string; acceptance?: string | null }[], struck: readonly { id: string; reason: string | null }[], by: string): Evidence[] {
  const accepted = requirements.filter((q) => q.status === 'accepted').length
  const head = `Requirements review, submitted by ${by}: ${accepted} of ${requirements.length} accepted${requirements.length > accepted ? `, ${requirements.length - accepted} not decided` : ''}, ${struck.length} struck`
  return [
    { kind: 'skill', ref: 'requirements-review', label: head },
    ...requirements.map((q) => ({
      kind: 'requirement', ref: q.id,
      label: `${q.id} ${q.status}${q.acceptance ? `, measured by "${q.acceptance}"` : ', with no acceptance criterion'}: ${q.text}`.slice(0, 300),
    })),
    ...struck.map((q) => ({ kind: 'requirement', ref: q.id, label: `${q.id} struck${q.reason ? `: ${q.reason}` : ''}`.slice(0, 300) })),
  ]
}

/** The job Intent builder's Submit starts (src/api/drafting.ts, where requirements.draft starts it again too). */
export { REQUIREMENTS_FROM_INTENT }

/**
 * The design decisions a skill's draft makes, which Submit records (design.decide's shapes):
 *   intent-builder       draft.proposed [{ id, topic, kind?, text, interface?, owner?, decide_by? }]: the statements
 *                        trace's chat noted in the draft from the person's answers. Submit records each in the words
 *                        that stand (stated; the person's edit folded in, a rejected one left out); the preview lays
 *                        them over the record as proposed (drafted), with the person's decisions on them.
 *                        draft.decisions [{ statement, choice: accept | edit | reject, text?, reason? }]; every
 *                        proposed statement not named there is accepted as worded (Submit intent accepts the draft;
 *                        the bar's preview, acceptRest false, leaves them proposed)
 *   requirements-review  draft.decisions [{ requirement, choice: accept | strike, reason? }], draft.uncovered
 *                        [{ statement, reason }]
 *   architecture-choice  draft.choice { option, reason } with draft.deciding [criterion ids], draft.scores?,
 *                        draft.only_one?. The criteria are not part of Submit: they are fixed (design.decide) at the
 *                        first step, before any score is read, which is what "criteria fixed before scoring" checks
 *   pin-plan-review      every part in the plan, or draft.parts [part]: agreed as it stands
 * Entries that are not decisions are left out (the bar then says what is missing).
 */
export function pendingDecisions(skill: string, draft: Record<string, unknown>, rows: DesignRows, decided: readonly import('../tools/design/decisions.js').DesignDecision[] = [], o: { acceptRest?: boolean } = {}): PendingDecision[] {
  const parse = (x: unknown): PendingDecision[] => { const r = Decision.safeParse(x); return r.success ? [r.data] : [] }
  switch (skill) {
    case 'intent-builder': {
      const named = list(draft.decisions).flatMap((d) => parse({ kind: 'intent', ...(d as object) }))
      const proposed = draftedStatements(draft, rows)
      const mine = new Set(proposed.map((x) => x.statement))
      // Submit accepts every statement left undecided; the bar's preview does not, so the draft panel shows a
      // statement Accepted only once the person accepts it. The statements noted in the draft come first, so the
      // person's decisions on them have them to decide on
      if (o.acceptRest === false) return [...proposed.map((x) => ({ ...x, draft: true })), ...named]
      const decision = (id: string) => named.find((d) => d.kind === 'intent' && d.statement === id) as Extract<PendingDecision, { kind: 'intent' }> | undefined
      // each statement noted in the draft is recorded in the words that stand: the person's edit folded in, a
      // rejected one left out (it was never in the record)
      const stated = proposed.flatMap((x): StatedInput[] => {
        const d = decision(x.statement)
        if (d?.choice === 'reject') return []
        const text = d?.choice === 'edit' && d.text ? d.text : x.text
        const iface = x.topic === 'interfaces' && x.statement_kind === 'statement' && d && (d.choice === 'edit' || d.interface) ? decidedFields(x.interface ?? null, d.choice === 'edit' ? text : null, d.interface) : x.interface
        return [{ ...x, text, ...(iface ? { interface: iface } : {}) }]
      })
      const inDraft = new Set(named.map((d) => (d.kind === 'intent' ? d.statement : '')))
      const rest = intentView(rows, decided).filter((x) => x.state === 'proposed' && !inDraft.has(x.id) && !mine.has(x.id)).map((x) => ({ kind: 'intent' as const, statement: x.id, choice: 'accept' as const }))
      return [...stated, ...named.filter((d) => !(d.kind === 'intent' && mine.has(d.statement))), ...rest]
    }
    case 'requirements-review':
      return [...list(draft.decisions).flatMap((d) => parse({ kind: 'requirement', ...(d as object) })), ...list(draft.uncovered).flatMap((d) => parse({ kind: 'uncovered', ...(d as object) }))]
    case 'architecture-choice': {
      const c = draft.choice as { option?: unknown; reason?: unknown } | undefined
      if (!c || typeof c.option !== 'string') return []
      // taking trace's recommendation asks for no reason in the decision card: its own why is the reason, unless
      // another option scores higher (test-esp32 #96), when the person's own reason is asked for
      const a = architectureView(rows, decided)
      const scores = Array.isArray(draft.scores) ? (draft.scores as unknown[]).filter((s): s is { option: string; criterion: string; score: number } => !!s && typeof s === 'object' && typeof (s as { score?: unknown }).score === 'number') : []
      const rec = outscoredBy(a, c.option, scores) ? undefined : a.options.find((o) => o.recommended && o.id === c.option)
      const reason = typeof c.reason === 'string' && c.reason.trim() ? c.reason
        : typeof draft.why === 'string' && draft.why.trim() ? draft.why
        : rec ? `Took trace's recommendation${rec.why ? `: ${rec.why}` : '.'}`.slice(0, 2000) : ''
      const out = parse({ kind: 'architecture', option: c.option, reason: reason || 'none given', deciding: list(draft.deciding), ...(draft.scores ? { scores: draft.scores } : {}), ...(typeof draft.only_one === 'string' ? { only_one: draft.only_one } : {}) })
      // no reason at all is still the decision, so recording it says which reason is missing (design.decide's words)
      return out.map((d) => (d.kind === 'architecture' && !reason ? { ...d, reason: '' } : d))
    }
    case 'pin-plan-review': {
      const parts = list(draft.parts).filter((x): x is string => typeof x === 'string')
      return (parts.length ? parts : [...new Set(rows.pins.filter((p) => p.status !== 'withdrawn').map((p) => p.part))]).map((part) => ({ kind: 'pins' as const, part }))
    }
    default: return []
  }
}

/**
 * The statements noted in an Intent builder draft (draft.proposed, written by its chat's note_intent tool), as the
 * person's own: each with a well-formed id that no agent's row has. One that does not parse is left out. Pure.
 */
export function draftedStatements(draft: Record<string, unknown>, rows: Pick<DesignRows, 'intent'>): StatedInput[] {
  const agents = new Set(rows.intent.map((x) => x.id))
  const seen = new Set<string>()
  return list(draft.proposed).flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const { id, kind, ...rest } = x as Record<string, unknown>
    const r = Stated.safeParse({ ...rest, kind: 'stated', statement: id, ...(kind !== undefined ? { statement_kind: kind } : {}) })
    if (!r.success || agents.has(r.data.statement) || seen.has(r.data.statement)) return []
    seen.add(r.data.statement)
    return [r.data]
  })
}

const finding = (f: NonNullable<CheckInput['erc']>['findings'][number]) => ({
  id: f.id, severity: f.severity, text: f.text, where: f.ref ?? f.where, sheet: f.where, ...(f.x_mm !== null ? { x_mm: f.x_mm, y_mm: f.y_mm } : {}),
  source: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` },
})

/**
 * What choosing an option that waives records, in words, so the person knows before choosing it (test-esp32 #142):
 * "Records a waiver in your name: 3 findings, rated cosmetic. Risk: …"
 */
export function optionWaiverWords(w: OptionWaiver): string {
  const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`
  const kinds = [...new Set(w.targets.map((t) => t.kind))]
  const what = kinds.map((k) => plural(w.targets.filter((t) => t.kind === k).length, k)).join(' and ')
  const caught = w.caught_where?.trim() ? ` Checked instead: ${w.caught_where.trim()}.` : ''
  return `Records a waiver in your name: ${what}, rated ${w.severity}, ${w.scope}. Risk: ${w.risk.replace(/\.$/, '')}.${caught}`
}

/** The options another one outscores, each with why choosing it asks for a reason; empty when none does. */
function reasonNeeded(a: ReturnType<typeof architectureView>): { reasonNeeded?: Record<string, string> } {
  const m = Object.fromEntries(a.options.flatMap((o) => { const h = outscoredBy(a, o.id); return h ? [[o.id, outscoredWords(h)]] : [] }))
  return Object.keys(m).length ? { reasonNeeded: m } : {}
}

/** What a skill's screen reads beyond the bar. */
/**
 * What changed in a requirement since a person last decided it: its words and its acceptance criterion as the
 * decision was made on them (the decision keeps both: actions-design.ts), against the row now. Nothing when the
 * decision kept neither, or both are as they were. Pure.
 */
export function changedSince(d: DesignDecision | undefined, now: RequirementWords): { choice: 'accepted' | 'struck'; by: string; at: string; changes: { field: 'words' | 'criterion'; before: string | null; after: string | null }[] } | null {
  if (!d || typeof d.detail.text !== 'string') return null
  const changes: { field: 'words' | 'criterion'; before: string | null; after: string | null }[] = []
  if (d.detail.text !== now.text) changes.push({ field: 'words', before: d.detail.text, after: now.text })
  if ('acceptance' in d.detail) {
    const was = typeof d.detail.acceptance === 'string' ? d.detail.acceptance : null
    if (was !== now.acceptance) changes.push({ field: 'criterion', before: was, after: now.acceptance })
  }
  return changes.length ? { choice: d.choice === 'struck' ? 'struck' : 'accepted', by: d.by, at: new Date(d.at * 1000).toISOString(), changes } : null
}

function extras(skill: string, i: CheckInput & { reviewBefore?: ReviewBefore | null }): Record<string, unknown> {
  switch (skill) {
    case 'question-answer': {
      const q = i.question
      if (!q) return {}
      const rec = q.options.find((o) => o.recommended)
      // what it asks about has moved on since (test-esp32 #108): the page says so above the question
      const stale = i.r ? outOfDate(q, i.r) : null
      return {
        question: {
          ...(stale ? { outOfDate: stale } : {}),
          id: q.id, to: q.askedOf || q.askedOfSub ? 'you' : q.askedPart === 'admins' ? 'the admins' : 'the contributors', text: q.text, askedAt: new Date(q.askedAt * 1000).toISOString(), ...(q.blocks ? { blocks: q.blocks } : {}),
          ...(rec ? { recommended: { id: rec.id, label: rec.label } } : {}), options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.why ? { detail: o.why } : {}), ...(o.waives ? { waiver: optionWaiverWords(o.waives) } : {}), ...(o.needs ? { needs: o.needs } : {}) })),
          sources: q.sources.map((s) => ({ kind: s.kind === 'run' ? 'run' : 'record', label: s.label ?? s.ref, id: s.ref })), context: `Asked by ${q.askedBy}.`,
        },
      }
    }
    case 'waiver': {
      const r = i.r
      const criteria = (r?.criteria ?? []).filter((c) => c.status !== 'met' && r?.gates.find((g) => g.id === c.gate)?.stage === r?.journey.currentStage && !r?.waivers.some((w) => w.target === c.id && w.closedAt === null))
      return {
        waivable: [
          ...criteria.map((c) => ({ id: `criterion:${c.id}`, kind: 'requirement' as const, title: c.text, why: 'A gate criterion of the current stage that is not met.' })),
          ...i.requirements.filter((q) => q.evidence === 'failing' || q.evidence === 'untested').map((q) => ({ id: `requirement:${q.id}`, kind: 'requirement' as const, title: `${q.id}: ${q.text}`, why: q.why })),
          ...[...(i.erc?.findings ?? []), ...(i.drc?.findings ?? [])].filter((f) => f.severity !== 'waived').map((f) => ({ id: `finding:${f.id}`, kind: 'finding' as const, title: f.text, evidence: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` } })),
          // what a criterion's shape found (shape.check), each waivable on its own: the run that found it is its evidence
          ...criteria.flatMap((c) => {
            const run = c.evidence.find((e) => e.kind === 'run')
            const waived = new Set((r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
            return c.evidence.filter((e) => e.kind === 'finding' && !waived.has(e.ref)).map((e) => ({
              id: `finding:${e.ref}`, kind: 'finding' as const, title: e.label ?? e.ref, why: `What trace found for: ${c.text}`,
              ...(run ? { evidence: { kind: 'run' as const, id: run.ref, label: `run ${run.ref.slice(0, 8)}` } } : {}),
            }))
          }),
        ],
      }
    }
    case 'intent-builder': return i.design ? { intent: intentDraft(intentView(i.design.rows, i.design.decisions)) } : {}
    case 'requirements-review': {
      if (!i.design) return {}
      const v = intentView(i.design.rows, i.design.decisions)
      const links = linksView(i.design.rows)
      return {
        items: [
          // the rows the record has not accepted, the draft's decisions on them shown beside each on screen; with each
          // its acceptance criterion and, for one an agent changed after a person decided it, what changed
          ...(i.reviewBefore?.requirements ?? i.requirements).filter((q) => q.status !== 'accepted').map((q) => {
            const was = changedSince(i.reviewBefore ? standing(i.reviewBefore.decisions, 'requirement').get(q.id) : undefined, q)
            return { id: `requirement:${q.id}`, title: `${q.id}: ${q.text}`, detail: `From ${links.filter((l) => l.requirement === q.id).map((l) => v.find((x) => x.id === l.intent)?.words ?? l.intent).join('; ') || q.source || 'no source given'}.`, status: 'open' as const, criterion: q.acceptance, ...(was ? { was } : {}) }
          }),
          // as the record has it, so a line the draft leaves out stays listed with its reason (and Undo)
          ...(i.reviewBefore ? intentView(i.design.rows, i.reviewBefore.decisions) : v).filter((x) => x.state !== 'rejected' && x.kind === 'statement' && x.uncovered === null && !links.some((l) => l.intent === x.id)).map((x) => ({ id: `intent:${x.id}`, title: `Not covered: ${x.words}`, detail: 'No requirement is derived from this intent line: add one, or leave it out with a reason.', status: 'open' as const })),
        ],
      }
    }
    case 'architecture-choice': {
      if (!i.design) return {}
      const a = architectureView(i.design.rows, i.design.decisions)
      const rec = a.options.find((o) => o.recommended)
      // the key parts of the option going ahead (chosen, else recommended), with stock, price and exception
      const current = a.options.find((o) => o.id === a.current)
      return {
        architecture: a,
        ...(current ? { key_parts: keyPartsView(current, i.stockLines ?? [], i.r?.journey.build.quantity ?? null, i.r?.waivers ?? []) } : {}),
        ...(a.options.length ? {
          recommendation: {
            question: 'Which architecture goes forward?', recommended: rec?.id ?? a.options[0]?.id ?? '',
            options: a.options.map((o) => ({ id: o.id, label: `Option ${o.id}: ${o.name}`, detail: `${o.summary}${a.criteria.length ? ` Weighted score ${o.total}.` : ''}` })),
            ...(rec?.why ? { why: rec.why } : {}), ...(rec?.gives_up ? { givesUp: rec.gives_up } : {}),
            // the options another outscores, the recommendation among them: choosing one asks for the person's reason
            ...reasonNeeded(a),
          },
        } : {}),
      }
    }
    case 'pin-plan-review': {
      if (!i.design) return {}
      const waived = new Set((i.r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
      // an open question about a pin comes first, with Answer it: the plan is agreed on its answer, and Submit is refused
      // until then (questionsFirst; test-esp32 #106)
      const design = i.design.rows
      const asked = questionsOn('pin-plan-review', i.r, design).map((q) => {
        const parts = questionParts(q, design)
        return {
          id: `question:${q.id}`, title: `${parts.length ? `Open question about ${parts.join(', ')}` : 'Open question'}: ${q.text}`, status: 'open' as const, label: 'Unanswered', question: q.id,
          detail: `${q.askedBy} asks. Answer it before agreeing the plan${q.blocks ? `; it holds back ${q.blocks.replace(/\.$/, '')}` : ''}.`,
        }
      })
      return { items: [...asked, ...pinCheck(design.pins, i.nets ?? null, matedParts(architectureView(design, i.design.decisions))).map((f) => ({ id: `finding:${f.id}`, title: f.text, detail: f.severity === 'blocks' ? 'Fix it in the plan or the schematic, or waive it.' : 'Fix or waive.', status: waived.has(f.id) ? 'waived' as const : 'open' as const }))] }
    }
    case 'schematic-finish': return { findings: (i.erc?.findings ?? []).map(finding) }
    case 'board-setup': case 'placement-adjust': return { findings: (i.drc?.findings ?? []).map(finding) }
    case 'case-design': {
      const b = i.caseBuild
      const x = b?.result
      // the designs that could work, recommended first (mech.options), and each one not offered with the rule's words
      const o = i.caseOptions
      const offered = o ? o.options.options.filter((c) => c.feasible) : []
      const rec = offered.find((c) => c.recommended)
      return {
        ...(b && x ? { case: { run: b.id, status: b.status, summary: b.summary, process: x.process ?? null, fit: x.fit_status ?? null, problems: x.problems ?? [], rules_failing: x.rules_failing ?? [], files: x.files ?? [], case: x.case ?? null } } : {}),
        ...(o && rec ? {
          recommendation: {
            question: 'Which case should trace build?', recommended: rec.key,
            options: offered.slice(0, 6).map((c) => ({ id: c.key, label: c.label, detail: [...(c.why ?? []), ...(c.gives_up ? [`Gives up: ${c.gives_up}`] : [])].join('. ') })),
            why: (rec.why ?? []).join('; '), ...(rec.gives_up ? { givesUp: rec.gives_up } : {}),
            evidence: [{ kind: 'run' as const, id: o.id, label: 'the case options' }],
          },
          items: o.options.not_offered.map((n) => ({ id: `not-offered:${n.template}/${n.process}`, title: n.label, detail: n.why, status: 'waived' as const, label: 'Not offered' })),
        } : {}),
      }
    }
    case 'change-request': {
      const impact = changeImpact(i.r, i.draft?.what, i.evidenceFiles)
      return impact ? { impact } : {}
    }
    case 'gate-signing': return i.gate ? { gate: i.gate } : {}
    case 'release-review': {
      const v = releaseView(i.r, i.release ?? null, { drc: i.drc, board: i.board, handPlaced: i.handPlaced ?? null })
      const rec = releaseRecommendation(i.r, v, i.requirements)
      return { release: v, ...(rec ? { recommendation: rec } : {}) }
    }
    case 'order-submit': return { order: orderView(i.r, i.order ?? null, i.orders, Date.now() / 1000, i.quotes ?? []) }
    case 'incoming-inspection': return { boards: (i.boards ?? []).map((b) => boardView(b, i.orders, i.readings ?? [])), ...(i.handPlaced ? { handPlaced: i.handPlaced } : {}) }
    case 'bench-setup': case 'bring-up-run': return { bench: skillBench(skill, i) }
    default: return {}
  }
}

/** The bar in words: "4 of 6 met; 2 need the record to hold more first." */
function summaryOf(checks: CheckResult[]): string {
  // a check not due yet is in neither count (#227)
  const due = checks.filter((c) => c.status !== 'not_due')
  const ok = due.filter((c) => c.status !== 'not_met').length
  const missing = checks.filter((c) => c.unavailable).length
  return `${ok} of ${due.length} checks met${missing ? `; ${missing} cannot be checked until the record holds more` : ''}.`
}

/** The target of a waiver draft's `what` ("criterion:capture.erc", "requirement:REQ-1", "finding:erc:…", or other). */
function waiverTarget(d: Record<string, unknown>): { kind: 'criterion' | 'requirement' | 'finding' | 'test'; id: string } {
  const what = String(d.what ?? '')
  const m = /^(criterion|requirement|finding|test):(.+)$/.exec(what)
  if (m) return { kind: m[1] as 'criterion', id: m[2] as string }
  const custom = String(d.custom ?? '').trim()
  if (!custom) throw new ActionError('Name what is waived.')
  return { kind: /^REQ-|^R-/i.test(custom) ? 'requirement' : /^TST-|^T-/i.test(custom) ? 'test' : 'finding', id: custom }
}

export const SKILL_ACTIONS = {
  'skill.get': def('read', Repo.extend({ skill: SkillId, question: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }), async (a, ctx) => {
    const sk = skillDef(a.skill)!
    const i = await inputFor(ctx, a.repo, a.skill, undefined, { question: a.question })
    const checks = checkSkill(a.skill, i) ?? []
    return {
      repo: a.repo, skill: sk.id, name: sk.name, stage: sk.stage,
      steps: sk.steps, step: i.draftRow?.step ?? 0,
      checks, met: checks.filter((c) => c.status !== 'not_met' && c.status !== 'not_due').length, total: checks.filter((c) => c.status !== 'not_due').length, summary: summaryOf(checks),
      ...(i.pendingErrors.length ? { pending_errors: i.pendingErrors } : {}),
      draft: i.draft, saved: i.draftRow?.saved ?? null,
      ...extras(a.skill, i),
    }
  }),

  'skill.draft': def('read', Repo.extend({ skill: SkillId, step: z.number().int().min(0).max(50).default(0), data: Data.nullable() }), async (a, ctx) => {
    const who = hashOf(ctx.principal)
    return plainly(() => writeJourney(ctx, a.repo, (db) => {
      if (!loadJourney(db)) throw new ActionError('This project has no journey yet, so there is nowhere to keep a draft.')
      const changed = putDraft(db, who, a.skill, a.data === null ? null : { step: a.step, data: a.data })
      return { result: { repo: a.repo, skill: a.skill, kept: a.data !== null, saved: a.data === null ? null : new Date().toISOString() }, changed }
    }))
  }),

  'skill.drafts': def('read', Repo, async (a, ctx) => {
    const who = hashOf(ctx.principal)
    const drafts = await withJourneyDb(ctx, a.repo, (db) => (db.prepare('SELECT skill, step, saved FROM skill_drafts WHERE who=? ORDER BY saved DESC').all(who) as Record<string, unknown>[])
      .map((x) => { const d = skillDef(String(x.skill)); return { skill: String(x.skill), name: d?.name ?? String(x.skill), step: Number(x.step), steps: d?.steps.length ?? 0, saved: new Date(Number(x.saved) * 1000).toISOString() } }))
    return { repo: a.repo, drafts }
  }),

  'skill.submit': def('write', Repo.extend({ skill: SkillId, draft: Data.default({}) }), async (a, ctx) => {
    const sk = skillDef(a.skill)!
    const i = await inputFor(ctx, a.repo, a.skill, a.draft)
    const checks = checkSkill(a.skill, i) ?? []
    // Release review returned to a stage: the return needs only its decision and note, not the bar a release needs
    const returning = a.skill === 'release-review' ? (() => { const d = decisionOf(a.draft); return d?.choice === 'return' ? d.stage : null })() : null
    const missing = checks.filter((c) => c.status === 'not_met' && (!returning || c.id === 'decision'))
    if (i.pendingErrors.length) throw new ActionError(`${sk.name} cannot be submitted yet: ${i.pendingErrors.join(' ')}`)
    if (missing.length) {
      const words = missing.map((c) => `${sk.checks.find((x) => x.id === c.id)?.text ?? c.id}${c.unavailable ? ` (cannot be checked yet: needs ${c.unavailable})` : c.detail ? ` (${c.detail})` : ''}`)
      throw new ActionError(`${sk.name} cannot be submitted yet. Not met: ${words.join('; ')}.`)
    }
    const by = { hash: hashOf(ctx.principal), label: label(ctx.principal) }
    let started: string[] = []
    let jobId: string | undefined
    let queued = false
    if (a.skill === 'change-request') {
      const d = a.draft
      const request = `Change request (${String(d.what)}): ${String(d.change)}\n\nWhy: ${String(d.why)}\nScope: ${d.revision === 'next' ? 'the next revision' : 'this revision'}, ${d.covers === 'firmware' ? 'firmware only' : 'hardware and firmware'}.\nRaise it for approval at a gate; change nothing before it is approved.`
      const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
      if (!r.accepted) throw new ActionError(r.reason ?? 'trace did not accept the change request.')
      jobId = r.jobId
      started = ['The agents raise the change request for approval.']
    }
    // the skills whose submission can land the last of a stage's design work (a person's criterion met, a question
    // answered that approves one, a criterion waived): the stage's documents are written then (docsAfterDesign)
    const before = DESIGN_SETTLING.has(a.skill) ? await designBefore(ctx, a.repo) : null
    const { rows: designRows, reqIds } = DESIGN_SKILLS.has(a.skill) ? await withRecordDb(ctx, a.repo, (db) => ({ rows: designOf(db).rows, reqIds: requirementTexts(db) })) : { rows: null as unknown as DesignRows, reqIds: new Map<string, RequirementWords>() }
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      let ref: string | null = null
      let answered: ReturnType<typeof answerQuestion> | null = null
      // the design decisions the skill makes (Intent builder, Requirements review, Architecture choice, Pin plan
      // review), recorded as design.decide would, each logged
      const changes: { stage: StageId; summary: string }[] = []
      // what Submit's answer says it recorded: each decision, and each gate criterion it set (met or not, and why)
      const recorded: { kind: string; choice: string }[] = []
      const set: CriterionSet[] = []
      const move = (id: string, ok: boolean, evidence: Evidence[], why?: { why: string; step: string }): void => {
        setCriterion(db, id, ok ? 'met' : 'not_met', evidence, by.label)
        const text = loadJourney(db)?.criteria.find((c) => c.id === id)?.text ?? id
        set.push({ id, text, status: ok ? 'met' : 'not_met', ...(ok || !why ? {} : why) })
      }
      for (const d of DESIGN_SKILLS.has(a.skill) ? pendingDecisions(a.skill, a.draft, designRows, loadDesignDecisions(db)) : []) {
        const prior = loadDesignDecisions(db)
        const p = prepare(d, designRows, reqIds, prior)
        const rec = recordDesignDecision(db, p, by)
        recorded.push({ kind: p.kind, choice: p.choice })
        decide(db, { kind: `design.${p.kind}`, stage: loadJourney(db)?.journey.currentStage ?? null, ref: p.target, by: by.label, summary: p.summary, detail: { decision: rec.id, skill: a.skill } })
        const stage = changesStage(p, prior)
        if (stage) changes.push({ stage, summary: p.summary.replace(/\.$/, '') })
      }
      // a requirement, the intent or the architecture changed after its stage was passed: the project goes back there
      // first, so what this skill meets below counts there (Requirements review and Architecture choice meet it again)
      // the earliest stage any of them changes; before release the project goes back there, after it the next
      // revision starts there (applyChange)
      const first = [...changes].sort((x, y) => STAGE_IDS.indexOf(x.stage) - STAGE_IDS.indexOf(y.stage))[0]
      const mine = changes.filter((c) => c.stage === first?.stage)
      const backTo = first ? applyChange(db, first.stage, changeReason(first.stage, mine.length === 1 ? first.summary : `${mine.length} decisions changed (${mine.slice(0, 3).map((c) => c.summary).join('; ')})`), by.label) : null
      // Requirements review is the person's act the baseline gate's own criteria wait for: submitted, it records
      // whether every requirement is accepted (or struck) and each accepted one measurable, as the record now stands
      if (a.skill === 'requirements-review') {
        const have = new Set((loadJourney(db)?.criteria ?? []).map((c) => c.id))
        const evidence = baselineEvidence(i.requirements, i.struck, by.label)
        const asked = (id: string): boolean => Boolean(i.r?.questions.some((q) => q.answeredAt === null && q.text.includes(id)))
        const why = baselineWhy(i.requirements, asked)
        for (const [id, ok] of baselineCriteria(i.requirements)) if (have.has(id)) move(id, ok, evidence, why[id])
      }
      // Architecture choice is the person's approval of the blocks and key parts the architecture gate waits for
      if (a.skill === 'architecture-choice' && (loadJourney(db)?.criteria ?? []).some((c) => c.id === 'architect.blocks')) {
        const chosen = architectureView(designRows, loadDesignDecisions(db)).chosen
        if (chosen) move('architect.blocks', true, [{ kind: 'skill', ref: 'architecture-choice', label: `Architecture choice: option ${chosen.option}, submitted by ${by.label}` }])
      }
      // Pin plan review is the person's agreement the schematic review waits for: it submits only when the plan
      // matches the schematic (its match check), so its submission meets capture.pins
      if (a.skill === 'pin-plan-review' && (loadJourney(db)?.criteria ?? []).some((c) => c.id === 'capture.pins')) {
        const parts = [...new Set((designRows?.pins ?? []).filter((x) => x.status !== 'withdrawn').map((x) => x.part))]
        move('capture.pins', true, [{ kind: 'skill', ref: 'pin-plan-review', label: `Pin plan review: ${parts.length ? parts.join(', ') : 'the plan'} agreed, submitted by ${by.label}` }])
      }
      // Release review is the person's review of the release report the release approval gate waits for: submitted,
      // it meets signoff.report, once the coverage, interference and parts list work it reviews is met or waived.
      // Without this the next step sent the person back to the same review after each submission (test-2, rev C).
      // with the agents' checks merged in, as every view does: coverage, interference and the parts list are trace's
      // criteria, met by its agents' journey.check facts, so the raw record alone always read them as unmet
      const own = loadJourney(db)
      const rec = own ? mergeAgentFacts(own, i.facts) : own
      // returned: the release gate is returned with the person's note, and the stage the concern belongs to reopened
      if (returning) {
        const gate = rec?.criteria.find((c) => c.id === 'signoff.report')?.gate ?? rec?.gates.find((g) => g.stage === rec.journey.currentStage)?.id
        if (!gate) throw new ActionError('There is no release gate in this stage to return.')
        returnGate(db, gate, { hash: by.hash, label: by.label }, { reason: noteOf(a.draft), reopen: returning })
      }
      if (a.skill === 'release-review' && !returning && rec?.criteria.some((c) => c.id === 'signoff.report')) {
        const waits = reviewWaitsOn(rec, 'signoff.report')
        if (waits.length) throw new ActionError(`The release report can't be approved yet: ${waits.map((c) => c.text.replace(/\.$/, '').toLowerCase()).join('; ')}. trace is still working on ${waits.length === 1 ? 'it' : 'them'}.`)
        // the report reviewed is the Verification agent's verify.report run (its report.md): no file of it is written
        // to the repository, so a file ref named one that is not there (test-esp32 #207)
        if (!i.releaseReport) throw new ActionError('There is no release report to approve yet: the Verification agent writes it (verify.report) once coverage, interference and the parts list are done.')
        move('signoff.report', true, [
          { kind: 'skill', ref: 'release-review', label: `Release review, submitted by ${by.label}` },
          { kind: 'run', ref: i.releaseReport.id, label: `the release report (report.md of run ${i.releaseReport.id.slice(0, 8)})` },
        ])
      }
      // Order submit before the order gate is signed: the order sheet matches the release (fabricate.order.sheet), so
      // the gate can be signed; the draft is kept, and after paying the same skill records the order
      let ordering = false
      if (a.skill === 'order-submit' && rec?.criteria.some((c) => c.id === 'fabricate.order.sheet') && !orderSigned(rec)) {
        const open = (id: string): boolean => { const c = rec.criteria.find((x) => x.id === id); return Boolean(c && c.status !== 'met' && !rec.waivers.some((w) => w.targetKind === 'criterion' && w.target === id && w.closedAt === null)) }
        const waits = ['fabricate.order.package', 'fabricate.order.stock'].filter(open)
        if (waits.length) throw new ActionError(`The order sheet can't be confirmed yet: ${waits.map((id) => rec.criteria.find((c) => c.id === id)!.text.replace(/\.$/, '').toLowerCase()).join('; ')}. trace is still working on ${waits.length === 1 ? 'it' : 'them'}.`)
        const off = matchedOf(a.draft).unplaced
        move('fabricate.order.sheet', true, [{ kind: 'skill', ref: 'order-submit', label: `Order submit: options entered and parts matched${off.length ? ` (JLCPCB does not place ${off.join(', ')})` : ''}, submitted by ${by.label}` }])
        ordering = true
      }
      if (a.skill === 'waiver') {
        const d = a.draft
        const sev = SEVERITIES.includes(d.severity as never) ? d.severity as (typeof SEVERITIES)[number] : (() => { throw new ActionError('Give the severity.') })()
        const caught = d.caught === 'nowhere' ? null : `${d.caught === 'bench' ? 'On the bench' : 'At a later stage'}: ${String(d.where ?? '').trim()}`
        // taken again from an earlier waiver (its "Take it again"): recording this one withdraws that one
        const replaces = typeof d.replaces === 'string' && d.replaces ? d.replaces : undefined
        const w = addWaiver(db, { target: waiverTarget(d), reason: String(d.reason), risk: String(d.risk), severity: sev, caught_where: caught, scope: d.scope === 'condition' ? `until ${String(d.condition).trim()}` : 'this revision only' }, { ...by, admin: isAdmin(ctx.principal) }, { facts: i.facts, replaces })
        ref = w.id
      } else if (a.skill === 'question-answer') {
        if (!i.question) throw new ActionError('There is no open question to answer.')
        const d = a.draft
        const opt = typeof d.option === 'string' && d.option !== 'other' ? d.option : undefined
        const text = opt ? undefined : [d.value ? String(d.value) : '', String(d.answer ?? '')].filter((x) => x.trim()).join(': ') + (d.source ? ` (source: ${String(d.source)})` : '')
        // what the person said it lasts as goes on the record, as question.answer records it: a rule's answer is then
        // found for the rules file (src/api/rule-answers.ts), a requirement change's backs the agent's edit of one
        const lasts = (['once', 'rule', 'requirement'] as const).find((x) => x === d.lasts)
        answered = answerQuestion(db, i.question.id, by, { option: opt, answer: text, reason: typeof d.reason === 'string' ? d.reason : undefined, lasts }, { facts: i.facts })
        ref = i.question.id
      }
      const id = decide(db, {
        kind: 'skill.submitted', stage: loadJourney(db)?.journey.currentStage ?? null, ref: ref ?? a.skill, by: by.label,
        summary: `${sk.name} was submitted with every check of its quality bar met or waived${jobId ? '; the agents raise the change' : ''}.`,
        detail: { skill: a.skill, checks: checks.map((c) => ({ id: c.id, status: c.status })), ...(jobId ? { job: jobId } : {}), ...(a.skill === 'release-review' ? { decision: returning ? `return:${returning}` : 'release', ...(noteOf(a.draft) ? { note: noteOf(a.draft) } : {}) } : {}), ...(a.skill === 'order-submit' ? { unplaced: matchedOf(a.draft).unplaced } : {}) },
      })
      // a criterion it set is still not met: the draft is kept, so the person carries on from it on the skill's page
      // (what was decided is recorded; deciding it again on the next Submit records it again, superseding)
      const partly = set.some((c) => c.status === 'not_met') || ordering
      if (!partly) putDraft(db, by.hash, a.skill, null)
      return { result: { id, ref, answered, backTo, recorded: recordedWords(recorded), criteria: set, kept: partly, ordering } }
    }))
    // saved: the wait from asked to answered, as question.answer records it (src/api/process-metrics.ts)
    if (out.answered) recordAnswered(a.repo, out.answered)
    // Question answer: an agent that asked and then ended is started again with the answer, as question.answer does
    let carried: { jobId?: string; started?: string[]; jobError?: string; summary?: string } = {}
    if (a.skill === 'question-answer' && i.question) {
      const asked = askedBy(i.facts, i.question.id)
      if (asked?.jobId) {
        const lasts = (['once', 'rule', 'requirement'] as const).find((x) => x === a.draft.lasts) as Lasts | undefined
        const row = await withJourneyDb(ctx, a.repo, (db) => loadJourney(db)?.questions.find((q) => q.id === asked.id) ?? null)
        const answered = row?.answeredAt != null ? { answer: row.answer ?? '', reason: row.answerReason ?? null, by: row.answeredBy ?? null } : null
        carried = await carryOn(ctx, a.repo, asked, { answered }, lasts).catch((e: unknown) => ({ jobError: e instanceof Error ? e.message : String(e) }))
        if (carried.jobId) { jobId = carried.jobId; started = [...started, ...(carried.started ?? [])] }
      }
    }
    // an answer made a rule for the project goes into .trace/rules.md, where every agent reads its rules (log #109)
    const rule = a.skill === 'question-answer' && i.question && a.draft.lasts === 'rule' ? await ruleFromAnswer(ctx, a.repo, i.question.id) : {}
    if (rule.started) started = [...started, ...rule.started]
    // Intent builder: the intent is now decided, so the Verification agent drafts the candidate requirements from it,
    // which open Requirements review (docs/user-journey.md, Intent builder: "What it produces"). Started after the
    // decisions are recorded, so the agent reads them; the submission stands even when the job cannot start
    let jobError: string | undefined
    if (a.skill === 'intent-builder') {
      try {
        const r = await draftRequirements(ctx, a.repo)
        // a project whose agent is still being set up: the drafting is queued and starts by itself (src/api/agent-queue.ts)
        if (r.accepted) {
          jobId = r.jobId
          queued = Boolean(r.queued)
          started = [queued ? QUEUED_DRAFTING : 'The Verification agent drafts the candidate requirements for Requirements review.']
        } else jobError = r.reason ?? 'trace did not accept the job.'
      } catch (e) { jobError = e instanceof Error ? e.message : String(e) }
    }
    if (carried.jobError) jobError = carried.jobError
    // an answer whose option waives recorded the waivers in this person's name: the summary says so
    const waived = out.answered ? waivedWords(out.answered) : ''
    const summary = carried.summary ? carried.summary.replace(/^Answered\./, `Answered.${waived}`) : waived ? `Answered.${waived} The agent carries on.` : undefined
    const docs = await docsAfterDesign(ctx, a.repo, before).catch(() => ({ started: undefined }))
    if (docs.started) started = [...started, docs.started]
    if (out.backTo) started = [...started, `${changeWords(out.backTo)}, to agree the change; every gate from there is signed again.`]
    if (out.ordering) started = [...started, 'The order sheet matches the release: the order gate can be signed. After paying on JLCPCB, record the order and submit Order submit again.']
    if (returning) started = [...started, returning === i.r?.journey.currentStage ? `The release gate was returned with your note; ${STAGE_NAMES[returning]} stays open.` : `The release gate was returned with your note, and ${STAGE_NAMES[returning]} is reopened; every gate from there is signed again.`]
    return { ok: true, repo: a.repo, skill: a.skill, id: out.id, ...(out.ref ? { ref: out.ref } : {}), ...(jobId ? { jobId } : {}), ...(queued ? { queued } : {}), ...(jobError ? { jobError } : {}), ...(summary ? { summary } : {}), ...(rule.rule ? { rule: rule.rule } : {}), ...(rule.rule_error ? { rule_error: rule.rule_error } : {}), started, ...(out.recorded ? { recorded: out.recorded } : {}), criteria: out.criteria, ...(out.kept ? { draft_kept: true } : {}), ...(out.backTo ? { back_to: out.backTo.stage, ...(out.backTo.revision ? { revision: out.backTo.revision } : {}) } : {}), version: out.version }
  }),
}

