/**
 * A small, fast S-expression reader for KiCad's text formats (.kicad_sch, .kicad_pcb, .kicad_sym, fp-lib-table…).
 *
 * A KiCad file is one big S-expression: `(kicad_pcb (version 20240108) (net 1 "GND") …)`. Every node is a list whose
 * first element is its keyword, followed by atoms and child nodes. This module reads such text into plain nested
 * arrays of strings, so the readers built on it can walk any KiCad version without a grammar per version:
 *
 *   const tree = parse(text)          // ['kicad_pcb', ['version', '20240108'], ['net', '1', 'GND'], …]
 *   find(tree, 'version')             // ['version', '20240108']
 *   value(tree, 'version')            // '20240108'
 *   findAll(tree, 'net')              // every direct 'net' child
 *   walk(tree, 'pad')                 // every 'pad' node at any depth
 *
 * Atoms stay strings, quoted or not ("1.27" is not turned into a number), because KiCad mixes numbers, names and
 * yes/no flags and only the caller knows which a field is; `num()` converts when asked. Quoted strings are unescaped
 * (\" \\ \n \t \r). The reader is one pass over the characters with no regular expressions, which reads a 20 MB board
 * in well under a second in V8.
 */

/** An atom or a list. A list's first element is normally its keyword. */
export type SNode = string | SList
export interface SList extends Array<SNode> {}

export class SexprError extends Error {
  override name = 'SexprError'
}

export const isList = (n: SNode | undefined): n is SList => Array.isArray(n)
export const isAtom = (n: SNode | undefined): n is string => typeof n === 'string'

const OPEN = 40 // (
const CLOSE = 41 // )
const QUOTE = 34 // "
const BACKSLASH = 92

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
}

function unescape(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string
    if (ch === '\\' && i + 1 < s.length) {
      const nx = s[++i] as string
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx
    } else {
      out += ch
    }
  }
  return out
}

/** Parse one top-level expression (KiCad files hold exactly one). Throws SexprError on malformed input. */
export function parse(text: string): SList {
  const stack: SList[] = []
  let root: SList | null = null
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (isSpace(c)) {
      i++
      continue
    }
    if (c === OPEN) {
      const node: SList = []
      const top = stack[stack.length - 1]
      if (top) top.push(node)
      else if (root !== null) throw new SexprError(`more than one top-level expression (second at offset ${i})`)
      else root = node
      stack.push(node)
      i++
      continue
    }
    if (c === CLOSE) {
      if (!stack.pop()) throw new SexprError(`unbalanced ')' at offset ${i}`)
      i++
      continue
    }
    const top = stack[stack.length - 1]
    if (!top) throw new SexprError(`atom outside an expression at offset ${i}`)
    if (c === QUOTE) {
      let j = i + 1
      let escaped = false
      for (;;) {
        if (j >= n) throw new SexprError(`unterminated string starting at offset ${i}`)
        const d = text.charCodeAt(j)
        if (d === BACKSLASH) {
          escaped = true
          j += 2
          continue
        }
        if (d === QUOTE) break
        j++
      }
      const raw = text.slice(i + 1, j)
      top.push(escaped ? unescape(raw) : raw)
      i = j + 1
      continue
    }
    let j = i
    while (j < n) {
      const d = text.charCodeAt(j)
      if (isSpace(d) || d === OPEN || d === CLOSE || d === QUOTE) break
      j++
    }
    top.push(text.slice(i, j))
    i = j
  }
  if (stack.length) throw new SexprError(`unterminated expression: ${stack.length} '(' still open at end of input`)
  if (root === null) throw new SexprError('no expression found')
  return root
}

/** Escape a string for writing back into a KiCad file. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

export function head(node: SNode | undefined): string | undefined {
  return isList(node) && isAtom(node[0]) ? node[0] : undefined
}

/** Direct child lists, optionally only those named `name`. */
export function children(node: SList, name?: string): SList[] {
  const out: SList[] = []
  for (let k = 1; k < node.length; k++) {
    const c = node[k]
    if (isList(c) && c.length && (name === undefined || c[0] === name)) out.push(c)
  }
  return out
}

/** The first direct child named `name`. */
export function find(node: SList | undefined, name: string): SList | undefined {
  if (!node) return undefined
  for (let k = 1; k < node.length; k++) {
    const c = node[k]
    if (isList(c) && c[0] === name) return c
  }
  return undefined
}

export function findAll(node: SList | undefined, name: string): SList[] {
  return node ? children(node, name) : []
}

/** The atom at `index` of the first child named `name`: value(fp, 'layer') → 'F.Cu'. */
export function value(node: SList | undefined, name: string, index = 1): string | undefined {
  const c = find(node, name)
  const v = c?.[index]
  return isAtom(v) ? v : undefined
}

/** The atom at position `index` of the node itself. */
export function atomAt(node: SList | undefined, index: number): string | undefined {
  const v = node?.[index]
  return isAtom(v) ? v : undefined
}

/** The node's direct atoms (its arguments that are not lists), keyword excluded. */
export function atoms(node: SList): string[] {
  const out: string[] = []
  for (let k = 1; k < node.length; k++) {
    const c = node[k]
    if (isAtom(c)) out.push(c)
  }
  return out
}

/** Every node named `name` at any depth, in document order (not descending into a match). */
export function walk(node: SList, name: string): SList[] {
  const out: SList[] = []
  const visit = (n: SList): void => {
    for (let k = 1; k < n.length; k++) {
      const c = n[k]
      if (isList(c) && c.length) {
        if (c[0] === name) out.push(c)
        else visit(c)
      }
    }
  }
  visit(node)
  return out
}

/** A number, or undefined when the atom is not one. */
export function num(s: SNode | undefined): number | undefined {
  if (!isAtom(s) || s === '') return undefined
  const v = Number(s)
  return Number.isFinite(v) ? v : undefined
}

export function numValue(node: SList | undefined, name: string, index = 1): number | undefined {
  return num(value(node, name, index))
}

/** [x, y, angle] of a child like (at 1 2 90); the angle is 0 when absent. */
export function xy(node: SList | undefined, name = 'at'): [number, number, number] | undefined {
  const c = find(node, name)
  if (!c) return undefined
  const x = num(c[1])
  const y = num(c[2])
  if (x === undefined || y === undefined) return undefined
  return [x, y, num(c[3]) ?? 0]
}

/** A yes/no child: (dnp yes) → true, (dnp no) → false, a bare (dnp) → true, absent → `dflt`. KiCad 6/7 also wrote
 * bare atoms such as `hide` among a node's arguments; that form counts too. */
export function flag(node: SList, name: string, dflt: boolean): boolean {
  const c = find(node, name)
  if (c) return c.length < 2 || c[1] === 'yes' || c[1] === 'true'
  return atoms(node).includes(name) ? true : dflt
}
