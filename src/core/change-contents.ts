/**
 * What a change holds, said in its title and its "What trace did" summary (test-esp32 log #144, #133).
 *
 * A specialist's finished job commits what its tools wrote to the project's record as "trace: the <kind> specialist's
 * record (<job>)" (src/agents/runtime/job.ts keepRecord). A pull request is titled from its first commit when it is
 * opened (src/harness/prs.ts openPr), and was never titled again: in the test run, change #20 kept the title "trace:
 * the docs specialist's record (…)" while later jobs added the whole case (mechanical/case.py, STEP, STL, 3MF), a
 * schematic field and board text to it. A person reviewing a "record" did not expect design work in it. Another
 * change's summary did not say that it added an intent statement: only its table list did.
 *
 *   recordTitle      a title (or commit subject) that is only a specialist's record, as keepRecord words it, with
 *                    openPr's "(+N more)" after it or not
 *   changeTitle      a change's title from its commit subjects: the first that is not a record, so a change is named
 *                    after the work in it; only records: the first record, as before
 *   betterTitle      the title to show for a change: its own, unless that is a record title and its commits name work
 *   designAreas      the design files it changes (hardware/, mechanical/, firmware/, and KiCad files anywhere), by area
 *   recordChanges    the intent statements and requirements its copy of the project's record adds or changes,
 *                    against the design's copy
 *   contentBullets   the summary's first bullets: the design files it changes, the intent statements and requirements
 *                    it adds or changes
 *
 * Pure (recordChanges reads two open databases).
 */
import type { DatabaseSync } from 'node:sqlite'

/** keepRecord's commit subject, as openPr makes a title of it (with "(+N more)" when there were more commits). */
const RECORD = /^trace: the [\w-]+ specialist's record \([^)]*\)(?: \(\+\d+ more\))?$/

/** Whether a title or commit subject is only a specialist's record (keepRecord). */
export const recordTitle = (s: string): boolean => RECORD.test(s.trim())

const subjectOf = (m: string): string => (m.split('\n')[0] ?? '').trim()

/**
 * A change's title from its commit messages, oldest first: the first subject that is not a record (the work it holds),
 * else the first; "(+N more)" when there are more commits. Empty when there are none.
 */
export function changeTitle(messages: readonly string[]): string {
  const subjects = messages.map(subjectOf).filter(Boolean)
  const first = subjects.find((s) => !recordTitle(s)) ?? subjects[0] ?? ''
  return subjects.length > 1 ? `${first.replace(/\.$/, '')} (+${subjects.length - 1} more)` : first
}

/** The title to show: `title`, unless it is a record title and the commits hold more than records (log #144). */
export function betterTitle(title: string, messages: readonly string[]): string {
  if (!recordTitle(title)) return title
  const t = changeTitle(messages)
  return t && !recordTitle(t) ? t : title
}

export type DesignArea = 'hardware' | 'mechanical' | 'firmware'
const AREAS: readonly DesignArea[] = ['hardware', 'mechanical', 'firmware']

/** The design files among `paths`, by area: under hardware/, mechanical/ or firmware/, and KiCad files anywhere. */
export function designAreas(paths: readonly string[]): { area: DesignArea; files: string[] }[] {
  const by = new Map<DesignArea, string[]>()
  for (const p of paths) {
    const top = p.split('/')[0] as DesignArea
    const area = AREAS.includes(top) ? top : /\.kicad_(sch|pcb|sym|mod|pro)$/i.test(p) ? 'hardware' : null
    if (!area) continue
    by.set(area, [...(by.get(area) ?? []), p])
  }
  return AREAS.filter((a) => by.has(a)).map((area) => ({ area, files: by.get(area) as string[] }))
}

/** One intent statement or requirement a change adds or changes. */
export interface RecordRow { id: string; text: string; status: string | null }
export interface RecordChanges {
  intent: { added: RecordRow[]; changed: RecordRow[] }
  requirements: { added: RecordRow[]; changed: RecordRow[] }
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

const read = (db: DatabaseSync, table: string, cols: readonly string[]): Map<string, Record<string, unknown>> => {
  if (!has(db, table)) return new Map()
  const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
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

/**
 * The intent statements and requirements the change's copy of the project's record (`head`) adds or changes, against
 * the design's (`design`: the default branch's). What a change removes is left out: the requirement edits say that.
 */
export function recordChanges(design: DatabaseSync, head: DatabaseSync): RecordChanges {
  return {
    intent: diff(design, head, 'intent_statements', ['text', 'kind', 'status', 'topic']),
    requirements: diff(design, head, 'requirements', ['text', 'acceptance', 'status']),
  }
}

const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const ids = (rows: readonly RecordRow[]): string => (rows.length <= 6 ? rows.map((r) => r.id).join(', ') : `${rows.slice(0, 6).map((r) => r.id).join(', ')} and ${rows.length - 6} more`)

/** One line for the rows a change adds or changes in one table. */
function rowsLine(verb: 'Adds' | 'Changes', one: string, many: string, rows: readonly RecordRow[]): string[] {
  if (!rows.length) return []
  if (rows.length === 1) {
    const r = rows[0] as RecordRow
    return [`${verb} ${one} ${r.id}${r.status ? ` (${r.status})` : ''}: "${clip(r.text)}"`]
  }
  return [`${verb} ${rows.length} ${many}: ${ids(rows)}`]
}

/**
 * What a change holds, as the first bullets of its summary: the design files it changes, by area, and the intent
 * statements and requirements its record adds or changes (null: its record could not be read, or it carries none).
 */
export function contentBullets(o: { paths: readonly string[]; record: RecordChanges | null }): string[] {
  const areas = designAreas(o.paths)
  const out: string[] = []
  if (areas.length) {
    const parts = areas.map((a) => `${a.files.length} ${a.area} ${a.files.length === 1 ? 'file' : 'files'}`)
    out.push(`Changes the design: ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}`)
  }
  const r = o.record
  if (r) {
    out.push(...rowsLine('Adds', 'intent statement', 'intent statements', r.intent.added))
    out.push(...rowsLine('Changes', 'intent statement', 'intent statements', r.intent.changed))
    out.push(...rowsLine('Adds', 'requirement', 'requirements', r.requirements.added))
    out.push(...rowsLine('Changes', 'requirement', 'requirements', r.requirements.changed))
  }
  return out
}
