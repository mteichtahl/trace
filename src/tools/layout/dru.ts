/**
 * KiCad custom design rules (.kicad_dru): the skew and length constraints, with their conditions evaluated against
 * board items, as KiCad's DRC expression language writes them:
 *
 *   A.NetClass == 'USB*'      A.NetName == '/DDR/DQ*'     A.inDiffPair('/USB*')
 *   A.Type == 'Track'         (Pad, Via, Track, Zone, Footprint)
 *   A.Layer == 'F.Cu'         A.existsOnLayer('In*.Cu')   (an item on several layers matches any of them)
 *   A.isPlated()              (a plated through-hole pad, or a via)
 *   A.Pad_Type == 'SMD'       (Through-hole, SMD, Edge connector, NPTH, mechanical)
 *   A.Via_Type == 'Through'   (Through, Blind/buried, Micro)
 *   A.Reference == 'U*'       (the footprint a pad belongs to)
 *   A.insideArea('name')      (KiCad 6/7; also intersectsArea and enclosedByArea, KiCad 8+): the named rule area or
 *                             zone, which the item meets (or, for enclosedByArea, lies wholly inside) on a shared layer
 *   B.<any of the above>      the other item of a two-item check
 *
 * joined with &&, || and !, with parentheses; strings compare case-insensitively with * and ? wildcards, as KiCad
 * does (net names case-sensitively). Any other term (A.fromTo, numeric comparisons, …) makes the rule skipped, with a
 * note naming the term. For these one-item constraints KiCad has no B item; this tool gives a differential pair's
 * other net as B, and B terms are false elsewhere.
 */
import * as sx from '../kicad/sexpr.js'
import { inside, type Poly, type Pt } from './geom.js'
import { pointInPolygon, segmentsCross } from '../pcb/geometry.js'

export interface DruItem {
  type: 'track' | 'via' | 'pad' | 'zone' | 'footprint'
  net: string | null
  netclass: string | null
  /** the net is one of a differential pair */
  diffPair: boolean
  /** the layers it is on */
  layers: readonly string[]
  /** pads: the file's kind (smd, thru_hole, np_thru_hole, connect) */
  padKind?: string
  /** vias: through, blind (blind or buried) or micro */
  viaKind?: 'through' | 'blind' | 'micro'
  /** pads: the footprint's reference */
  reference?: string | null
  /** its geometry: one point (a via, a pad's centre) or a polyline (a track) */
  points: readonly Pt[]
}

export interface DruArea { name: string; layers: readonly string[]; polygon: Poly }

export interface DruRule {
  name: string
  skew_max_mm?: number
  length?: { min?: number; opt?: number; max?: number }
  condition: string
  /** the condition on one item (and the other, for a two-item check) */
  test: (a: DruItem, b?: DruItem | null) => boolean
  /** the condition on a net as a whole (a track of it, on no particular layer): for callers without items */
  match: (net: string, cls: string | null, pair: boolean) => boolean
}

// ------------------------------------------------------------------ expressions

type Side = 'A' | 'B'
type Node =
  | { k: 'and' | 'or'; l: Node; r: Node }
  | { k: 'not'; e: Node }
  | { k: 'cmp'; op: '==' | '!='; side: Side; prop: string; value: string }
  | { k: 'call'; side: Side; fn: string; args: string[] }

export class DruConditionError extends Error {}

const PROPS = new Set(['type', 'layer', 'netclass', 'netname', 'pad_type', 'via_type', 'reference'])
const FUNCS = new Set(['indiffpair', 'existsonlayer', 'isplated', 'insidearea', 'intersectsarea', 'enclosedbyarea'])

function tokens(src: string): string[] {
  const out: string[] = []
  const re = /\s*(&&|\|\||==|!=|!|\(|\)|,|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*|-?\d+(?:\.\d+)?\w*|\S)/y
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] === undefined) break
    out.push(m[1])
  }
  if (src.slice(re.lastIndex).trim()) throw new DruConditionError(src.slice(re.lastIndex).trim())
  return out
}

const unquote = (t: string): string | null => (/^'.*'$|^".*"$/.test(t) ? t.slice(1, -1).replace(/\\(.)/g, '$1') : null)

/** Parse a condition. Throws DruConditionError naming the first term it does not evaluate. */
export function parseCondition(src: string): Node {
  const ts = tokens(src)
  let i = 0
  const peek = (): string | undefined => ts[i]
  const next = (): string => {
    const t = ts[i++]
    if (t === undefined) throw new DruConditionError('(end of condition)')
    return t
  }
  const ref = (t: string): { side: Side; name: string } | null => {
    const m = /^([AB])\.(\w+)$/.exec(t)
    return m ? { side: m[1] as Side, name: m[2] as string } : null
  }
  const or = (): Node => {
    let l = and()
    while (peek() === '||') { i++; l = { k: 'or', l, r: and() } }
    return l
  }
  const and = (): Node => {
    let l = unary()
    while (peek() === '&&') { i++; l = { k: 'and', l, r: unary() } }
    return l
  }
  const unary = (): Node => {
    if (peek() === '!') { i++; return { k: 'not', e: unary() } }
    return primary()
  }
  const primary = (): Node => {
    const t = next()
    if (t === '(') {
      const e = or()
      if (next() !== ')') throw new DruConditionError('a missing )')
      return e
    }
    const r = ref(t)
    if (!r) throw new DruConditionError(t)
    if (peek() === '(') {
      i++
      const fn = r.name.toLowerCase()
      const args: string[] = []
      while (peek() !== ')') {
        const a = unquote(next())
        if (a === null) throw new DruConditionError(`${t}(…): arguments must be quoted strings`)
        args.push(a)
        if (peek() === ',') i++
      }
      i++
      if (!FUNCS.has(fn)) throw new DruConditionError(`${t}()`)
      const want = fn === 'isplated' ? 0 : 1
      if (args.length !== want) throw new DruConditionError(`${t}() takes ${want} argument${want === 1 ? '' : 's'}`)
      return { k: 'call', side: r.side, fn, args }
    }
    const op = peek()
    if (op !== '==' && op !== '!=') throw new DruConditionError(op === undefined ? t : `${t} ${op}`)
    i++
    const v = next()
    const value = unquote(v)
    const prop = r.name.toLowerCase()
    if (!PROPS.has(prop)) throw new DruConditionError(t)
    if (value === null) throw new DruConditionError(`${t} ${op} ${v}`)
    return { k: 'cmp', op, side: r.side, prop, value }
  }
  const e = or()
  if (i < ts.length) throw new DruConditionError(ts.slice(i).join(' '))
  return e
}

/** KiCad's wildcard string match (* and ?), case-insensitive unless `exact`. */
export function wild(pattern: string, value: string, exact = false): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, exact ? '' : 'i')
  return re.test(value)
}

const TYPE_NAME: Record<DruItem['type'], string> = { track: 'Track', via: 'Via', pad: 'Pad', zone: 'Zone', footprint: 'Footprint' }
const PAD_TYPE: Record<string, string> = { thru_hole: 'Through-hole', smd: 'SMD', connect: 'Edge connector', np_thru_hole: 'NPTH, mechanical' }
const VIA_TYPE: Record<NonNullable<DruItem['viaKind']>, string> = { through: 'Through', blind: 'Blind/buried', micro: 'Micro' }
const netMatch = (pattern: string, net: string | null): boolean => net !== null && (wild(pattern, net, true) || wild(pattern, net.replace(/^\//, ''), true))

function layersMeet(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return true
  const expand = (l: string): string[] => (l === '*.Cu' || l === 'F&B.Cu' ? ['*'] : [l])
  return a.flatMap(expand).some((x) => b.flatMap(expand).some((y) => x === '*' || y === '*' ? true : x === y))
}

/** Whether the item meets the area (any point inside, or a track crossing its outline), or lies wholly in it. */
function inArea(item: DruItem, area: DruArea, enclosed: boolean): boolean {
  if (!layersMeet(item.layers, area.layers)) return false
  const ps = item.points
  if (!ps.length) return false
  const where = ps.map((p) => pointInPolygon(p, area.polygon))
  let crosses = false
  for (let i = 0; i + 1 < ps.length && !crosses; i++) {
    for (let j = 0; j < area.polygon.length; j++) {
      if (segmentsCross(ps[i] as Pt, ps[i + 1] as Pt, area.polygon[j] as Pt, area.polygon[(j + 1) % area.polygon.length] as Pt)) { crosses = true; break }
    }
  }
  if (enclosed) return !crosses && where.every((w) => w !== 'out')
  return crosses || where.some((w) => w !== 'out') || (ps.length === 1 && inside(ps[0] as Pt, area.polygon))
}

function evaluate(n: Node, a: DruItem, b: DruItem | null, areas: readonly DruArea[]): boolean {
  switch (n.k) {
    case 'and': return evaluate(n.l, a, b, areas) && evaluate(n.r, a, b, areas)
    case 'or': return evaluate(n.l, a, b, areas) || evaluate(n.r, a, b, areas)
    case 'not': return !evaluate(n.e, a, b, areas)
    case 'cmp': {
      const it = n.side === 'A' ? a : b
      if (!it) return false
      let hit: boolean
      switch (n.prop) {
        case 'type': hit = wild(n.value, TYPE_NAME[it.type]); break
        case 'layer': hit = it.layers.some((l) => wild(n.value, l)); break
        case 'netclass': hit = it.netclass !== null && wild(n.value, it.netclass); break
        case 'netname': hit = netMatch(n.value, it.net); break
        case 'pad_type': hit = it.type === 'pad' && wild(n.value, PAD_TYPE[it.padKind ?? ''] ?? it.padKind ?? ''); break
        case 'via_type': hit = it.type === 'via' && wild(n.value, VIA_TYPE[it.viaKind ?? 'through']); break
        case 'reference': hit = it.reference !== undefined && it.reference !== null && wild(n.value, it.reference); break
        default: hit = false
      }
      return n.op === '==' ? hit : !hit
    }
    case 'call': {
      const it = n.side === 'A' ? a : b
      if (!it) return false
      const arg = n.args[0] ?? ''
      switch (n.fn) {
        case 'indiffpair': return it.diffPair && netMatch(arg, it.net)
        case 'existsonlayer': return it.layers.some((l) => wild(arg, l))
        case 'isplated': return it.type === 'via' || (it.type === 'pad' && it.padKind === 'thru_hole')
        case 'insidearea':
        case 'intersectsarea':
        case 'enclosedbyarea': return areas.some((z) => wild(arg, z.name, true) && inArea(it, z, n.fn === 'enclosedbyarea'))
        default: return false
      }
    }
  }
}

const UNIT_MM: Record<string, number> = { mm: 1, um: 1e-3, mil: 0.0254, mils: 0.0254, in: 25.4, '': 1 }

function mmOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const m = /^(-?\d+(?:\.\d+)?)\s*(mm|um|mils?|in)?$/.exec(v.trim())
  return m ? Number(m[1]) * (UNIT_MM[m[2] ?? ''] ?? 1) : undefined
}

/** Skew and length constraints in a .kicad_dru, their conditions parsed (see the header). Rules with a condition
 * this does not evaluate are listed as skipped, naming the term. `areas`: the board's named rule areas and zones,
 * for insideArea. */
export function druRules(text: string, areas: readonly DruArea[] = []): { rules: DruRule[]; skipped: string[] } {
  let tree: sx.SList
  try {
    tree = sx.parse(`(dru ${text})`)
  } catch {
    return { rules: [], skipped: ['the .kicad_dru is not readable'] }
  }
  const rules: DruRule[] = []
  const skipped: string[] = []
  for (const r of sx.findAll(tree, 'rule')) {
    const name = sx.atomAt(r, 1) ?? '?'
    let skew: number | undefined
    let length: DruRule['length']
    for (const c of sx.findAll(r, 'constraint')) {
      const kind = sx.atomAt(c, 1)
      const get = (k: string): number | undefined => mmOf(sx.value(c, k))
      if (kind === 'skew') skew = get('max')
      if (kind === 'length') length = { ...(get('min') !== undefined ? { min: get('min') } : {}), ...(get('opt') !== undefined ? { opt: get('opt') } : {}), ...(get('max') !== undefined ? { max: get('max') } : {}) }
    }
    if (skew === undefined && !length) continue
    const cond = sx.value(r, 'condition') ?? ''
    let ast: Node | null = null
    if (cond.trim()) {
      try {
        ast = parseCondition(cond)
      } catch (e) {
        if (!(e instanceof DruConditionError)) throw e
        skipped.push(`${name}: skipped: unsupported condition ${JSON.stringify(e.message)} in ${JSON.stringify(cond)}`)
        continue
      }
    }
    const test = (a: DruItem, b?: DruItem | null): boolean => ast === null || evaluate(ast, a, b ?? null, areas)
    rules.push({
      name, ...(skew !== undefined ? { skew_max_mm: skew } : {}), ...(length ? { length } : {}), condition: cond, test,
      match: (net, cls, pair) => test({ type: 'track', net, netclass: cls, diffPair: pair, layers: [], points: [] }),
    })
  }
  return { rules, skipped }
}
