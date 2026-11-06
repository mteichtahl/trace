/**
 * The release report's other sections, beside coverage (verify.report): interference, the parts list and the open
 * waivers, read from the record as it stands.
 *
 * The Sign-off gate's report criterion reads "The release report is reviewed: coverage, interference estimates, parts
 * list and open waivers." A report of coverage alone said "Open items: None" while 17 waivers stood (test-esp32 #207).
 *
 *   interference   the newest emc.precheck run with its findings, and the newest spectrum, field-solver and signal
 *                  integrity runs, each a pre-compliance estimate; whether signoff.emc or any of its findings is waived
 *   parts list     the newest parts.bom_check run: its lines (parts_list_lines), cost for the boards it checked, stock,
 *                  set against the build quantity of the build plan
 *   open waivers   every waiver not closed: id, what it is on, severity, where it is caught instead, scope
 *
 * The waivers are the journey record's. Without one in reach the report says so, and never says there is nothing open.
 */
import type { DatabaseSync } from 'node:sqlite'
import { SEVERITIES, type JourneyRecord, type WaiverRow } from '../../core/journey.js'
import { storedRef, unpackArtifact } from '../../core/store.js'
import { waiverCriterion, waiverTargetWords } from '../../core/waiver-words.js'

export interface RunRef { id: string; kind: string; subject: string | null; status: string; summary: string | null; started: number }

export interface CriterionState { id: string; text: string; status: 'met' | 'not_met' | 'waived'; waivers: string[] }

export interface PrecheckFinding { severity: string; rule: string; net: string | null; message: string }

export interface ReleaseFacts {
  /** where the waivers were read from: the journey store, the checkout's copy, or nowhere */
  record: 'live' | 'checkout' | null
  interference: {
    /** false: the project has no interference criterion (no board), so the section says so */
    applies: boolean
    criterion: CriterionState | null
    precheck: (RunRef & { counts: Record<string, number> | null; findings: PrecheckFinding[] }) | null
    estimates: RunRef[]
    /** open waivers on the criterion's findings */
    waivedFindings: WaiverRow[]
  }
  parts: {
    criterion: CriterionState | null
    quantity: number | null
    check: (RunRef & { boards: number | null; total: number | null; currency: string | null; blocking: number | null; unpriced: number | null }) | null
    lines: { line: number; part: string; refs: string | null; need: number; stock: number | null; status: string; flags: string[]; unit_price: number | null; line_total: number | null; currency: string | null }[]
  }
  waivers: WaiverRow[]
  criterionText: Record<string, string>
}

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return null
  try { return JSON.parse(v) } catch { return null }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function runRows(db: DatabaseSync, kind: string, limit: number): (RunRef & { result: unknown })[] {
  if (!hasTable(db, 'runs')) return []
  return (db.prepare("SELECT id, kind, subject, status, summary, started, result FROM runs WHERE kind=? AND status IN ('pass','fail') ORDER BY started DESC LIMIT ?").all(kind, limit) as Record<string, unknown>[])
    .map((r) => ({
      id: String(r.id), kind: String(r.kind), subject: r.subject === null ? null : String(r.subject), status: String(r.status),
      summary: r.summary === null ? null : String(r.summary), started: Number(r.started), result: json(r.result),
    }))
}

function artifactText(db: DatabaseSync, run: string, name: string): string | null {
  if (!hasTable(db, 'artifacts')) return null
  const row = db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(run, name) as { mime: string | null; bytes: Uint8Array | null } | undefined
  // one kept in the bucket (storedRef) has no bytes here: the run's result still carries the first findings
  if (!row?.bytes || !row.bytes.length || storedRef(row.mime)) return null
  return new TextDecoder().decode(unpackArtifact(row.mime, row.bytes).bytes)
}

/** Waivers that stand: not closed. */
export const standing = (rec: JourneyRecord | null): WaiverRow[] => (rec?.waivers ?? []).filter((w) => w.closedAt === null)

function criterion(rec: JourneyRecord | null, id: string): CriterionState | null {
  const c = rec?.criteria.find((x) => x.id === id)
  if (!c) return null
  const on = standing(rec).filter((w) => w.targetKind === 'criterion' && w.target === id).map((w) => w.id)
  return { id, text: c.text, status: on.length ? 'waived' : c.status, waivers: on }
}

/** What the release report needs beside coverage, from the project database and the journey record. */
export function releaseFacts(db: DatabaseSync, rec: JourneyRecord | null, record: ReleaseFacts['record']): ReleaseFacts {
  const waivers = standing(rec)
  const emc = criterion(rec, 'signoff.emc')
  const pre = runRows(db, 'emc.precheck', 1)[0]
  let precheck: ReleaseFacts['interference']['precheck'] = null
  if (pre) {
    const counts = (pre.result as { counts?: Record<string, number> } | null)?.counts ?? null
    const all = json(artifactText(db, pre.id, 'findings.json'))
    const findings = (Array.isArray(all) ? all as Record<string, unknown>[] : (pre.result as { findings?: Record<string, unknown>[] } | null)?.findings ?? [])
      .map((f) => ({ severity: String(f.severity ?? ''), rule: String(f.rule ?? ''), net: typeof f.net === 'string' ? f.net : null, message: String(f.message ?? '') }))
    const { result: _r, ...ref } = pre
    precheck = { ...ref, counts, findings }
  }
  const estimates = ['emc.spectrum', 'emc.run', 'emc.si'].flatMap((k) => runRows(db, k, 5)).sort((a, b) => b.started - a.started).map(({ result: _r, ...ref }) => ref)
  const bom = runRows(db, 'parts.bom_check', 1)[0]
  let check: ReleaseFacts['parts']['check'] = null
  let lines: ReleaseFacts['parts']['lines'] = []
  if (bom) {
    const r = (bom.result ?? {}) as Record<string, unknown>
    const { result: _r, ...ref } = bom
    check = { ...ref, boards: num(r.boards), total: num(r.total), currency: typeof r.currency === 'string' ? r.currency : null, blocking: num(r.blocking), unpriced: num(r.unpriced) }
    if (hasTable(db, 'parts_list_lines')) {
      lines = (db.prepare('SELECT * FROM parts_list_lines WHERE run_id=? ORDER BY line').all(bom.id) as Record<string, unknown>[]).map((l) => ({
        line: Number(l.line), part: String(l.mpn ?? l.order_code ?? '—'), refs: l.refs === null ? null : String(l.refs), need: Number(l.need),
        stock: num(l.stock), status: String(l.status), flags: (json(l.flags) as string[] | null) ?? [], unit_price: num(l.unit_price), line_total: num(l.line_total),
        currency: l.currency === null ? null : String(l.currency),
      }))
    }
  }
  return {
    record,
    interference: {
      applies: rec ? Boolean(emc) : true, criterion: emc, precheck, estimates,
      waivedFindings: waivers.filter((w) => w.targetKind === 'finding' && waiverCriterion({ kind: w.targetKind, id: w.target }) === 'signoff.emc'),
    },
    parts: { criterion: criterion(rec, 'signoff.bom'), quantity: rec?.journey.build.quantity ?? null, check, lines },
    waivers,
    criterionText: Object.fromEntries((rec?.criteria ?? []).map((c) => [c.id, c.text])),
  }
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const day = (t: number): string => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const money = (v: number | null, cur: string | null): string => (v === null ? '—' : `${Number(v.toFixed(4))}${cur ? ` ${cur}` : ''}`)

function criterionLine(c: CriterionState | null): string | null {
  if (!c) return null
  const s = c.status === 'waived' ? `waived (${c.waivers.join(', ')})` : c.status === 'met' ? 'met' : 'not met'
  return `- Criterion ${c.id}: ${esc(c.text)} It is ${s}.`
}

const FINDINGS_SHOWN = 30
const SEV_RANK = (s: string): number => SEVERITIES.indexOf(s as never)

/** The interference, parts list and open waivers sections, as Markdown lines. */
export function releaseMarkdown(f: ReleaseFacts): string[] {
  const out: string[] = ['', '## Interference (EMC)', '']
  const i = f.interference
  if (!i.applies) out.push('This project has no interference criterion: it has no board of its own.')
  else {
    out.push('These are pre-compliance estimates from rules on the board and closed forms. They are not a test result: only a test lab measures compliance.', '')
    const cl = criterionLine(i.criterion)
    if (cl) out.push(cl)
    if (!i.precheck) out.push('- No interference precheck (emc.precheck) is in the record.')
    else {
      const p = i.precheck
      const counts = p.counts ? `${p.counts.error ?? 0} errors, ${p.counts.warn ?? 0} warnings, ${p.counts.info ?? 0} notes` : esc(p.summary ?? p.status)
      out.push(`- Precheck: run ${p.id} on ${p.subject ?? 'the board'}, ${day(p.started)}: ${counts}.`)
    }
    if (i.waivedFindings.length) out.push(`- Findings waived: ${i.waivedFindings.map((w) => `${w.id} (${esc(waiverTargetWords({ kind: w.targetKind, id: w.target }, (id) => f.criterionText[id]))})`).join('; ')}.`)
    const shown = (i.precheck?.findings ?? []).filter((x) => x.severity !== 'info').sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    if (shown.length) {
      out.push('', '| Severity | Rule | Net | Finding |', '|---|---|---|---|')
      for (const x of shown.slice(0, FINDINGS_SHOWN)) out.push(`| ${x.severity} | ${x.rule} | ${x.net ? esc(x.net) : '—'} | ${esc(clip(x.message, 160))} |`)
      if (shown.length > FINDINGS_SHOWN) out.push('', `${shown.length - FINDINGS_SHOWN} more are in findings.json of run ${i.precheck?.id}.`)
    }
    if (i.estimates.length) {
      out.push('', '| Estimate | Subject | Status | Summary | Run |', '|---|---|---|---|---|')
      for (const e of i.estimates) out.push(`| ${e.kind} | ${e.subject ? esc(clip(e.subject, 60)) : '—'} | ${e.status} | ${esc(clip(e.summary ?? '', 160)) || '—'} | ${e.id} |`)
    } else out.push('- No spectrum, field-solver or signal integrity estimate is in the record.')
  }

  out.push('', '## Parts list', '')
  const p = f.parts
  const cl = criterionLine(p.criterion)
  if (cl) out.push(cl)
  if (!p.check) out.push('- No parts list check (parts.bom_check) is in the record.')
  else {
    const c = p.check
    const cur = c.currency
    out.push(`- Check: run ${c.id}, ${day(c.started)}, for ${c.boards === null ? 'an unknown number of' : c.boards} board${c.boards === 1 ? '' : 's'}: ${plural(p.lines.length, 'line')}.`)
    out.push(`- Cost for ${c.boards ?? '?'} board${c.boards === 1 ? '' : 's'}: ${money(c.total, cur)}${c.unpriced ? ` (${plural(c.unpriced, 'line')} priced in another currency left out)` : ''}${c.total !== null && c.boards ? `, ${money(c.total / c.boards, cur)} a board` : ''}.`)
    out.push(`- Stock: ${c.blocking ? `${plural(c.blocking, 'line')} out of stock, short or not found` : 'every line in stock'}.`)
    if (p.quantity !== null) {
      out.push(c.boards === p.quantity
        ? `- Build quantity: ${p.quantity} boards, as checked.`
        : `- Build quantity: ${p.quantity} boards. The check was for ${c.boards ?? 'another number of'} boards, so its cost and stock are not for the build.`)
    }
    if (p.lines.length) {
      out.push('', '| Line | Part | Refs | Need | Stock | Status | Unit price | Line total |', '|---|---|---|---|---|---|---|---|')
      for (const l of p.lines) {
        const status = [l.status, ...l.flags].join(', ')
        out.push(`| ${l.line} | ${esc(l.part)} | ${l.refs ? esc(clip(l.refs, 60)) : '—'} | ${l.need} | ${l.stock ?? '—'} | ${esc(status)} | ${money(l.unit_price, l.currency)} | ${money(l.line_total, l.currency)} |`)
      }
    }
  }

  out.push('', '## Open waivers', '')
  if (f.record === null) out.push('The journey record was not in reach, so the waivers could not be read. Read them in the app before signing.')
  else if (!f.waivers.length) out.push('None.')
  else {
    out.push(`${plural(f.waivers.length, 'waiver')} stand${f.waivers.length === 1 ? 's' : ''}, most severe first.`, '',
      '| Waiver | On | Severity | Caught | Scope | Stage | By |', '|---|---|---|---|---|---|---|')
    const rows = [...f.waivers].sort((a, b) => SEV_RANK(b.severity) - SEV_RANK(a.severity) || a.at - b.at)
    for (const w of rows) {
      const on = waiverTargetWords({ kind: w.targetKind, id: w.target }, (id) => f.criterionText[id])
      out.push(`| ${w.id} | ${esc(clip(on, 140))} | ${w.severity} | ${w.caughtWhere ? esc(clip(w.caughtWhere, 100)) : 'nowhere'} | ${esc(w.scope)} | ${w.stage} | ${esc(w.by)} |`)
    }
  }
  return out
}

/** What the interference, parts list and waivers leave open, for the report's open items. */
export function releaseOpenItems(f: ReleaseFacts): string[] {
  const out: string[] = []
  const i = f.interference
  if (i.applies && i.criterion?.status !== 'waived') {
    if (!i.precheck) out.push('No interference precheck is in the record.')
    else {
      const errs = i.precheck.counts?.error ?? i.precheck.findings.filter((x) => x.severity === 'error').length
      if (errs) out.push(`The interference precheck (run ${i.precheck.id}) has ${plural(errs, 'error')}${i.waivedFindings.length ? `, with ${plural(i.waivedFindings.length, 'finding')} waived` : ''}.`)
    }
    if (i.criterion?.status === 'not_met') out.push(`${i.criterion.id} is not met.`)
  }
  const p = f.parts
  if (p.criterion?.status !== 'waived') {
    if (!p.check) out.push('No parts list check is in the record.')
    else {
      if (p.check.blocking) out.push(`${plural(p.check.blocking, 'parts list line')} out of stock, short or not found (run ${p.check.id}).`)
      if (p.quantity !== null && p.check.boards !== p.quantity) out.push(`The parts list was checked for ${p.check.boards ?? 'another number of'} boards, not the build quantity of ${p.quantity}.`)
    }
    if (p.criterion?.status === 'not_met') out.push(`${p.criterion.id} is not met.`)
  }
  if (f.record === null) out.push('The waivers could not be read: the journey record was not in reach.')
  else if (f.waivers.length) out.push(`${plural(f.waivers.length, 'waiver')} stand${f.waivers.length === 1 ? 's' : ''}: see Open waivers.`)
  return out
}
