/**
 * Markdown that is still streaming in: close what is open so half-finished text renders steadily. `remend` closes
 * inline formatting (bold, italics, inline code, links, inline maths); here we also close an open code fence or
 * maths block and hold back a table row (or separator) that has not finished arriving, so a table never flickers
 * between a paragraph and a table.
 */
import remend from 'remend'

export function closeStreaming(text: string): string {
  let t = text
  const lines = t.split('\n')
  // an unfinished table row at the end: hold it back until its closing pipe arrives
  const last = lines[lines.length - 1] ?? ''
  if (/^\s*\|/.test(last) && !/\|\s*$/.test(last)) {
    lines.pop()
    t = lines.join('\n')
  }
  // a table header without its separator yet: hold the header back too
  const l2 = t.split('\n')
  const tail = l2[l2.length - 1] ?? ''
  const before = l2[l2.length - 2] ?? ''
  if (/^\s*\|.*\|\s*$/.test(tail) && !/^\s*\|.*\|\s*$/.test(before) && !/^\s*\|?\s*:?-{1,}/.test(tail)) {
    // a lone row that will become a header: render it as text only once its separator arrives
    l2.pop()
    t = l2.join('\n')
  }
  // open code fence
  const fences = t.match(/^\s*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return `${t}${t.endsWith('\n') ? '' : '\n'}\`\`\``
  // open display maths
  const maths = t.match(/^\s*\$\$/gm)?.length ?? 0
  if (maths % 2 === 1) return `${t}\n$$`
  return remend(t)
}
