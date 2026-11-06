/**
 * What a change holds, said in its title and its "What trace did" summary (test-esp32 log #144, #133, #14, #59, #154,
 * #18, #27, #37).
 *
 * A specialist's finished job commits what its tools wrote to the project's record as "trace: the <kind> specialist's
 * record (<job>)" (src/agents/runtime/job.ts keepRecord). A pull request is titled from its first commit when it is
 * opened (src/harness/prs.ts openPr), and was never titled again: in the test run, change #20 kept the title "trace:
 * the docs specialist's record (…)" while later jobs added the whole case (mechanical/case.py, STEP, STL, 3MF), a
 * schematic field and board text to it. A person reviewing a "record" did not expect design work in it. Another
 * change's summary did not say that it added an intent statement: only its table list did.
 *
 * A change that holds only a record was titled by its job's id ("trace: the verify specialist's record
 * (job-mw2jvo2g-…)"), and one brought up to date by a merge commit ("Merge claude/handoff-… into claude/handoff-…
 * (trace: the project database merged)"), and its "What trace did" repeated that title. A verify record's 17 test
 * results, an architecture change's three options and how they differ, were only findable in the database diff. Now
 * such a change is named and summarised by what its record adds, table by table.
 *
 *   recordTitle      a title (or commit subject) that is only a specialist's record, as keepRecord words it (with
 *                    openPr's "(+N more)" after it or not), or as trace names one ("The verify specialist's record…")
 *   mergeTitle       a merge commit's subject, git's or trace's
 *   plumbingTitle    either: a title that says nothing of the work
 *   changeTitle      a change's title from its commit subjects: the first that is neither, so a change is named after
 *                    the work in it; only records and merges: "The <kind> specialist's record", never a job's id
 *   betterTitle      the title to show for a change: its own, unless that says nothing of the work; then its commits'
 *                    work, else the record's name with what the record holds (contentPhrase)
 *   designAreas      the design files it changes (hardware/, mechanical/, firmware/, and KiCad files anywhere), by area
 *   recordChanges    what its copy of the project's record adds or changes against the design's copy: intent
 *                    statements and requirements row by row, the other design tables by count, architecture options
 *                    with what sets them apart
 *   contentBullets   the summary's first bullets: the files it changes, then what its record adds or changes
 *   contentPhrase    a few words of that for a title: "17 test results and 39 tests"
 *
 * Pure (recordChanges reads two open databases).
 */
import type { DatabaseSync } from 'node:sqlite'

/** keepRecord's commit subject, as openPr makes a title of it (with "(+N more)" when there were more commits). */
const RECORD = /^trace: the [\w-]+ specialist's record \([^)]*\)(?: \(\+\d+ more\))?$/
/** The name trace gives a change that holds only records (recordName). */
const PLAIN_RECORD = /^The (?:[\w -]+ )?specialist's record(?:: .*)?$/
/**
 * A merge commit's subject: git's own ("Merge branch 'main' into …", "Merge pull request #3 from …", "Merge
 * remote-tracking branch …") and trace's when it brings a branch up to date ("Merge claude/a into claude/b (trace: the
 * project database merged)"), with openPr's "(+N more)" after it or not (test-esp32 log #154).
 */
const MERGE = /^Merge (?:branch |pull request |remote-tracking branch |commit |[\w./'-]+ into )/

/** Whether a title or commit subject is only a specialist's record (keepRecord), or the name trace gives one. */
export const recordTitle = (s: string): boolean => RECORD.test(s.trim()) || PLAIN_RECORD.test(s.trim())

/** Whether a title or commit subject is a merge commit's. */
export const mergeTitle = (s: string): boolean => MERGE.test(s.trim())

/** Whether a title or commit subject says nothing of the work: a specialist's record, or a merge (log #154). */
export const plumbingTitle = (s: string): boolean => recordTitle(s) || mergeTitle(s)

/** The specialist a record names ("verify" in "trace: the verify specialist's record (job-…)"), or null. */
export const recordKind = (s: string): string | null => /^(?:trace: the|The) ([\w-]+) specialist's record/.exec(s.trim())?.[1] ?? null

const subjectOf = (m: string): string => (m.split('\n')[0] ?? '').trim()

/** The specialists whose kind is not their name, in words (as src/api/actions-jobs.ts AGENT_WORDS says them). */
const KIND_WORDS: Readonly<Record<string, string>> = { verify: 'verification', impl: 'implementation', ams: 'analog and mixed-signal', emc: 'EMC' }

/** "The verification specialist's record", with what it holds when known: never its job's id (log #14, #59). */
export const recordName = (kind: string | null, holds?: string | null): string =>
  `${kind ? `The ${KIND_WORDS[kind] ?? kind} specialist's record` : "The specialist's record"}${holds ? `: ${holds}` : ''}`

/**
 * A change's title from its commit messages, oldest first: the first subject that is not a record or a merge (the
 * work it holds), with "(+N more)" when there are more commits; only records and merges: the record's name, without
 * its job's id. Empty when there are none.
 */
export function changeTitle(messages: readonly string[]): string {
  const subjects = messages.map(subjectOf).filter(Boolean)
  if (!subjects.length) return ''
  const work = subjects.find((s) => !plumbingTitle(s))
  if (work) return subjects.length > 1 ? `${work.replace(/\.$/, '')} (+${subjects.length - 1} more)` : work
  return recordName(subjects.map(recordKind).find(Boolean) ?? null)
}

/**
 * The title to show: `title`, unless it says nothing of the work (a record's or a merge commit's, log #144, #154).
 * Then the work its commits name; else the record's name, from its commits or `kind` (the specialist whose change it
 * is), with what it holds (`holds`: contentPhrase).
 */
export function betterTitle(title: string, messages: readonly string[], o: { holds?: string | null; kind?: string | null } = {}): string {
  if (!plumbingTitle(title)) return title
  const t = changeTitle(messages)
  if (t && !plumbingTitle(t)) return t
  const kind = [title, ...messages.map(subjectOf)].map(recordKind).find(Boolean) ?? o.kind ?? null
  return recordName(kind, o.holds)
}

export type DesignArea = 'hardware' | 'mechanical' | 'firmware'
const AREAS: readonly DesignArea[] = ['hardware', 'mechanical', 'firmware']

/** The design files among `paths`, by area: under hardware/, mechanical/ or firmware/, and KiCad files anywhere. */
export function designAreas(paths: readonly string[]): { area: DesignArea; files: string[] }[] {
  const by = new Map<DesignArea, string[]>()
  for (const p of paths) {
    const area = areaOf(p)
    if (!area) continue
    by.set(area, [...(by.get(area) ?? []), p])
  }
  return AREAS.filter((a) => by.has(a)).map((area) => ({ area, files: by.get(area) as string[] }))
}

/**
 * What a change carries, from its files: only the project's record ('record': a finished job's runs, as keepRecord
 * commits them), only the documents with or without the record ('docs'), or anything else ('design'). None: 'design',
 * since nothing says otherwise. The first two hold no design content, so they do not hold a gate (src/core/journey.ts
 * pendingBlockers): in the test run a thermal job's record, a re-run's record and a documents update each locked the
 * next gate for accept-and-wait (test-esp32 #101, #116).
 */
export type ChangeContent = 'record' | 'docs' | 'design'
export function changeContent(paths: readonly string[]): ChangeContent {
  if (!paths.length) return 'design'
  if (paths.every((p) => p === '.trace/project.db')) return 'record'
  return paths.every((p) => p === '.trace/project.db' || p.startsWith('docs/design/')) ? 'docs' : 'design'
}

const areaOf = (p: string): DesignArea | null => {
  const top = p.split('/')[0] as DesignArea
  return AREAS.includes(top) ? top : /\.kicad_(sch|pcb|sym|mod|pro)$/i.test(p) ? 'hardware' : null
}

/** One intent statement or requirement a change adds or changes. */
export interface RecordRow { id: string; text: string; status: string | null }
/** How many rows of one design table a change adds and changes, and their statuses (status: count). */
export interface TableChange { table: string; one: string; many: string; added: number; changed: number; statuses: Record<string, number> }
/** An architecture option, as the change's record holds it. */
export interface OptionRow { id: string; name: string; recommended: boolean; why: string | null }
/** The architecture options a change adds or changes: all of them, and the blocks whose parts set them apart. */
export interface OptionsChange {
  added: number
  options: OptionRow[]
  differ: { block: string; by: { option: string; parts: string }[] }[]
}
export interface RecordChanges {
  intent: { added: RecordRow[]; changed: RecordRow[] }
  requirements: { added: RecordRow[]; changed: RecordRow[] }
  /** the other design tables, in TABLES order, those it adds to or changes only */
  tables?: TableChange[]
  /** null: it adds or changes no architecture option */
  options?: OptionsChange | null
}

/**
 * The design tables of the project's record said by what they hold (singular, plural), in the order they are said.
 * Intent statements and requirements are said row by row, and architecture options with what sets them apart, so
 * they are not here; nor is bookkeeping (tool runs, the journey, settings), which is not design.
 */
export const TABLES: Readonly<Record<string, readonly [string, string]>> = {
  requirement_intent: ['link from a requirement to its intent', 'links from requirements to their intent'],
  arch_criteria: ['architecture criterion', 'architecture criteria'],
  arch_scores: ['option score', 'option scores'],
  arch_blocks: ['architecture block', 'architecture blocks'],
  arch_connections: ['architecture connection', 'architecture connections'],
  design_decisions: ['design decision', 'design decisions'],
  pin_plan: ['pin assignment', 'pin assignments'],
  sheet_requirements: ['schematic sheet', 'schematic sheets'],
  parts_list_lines: ['parts list line', 'parts list lines'],
  protocol_specs: ['protocol description', 'protocol descriptions'],
  ams_specs: ['analog or mixed-signal specification', 'analog and mixed-signal specifications'],
  thermal_budget: ['thermal budget line', 'thermal budget lines'],
  thermal_envelopes: ['thermal envelope', 'thermal envelopes'],
  thermal_part_limits: ['part temperature limit', 'part temperature limits'],
  thermal_derating: ['derating rule', 'derating rules'],
  thermal_corrections: ['thermal correction', 'thermal corrections'],
  board_checks: ['board check', 'board checks'],
  test_items: ['test', 'tests'],
  test_results: ['test result', 'test results'],
  coverage_points: ['coverage point', 'coverage points'],
  waivers: ['waiver', 'waivers'],
  bringup_readings: ['bring-up reading', 'bring-up readings'],
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const columns = (db: DatabaseSync, t: string): { name: string; pk: number }[] => db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[]

const read = (db: DatabaseSync, table: string, cols: readonly string[]): Map<string, Record<string, unknown>> => {
  if (!has(db, table)) return new Map()
  const names = new Set(columns(db, table).map((c) => c.name))
  const pick = ['id', ...cols].filter((c) => names.has(c))
  return new Map((db.prepare(`SELECT ${pick.join(', ')} FROM ${table}`).all() as Record<string, unknown>[]).map((r) => [String(r.id), r]))
}

const diff = (design: DatabaseSync, head: DatabaseSync, table: string, cols: readonly string[]): { added: RecordRow[]; changed: RecordRow[] } => {
  const ours = read(design, table, cols)
  const theirs = read(head, table, cols)
  const row = (id: string, r: Record<string, unknown>): RecordRow => ({ id, text: String(r.text ?? ''), status: r.status === null || r.status === undefined ? null : String(r.status) })
  const added: RecordRow[] = []
  const changed: RecordRow[] = []
  for (const [id, r] of theirs) {
    const m = ours.get(id)
    if (!m) added.push(row(id, r))
    else if (cols.some((c) => (m[c] ?? null) !== (r[c] ?? null))) changed.push(row(id, r))
  }
  return { added, changed }
}

/** The rows of `table` that `head` adds and changes against `design`, by its primary key (whole rows compared). */
function rowsDiff(design: DatabaseSync, head: DatabaseSync, table: string): { added: Record<string, unknown>[]; changed: Record<string, unknown>[] } {
  if (!has(head, table)) return { added: [], changed: [] }
  const cols = columns(head, table)
  const key = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  if (!key.length) return { added: [], changed: [] }
  const keyOf = (r: Record<string, unknown>): string => JSON.stringify(key.map((k) => r[k] ?? null))
  const valueOf = (r: Record<string, unknown>): string => JSON.stringify(cols.map((c) => { const v = r[c.name] ?? null; return v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v }))
  const ours = new Map(has(design, table) ? (design.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((r) => [keyOf(r), valueOf(r)]) : [])
  const added: Record<string, unknown>[] = []
  const changed: Record<string, unknown>[] = []
  for (const r of head.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
    const m = ours.get(keyOf(r))
    if (m === undefined) added.push(r)
    else if (m !== valueOf(r)) changed.push(r)
  }
  return { added, changed }
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** A block's parts, "AMS1117-3.3 + 2 capacitors" as its JSON lists them: their part numbers, joined. */
const partsOf = (v: unknown): string => {
  try {
    const xs = JSON.parse(str(v) || '[]') as { mpn?: unknown }[]
    return Array.isArray(xs) ? xs.map((x) => str(x?.mpn)).filter(Boolean).join(' + ') : ''
  } catch { return '' }
}

/** The architecture options in `head` (all of them, when the change adds or changes one), and what sets them apart. */
function optionsChange(design: DatabaseSync, head: DatabaseSync): OptionsChange | null {
  const d = rowsDiff(design, head, 'arch_options')
  if (!d.added.length && !d.changed.length) return null
  const options = (head.prepare('SELECT * FROM arch_options ORDER BY id').all() as Record<string, unknown>[])
    .filter((r) => !['rejected', 'withdrawn'].includes(str(r.status)))
    .map((r) => ({ id: str(r.id), name: str(r.name), recommended: Number(r.recommended ?? 0) === 1, why: str(r.why) || null }))
  const differ: OptionsChange['differ'] = []
  if (options.length > 1 && has(head, 'arch_blocks')) {
    const blocks = head.prepare('SELECT * FROM arch_blocks ORDER BY option, id').all() as Record<string, unknown>[]
    const ids = [...new Set(blocks.map((b) => str(b.id)))]
    for (const id of ids) {
      const by = options.map((o) => {
        const b = blocks.find((x) => str(x.option) === o.id && str(x.id) === id && !['rejected', 'withdrawn'].includes(str(x.status)))
        return { option: o.id, parts: b ? partsOf(b.parts) || str(b.name) : '', name: b ? str(b.name) : '' }
      })
      if (new Set(by.map((x) => x.parts)).size < 2) continue
      differ.push({ block: by.find((x) => x.name)?.name ?? id, by: by.map(({ option, parts }) => ({ option, parts })) })
    }
  }
  return { added: d.added.length, options, differ }
}

/**
 * What the change's copy of the project's record (`head`) adds or changes, against the design's (`design`: the
 * default branch's, or the change it is stacked on). What a change removes is left out: the requirement edits say that.
 */
export function recordChanges(design: DatabaseSync, head: DatabaseSync): RecordChanges {
  const tables: TableChange[] = []
  for (const [table, [one, many]] of Object.entries(TABLES)) {
    const d = rowsDiff(design, head, table)
    if (!d.added.length && !d.changed.length) continue
    const statuses: Record<string, number> = {}
    for (const r of [...d.added, ...d.changed]) if (r.status !== undefined && r.status !== null) statuses[str(r.status)] = (statuses[str(r.status)] ?? 0) + 1
    tables.push({ table, one, many, added: d.added.length, changed: d.changed.length, statuses })
  }
  return {
    intent: diff(design, head, 'intent_statements', ['text', 'kind', 'status', 'topic']),
    requirements: diff(design, head, 'requirements', ['text', 'acceptance', 'status']),
    tables,
    options: optionsChange(design, head),
  }
}

const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const ids = (rows: readonly RecordRow[]): string => (rows.length <= 6 ? rows.map((r) => r.id).join(', ') : `${rows.slice(0, 6).map((r) => r.id).join(', ')} and ${rows.length - 6} more`)
const andList = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** One line for the rows a change adds or changes in one table. */
function rowsLine(verb: 'Adds' | 'Changes', one: string, many: string, rows: readonly RecordRow[]): string[] {
  if (!rows.length) return []
  if (rows.length === 1) {
    const r = rows[0] as RecordRow
    return [`${verb} ${one} ${r.id}${r.status ? ` (${r.status})` : ''}: "${clip(r.text)}"`]
  }
  return [`${verb} ${rows.length} ${many}: ${ids(rows)}`]
}

const STATUS_WORDS: Readonly<Record<string, string>> = { pass: 'passed', fail: 'failed', error: 'could not run', blocked: 'blocked', planned: 'planned', waived: 'waived' }

/** "(17 passed, 22 planned)": the statuses of a table's rows, when they have one. */
const statusWords = (s: Record<string, number>): string => {
  const parts = Object.entries(s).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${STATUS_WORDS[k] ?? k}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

/** "Adds 3 architecture options: …", how they differ, and which one is recommended (log #37). */
function optionLines(o: OptionsChange): string[] {
  if (!o.options.length) return []
  const verb = o.added ? 'Adds' : 'Changes'
  const names = o.options.map((x) => `${x.id} ${x.name}`.trim())
  const out = [o.options.length === 1 ? `${verb} architecture option ${names[0]}` : `${verb} ${o.options.length} architecture options: ${andList(names)}`]
  if (o.differ.length) {
    const said = o.differ.slice(0, 3).map((d) => `${d.block} (${d.by.map((b) => `${b.option}: ${b.parts || 'none'}`).join(', ')})`)
    out.push(`They differ in ${andList(o.differ.length > 3 ? [...said, `${o.differ.length - 3} more blocks`] : said)}`)
  }
  const rec = o.options.find((x) => x.recommended)
  if (rec) out.push(`Recommends ${rec.id}${rec.why ? `: ${clip(rec.why, 200)}` : ''}`)
  return out
}

/**
 * What a change holds, as the first bullets of its summary: the files it changes (design files by area, then the
 * others), the intent statements and requirements its record adds or changes, its architecture options, and the
 * other design tables it adds to or changes, by count (null: its record could not be read, or it carries none).
 */
export function contentBullets(o: { paths: readonly string[]; record: RecordChanges | null }): string[] {
  const areas = designAreas(o.paths)
  const out: string[] = []
  if (areas.length) {
    const parts = areas.map((a) => count(a.files.length, `${a.area} file`, `${a.area} files`))
    out.push(`Changes the design: ${andList(parts)}`)
  }
  // the project's record itself is said by what it holds, below
  const other = o.paths.filter((p) => !areaOf(p) && !p.startsWith('.trace/'))
  if (other.length) out.push(`Changes ${count(other.length, 'other file', 'other files')}: ${other.length <= 3 ? other.join(', ') : `${other.slice(0, 3).join(', ')} and ${other.length - 3} more`}`)
  const r = o.record
  if (r) {
    out.push(...rowsLine('Adds', 'intent statement', 'intent statements', r.intent.added))
    out.push(...rowsLine('Changes', 'intent statement', 'intent statements', r.intent.changed))
    out.push(...rowsLine('Adds', 'requirement', 'requirements', r.requirements.added))
    out.push(...rowsLine('Changes', 'requirement', 'requirements', r.requirements.changed))
    if (r.options) out.push(...optionLines(r.options))
    for (const t of r.tables ?? []) {
      // the statuses said once: on the line for what it adds, or for what it changes when it adds none
      if (t.added) out.push(`Adds ${count(t.added, t.one, t.many)}${t.changed ? '' : statusWords(t.statuses)}`)
      if (t.changed) out.push(`Changes ${count(t.changed, t.one, t.many)}${t.added ? '' : statusWords(t.statuses)}`)
    }
  }
  return out
}

/**
 * A few words of what a change's record holds, for its title when nothing else names it: "17 test results and 39
 * tests", "3 architecture options". Empty when it holds nothing said here.
 */
export function contentPhrase(o: { paths: readonly string[]; record: RecordChanges | null }): string {
  const r = o.record
  const parts: string[] = []
  if (r?.options?.options.length) parts.push(count(r.options.options.length, 'architecture option', 'architecture options'))
  const intent = (r?.intent.added.length ?? 0) + (r?.intent.changed.length ?? 0)
  if (intent) parts.push(count(intent, 'intent statement', 'intent statements'))
  const reqs = (r?.requirements.added.length ?? 0) + (r?.requirements.changed.length ?? 0)
  if (reqs) parts.push(count(reqs, 'requirement', 'requirements'))
  // what goes with a requirement or an option is not said again in a title
  const along = (t: string): boolean => t === 'requirement_intent' || (Boolean(r?.options) && t.startsWith('arch_'))
  for (const t of r?.tables ?? []) if (!along(t.table)) parts.push(count(t.added + t.changed, t.one, t.many))
  for (const a of designAreas(o.paths)) parts.push(count(a.files.length, `${a.area} file`, `${a.area} files`))
  return andList(parts.slice(0, 3))
}

/** The ids of the requirements a change's record adds or changes: the requirements it names (log #27). */
export const recordRequirementIds = (r: RecordChanges | null): string[] => (r ? [...r.requirements.added, ...r.requirements.changed].map((x) => x.id) : [])
