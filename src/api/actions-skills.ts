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
 *                         logged for every skill, and the draft discarded
 */
import { z } from 'zod'
import {
  type AgentFacts, type JourneyRecord, SEVERITIES, type Viewer, addWaiver, answerQuestion, decide, getDraft, loadJourney, loadOrders, mergeAgentFacts, putDraft,
  questionIsFor,
} from '../core/journey.js'
import { SKILL_IDS, skillDef } from '../core/skills.js'
import { ActionError, type Context, Repo, agentFacts, def, hashOf, label, plainly, storeAt, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { viewerOf } from './actions-journey.js'
import { loadDesignDecisions, recordDesignDecision } from '../tools/design/decisions.js'
import type { DesignRows } from '../tools/design/db.js'
import { architectureView, intentDraft, intentView, linksView, pinCheck } from '../tools/design/record.js'
import { type DecisionInput, Decision, prepare } from './actions-design.js'
import { kicadFiles } from './actions-record.js'
import { checkFindings, designOf, hasTable, latestNetlist, latestRun, requirementEvidence, runResult, struckRequirements } from './record-read.js'
import { BenchStore, type InstrumentId, type Reading, idsFromRuns, latestByQuantity, loadIds, loadReadings, unionIds, unionReadings } from '../core/bench.js'
import { loadBoards } from '../core/boards.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { boardView, readingView } from './actions-build.js'
import { CAPABILITIES, capabilitiesStamp } from '../tools/mech/capabilities.js'
import { type BuildInputs, filesNow, staleReasons } from '../tools/mech/stale.js'

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
import { type CheckInput, type CheckResult, checkSkill } from './skill-checks.js'

/** The skills whose Submit records design decisions. */
const DESIGN_SKILLS = new Set(['intent-builder', 'requirements-review', 'architecture-choice', 'pin-plan-review'])

const SkillId = z.string().regex(/^[a-z][a-z-]{1,40}$/).refine((s) => SKILL_IDS.includes(s), 'one of the twenty guided skills')
const Data = z.record(z.string(), z.unknown())

/** The gate a person signs now: the first unsigned gate of the current stage. */
const currentGate = (r: JourneyRecord | null): string | null => {
  if (!r) return null
  return r.gates.find((g) => g.stage === r.journey.currentStage && !r.signatures.some((s) => s.gate === g.id && s.supersededAt === null && s.revision === r.journey.revision))?.id ?? null
}

/** Everything the checks read, from the record database (repository + live journey), for this person and skill. */
async function inputFor(ctx: Context, repo: string, skill: string, draftOverride?: Record<string, unknown>): Promise<CheckInput & { draftRow: { step: number; saved: string } | null; facts: AgentFacts; pendingErrors: string[] }> {
  const viewer: Viewer = await viewerOf(ctx.principal, repo)
  // drafts are the journey store's own (never copied into the repository), so they are read from it
  const row = await withJourneyDb(ctx, repo, (db) => getDraft(db, viewer.hash, skill))
  // the agents' questions and checks (src/core/agent-facts.ts), merged in as every view of the journey does
  const facts = await agentFacts(ctx, repo)
  // Schematic finish names every sheet's requirements: the schematic files of the default branch
  const sheetFiles = skill === 'schematic-finish' ? await kicadFiles(ctx, repo).then((f) => f.sch, () => null) : null
  // what the bench measured and who answered, as taken (the bench's live copy beside the facts: src/core/bench.ts)
  const bench = HARDWARE_SKILLS.has(skill) ? await liveBenchOf(ctx, repo) : { readings: [], ids: [] }
  const input: Awaited<ReturnType<typeof inputFor>> = await withRecordDb(ctx, repo, (db) => {
    const own = loadJourney(db)
    const r = own ? mergeAgentFacts(own, facts) : null
    const draft = draftOverride ?? (row?.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : null)
    // this skill's own pending decisions, laid over the record (this copy of it is thrown away after): the bar shows
    // what Submit would record. One a decision cannot be (it names nothing, or lacks its reason) is left out, and the
    // check it feeds stays not met
    const pendingErrors: string[] = []
    for (const d of draft ? (() => { const x = designOf(db); return pendingDecisions(skill, draft, x.rows, x.decisions) })() : []) {
      try {
        const des = designOf(db)
        recordDesignDecision(db, prepare(d, des.rows, new Set(requirementIds(db)), des.decisions), { label: viewer.label, hash: viewer.hash })
      } catch (e) { pendingErrors.push(e instanceof Error ? e.message : String(e)) }
    }
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
    let instruments: CheckInput['instruments'] = []
    try {
      const v = hasTable(db, 'settings') ? db.prepare("SELECT value FROM settings WHERE key='hil.instruments'").get() as { value?: string } | undefined : undefined
      const parsed: unknown = v?.value ? JSON.parse(v.value) : []
      if (Array.isArray(parsed)) instruments = parsed as CheckInput['instruments']
    } catch { /* unreadable settings: no instruments */ }
    const tests = hasTable(db, 'test_items') ? (db.prepare('SELECT id, method, status FROM test_items').all() as Record<string, unknown>[]).map((t) => ({ id: String(t.id), method: String(t.method), status: String(t.status) })) : []
    const question = r?.questions.find((q) => q.answeredAt === null && questionIsFor(q, viewer)) ?? null
    const fab = latestRun(db, 'kicad.fab')
    const fabResult = fab ? runResult(db, fab.id) : null
    const handPlaced = Array.isArray(fabResult?.hand_placed) ? (fabResult.hand_placed as unknown[]).filter((x): x is string => typeof x === 'string') : null
    return {
      boards: loadBoards(db), handPlaced, ids: unionIds(idsFromRuns(db), bench.ids), readings: unionReadings(loadReadings(db), bench.readings),
      r, viewer, requirements: live, struck,
      erc: erc.findings ? { findings: erc.findings, errors: erc.report.errors } : null,
      drc: drc.findings ? { findings: drc.findings, errors: drc.report.errors } : null,
      bom: bomRun ? runResult(db, bomRun.id) : null, board: boardRun ? runResult(db, boardRun.id) : null,
      placement: placement ? { status: placement.status, summary: placement.summary } : null,
      caseBuild: caseRun ? { id: caseRun.id, status: caseRun.status, summary: caseRun.summary, result: runResult(db, caseRun.id) } : null,
      instruments, tests, orders: r ? loadOrders(db) : [], draft, gate: currentGate(r), question,
      design: designOf(db), nets: latestNetlist(db)?.nets ?? null, sheetFiles,
      draftRow: row ? { step: row.step, saved: row.saved } : null, facts, pendingErrors,
    }
  })
  // Case design's fit: the build's recorded inputs against the default branch's files now
  if (skill === 'case-design' && input.caseBuild?.result) input.caseStale = await caseStaleness(ctx, repo, input.caseBuild.result.inputs)
  return input
}

/** Why the latest case build no longer stands for the default branch (src/tools/mech/stale.ts); null when the files
 * cannot be read (not compared). */
async function caseStaleness(ctx: Context, repo: string, was: unknown): Promise<string[] | null> {
  if (!was || typeof was !== 'object') return ['the build recorded no inputs']
  try {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    const now = await filesNow(was as Partial<BuildInputs>, (p) => gh.rawFile(repo, p, branch), { checked: CAPABILITIES.checked, sha256: capabilitiesStamp() })
    return staleReasons(was as Partial<BuildInputs>, now)
  } catch {
    return null
  }
}

const requirementIds = (db: import('node:sqlite').DatabaseSync): string[] => (hasTable(db, 'requirements') ? (db.prepare('SELECT id FROM requirements').all() as { id: string }[]).map((x) => String(x.id)) : [])
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * The design decisions a skill's draft makes, which Submit records (design.decide's shapes):
 *   intent-builder       draft.decisions [{ statement, choice: accept | edit | reject, text?, reason? }]; every
 *                        proposed statement not named there is accepted as worded (Submit intent accepts the draft)
 *   requirements-review  draft.decisions [{ requirement, choice: accept | strike, reason? }], draft.uncovered
 *                        [{ statement, reason }]
 *   architecture-choice  draft.choice { option, reason } with draft.deciding [criterion ids], draft.scores?,
 *                        draft.only_one?. The criteria are not part of Submit: they are fixed (design.decide) at the
 *                        first step, before any score is read, which is what "criteria fixed before scoring" checks
 *   pin-plan-review      every part in the plan, or draft.parts [part]: agreed as it stands
 * Entries that are not decisions are left out (the bar then says what is missing).
 */
export function pendingDecisions(skill: string, draft: Record<string, unknown>, rows: DesignRows, decided: readonly import('../tools/design/decisions.js').DesignDecision[] = []): DecisionInput[] {
  const parse = (x: unknown): DecisionInput[] => { const r = Decision.safeParse(x); return r.success ? [r.data] : [] }
  switch (skill) {
    case 'intent-builder': {
      const named = list(draft.decisions).flatMap((d) => parse({ kind: 'intent', ...(d as object) }))
      const inDraft = new Set(named.map((d) => (d.kind === 'intent' ? d.statement : '')))
      const rest = intentView(rows, decided).filter((x) => x.state === 'proposed' && !inDraft.has(x.id)).map((x) => ({ kind: 'intent' as const, statement: x.id, choice: 'accept' as const }))
      return [...named, ...rest]
    }
    case 'requirements-review':
      return [...list(draft.decisions).flatMap((d) => parse({ kind: 'requirement', ...(d as object) })), ...list(draft.uncovered).flatMap((d) => parse({ kind: 'uncovered', ...(d as object) }))]
    case 'architecture-choice': {
      const c = draft.choice as { option?: unknown; reason?: unknown } | undefined
      if (!c || typeof c.option !== 'string') return []
      const reason = typeof c.reason === 'string' && c.reason.trim() ? c.reason : typeof draft.why === 'string' ? draft.why : ''
      return parse({ kind: 'architecture', option: c.option, reason, deciding: list(draft.deciding), ...(draft.scores ? { scores: draft.scores } : {}), ...(typeof draft.only_one === 'string' ? { only_one: draft.only_one } : {}) })
    }
    case 'pin-plan-review': {
      const parts = list(draft.parts).filter((x): x is string => typeof x === 'string')
      return (parts.length ? parts : [...new Set(rows.pins.filter((p) => p.status !== 'withdrawn').map((p) => p.part))]).map((part) => ({ kind: 'pins' as const, part }))
    }
    default: return []
  }
}

const finding = (f: NonNullable<CheckInput['erc']>['findings'][number]) => ({
  id: f.id, severity: f.severity, text: f.text, where: f.ref ?? f.where, sheet: f.where, ...(f.x_mm !== null ? { x_mm: f.x_mm, y_mm: f.y_mm } : {}),
  source: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` },
})

/** What a skill's screen reads beyond the bar. */
function extras(skill: string, i: CheckInput): Record<string, unknown> {
  switch (skill) {
    case 'question-answer': {
      const q = i.question
      if (!q) return {}
      const rec = q.options.find((o) => o.recommended)
      return {
        question: {
          id: q.id, to: q.askedOf || q.askedOfSub ? 'you' : q.askedPart === 'admins' ? 'the admins' : 'the contributors', text: q.text, askedAt: new Date(q.askedAt * 1000).toISOString(), ...(q.blocks ? { blocks: q.blocks } : {}),
          ...(rec ? { recommended: { id: rec.id, label: rec.label } } : {}), options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.why ? { detail: o.why } : {}) })),
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
          ...i.requirements.filter((q) => q.status !== 'accepted').map((q) => ({ id: `requirement:${q.id}`, title: `${q.id}: ${q.text}`, detail: `From ${links.filter((l) => l.requirement === q.id).map((l) => v.find((x) => x.id === l.intent)?.words ?? l.intent).join('; ') || q.source || 'no source given'}.`, status: 'open' as const })),
          ...v.filter((x) => x.state !== 'rejected' && x.kind === 'statement' && x.uncovered === null && !links.some((l) => l.intent === x.id)).map((x) => ({ id: `intent:${x.id}`, title: `Not covered: ${x.words}`, detail: 'No requirement is derived from this intent line: add one, or leave it out with a reason.', status: 'open' as const })),
        ],
      }
    }
    case 'architecture-choice': {
      if (!i.design) return {}
      const a = architectureView(i.design.rows, i.design.decisions)
      const rec = a.options.find((o) => o.recommended)
      return {
        architecture: a,
        ...(a.options.length ? {
          recommendation: {
            question: 'Which architecture goes forward?', recommended: rec?.id ?? a.options[0]?.id ?? '',
            options: a.options.map((o) => ({ id: o.id, label: `Option ${o.id}: ${o.name}`, detail: `${o.summary}${a.criteria.length ? ` Weighted score ${o.total}.` : ''}` })),
            ...(rec?.why ? { why: rec.why } : {}), ...(rec?.gives_up ? { givesUp: rec.gives_up } : {}),
          },
        } : {}),
      }
    }
    case 'pin-plan-review': {
      if (!i.design) return {}
      const waived = new Set((i.r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
      return { items: pinCheck(i.design.rows.pins, i.nets ?? null).map((f) => ({ id: `finding:${f.id}`, title: f.text, detail: f.severity === 'blocks' ? 'Fix it in the plan or the schematic, or waive it.' : 'Fix or waive.', status: waived.has(f.id) ? 'waived' as const : 'open' as const })) }
    }
    case 'schematic-finish': return { findings: (i.erc?.findings ?? []).map(finding) }
    case 'board-setup': case 'placement-adjust': return { findings: (i.drc?.findings ?? []).map(finding) }
    case 'case-design': {
      const b = i.caseBuild
      if (!b?.result) return {}
      const x = b.result
      return { case: { run: b.id, status: b.status, summary: b.summary, process: x.process ?? null, fit: x.fit_status ?? null, problems: x.problems ?? [], rules_failing: x.rules_failing ?? [], files: x.files ?? [], case: x.case ?? null } }
    }
    case 'gate-signing': return i.gate ? { gate: i.gate } : {}
    case 'incoming-inspection': return { boards: (i.boards ?? []).map((b) => boardView(b, i.orders, i.readings ?? [])), ...(i.handPlaced ? { handPlaced: i.handPlaced } : {}) }
    case 'bench-setup': case 'bring-up-run': return { bench: skillBench(skill, i) }
    default: return {}
  }
}

/** The bar in words: "4 of 6 met; 2 need the record to hold more first." */
function summaryOf(checks: CheckResult[]): string {
  const ok = checks.filter((c) => c.status !== 'not_met').length
  const missing = checks.filter((c) => c.unavailable).length
  return `${ok} of ${checks.length} checks met${missing ? `; ${missing} cannot be checked until the record holds more` : ''}.`
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
  'skill.get': def('read', Repo.extend({ skill: SkillId }), async (a, ctx) => {
    const sk = skillDef(a.skill)!
    const i = await inputFor(ctx, a.repo, a.skill)
    const checks = checkSkill(a.skill, i) ?? []
    return {
      repo: a.repo, skill: sk.id, name: sk.name, stage: sk.stage,
      steps: sk.steps, step: i.draftRow?.step ?? 0,
      checks, met: checks.filter((c) => c.status !== 'not_met').length, total: checks.length, summary: summaryOf(checks),
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
    const missing = checks.filter((c) => c.status === 'not_met')
    if (i.pendingErrors.length) throw new ActionError(`${sk.name} cannot be submitted yet: ${i.pendingErrors.join(' ')}`)
    if (missing.length) {
      const words = missing.map((c) => `${sk.checks.find((x) => x.id === c.id)?.text ?? c.id}${c.unavailable ? ` (cannot be checked yet: needs ${c.unavailable})` : c.detail ? ` (${c.detail})` : ''}`)
      throw new ActionError(`${sk.name} cannot be submitted yet. Not met: ${words.join('; ')}.`)
    }
    const by = { hash: hashOf(ctx.principal), label: label(ctx.principal) }
    let started: string[] = []
    let jobId: string | undefined
    if (a.skill === 'change-request') {
      const d = a.draft
      const request = `Change request (${String(d.what)}): ${String(d.change)}\n\nWhy: ${String(d.why)}\nScope: ${d.revision === 'next' ? 'the next revision' : 'this revision'}, ${d.covers === 'firmware' ? 'firmware only' : 'hardware and firmware'}.\nRaise it for approval at a gate; change nothing before it is approved.`
      const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
      if (!r.accepted) throw new ActionError(r.reason ?? 'trace did not accept the change request.')
      jobId = r.jobId
      started = ['The agents raise the change request for approval.']
    }
    const { rows: designRows, reqIds } = DESIGN_SKILLS.has(a.skill) ? await withRecordDb(ctx, a.repo, (db) => ({ rows: designOf(db).rows, reqIds: new Set(requirementIds(db)) })) : { rows: null as unknown as DesignRows, reqIds: new Set<string>() }
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      let ref: string | null = null
      // the design decisions the skill makes (Intent builder, Requirements review, Architecture choice, Pin plan
      // review), recorded as design.decide would, each logged
      for (const d of DESIGN_SKILLS.has(a.skill) ? pendingDecisions(a.skill, a.draft, designRows, loadDesignDecisions(db)) : []) {
        const p = prepare(d, designRows, reqIds, loadDesignDecisions(db))
        const rec = recordDesignDecision(db, p, by)
        decide(db, { kind: `design.${p.kind}`, stage: loadJourney(db)?.journey.currentStage ?? null, ref: p.target, by: by.label, summary: p.summary, detail: { decision: rec.id, skill: a.skill } })
      }
      if (a.skill === 'waiver') {
        const d = a.draft
        const sev = SEVERITIES.includes(d.severity as never) ? d.severity as (typeof SEVERITIES)[number] : (() => { throw new ActionError('Give the severity.') })()
        const caught = d.caught === 'nowhere' ? null : `${d.caught === 'bench' ? 'On the bench' : 'At a later stage'}: ${String(d.where ?? '').trim()}`
        const w = addWaiver(db, { target: waiverTarget(d), reason: String(d.reason), risk: String(d.risk), severity: sev, caught_where: caught, scope: d.scope === 'condition' ? `until ${String(d.condition).trim()}` : 'this revision only' }, by, { facts: i.facts })
        ref = w.id
      } else if (a.skill === 'question-answer') {
        if (!i.question) throw new ActionError('There is no open question to answer.')
        const d = a.draft
        const opt = typeof d.option === 'string' && d.option !== 'other' ? d.option : undefined
        const text = opt ? undefined : [d.value ? String(d.value) : '', String(d.answer ?? '')].filter((x) => x.trim()).join(': ') + (d.source ? ` (source: ${String(d.source)})` : '')
        answerQuestion(db, i.question.id, by, { option: opt, answer: text, reason: typeof d.reason === 'string' ? d.reason : undefined }, { facts: i.facts })
        ref = i.question.id
      }
      const id = decide(db, {
        kind: 'skill.submitted', stage: loadJourney(db)?.journey.currentStage ?? null, ref: ref ?? a.skill, by: by.label,
        summary: `${sk.name} was submitted with every check of its quality bar met or waived${jobId ? '; the agents raise the change' : ''}.`,
        detail: { skill: a.skill, checks: checks.map((c) => ({ id: c.id, status: c.status })), ...(jobId ? { job: jobId } : {}) },
      })
      putDraft(db, by.hash, a.skill, null)
      return { result: { id, ref } }
    }))
    return { ok: true, repo: a.repo, skill: a.skill, id: out.id, ...(out.ref ? { ref: out.ref } : {}), ...(jobId ? { jobId } : {}), started, version: out.version }
  }),
}

