/**
 * A minimal XML reader, enough for the files kicad-cli writes (the kicadxml netlist): elements, attributes, text,
 * self-closing tags, comments, processing instructions, CDATA and the five predefined entities plus numeric
 * character references. It builds a small typed tree. It does not validate, resolve DTDs or handle namespaces, which
 * kicad-cli's output does not use. Writing it here avoids a dependency for one regular, machine-written format.
 */

export interface XmlElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: XmlElement[]
  text: string
}

export class XmlError extends Error {
  override name = 'XmlError'
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

const NAME_END = /[\s/>]/
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlElement[] = [root]
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    const top = stack[stack.length - 1] as XmlElement
    if (lt < 0) {
      top.text += decodeEntities(text.slice(i))
      break
    }
    if (lt > i) top.text += decodeEntities(text.slice(i, lt))
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4)
      if (e < 0) throw new XmlError('unterminated comment')
      i = e + 3
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9)
      if (e < 0) throw new XmlError('unterminated CDATA')
      top.text += text.slice(lt + 9, e)
      i = e + 3
    } else if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2)
      if (e < 0) throw new XmlError('unterminated declaration')
      i = e + 1
    } else if (text.startsWith('</', lt)) {
      const e = text.indexOf('>', lt + 2)
      if (e < 0) throw new XmlError('unterminated end tag')
      const name = text.slice(lt + 2, e).trim()
      const open = stack.pop()
      if (!open || open.name !== name) throw new XmlError(`mismatched </${name}> (open: <${open?.name ?? 'none'}>)`)
      i = e + 1
    } else {
      // a start tag: find its end, skipping '>' inside quoted attribute values
      let j = lt + 1
      let q = ''
      for (; j < n; j++) {
        const c = text[j]
        if (q) {
          if (c === q) q = ''
        } else if (c === '"' || c === "'") q = c
        else if (c === '>') break
      }
      if (j >= n) throw new XmlError('unterminated start tag')
      let body = text.slice(lt + 1, j)
      const selfClose = body.endsWith('/')
      if (selfClose) body = body.slice(0, -1)
      const m = NAME_END.exec(body)
      const name = m ? body.slice(0, m.index) : body
      const attrs: Record<string, string> = {}
      ATTR.lastIndex = 0
      for (let a = ATTR.exec(body); a; a = ATTR.exec(body)) {
        attrs[a[1] as string] = decodeEntities(a[3] ?? a[4] ?? '')
      }
      const el: XmlElement = { name, attrs, children: [], text: '' }
      top.children.push(el)
      if (!selfClose) stack.push(el)
      i = j + 1
    }
  }
  if (stack.length !== 1) throw new XmlError(`unclosed <${(stack[stack.length - 1] as XmlElement).name}>`)
  const doc = root.children[0]
  if (!doc) throw new XmlError('no root element')
  return doc
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name)
}

export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name)
}

/** Every descendant element named `name`. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const visit = (e: XmlElement): void => {
    for (const c of e.children) {
      if (c.name === name) out.push(c)
      visit(c)
    }
  }
  visit(el)
  return out
}

export function childText(el: XmlElement, name: string): string {
  return child(el, name)?.text.trim() ?? ''
}
