/**
 * Propose interface timing specs from a datasheet's characteristics tables, by rules: no model is involved.
 *
 * Every table row that has min/typ/max columns (datasheets.params' rows, read by pdfplumber) is matched first by its
 * symbol, normalised (case, spaces, underscores and the ; : ( ) , . - separators dropped: "tSU;DAT", "t SU:DAT" and
 * "tSU(DAT)" are all "tsudat"), against each protocol's symbol table; then, when the symbol says nothing, by its
 * parameter name against name patterns ("data set-up time", "bus free time"). The numbers are converted to SI from the
 * row's unit. A row whose cells are not plain numbers (a footnote, "see Figure 3") is returned unparsed with its raw
 * text, never guessed at. Each candidate carries its citation (part, sha256, page) and the rule that matched; the
 * agent reads the page and confirms each one with protocol.spec action=set.
 */
import { toSI, type Protocol } from './spec.js'

export interface ParamRow { page: number; raw: string; parsed: boolean; parameter?: string | undefined; symbol?: string | undefined; conditions?: string | undefined; min?: string | null | undefined; typ?: string | null | undefined; max?: string | null | undefined; unit?: string | null | undefined }

export interface Candidate {
  parameter: string
  min?: number
  typ?: number
  max?: number
  unit: string
  printed: { min: string | null; typ: string | null; max: string | null; unit: string | null }
  symbol: string
  name: string
  conditions: string
  rule: string
  page: number
  citation: { source: string; mpn: string; sha256: string; page: number }
  duplicate_of?: number
}

export const normSymbol = (s: string): string => s.toLowerCase().replace(/[\s_;:(),.\-]/g, '').replace(/[‐‑–—]/g, '')

const SYMBOLS: Readonly<Record<Protocol, Readonly<Record<string, string>>>> = {
  i2c: {
    fscl: 'f_scl', fclk: 'f_scl', thdsta: 'thd_sta', tlow: 't_low', thigh: 't_high', tsusta: 'tsu_sta', thddat: 'thd_dat', tsudat: 'tsu_dat',
    tvddat: 'tvd_dat', tvdack: 'tvd_ack', tsusto: 'tsu_sto', tbuf: 't_buf', tr: 't_r', tf: 't_f', cb: 'c_b', tsp: 't_sp', vil: 'vil', vih: 'vih', vol: 'vol', iol: 'iol',
  },
  spi: {
    fsck: 'f_sck', fsclk: 'f_sck', fclk: 'f_sck', fc: 'f_sck', fspi: 'f_sck',
    tcss: 'tcss', tcssu: 'tcss', tcsu: 'tcss', tlead: 'tcss', tsucs: 'tcss', tcsclk: 'tcss',
    tcsh: 'tcsh', tlag: 'tcsh', thcs: 'tcsh', tclkcs: 'tcsh',
    tcsd: 'tcsd', tcsw: 'tcsd', tcshigh: 'tcsd', tcsdis: 'tcsd', tcshi: 'tcsd',
    tsu: 'tsu', tds: 'tsu', tdsu: 'tsu', tsudi: 'tsu', tsi: 'tsu',
    th: 'th', tdh: 'th', thd: 'th', thdi: 'th', thi: 'th',
    tv: 'tv', tdo: 'tv', tco: 'tv', todv: 'tv', tvalid: 'tv', tdov: 'tv',
    tho: 'tho', toh: 'tho', tdoh: 'tho', thdo: 'tho',
    tdis: 'tdis', thz: 'tdis', tcsz: 'tdis', tdz: 'tdis',
    tch: 't_sck_high', twh: 't_sck_high', tsckh: 't_sck_high', tclkh: 't_sck_high', thigh: 't_sck_high',
    tcl: 't_sck_low', twl: 't_sck_low', tsckl: 't_sck_low', tclkl: 't_sck_low', tlow: 't_sck_low',
  },
  uart: { baud: 'baud', fbaud: 'baud' },
  can: { fbit: 'bitrate' },
  onewire: { trstl: 't_rstl', tpdh: 't_pdh', tpdl: 't_pdl', tslot: 't_slot', tlow1: 't_low1', tw1l: 't_low1', tlow0: 't_low0', tw0l: 't_low0', trec: 't_rec' },
  i2s: { fbclk: 'f_bclk', fsck: 'f_bclk', tsu: 'tsu', th: 'th' },
}

const NAMES: Readonly<Record<Protocol, readonly [RegExp, string][]>> = {
  i2c: [
    [/scl\b.*(clock )?frequency|clock frequency/i, 'f_scl'], [/hold time.*(repeated )?start/i, 'thd_sta'], [/low period/i, 't_low'], [/high period/i, 't_high'],
    [/set-?up time.*repeated start/i, 'tsu_sta'], [/data hold/i, 'thd_dat'], [/data set-?up/i, 'tsu_dat'], [/valid acknowledge/i, 'tvd_ack'], [/data valid/i, 'tvd_dat'],
    [/set-?up time.*stop/i, 'tsu_sto'], [/bus free/i, 't_buf'], [/rise time/i, 't_r'], [/fall time/i, 't_f'], [/capacitive load/i, 'c_b'], [/spike/i, 't_sp'],
  ],
  spi: [
    [/(sck|sclk|serial clock|clock) frequency/i, 'f_sck'], [/(cs|chip select)\b.*(set-?up|lead|to (sck|clock))/i, 'tcss'], [/((sck|clock).*to (cs|chip select)|(cs|chip select) hold|lag)/i, 'tcsh'],
    [/(cs|chip select)\b.*(high|disable|deselect)/i, 'tcsd'], [/output valid|data.*out.*valid|clock.*to.*output/i, 'tv'], [/output hold/i, 'tho'],
    [/output disable|high.?impedance|tri-?state/i, 'tdis'], [/(data.*in(put)?|sdi|mosi).*set-?up|^set-?up time/i, 'tsu'], [/(data.*in(put)?|sdi|mosi).*hold|^hold time/i, 'th'],
    [/clock high/i, 't_sck_high'], [/clock low/i, 't_sck_low'],
  ],
  uart: [[/baud/i, 'baud']],
  can: [[/bit ?rate/i, 'bitrate']],
  onewire: [[/reset (time|low)/i, 't_rstl'], [/presence.*high|presence.*detect/i, 't_pdh'], [/presence.*low/i, 't_pdl'], [/time slot/i, 't_slot'], [/recovery/i, 't_rec']],
  i2s: [[/(bit|serial) clock frequency/i, 'f_bclk'], [/set-?up/i, 'tsu'], [/hold/i, 'th']],
}

const num = (s: string | null | undefined): number | undefined => {
  if (s === null || s === undefined) return undefined
  const t = s.replace(/−/g, '-').replace(/\s+/g, '').replace(/^±/, '')
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return undefined
  return Number(t)
}

export function extractCandidates(rows: readonly ParamRow[], protocol: Protocol, cite: { mpn: string; sha256: string }): { candidates: Candidate[]; unparsed: { page: number; raw: string; parameter: string | undefined; reason: string }[] } {
  const sym = SYMBOLS[protocol]
  const names = NAMES[protocol]
  const candidates: Candidate[] = []
  const unparsed: { page: number; raw: string; parameter: string | undefined; reason: string }[] = []
  for (const r of rows) {
    const symbol = (r.symbol ?? '').trim()
    const name = (r.parameter ?? '').trim()
    let param: string | undefined
    let rule = ''
    const key = normSymbol(symbol)
    if (key && sym[key]) { param = sym[key]; rule = `symbol ${symbol} → ${sym[key]}` }
    // a symbol another protocol's table knows (fSCLK in an I2C search) is that protocol's row: no name fallback
    const foreign = key !== '' && !sym[key] && Object.values(SYMBOLS).some((t) => t[key] !== undefined)
    if (!param && !foreign) {
      for (const [rx, p] of names) if (rx.test(name)) { param = p; rule = `name /${rx.source}/ → ${p}`; break }
    }
    if (!param) continue
    if (!r.parsed) { unparsed.push({ page: r.page, raw: r.raw, parameter: param, reason: 'cells are not plain numbers: read the row on the page' }); continue }
    const mn = num(r.min)
    const ty = num(r.typ)
    const mx = num(r.max)
    if (mn === undefined && ty === undefined && mx === undefined) { unparsed.push({ page: r.page, raw: r.raw, parameter: param, reason: 'no numeric min, typ or max' }); continue }
    let scale = 1
    let unit = ''
    try {
      const u = toSI(r.unit ?? '')
      scale = u.scale
      unit = u.unit
    } catch {
      unparsed.push({ page: r.page, raw: r.raw, parameter: param, reason: `unit ${JSON.stringify(r.unit)} is not one protocol.spec converts` })
      continue
    }
    const c: Candidate = {
      parameter: param, unit, symbol, name, conditions: r.conditions ?? '', rule, page: r.page,
      printed: { min: r.min ?? null, typ: r.typ ?? null, max: r.max ?? null, unit: r.unit ?? null },
      citation: { source: `${cite.mpn} datasheet, page ${r.page}: ${r.raw.slice(0, 160)}`, mpn: cite.mpn, sha256: cite.sha256, page: r.page },
    }
    if (mn !== undefined) c.min = mn * scale
    if (ty !== undefined) c.typ = ty * scale
    if (mx !== undefined) c.max = mx * scale
    const dup = candidates.findIndex((x) => x.parameter === param)
    if (dup >= 0) c.duplicate_of = dup
    candidates.push(c)
  }
  return { candidates, unparsed }
}
