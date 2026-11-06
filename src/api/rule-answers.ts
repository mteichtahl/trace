/**
 * Rules from answers (docs/user-journey.md "Question answer", step 4 "Say whether it lasts"): a question a person answers
 * as "A rule for the project" is added to the project's rules, .trace/rules.md, which every specialist reads from the
 * default branch as its authority (src/agents/rules.ts). Before this, the answer only reached the job that asked (told
 * to remember it), and the rules file stayed empty on every branch (test-esp32 log #109).
 *
 * The rule goes in through a change of trace's own, as every app edit does (src/api/edits.ts): one commit on
 * trace/rule-<question>-<base36 time> that adds the entry under "## Rules from answers", its pull request opened at once
 * and the edit recorded (kind rule; only .trace/rules.md). An admin's own rule applies once its checks pass; anyone
 * else's waits for an admin to accept it (src/core/app-edits.ts appliesOf), since the rules steer every agent. When the
 * default branch moves on, it is made again on the newest rules file (src/api/apply-edits.ts redo), so two rules
 * answered in a row never conflict. Each entry carries a marker with its question's id, so it is added once.
 *
 *   project.rules              read   { repo } → the rules file on the default branch, and each answer made a rule:
 *                                     in the rules, waiting in its change, or not in the rules yet
 *   project.rule_from_answer   write  { repo, question } → adds an answer made a rule that is not in the rules yet (one
 *                                     answered before trace wrote them, or whose change could not be made then)
 */
import { z } from 'zod'
import type { RedoSpec } from '../core/app-edits.js'
import { loadFollowups } from '../core/answer-followups.js'
import { decide, loadJourney, type QuestionRow } from '../core/journey.js'
import { ActionError, type Context, Repo, def, label, slugify, withJourneyDb, writeJourney } from './action-kit.js'
import { initials, neutralise } from './actions-changes.js'
import { editStore, editorName, recordEdit } from './edits.js'

const Id = z.string().min(1).max(80)

export const RULES_PATH = '.trace/rules.md'
export const RULES_SECTION = '## Rules from answers'
const SECTION_INTRO = 'Rules people made in trace when they answered an agent\'s question with "A rule for the project". Each says who decided it and which question it answers. Follow them as every other rule here.'

/** What one entry in the rules file says. */
export type RuleAnswer = Extract<RedoSpec, { op: 'rule' }>['rule']

/** The comment that marks a question's entry, so it is added once (an id is letters, digits, dashes and underscores). */
export const ruleMarker = (question: string): string => `<!-- trace: rule from question ${question.replace(/[^A-Za-z0-9_.-]/g, '')} -->`

const oneLine = (s: string): string => neutralise(s.replace(/\s+/g, ' ').trim())

/** The entry for one rule, in Markdown. Pure. */
export function ruleEntry(r: RuleAnswer): string {
  const rule = oneLine(r.rule)
  return [
    ruleMarker(r.question),
    `- ${/[.!?]$/.test(rule) ? rule : `${rule}.`}`,
    ...(r.reason?.trim() ? [`  - Why: ${oneLine(r.reason)}`] : []),
    `  - Decided by ${oneLine(r.decidedBy)} on ${r.on}, answering ${oneLine(r.askedBy)}'s question ${r.question}: "${oneLine(r.asked).slice(0, 400)}"`,
  ].join('\n')
}

/**
 * The rules file with this rule added at the end of "## Rules from answers" (the section added at the end of the file
 * when there is none), or null when the question's rule is already in it. Pure.
 */
export function withRule(text: string | null, r: RuleAnswer): string | null {
  const now = (text ?? '').replace(/\r\n/g, '\n')
  if (now.includes(ruleMarker(r.question))) return null
  const entry = ruleEntry(r)
  const at = now.search(/^## Rules from answers[ \t]*$/m)
  if (at < 0) {
    const base = now.trimEnd()
    return `${base ? `${base}\n\n` : ''}${RULES_SECTION}\n\n${SECTION_INTRO}\n\n${entry}\n`
  }
  // the end of the section: the next heading of the same or a higher level, else the end of the file
  const rest = now.slice(at + RULES_SECTION.length)
  const next = rest.search(/^#{1,2} /m)
  const end = next < 0 ? now.length : at + RULES_SECTION.length + next
  const head = now.slice(0, end).trimEnd()
  const tail = now.slice(end)
  return `${head}\n\n${entry}\n${tail ? `\n${tail}` : ''}`
}

/** The questions whose rule is in this rules file. Pure. */
export function rulesIn(text: string | null): string[] {
  return [...(text ?? '').matchAll(/<!-- trace: rule from question ([A-Za-z0-9_.-]+) -->/g)].map((m) => m[1] as string)
}

const day = (at: number): string => new Date(at * 1000).toISOString().slice(0, 10)

/** The rule an answered question makes, or null when it is not answered. */
export function ruleOf(q: QuestionRow, decidedBy: string): RuleAnswer | null {
  if (q.answeredAt === null || !q.answer) return null
  return { question: q.id, asked: q.text, askedBy: q.askedBy, rule: q.answer, reason: q.answerReason, decidedBy, on: day(q.answeredAt) }
}

/** The answers made a rule, by question id: said so in the decision, or kept as a follow-up with it (an older answer). */
function ruleAnswerIds(db: Parameters<typeof loadFollowups>[0]): string[] {
  const r = loadJourney(db)
  const ids = new Set<string>()
  for (const d of r?.decisions ?? []) if (d.kind === 'question.answered' && d.ref && (d.detail as { lasts?: unknown } | null)?.lasts === 'rule') ids.add(d.ref)
  try { for (const f of loadFollowups(db)) if (f.lasts === 'rule') ids.add(f.question) } catch { /* a record from before follow-ups */ }
  return [...ids]
}

/** The open edit that adds this question's rule, if any. */
async function openRuleEdit(ctx: Context, repo: string, question: string) {
  return (await editStore(ctx).list(repo)).find((e) => e.kind === 'rule' && e.redo?.op === 'rule' && e.redo.rule.question === question) ?? null
}

export interface ProposedRule {
  /** proposed: a change was made now; in_rules: it was there already; waiting: its change is open already */
  state: 'proposed' | 'in_rules' | 'waiting'
  change: number | null
  branch?: string
  applies?: 'auto' | 'review'
  /** what to tell the person */
  words: string
}

/**
 * Add an answered question's rule to .trace/rules.md through a change of trace's own, unless it is in the rules or a
 * change for it is open. `decidedBy` is the name written in the file (never an email): the answerer's.
 */
export async function proposeRule(ctx: Context, repo: string, question: string, decidedBy: string): Promise<ProposedRule> {
  const q = await withJourneyDb(ctx, repo, (db) => loadJourney(db)?.questions.find((x) => x.id === question) ?? null)
  const rule = q ? ruleOf(q, decidedBy) : null
  if (!rule) throw new ActionError(`Question ${question} is not answered, so it makes no rule.`)
  const open = await openRuleEdit(ctx, repo, question)
  if (open) return { state: 'waiting', change: open.number, branch: open.branch, words: `The rule is already waiting in ${open.number ? `change #${open.number}` : 'a change'}.` }
  const gh = await ctx.deps.github()
  const { branch: base, sha } = await gh.defaultBranch(repo)
  const now = await gh.rawFile(repo, RULES_PATH, base)
  const next = withRule(now ? new TextDecoder().decode(now) : null, rule)
  if (next === null) return { state: 'in_rules', change: null, words: 'The rule is already in the project\'s rules.' }
  const blob = now ? await gh.fileSha(repo, RULES_PATH, base) : null
  const branch = `trace/rule-${slugify(question)}-${Date.now().toString(36)}`
  if (branch === base) throw new ActionError('refusing to write the default branch')
  await gh.createBranch(repo, branch, sha)
  const short = oneLine(rule.rule).slice(0, 72)
  const title = `Project rule: ${short}${rule.rule.length > 72 ? '…' : ''}`
  const message = `${title}\n\nAdded to ${RULES_PATH}: the answer to question ${question}, made a rule for the project by ${rule.decidedBy}.\n\nRequested by ${label(ctx.principal)} through the trace API.`
  const { commit } = await gh.putFile(repo, { path: RULES_PATH, branch, content: new TextEncoder().encode(next), message, sha: blob })
  const body = [
    title, '',
    `${rule.decidedBy} answered ${oneLine(rule.askedBy)}'s question as a rule for the project, so it is added to \`${RULES_PATH}\`, which every agent reads from the default branch as its authority:`, '',
    ruleEntry(rule).split('\n').slice(1).join('\n'), '',
    `Made in trace by ${await editorName(ctx)}.`,
  ].join('\n')
  const edit = await recordEdit(ctx, { repo, branch, base, commit, kind: 'rule', title, body, redo: { op: 'rule', rule }, paths: [RULES_PATH] })
  const where = edit.number ? `change #${edit.number}` : 'a change of its own'
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, {
      kind: 'rule.proposed', stage: r.journey.currentStage, ref: question, by: label(ctx.principal),
      summary: `The answer to question ${question} is a rule for the project: "${short}". trace added it to ${RULES_PATH} in ${where}.`,
      detail: { change: edit.number, branch, applies: edit.applies },
    })
    return { result: null }
  }).catch(() => undefined)
  const words = `The rule goes into the project's rules (${RULES_PATH}) in ${where}: ${edit.applies === 'auto' ? 'trace applies it once its checks pass' : 'it applies once an admin accepts it'}, and every agent follows it from then on.`
  return { state: 'proposed', change: edit.number, branch, applies: edit.applies, words }
}

/** The name written in the rules for who decided: this person's when they answered, else the answerer's initials. */
async function deciderName(ctx: Context, q: QuestionRow): Promise<string> {
  if (q.answeredBy && q.answeredBy === label(ctx.principal)) return editorName(ctx)
  return `a person on the project (${initials(q.answeredBy ?? '?')})`
}

/** One answer made a rule, as Settings shows it. */
export interface RuleAnswerView {
  question: string; asked: string; asked_by: string; rule: string; reason: string | null; by: string | null; at: string | null
  /** in_rules: in .trace/rules.md on the default branch; waiting: its change is open; missing: neither */
  state: 'in_rules' | 'waiting' | 'missing'
  change: number | null
}

export const RULE_ANSWER_ACTIONS = {
  'project.rules': def('read', Repo, async (a, ctx) => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(a.repo)
    const bytes = await gh.rawFile(a.repo, RULES_PATH, branch)
    const text = bytes ? new TextDecoder().decode(bytes) : null
    const inRules = new Set(rulesIn(text))
    const rows = await withJourneyDb(ctx, a.repo, (db) => {
      const r = loadJourney(db)
      const ids = ruleAnswerIds(db)
      return ids.map((id) => r?.questions.find((x) => x.id === id)).filter((x): x is QuestionRow => !!x && x.answeredAt !== null)
    })
    const edits = (await editStore(ctx).list(a.repo).catch(() => [])).filter((e) => e.kind === 'rule' && e.redo?.op === 'rule')
    const answers = rows.map((q): RuleAnswerView => {
      const edit = edits.find((e) => e.redo?.op === 'rule' && e.redo.rule.question === q.id)
      return {
        question: q.id, asked: q.text, asked_by: q.askedBy, rule: q.answer ?? '', reason: q.answerReason, by: q.answeredBy,
        at: q.answeredAt ? new Date(q.answeredAt * 1000).toISOString() : null,
        state: inRules.has(q.id) ? 'in_rules' : edit ? 'waiting' : 'missing', change: inRules.has(q.id) ? null : edit?.number ?? null,
      }
    }).sort((x, y) => (y.at ?? '').localeCompare(x.at ?? ''))
    return { repo: a.repo, branch, path: RULES_PATH, text, answers }
  }),

  'project.rule_from_answer': def('write', Repo.extend({ question: Id }), async (a, ctx) => {
    const q = await withJourneyDb(ctx, a.repo, (db) => loadJourney(db)?.questions.find((x) => x.id === a.question) ?? null)
    if (!q || q.answeredAt === null) throw new ActionError(`Question ${a.question} is not answered, so it makes no rule.`)
    const said = await withJourneyDb(ctx, a.repo, (db) => ruleAnswerIds(db).includes(a.question))
    if (!said) throw new ActionError('This answer was not made a rule for the project. Answer the next question like it as "A rule for the project" instead.')
    const r = await proposeRule(ctx, a.repo, a.question, await deciderName(ctx, q))
    return { repo: a.repo, question: a.question, ...r, summary: r.words }
  }),
}
