/**
 * Per-page text from a PDF's text layer, with pdfjs-dist (no Python needed for text).
 *
 * Text items are grouped into lines by their baseline and ordered left to right, so a table row reads as one line
 * ("Quiescent current IQ VIN = 5 V 45 70 µA") — which is what `datasheets.find` searches and what a reader expects.
 * A page with no text layer (a scan) comes back empty: trace never guesses text it cannot read.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

interface TextItemLike {
  str: string
  transform: number[]
  width: number
  hasEOL?: boolean
}

const isTextItem = (x: unknown): x is TextItemLike =>
  typeof x === 'object' && x !== null && typeof (x as { str?: unknown }).str === 'string' && Array.isArray((x as { transform?: unknown }).transform)

function fontDir(): string {
  const req = createRequire(import.meta.url)
  return join(dirname(req.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/'
}

export interface PdfText {
  pages: string[]
}

/** The text of every page (index 0 is page 1). */
export async function pdfText(data: Uint8Array): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data), // pdfjs takes ownership of the buffer it is given
    standardFontDataUrl: fontDir(),
    useSystemFonts: false,
    verbosity: 0,
  }).promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(linesOf((content.items as unknown[]).filter(isTextItem)))
      page.cleanup()
    }
    return { pages }
  } finally {
    await doc.destroy()
  }
}

/** Group items into lines by baseline (within a third of the text height), each line left to right. */
export function linesOf(items: TextItemLike[]): string {
  const rows: { y: number; h: number; parts: { x: number; s: string; w: number }[] }[] = []
  for (const it of items) {
    if (!it.str) continue
    const x = it.transform[4] ?? 0
    const y = it.transform[5] ?? 0
    const h = Math.abs(it.transform[3] ?? 10) || 10
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.max(r.h, h) / 3)
    if (row) row.parts.push({ x, s: it.str, w: it.width })
    else rows.push({ y, h, parts: [{ x, s: it.str, w: it.width }] })
  }
  rows.sort((a, b) => b.y - a.y)
  return rows
    .map((r) => {
      r.parts.sort((a, b) => a.x - b.x)
      let line = ''
      let end = -Infinity
      for (const p of r.parts) {
        if (line && p.x - end > 1 && !line.endsWith(' ') && !p.s.startsWith(' ')) line += ' '
        line += p.s
        end = p.x + p.w
      }
      return line.replace(/\s+/g, ' ').trim()
    })
    .filter(Boolean)
    .join('\n')
}
