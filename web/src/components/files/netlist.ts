/**
 * KiCad's net list (.net, an S-expression): each net with the pins it joins. Parsed here so the viewer can draw a
 * connection table and a comparison can say which nets were added, removed or rewired. Pure, so it is tested.
 */

export interface NetPin { ref: string; pin: string; fn?: string }
export interface Net { name: string; pins: NetPin[] }

type Sx = string | Sx[]

/** The text as nested lists of atoms (quoted strings unquoted). */
function sexp(text: string): Sx[] {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()"]+/g) ?? []
  const stack: Sx[][] = [[]]
  for (const t of tokens) {
    if (t === '(') stack.push([])
    else if (t === ')') {
      const done = stack.pop()
      if (!done || !stack.length) throw new Error('Unbalanced brackets')
      stack[stack.length - 1]!.push(done)
    } else stack[stack.length - 1]!.push(t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
  }
  if (stack.length !== 1) throw new Error('Unbalanced brackets')
  return stack[0]!
}

const child = (l: Sx[], name: string): Sx[] | undefined => l.find((x): x is Sx[] => Array.isArray(x) && x[0] === name)
const atom = (l: Sx[] | undefined, name: string): string | undefined => {
  const c = l && child(l, name)
  return typeof c?.[1] === 'string' ? c[1] : undefined
}

/** The nets in a KiCad net list, or null when the text is not one. */
export function parseNetlist(text: string): Net[] | null {
  let root: Sx[]
  try {
    root = sexp(text)
  } catch {
    return null
  }
  const export_ = root.find((x): x is Sx[] => Array.isArray(x) && x[0] === 'export')
  const nets = export_ && child(export_, 'nets')
  if (!nets) return null
  return nets
    .filter((n): n is Sx[] => Array.isArray(n) && n[0] === 'net')
    .map((n) => ({
      name: atom(n, 'name') ?? '(unnamed)',
      pins: n.filter((x): x is Sx[] => Array.isArray(x) && x[0] === 'node').map((x) => ({ ref: atom(x, 'ref') ?? '?', pin: atom(x, 'pin') ?? '?', fn: atom(x, 'pinfunction') })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export type NetChange = 'added' | 'removed' | 'changed'
export interface NetDiff { name: string; change: NetChange; joined: string[]; left: string[] }

const pinKey = (p: NetPin) => `${p.ref}.${p.pin}`

/** Nets added, removed, or with pins joined or left. Unchanged nets are not listed. */
export function diffNets(before: Net[], after: Net[]): NetDiff[] {
  const a = new Map(before.map((n) => [n.name, new Set(n.pins.map(pinKey))]))
  const b = new Map(after.map((n) => [n.name, new Set(n.pins.map(pinKey))]))
  const out: NetDiff[] = []
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name)
    const y = b.get(name)
    if (!x) out.push({ name, change: 'added', joined: [...y!], left: [] })
    else if (!y) out.push({ name, change: 'removed', joined: [], left: [...x] })
    else {
      const joined = [...y].filter((p) => !x.has(p))
      const left = [...x].filter((p) => !y.has(p))
      if (joined.length || left.length) out.push({ name, change: 'changed', joined, left })
    }
  }
  return out
}
