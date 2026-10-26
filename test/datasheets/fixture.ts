/** A real datasheet PDF for the tests, made by python/tests/fixture_pdf.py (reportlab, in the repository's venv). */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PYTHON = process.env.TRACE_PYTHON || join(ROOT, '.venv', 'bin', 'python')
process.env.TRACE_PYTHON = PYTHON

const made = new Map<string, string>()

/** The path of the fixture at `revision` (A or B: B has a different IQ max, so different bytes). */
export function fixturePdf(revision: 'A' | 'B' = 'A'): string {
  const have = made.get(revision)
  if (have) return have
  const out = join(mkdtempSync(join(tmpdir(), 'trace-pdf-')), `tpx123-${revision}.pdf`)
  execFileSync(PYTHON, [join(ROOT, 'python', 'tests', 'fixture_pdf.py'), out, revision])
  if (!existsSync(out)) throw new Error('the fixture PDF was not made')
  made.set(revision, out)
  return out
}

export const fixtureBytes = (revision: 'A' | 'B' = 'A'): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(fixturePdf(revision)))
