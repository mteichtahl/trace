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
 *                         Placement adjust: the latest checks'), `gate` (Gate signing: the gate of the current stage)
 *   skill.draft   read    { skill, step, data | null }: keep this person's draft in the journey store (null discards
 *                         it). Read access: a reviewer can draft a waiver to discuss, never submit it
 *   skill.drafts  read    this person's drafts on the project, newest first (the "Continue: … step 4 of 6" card)
 *   skill.submit  write   { skill, draft }: the draft is kept, the bar checked again from the record; any check not
 *                         met is refused with what is missing. Then the skill's own effect where an action exists
 *                         (Waiver → waiver.add, Question answer → question.answer, Change request → a task for the
 *                         agents), a decision logged for every skill, and the draft discarded
 */
import { z } from 'zod'
import {
  type AgentFacts, type JourneyRecord, SEVERITIES, type Viewer, addWaiver, answerQuestion, decide, getDraft, loadJourney, loadOrders, mergeAgentFacts, putDraft,
  questionIsFor,
} from '../core/journey.js'
import { SKILL_IDS, skillDef } from '../core/skills.js'
import { ActionError, type Context, Repo, agentFacts, def, hashOf, label, plainly, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { viewerOf } from './actions-journey.js'
import { checkFindings, hasTable, latestRun, requirementEvidence, runResult } from './record-read.js'
import { type CheckInput, type CheckResult, checkSkill } from './skill-checks.js'

const SkillId = z.string().regex(/^[a-z][a-z-]{1,40}$/).refine((s) => SKILL_IDS.includes(s), 'one of the nineteen guided skills')
const Data = z.record(z.string(), z.unknown())

/** The gate a person signs now: the first unsigned gate of the current stage. */
const currentGate = (r: JourneyRecord | null): string | null => {
  if (!r) return null
  return r.gates.find((g) => g.stage === r.journey.currentStage && !r.signatures.some((s) => s.gate === g.id && s.supersededAt === null && s.revision === r.journey.revision))?.id ?? null
}

/** Everything the checks read, from the record database (repository + live journey), for this person and skill. */
async function inputFor(ctx: Context, repo: string, skill: string, draftOverride?: Record<string, unknown>): Promise<CheckInput & { draftRow: { step: number; saved: string } | null; facts: AgentFacts }> {
  const viewer: Viewer = await viewerOf(ctx.principal, repo)
  // drafts are the journey store's own (never copied into the repository), so they are read from it
  const row = await withJourneyDb(ctx, repo, (db) => getDraft(db, viewer.hash, skill))
  // the agents' questions and checks (src/core/agent-facts.ts), merged in as every view of the journey does
  const facts = await agentFacts(ctx, repo)
  return withRecordDb(ctx, repo, (db) => {
    const own = loadJourney(db)
    const r = own ? mergeAgentFacts(own, facts) : null
    const live = requirementEvidence(db, r)
    const struck = hasTable(db, 'requirements')
      ? (db.prepare("SELECT id, tags FROM requirements WHERE status IN ('rejected', 'obsolete')").all() as Record<string, unknown>[]).map((x) => ({ id: String(x.id), tags: [] as string[] }))
      : []
    const erc = checkFindings(db, 'erc', r)
    const drc = checkFindings(db, 'drc', r)
    const bomRun = latestRun(db, 'kicad.bom')
    const boardRun = latestRun(db, 'kicad.board')
    const placement = latestRun(db, 'pcb.placement_check')
    let instruments: CheckInput['instruments'] = []
    try {
      const v = hasTable(db, 'settings') ? db.prepare("SELECT value FROM settings WHERE key='hil.instruments'").get() as { value?: string } | undefined : undefined
      const parsed: unknown = v?.value ? JSON.parse(v.value) : []
      if (Array.isArray(parsed)) instruments = parsed as CheckInput['instruments']
    } catch { /* unreadable settings: no instruments */ }
    const tests = hasTable(db, 'test_items') ? (db.prepare('SELECT id, method, status FROM test_items').all() as Record<string, unknown>[]).map((t) => ({ id: String(t.id), method: String(t.method), status: String(t.status) })) : []
    const draft = draftOverride ?? (row?.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : null)
    const question = r?.questions.find((q) => q.answeredAt === null && questionIsFor(q, viewer)) ?? null
    return {
      r, viewer, requirements: live, struck,
      erc: erc.findings ? { findings: erc.findings, errors: erc.report.errors } : null,
      drc: drc.findings ? { findings: drc.findings, errors: drc.report.errors } : null,
      bom: bomRun ? runResult(db, bomRun.id) : null, board: boardRun ? runResult(db, boardRun.id) : null,
      placement: placement ? { status: placement.status, summary: placement.summary } : null,
      instruments, tests, orders: r ? loadOrders(db) : [], draft, gate: currentGate(r), question,
      draftRow: row ? { step: row.step, saved: row.saved } : null, facts,
    }
  })
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
    case 'schematic-finish': return { findings: (i.erc?.findings ?? []).map(finding) }
    case 'board-setup': case 'placement-adjust': return { findings: (i.drc?.findings ?? []).map(finding) }
    case 'gate-signing': return i.gate ? { gate: i.gate } : {}
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
      const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request, requestedBy: ctx.principal.email ?? ctx.principal.sub, requestedBySub: ctx.principal.sub })
      if (!r.accepted) throw new ActionError(r.reason ?? 'trace did not accept the change request.')
      jobId = r.jobId
      started = ['The agents raise the change request for approval.']
    }
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      let ref: string | null = null
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

