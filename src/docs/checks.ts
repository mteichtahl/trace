/**
 * Scribe's quality bar (docs/scribe.md, "Quality bar"): every check a program can make on a document, with the line
 * and section it is about and words a person can act on. An `error` blocks the change; a `warning` is shown with it.
 * Pure: the document text and the project's stage in, findings out.
 */
import type { StageId } from '../core/journey-catalog.js'
import { BASES, DOCS, reached, type DocKind, VALUE_KINDS } from './catalog.js'
import { FIGURES, isFigureKind, mermaidProblem } from './diagrams.js'
import { parseDoc, type Section, VALUE_COLUMNS } from './markers.js'

export type Severity = 'error' | 'warning'

export interface Finding {
  code: string
  severity: Severity
  text: string
  section?: string
  line?: number
}

export interface CheckOptions {
  /** The project's current stage: sections due by it must be written. */
  stage: StageId
}

const FRONT_KEYS = ['project', 'document', 'revision', 'commit', 'updated'] as const

/** Acronyms plain enough to need no explanation. Kept short on purpose. */
const PLAIN = new Set(['OK', 'PDF'])

/** Acronym-shaped words outside code, comments and Mermaid: two or more capitals, digits allowed inside (I2C). */
const ACRONYM = /\b[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*\b/g

function prose(md: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  let fence = false
  let front = md.startsWith('---\n')
  md.split('\n').forEach((raw, i) => {
    const t = raw.trim()
    if (front) { if (i > 0 && t === '---') front = false; return }
    if (t.startsWith('```')) { fence = !fence; return }
    if (fence || t.startsWith('<!--')) return
    out.push({ text: raw.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' '), line: i + 1 })
  })
  return out
}

/** Acronyms used without being spelled out at first use or listed in the glossary. */
export function unexplainedAcronyms(md: string, glossary: string): { word: string; line: number }[] {
  const listed = new Set(glossary.match(ACRONYM) ?? [])
  const first = new Map<string, { line: number; explained: boolean }>()
  for (const { text, line } of prose(md)) {
    for (const m of text.matchAll(ACRONYM)) {
      const w = m[0]
      if (first.has(w)) continue
      const before = text.slice(0, m.index)
      const after = text.slice(m.index! + w.length)
      // "Inter-Integrated Circuit (I2C)" or "I2C (Inter-Integrated Circuit)"
      const explained = (/\w[\w\s-]*\($/.test(before) && after.startsWith(')')) || /^\s*\([a-z][\w\s-]{3,}\)/i.test(after)
      first.set(w, { line, explained })
    }
  }
  return [...first].filter(([w, f]) => !f.explained && !listed.has(w) && !PLAIN.has(w)).map(([word, f]) => ({ word, line: f.line }))
}

function checkSection(kind: DocKind, s: Section, due: boolean, out: Finding[]): void {
  const def = DOCS[kind].sections.find((x) => x.id === s.id)
  if (!def) return
  const at = (code: string, severity: Severity, text: string, line = s.line): void => { out.push({ code, severity, text, section: s.id, line }) }
  if (s.title !== def.title) at('title', 'warning', `the heading should read "${def.title}"`)
  if (s.pending) {
    if (due) at('pending', 'error', `${def.title} is due by now and still pending`)
    return
  }
  const allowed = new Set((def.figures ?? []).map((f) => f.kind))
  for (const f of s.figures) {
    if (!isFigureKind(f.kind)) { at('figure-kind', 'error', `unknown figure kind "${f.kind}"`, f.line); continue }
    if (!allowed.has(f.kind)) at('figure-place', 'error', `a ${f.kind} does not belong in ${def.title}`, f.line)
    if (!f.source) at('figure-source', 'error', `the ${f.kind} does not say where it came from (source="…")`, f.line)
    if (!f.image && f.mermaid === undefined) at('figure-missing', 'error', `the ${f.kind} marker is not followed by an image or a Mermaid block`, f.line)
    if (f.mermaid !== undefined) {
      const p = mermaidProblem(f.kind, f.mermaid)
      if (p) at('mermaid', 'error', p, f.line)
    } else if (f.image && FIGURES[f.kind].maker === 'mermaid') at('figure-maker', 'warning', `a ${f.kind} is written as Mermaid so it can be reviewed; this one is an image`, f.line)
    if (!f.caption) at('caption', 'error', `the ${f.kind} has no caption (an italic line after it saying what it shows)`, f.line)
  }
  if (due) {
    for (const r of (def.figures ?? []).filter((x) => x.required)) {
      if (!s.figures.some((f) => f.kind === r.kind)) at('figure-required', 'error', `${def.title} needs a ${r.kind}: ${FIGURES[r.kind].what}`)
    }
    for (const v of def.values ?? []) {
      if (!s.values.some((t) => t.kind === v)) at('values-required', 'error', `${def.title} needs its ${v} table`)
    }
  }
  for (const t of s.values) {
    if (!(VALUE_KINDS as readonly string[]).includes(t.kind) || !(def.values ?? []).includes(t.kind as never)) {
      at('values-kind', 'error', `a ${t.kind || 'nameless'} table does not belong in ${def.title}`, t.line)
    }
    if (VALUE_COLUMNS.some((c, i) => t.columns[i] !== c)) at('values-columns', 'error', `the ${t.kind} table's columns must be ${VALUE_COLUMNS.join(', ')}`, t.line)
    for (const r of t.rows) {
      const name = r.quantity || 'a row'
      if (!(BASES as readonly string[]).includes(r.basis)) { at('basis', 'error', `${name}: basis must be ${BASES.join(', ')}`, r.line); continue }
      if (r.basis === 'pending') {
        if (/\d/.test(r.value)) at('pending-value', 'error', `${name}: a pending value cannot have a number; write "pending"`, r.line)
        continue
      }
      if (!/\d/.test(r.value)) at('value', 'error', `${name}: a ${r.basis} value needs a number`, r.line)
      if (!r.source) at('source', 'error', `${name}: no source, no number (the run or record it came from)`, r.line)
      if (r.limit && !r.margin) at('margin', 'warning', `${name}: has a limit but no margin`, r.line)
    }
  }
}

/** Every finding on document `kind` written as `md`, for a project at `o.stage`. */
export function checkDoc(kind: DocKind, md: string, o: CheckOptions): Finding[] {
  const d = DOCS[kind]
  const doc = parseDoc(md)
  const out: Finding[] = doc.problems.map((p) => ({ code: 'markers', severity: 'error', text: p.text, line: p.line }))
  if (!doc.front) out.push({ code: 'front', severity: 'error', text: 'the document has no front matter', line: 1 })
  else {
    for (const k of FRONT_KEYS) if (!doc.front[k]) out.push({ code: 'front', severity: 'error', text: `the front matter has no ${k}`, line: 1 })
    if (doc.front.document && doc.front.document !== d.title) out.push({ code: 'front', severity: 'error', text: `the front matter says "${doc.front.document}", not "${d.title}"`, line: 1 })
  }
  const ids = doc.sections.map((s) => s.id)
  for (const s of doc.sections) if (!d.sections.some((x) => x.id === s.id)) out.push({ code: 'section-unknown', severity: 'error', text: `"${s.id}" is not a section of the ${d.title.toLowerCase()}`, section: s.id, line: s.line })
  const known = ids.filter((id) => d.sections.some((x) => x.id === id))
  const order = d.sections.map((x) => x.id).filter((id) => known.includes(id))
  if (known.join() !== order.join()) out.push({ code: 'order', severity: 'warning', text: `sections are out of order; expected ${order.join(', ')}` })
  for (const def of d.sections) {
    const s = doc.sections.find((x) => x.id === def.id)
    const due = reached(o.stage, def.due)
    if (!s) { out.push({ code: 'section-missing', severity: 'error', text: `${def.title} is missing`, section: def.id }); continue }
    checkSection(kind, s, due, out)
  }
  const lines = md.split('\n')
  let fenceStart = -1
  lines.forEach((l, i) => {
    const t = l.trim()
    if (fenceStart < 0 && t === '```mermaid') {
      fenceStart = i
      let k = i - 1
      while (k >= 0 && !lines[k]!.trim()) k--
      if (!/^<!--\s*scribe:figure\b/.test(lines[k]?.trim() ?? '')) out.push({ code: 'figure-marker', severity: 'error', text: 'a Mermaid diagram without a figure marker (kind and source)', line: i + 1 })
    } else if (fenceStart >= 0 && t === '```') fenceStart = -1
  })
  const glossary = doc.sections.find((s) => s.id === 'glossary')?.body ?? ''
  for (const a of unexplainedAcronyms(md, glossary)) {
    out.push({ code: 'acronym', severity: 'error', text: `${a.word} is not spelled out where it first appears or listed in the glossary`, line: a.line })
  }
  return out
}

/** Whether the findings let a change through: no errors. */
export const passes = (f: readonly Finding[]): boolean => !f.some((x) => x.severity === 'error')
