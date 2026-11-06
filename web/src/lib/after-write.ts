/**
 * After a person acts, the screens that show what the act changed are read again at once, wherever the act was taken
 * (test-esp32 log #17, #123, #148, #153: after Accept, an answer or a waiver the Overview showed the old state until an
 * event came or the page was reloaded). One table, by action, so no screen has to know what every other screen reads:
 * `call` (lib/api.ts) tells the listener here of every answer it gets, and the listener
 *
 *   1. applies what the answer settles to what is on screen now (an answered question leaves Waiting on people and
 *      stops being the next step, an accepted or discarded change leaves the lists, a waived finding leaves its
 *      criterion), so nothing waits on a round trip to look right;
 *   2. invalidates every query the act may have changed (writeInvalidations), so the active ones refetch now;
 *   3. looks once more a little later (AGAIN_MS): what an act starts lands a moment after its answer (the job an answer
 *      carries on enters the job index, GitHub's lists catch up with a merge), and an event may not come for it.
 *
 * The live events (lib/live.ts) keep the screens current after that. Reads, and writes not in the table (a skill's
 * draft saved on every keystroke, preferences), change nothing here.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { ActionName } from './api'
import type { Gate, InboxItem, Journey, NextStep } from './types'

/** How long after an act the screens look once more. */
export const AGAIN_MS = 4_000

type Args = Record<string, unknown>

/** Everything about one project's journey that an act on it may change: the journey and what is drawn from it. */
const project = (r: string): QueryKey[] => [
  ['journey.get', r], ['inbox'], ['jobs.list', r], ['tools.waits', r], ['activity.list'], ['runs', r], ['skill.get', r], ['skill.drafts', r],
  ['design.get', r], ['requirements.trace', r], ['build.get', r],
]
/** A project's changes: their lists, each change's page, its checks. */
const changes = (r: string): QueryKey[] => [['changes.list', r], ['change.get', r], ['pull.status', r], ['change.runs', r]]
/** A project's lifecycle: every list it is on, and its banner. */
const lifecycle = (r: string): QueryKey[] => [['projects'], ['projects.retired'], ['project.lifecycle', r], ['journey.get', r], ['inbox'], ['activity.list']]

/** What each act changes on one project (`r`): the query-key prefixes to read again. */
const BY_ACTION: Partial<Record<ActionName, (r: string, a: Args) => QueryKey[]>> = {
  // the journey record: questions, gates and their criteria, waivers, the guided skills, the build
  'question.answer': project,
  'stuck.dismiss': project,
  'handoff.decline': project,
  'waiver.add': project,
  'waiver.withdraw': project,
  'gate.sign': (r) => [...project(r), ['documents.get', r]],
  'gate.return': project,
  'journey.criterion.open': project,
  'criterion.confirm': project,
  'skill.submit': (r) => [...project(r), ...changes(r)],
  'design.decide': project,
  'requirements.draft': project,
  'journey.start_work': project,
  'order.record': project,
  'order.update': project,
  'board.record': project,
  'board.check': project,
  'project.update': (r) => [...project(r), ['projects']],
  'renders.seen': (r) => [['inbox'], ['renders.list', r], ['journey.get', r]],
  // work trace starts: its job, the lists of what trace is doing
  task: (r) => [...project(r), ['health.get', r]],
  'job.control': (r) => [...project(r), ['job']],
  // a change: its page and lists, and the journey whose steps its open changes are
  'change.accept': (r) => [...project(r), ...changes(r), ['documents.get', r], ['files.list', r]],
  'change.ask': (r) => [...project(r), ...changes(r)],
  'change.discard': (r) => [...project(r), ...changes(r)],
  'change.resolve': (r) => [...project(r), ...changes(r)],
  'change.rerun': (r) => [...project(r), ...changes(r)],
  // a person's edit made on a branch of trace's own: a change appears
  'design.handin': (r) => [...project(r), ...changes(r)],
  'files.edit': (r) => [...project(r), ...changes(r)],
  'settings.set': (r) => [...project(r), ...changes(r), ['settings.get', r]],
  'project.logo_set': (r) => [...changes(r), ['project.logo', r], ['journey.get', r]],
  'project.pause': lifecycle,
  'project.resume': lifecycle,
  'project.retire': lifecycle,
  'project.restore': lifecycle,
}

/** The query-key prefixes an act makes stale, or null for an action that changes nothing on screen here. Pure. */
export function writeInvalidations(action: string, args: Args): QueryKey[] | null {
  const of = BY_ACTION[action as ActionName]
  if (!of) return null
  const repo = typeof args.repo === 'string' && args.repo ? args.repo : null
  // a job controlled from a screen with no project (its id names none): every project's lists of what trace is doing
  if (!repo) return action === 'job.control' ? [['job'], ['jobs.list'], ['journey.get'], ['tools.waits'], ['activity.list'], ['inbox']] : null
  return [...new Map(of(repo, args).map((k) => [JSON.stringify(k), k])).values()]
}

/** The finding a waiver is of (`finding:<id>`, as the waiver skill's draft and waiver.add name it), or null. */
function waivedFinding(action: string, args: Args): string | null {
  if (action === 'waiver.add') {
    const t = args.target as { kind?: unknown; id?: unknown } | undefined
    return t?.kind === 'finding' && typeof t.id === 'string' ? t.id : null
  }
  if (action === 'skill.submit' && args.skill === 'waiver') {
    const what = (args.draft as { what?: unknown } | undefined)?.what
    return typeof what === 'string' && what.startsWith('finding:') ? what.slice('finding:'.length) : null
  }
  return null
}

/** Whether the next step is answering question `id` (its ref, or its button's address naming it). Pure. */
export function stepAnswers(n: Pick<NextStep, 'ref' | 'action'> | undefined, id: string): boolean {
  if (!n) return false
  if (n.ref?.kind === 'question' && n.ref.id === id) return true
  const to = n.action?.to
  return !!to && new URLSearchParams(to.split('?')[1] ?? '').get('question') === id
}

/** The next step once its question is answered, until journey.get says what comes next: trace carries on. */
export const ANSWERED_STEP: NextStep = { kind: 'working', owner: 'trace', summary: 'Answered. trace carries on with it.', short: 'trace carries on' }

/**
 * What an act's ok answer settles, applied to the data on screen: an answered (or dismissed) question leaves the
 * journey's questions and the inbox, and is no longer the next step (#199: its "Use …" stayed while Waiting on people
 * already said 0), an accepted or discarded change leaves the inbox and the change list, a waived
 * finding leaves the criterion it was listed under. The refetch that follows brings everything else. Pure on the
 * client's cache: nothing is applied to a query that holds no data.
 */
export function applyWrite(qc: Pick<QueryClient, 'setQueriesData'>, action: string, args: Args): void {
  const repo = typeof args.repo === 'string' ? args.repo : null
  if (!repo) return
  const journey = (f: (j: Journey) => Journey): void => { qc.setQueriesData<Journey>({ queryKey: ['journey.get', repo] }, (j) => (j ? f(j) : j)) }
  const inbox = (keep: (i: InboxItem) => boolean): void => { qc.setQueriesData<InboxItem[]>({ queryKey: ['inbox'] }, (xs) => (Array.isArray(xs) ? xs.filter(keep) : xs)) }
  if ((action === 'question.answer' && typeof args.question === 'string') || (action === 'stuck.dismiss' && typeof args.job === 'string')) {
    const id = (action === 'question.answer' ? args.question : args.job) as string
    journey((j) => {
      const asked = j.questions.some((x) => x.id === id)
      const next = stepAnswers(j.next, id)
      if (!asked && !next) return j
      return { ...j, questions: j.questions.filter((x) => x.id !== id), ...(next ? { next: ANSWERED_STEP } : {}) }
    })
    inbox((i) => !(i.repo === repo && i.questionId === id))
    return
  }
  if ((action === 'change.accept' || action === 'change.discard') && typeof args.number === 'number') {
    const n = args.number
    inbox((i) => !(i.change && i.change.repo === repo && i.change.number === n))
    qc.setQueriesData<{ repo: string; changes: { number: number }[] }>({ queryKey: ['changes.list', repo] }, (d) => (d && Array.isArray(d.changes) ? { ...d, changes: d.changes.filter((c) => c.number !== n) } : d))
    return
  }
  const finding = waivedFinding(action, args)
  if (finding) {
    const gates = (gs: Gate[]): Gate[] => gs.map((g) => (g.criteria.some((c) => c.findings?.some((f) => f.id === finding))
      ? { ...g, criteria: g.criteria.map((c) => (c.findings?.some((f) => f.id === finding) ? { ...c, findings: c.findings.filter((f) => f.id !== finding) } : c)) }
      : g))
    journey((j) => ({ ...j, gates: gates(j.gates) }))
  }
}

/**
 * The listener `call` tells of every ok answer (lib/api.ts onWrite): applies the act, invalidates what it changed now,
 * and once more AGAIN_MS later. Several acts within that time share the one later look.
 */
export function afterWrite(qc: Pick<QueryClient, 'invalidateQueries' | 'setQueriesData'>, againMs: number = AGAIN_MS): (action: string, args: Args) => void {
  const later = new Map<string, QueryKey>()
  let timer: ReturnType<typeof setTimeout> | undefined
  return (action, args) => {
    const keys = writeInvalidations(action, args)
    if (!keys) return
    try {
      applyWrite(qc, action, args)
    } catch {
      // a cached answer of an unexpected shape: the refetch below brings the real one
    }
    for (const queryKey of keys) {
      void qc.invalidateQueries({ queryKey })
      later.set(JSON.stringify(queryKey), queryKey)
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const all = [...later.values()]
      later.clear()
      for (const queryKey of all) void qc.invalidateQueries({ queryKey })
    }, againMs)
  }
}
