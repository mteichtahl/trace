/**
 * Scribe's own tools (docs/scribe.md "How it stays current"): what a change made stale, the documents a stage needs,
 * and writing one section between its markers. Scribe is a specialist, so it has no file tools of its own: these
 * write the documents in its checkout, and the worker it delegates to commits them as a stacked change.
 *
 *   docs.stale          the sections a change touched: its files and its project database compared with the
 *                       commit before (src/docs/stale.ts), for every document the project keeps
 *   docs.init           a skeleton for each document the stage needs that the repository does not have yet (the
 *                       protocol specification only once the project has an interface: a protocol spec or model)
 *   docs.write_section  one section's new body, held to the quality bar for that section before it is written; the
 *                       front matter's commit and date follow. Text outside the section's markers is never touched
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { STAGE_IDS, type StageId } from '../../core/journey-catalog.js'
import { type AnyTool, defineTool, ToolError } from '../../core/registry.js'
import { openProject } from '../../core/store.js'
import { DOC_KINDS, DOCS, docsFor, type DocKind, skeleton, SOURCE_KINDS } from '../../docs/catalog.js'
import { checkDoc } from '../../docs/checks.js'
import { parseDoc, replaceSection, setFront } from '../../docs/markers.js'
import { sourcesOfDatabases, sourcesOfPaths, staleSections } from '../../docs/stale.js'

const DB = '.trace/project.db'
const git = (root: string, args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const commitOk = /^[0-9A-Za-z_./~^-]{1,200}$/

/** The project database as it was at `rev`, opened read-only from a temporary copy (null when it was not there). */
function dbAt(root: string, rev: string): { db: DatabaseSync | null; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-docs-db-'))
  try {
    const bytes = execFileSync('git', ['show', `${rev}:${DB}`], { cwd: root, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    writeFileSync(join(dir, 'p.db'), bytes)
    const db = new DatabaseSync(join(dir, 'p.db'), { readOnly: true })
    return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return { db: null, done: () => {} }
  }
}

/** The oldest commit any document says it was written at (its front matter) that this checkout has, else HEAD~1. */
export function documentsBase(root: string): string {
  const commits: string[] = []
  for (const k of DOC_KINDS) {
    const f = join(root, DOCS[k].file)
    if (!existsSync(f)) continue
    const c = parseDoc(readFileSync(f, 'utf8')).front?.commit
    if (!c || !/^[0-9a-f]{4,40}$/.test(c)) continue
    try { execFileSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: root, stdio: 'ignore' }); commits.push(c) } catch { /* not in this history */ }
  }
  if (!commits.length) return 'HEAD~1'
  // the oldest: the one every other is a descendant of, else the first that is no one's descendant
  return commits.find((c) => commits.every((o) => o === c || isAncestor(root, c, o))) ?? commits[0]!
}

const isAncestor = (root: string, a: string, b: string): boolean => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' }); return true } catch { return false }
}

/** Whether the project has an interface to specify: a protocol spec or a protocol model. */
export function hasInterfaces(): boolean {
  const db = openProject()
  try {
    const n = (sql: string): number => { try { return (db.prepare(sql).get() as { n: number }).n } catch { return 0 } }
    return n('SELECT count(*) AS n FROM protocol_specs') > 0 || n("SELECT count(*) AS n FROM runs WHERE kind='protocol.model'") > 0
  } finally {
    db.close()
  }
}

const stale = defineTool({
  name: 'docs.stale',
  description: 'Which sections of the project\'s documents a change touched: the files changed between two commits and the project database\'s tables compared between them, mapped to the records each section is written from. Returns each document with the sections to write again and the records that marked each; also the documents the stage needs that do not exist yet.',
  input: z.object({
    base: z.string().regex(commitOk).optional().describe('the commit to compare with (a stacked change: its base branch); default: the commit the documents were last written at (their front matter), so every change since, missed or not, is seen'),
    head: z.string().regex(commitOk).default('HEAD'),
    stage: z.enum(STAGE_IDS).describe('the project\'s current stage: which documents it needs'),
    also: z.array(z.enum(SOURCE_KINDS)).max(SOURCE_KINDS.length).default([]).describe('records that changed outside the repository, as your request names them (a gate signed changes the journey): their sections are written again too'),
  }),
  run: (a) => {
    const root = process.cwd()
    const base = a.base ?? documentsBase(root)
    let paths: string[] = []
    try { paths = git(root, ['diff', '--name-only', base, a.head]).split('\n').filter(Boolean) } catch { throw new ToolError(`cannot compare ${base} with ${a.head}: is ${base} in this checkout?`) }
    const sources = sourcesOfPaths(paths)
    for (const r of a.also) sources.add(r)
    if (paths.includes(DB)) {
      const before = dbAt(root, base)
      const after = dbAt(root, a.head)
      try { sourcesOfDatabases(before.db, after.db).forEach((s) => sources.add(s)) } finally { before.done(); after.done() }
    }
    const due = docsFor(a.stage as StageId, hasInterfaces()).map((d) => d.kind)
    const docs = staleSections(sources, DOC_KINDS.filter((k) => due.includes(k) || existsSync(join(root, DOCS[k].file))))
    return {
      base,
      changed: paths.filter((p) => !p.startsWith('docs/design/')),
      records: [...sources].sort(),
      documents: docs.map((d) => ({ kind: d.kind, file: DOCS[d.kind].file, exists: existsSync(join(root, DOCS[d.kind].file)), sections: d.sections })),
      missing: due.filter((k) => !existsSync(join(root, DOCS[k].file))),
    }
  },
})

const init = defineTool({
  name: 'docs.init',
  description: 'Start each document the project\'s stage needs that the repository does not have yet: a skeleton with its front matter and every section pending, saying what it needs. The protocol specification only once the project has an interface (a protocol spec or model). Never replaces a document.',
  input: z.object({ stage: z.enum(STAGE_IDS), project: z.string().min(1).max(120).describe('the project\'s name, for the title and cover'), revision: z.string().regex(/^[A-Z]{1,3}$/).default('A') }),
  run: (a) => {
    const root = process.cwd()
    const commit = git(root, ['rev-parse', '--short=12', 'HEAD'])
    const date = new Date().toISOString().slice(0, 10)
    const created: string[] = []
    for (const d of docsFor(a.stage as StageId, hasInterfaces())) {
      const file = join(root, d.file)
      if (existsSync(file)) continue
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${skeleton(d.kind, { project: a.project, revision: a.revision, commit, date })}\n`, { flag: 'wx' })
      created.push(d.file)
    }
    return { created, note: created.length ? 'Each section is pending: write the ones due by this stage with docs.write_section.' : 'Every document this stage needs is there already.' }
  },
})

const writeSection = defineTool({
  name: 'docs.write_section',
  description: 'Write one section of a project document: its whole new body, from its heading down, between its markers. The section is checked against the quality bar first (figures with kind, source and caption, values with a basis and source, acronyms spelled out or in the glossary) and refused with the findings if it fails; text outside its markers is never touched. The front matter\'s commit and date follow.',
  input: z.object({
    doc: z.enum(DOC_KINDS),
    section: z.string().regex(/^[a-z0-9-]+$/),
    body: z.string().min(1).max(60_000).describe('the section\'s markdown, starting with its "## Title" heading'),
    stage: z.enum(STAGE_IDS).describe('the project\'s current stage'),
  }),
  run: (a) => {
    const root = process.cwd()
    const def = DOCS[a.doc as DocKind]
    const file = join(root, def.file)
    if (!existsSync(file)) throw new ToolError(`${def.file} does not exist yet: run docs.init`)
    if (!def.sections.some((s) => s.id === a.section)) throw new ToolError(`"${a.section}" is not a section of the ${def.title.toLowerCase()} (${def.sections.map((s) => s.id).join(', ')})`)
    if (/<!--\s*scribe:(section|end)\b/.test(a.body)) throw new ToolError('the body must not hold section markers: give only what goes between them')
    const before = readFileSync(file, 'utf8')
    let after = replaceSection(before, a.section, a.body)
    after = setFront(setFront(after, 'commit', git(root, ['rev-parse', '--short=12', 'HEAD'])), 'updated', new Date().toISOString().slice(0, 10))
    const findings = checkDoc(a.doc as DocKind, after, { stage: a.stage as StageId })
      .filter((f) => f.section === a.section || (f.code === 'acronym' && sectionHasLine(after, a.section, f.line)) || (f.code === 'figure-marker' && sectionHasLine(after, a.section, f.line)))
    const errors = findings.filter((f) => f.severity === 'error')
    if (errors.length) return { written: false, errors, warnings: findings.filter((f) => f.severity === 'warning') }
    writeFileSync(file, after)
    const s = parseDoc(after).sections.find((x) => x.id === a.section)!
    return { written: true, file: def.file, section: a.section, pending: s.pending, figures: s.figures.length, values: s.values.reduce((n, t) => n + t.rows.length, 0), warnings: findings }
  },
})

/** Whether a 1-based line of `md` falls inside section `id`. */
function sectionHasLine(md: string, id: string, line?: number): boolean {
  if (!line) return false
  const s = parseDoc(md).sections.find((x) => x.id === id)
  return !!s && line > s.line && line <= s.line + s.body.split('\n').length + 1
}

export const scribeTools: AnyTool[] = [stale, init, writeSection]
