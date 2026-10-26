/**
 * Package thermal figures from the datasheet library (src/tools/datasheets): the electrical-characteristics and
 * absolute-maximum rows that name the junction temperature and the thermal metrics, each with its citation
 * {mpn, sha256, page}. A figure is proposed only when every matching row agrees on it; otherwise the rows come back
 * for a person (or the specialist) to read, and nothing is assumed about which column holds what.
 */
import { library } from '../datasheets/library.js'
import { PdfReader, type Params } from '../datasheets/pdf.js'
import type { LimitField } from './store.js'

export const QUERIES: Readonly<Record<LimitField, { query: string; column: 'max' | 'typ' | 'min' }>> = {
  tj_max_c: { query: '(operating|maximum)?\\s*junction temperature|\\bT_?J\\b', column: 'max' },
  tj_min_c: { query: '(operating|maximum)?\\s*junction temperature|\\bT_?J\\b', column: 'min' },
  theta_ja: { query: 'R?(θ|theta|Θ)\\s?_?JA|junction[- ]to[- ]ambient', column: 'typ' },
  theta_jc: { query: 'R?(θ|theta|Θ)\\s?_?JC|junction[- ]to[- ]case', column: 'typ' },
  theta_jb: { query: 'R?(θ|theta|Θ)\\s?_?JB|junction[- ]to[- ]board', column: 'typ' },
  psi_jt: { query: '(ψ|psi|Ψ)\\s?_?JT|junction[- ]to[- ]top', column: 'typ' },
  psi_jb: { query: '(ψ|psi|Ψ)\\s?_?JB', column: 'typ' },
}

export interface Proposal { field: LimitField; value: number | null; citation: { mpn: string; sha256: string; page: number } | null; agree: boolean; rows: { page: number; raw: string; value: number | null }[] }

export type ParamsReader = (mpn: string, query: string) => Promise<{ mpn: string; sha256: string; result: Params }>

export const libraryReader = (lib?: string): ParamsReader => {
  const reader = new PdfReader()
  return async (mpn, query) => {
    const L = library(lib)
    const { entry, version } = await L.version(mpn)
    const path = await L.localPath(version.sha256)
    return { mpn: entry.key, sha256: version.sha256, result: await reader.params(path, version.sha256, query, { regex: true, limit: 20 }) }
  }
}

const number = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined) return null
  const m = /[-+]?\d+(\.\d+)?/.exec(s.replace('−', '-'))
  return m ? Number(m[0]) : null
}

export async function proposeLimits(mpn: string, fields: readonly LimitField[], read: ParamsReader): Promise<Proposal[]> {
  const out: Proposal[] = []
  for (const f of fields) {
    const q = QUERIES[f]
    const r = await read(mpn, q.query)
    const rows = r.result.rows.map((x) => {
      // a junction temperature range is printed as min/max; the metrics as typ (some vendors print a single max)
      const v = x.parsed ? number(x[q.column]) ?? (q.column === 'typ' ? number(x.max) : null) : null
      return { page: x.page, raw: x.raw.slice(0, 200), value: v }
    })
    const values = [...new Set(rows.map((x) => x.value).filter((v): v is number => v !== null))]
    const first = rows.find((x) => x.value !== null)
    out.push({ field: f, value: values.length === 1 ? values[0]! : null, citation: values.length === 1 && first ? { mpn: r.mpn, sha256: r.sha256, page: first.page } : null, agree: values.length === 1, rows })
  }
  return out
}
