/**
 * The project's documents (docs/scribe.md): checking them against Scribe's quality bar and printing them to PDF.
 *
 *   docs.check    each document under docs/design against src/docs/checks.ts at the project's stage: errors block a
 *                 change, warnings are shown with it. No program runs.
 *   docs.publish  each document printed to a PDF with the project's logo (python -m tracebridge.docs, the `docs` job
 *                 kind: pandoc, Mermaid's mmdc and Typst, on the tools function where there is one). On a worker
 *                 (TRACE_PROJECT_HOME) the PDF goes to the central bucket, named by its content
 *                 (src/docs/printed.ts), and the run keeps only where (<kind>.pdf.json), so prints never grow the
 *                 repository's run record; elsewhere (a laptop, CI) the PDF is the run's artifact. With `release`, the
 *                 copies are the revision's release copies (written once). The run has the size, diagram count and
 *                 commit; a diagram Mermaid cannot read or an image not beside the document fails it, saying which.
 *                 When the browser behind Mermaid cannot start, the document still prints with those diagrams as
 *                 their Mermaid source and a note, and the run names them (`not_drawn`) for the next print to draw.
 *
 * The images a document names are sent with it (relative to docs/design, as in the repository); so is the logo
 * (docs/design/logo.svg|png, src/docs/logo.ts).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { z } from 'zod'
import { STAGE_IDS, type StageId } from '../../core/journey-catalog.js'
import { type AnyTool, defineTool, ToolError } from '../../core/registry.js'
import { Work } from '../../core/store.js'
import { backendFor, runJob } from '../../gpu/jobs.js'
import { DOC_KINDS, DOCS, docsFor, type DocKind } from '../../docs/catalog.js'
import { checkDoc, passes } from '../../docs/checks.js'
import { logoPaths } from '../../docs/logo.js'
import { PY_DIR } from '../mech/engine.js'
import { commitOf } from '../render/model.js'
import { projectsBackend, projectsFromEnv } from '../../core/agent-facts.js'
import { type Printed, recordLatest, recordRelease, storePrinted } from '../../docs/printed.js'
import type { Backend } from '../../core/central.js'
import { figureTools } from './figures.js'
import { hasInterfaces, scribeTools } from './scribe.js'

const Kinds = z.array(z.enum(DOC_KINDS)).min(1).max(4).optional().describe('which documents (hld, lld, protocol, guide); default: every one the repository has')

/** The documents the repository has, of those asked for. */
function present(root: string, kinds?: readonly DocKind[]): DocKind[] {
  return (kinds ?? DOC_KINDS).filter((k) => existsSync(join(root, DOCS[k].file)))
}

/** The images a document names, relative to its folder: never a URL, a diagram it draws itself, or outside the repository. */
export function imagesOf(md: string): string[] {
  const out = new Set<string>()
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    const ref = m[1]!
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('/') || ref.split('/').includes('..')) continue
    out.add(posix.normalize(ref))
  }
  return [...out]
}

const check = defineTool({
  name: 'docs.check',
  description: 'Check the project\'s documents (docs/design: high level design, low level design, protocol specification, user guide) against Scribe\'s quality bar at a stage: every document the stage needs there, every section present, sections due by the stage written, figures with kind, source, caption and the right diagram type, values with a basis and a source, no unexplained acronyms. Recorded as a run: the evidence for the documents criterion (signoff.docs, journey.check). Errors block a change.',
  input: z.object({ docs: Kinds, stage: z.enum(STAGE_IDS).describe('the project\'s current stage: sections due by it must be written') }),
  run: (a) => {
    const root = process.cwd()
    const kinds = present(root, a.docs)
    const missing = a.docs ? [] : docsFor(a.stage as StageId, hasInterfaces()).map((d) => d.kind).filter((k) => !kinds.includes(k))
    const documents = kinds.map((k) => {
      const findings = checkDoc(k, readFileSync(join(root, DOCS[k].file), 'utf8'), { stage: a.stage as StageId })
      return { kind: k, file: DOCS[k].file, passes: passes(findings), errors: findings.filter((f) => f.severity === 'error').length, findings }
    })
    const ok = !missing.length && documents.every((d) => d.passes)
    const commit = commitOf(root)
    const work = new Work()
    try {
        const id = work.start('docs.check', { subject: `documents at ${a.stage}`, args: a, ...(commit ? { gitSha: commit } : {}) })
        for (const d of documents) work.measure(id, `${d.kind}.errors`, d.errors, '')
        work.measure(id, 'missing', missing.length, '')
        const summary = ok ? `${documents.length} document(s) pass at ${a.stage}` : [missing.length ? `missing: ${missing.join(', ')}` : '', ...documents.filter((d) => !d.passes).map((d) => `${d.kind}: ${d.errors} error(s)`)].filter(Boolean).join('; ')
        const result = { run_id: id, stage: a.stage, passes: ok, missing: missing.map((k) => DOCS[k].file), documents, ...(kinds.length ? {} : { note: 'No documents yet under docs/design.' }) }
        work.finish(id, ok ? 'pass' : 'fail', summary, { ...result, documents: documents.map(({ findings: _, ...d }) => d) })
        return result
      } finally {
        work.db.close()
      }
    },
  })

  const publish = defineTool({
    name: 'docs.publish',
    description: 'Print the project\'s documents to PDF with the project\'s logo: a cover, revisions, contents, every Mermaid diagram drawn, the renders, drawings and traces they name, page headers and numbers. Runs pandoc, Mermaid and Typst on the tools function (or here). Each PDF is kept as the run\'s artifact. A diagram Mermaid cannot read fails, naming it: fix the diagram. If the browser that draws diagrams cannot start (a fault in trace\'s installation, not the document), the PDF is still made with those diagrams printed as their Mermaid source, and the result lists them under not_drawn: carry on, and print again later; do not ask the person to fix trace.',
    input: z.object({
      docs: Kinds,
      revisions: z.array(z.object({ revision: z.string().max(20), date: z.string().max(40), commit: z.string().regex(/^[0-9a-f]{4,40}$/), note: z.string().max(300) })).max(50).optional()
        .describe('the revision table, oldest first; default: this revision only'),
      out_dir: z.string().optional().describe('also write the PDFs to this folder of the repository'),
      release: z.string().regex(/^[A-Z]{1,3}$/).optional().describe('the revision just cut (A, B, …): these are its release copies, kept with the revision for good; a document already printed for it is kept as it was'),
      timeout_s: z.number().int().min(30).max(840).default(600),
    }),
    run: async (a) => {
      const root = process.cwd()
      const kinds = present(root, a.docs)
      if (!kinds.length) throw new ToolError('there are no documents under docs/design to print')
      const logo = logoPaths('light').find((p) => existsSync(join(root, p)))
      const commit = commitOf(root)
      const printed = printedStore()
      if (a.release && !printed) throw new ToolError('release copies are kept in the central bucket, which this session cannot reach (TRACE_PROJECT_HOME is not set): print them from the worker')
      const released: Printed[] = []
    // every print on a worker, release or not: each document's newest (latest.json, the Docs tab's)
    const newest: Printed[] = []
      const work = new Work()
      // here: this machine's Python with tracebridge; on the tools function: its venv's, first on its PATH
      const local = backendFor({ kind: 'docs' }) === 'local'
      const python = local ? process.env.TRACE_PYTHON || 'python3' : 'python3'
      const env: Record<string, string> = { PYTHONUNBUFFERED: '1', ...(local ? { PYTHONPATH: [PY_DIR, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
        ...(process.env.TRACE_CHROMIUM ? { TRACE_CHROMIUM: process.env.TRACE_CHROMIUM } : {}) }
      const results: Record<string, unknown>[] = []
      try {
      for (const k of kinds) {
        const file = DOCS[k].file
        const dir = posix.dirname(file)
        const md = readFileSync(join(root, file), 'utf8')
        const inputs: Record<string, string> = { [file]: join(root, file) }
        for (const img of imagesOf(md)) {
          const p = posix.join(dir, img)
          if (!existsSync(join(root, p))) throw new ToolError(`${file} names the image ${img}, which is not in the repository`)
          inputs[p] = join(root, p)
        }
        if (logo) inputs[logo] = join(root, logo)
        const tmp = join(root, '.trace', 'tmp')
        mkdirSync(tmp, { recursive: true })
        const revFile = join(tmp, `revisions-${k}.json`)
        writeFileSync(revFile, JSON.stringify(a.revisions ?? []))
        inputs['revisions.json'] = revFile
        const pdf = `${k}.pdf`
        const id = work.start('docs.publish', { subject: file, args: { ...a, doc: k }, ...(commit ? { gitSha: commit } : {}) })
        try {
          const r = await runJob({
            kind: 'docs', timeoutSeconds: a.timeout_s, outputs: [pdf], inputs, env,
            argv: [python, '-m', 'tracebridge.docs', 'publish', '--doc', `{in:${file}}`, '--out', `{out:${pdf}}`,
              '--revisions', '{in:revisions.json}', ...(logo ? ['--logo', `{in:${logo}}`] : [])],
          })
          let said: { error?: string; bytes?: number; diagrams?: number; browser?: { flags: number | null; tried: string[] }; not_drawn?: number[]; not_drawn_why?: string } = {}
          try { said = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') } catch { /* a crash: stderr says why */ }
          const got = r.outputs[pdf]
          if (r.exitCode !== 0 || !got) {
            const why = said.error ?? (r.stderr || r.stdout).trim().slice(-600)
            work.finish(id, 'fail', `${DOCS[k].title} was not printed: ${why}`)
            throw new ToolError(`${DOCS[k].title} was not printed: ${why}`)
          }
          const bytes = readFileSync(got)
          rmSync(got, { force: true })
          // a release copy is kept for good: never one with a diagram left as source
          if (a.release && said.not_drawn?.length) {
            const why = `${DOCS[k].title} was not kept as revision ${a.release}'s release copy: diagram(s) ${said.not_drawn.join(', ')} could not be drawn (${said.not_drawn_why ?? 'the browser did not start'})`
            work.finish(id, 'fail', why)
            throw new ToolError(why)
          }
          // the bucket when there is one (the run keeps where), else the run's own artifact
          const kept = printed ? await storePrinted(printed.store, printed.repository, bytes) : null
          if (kept) work.artifact(id, `${pdf}.json`, JSON.stringify({ key: kept.key, sha256: kept.sha256, bytes: bytes.length, ...(a.release ? { release: a.release } : {}) }), 'application/json')
          else work.artifact(id, pdf, bytes, 'application/pdf')
          work.measure(id, 'bytes', bytes.length, 'B')
          work.measure(id, 'diagrams', said.diagrams ?? null, '')
          const notDrawn = said.not_drawn ?? []
          if (notDrawn.length) work.measure(id, 'diagrams_not_drawn', notDrawn.length, '')
          let written: string | undefined
          if (a.out_dir) {
            const target = resolve(root, a.out_dir, pdf)
            if (!target.startsWith(resolve(root) + '/')) throw new ToolError('out_dir must be inside the repository')
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, bytes)
            written = target
          }
          const summary = `${DOCS[k].title}: ${(bytes.length / 1024).toFixed(0)} KB, ${said.diagrams ?? 0} diagram(s)${notDrawn.length ? `, ${notDrawn.length} printed as Mermaid source (the browser that draws them did not start)` : ''}${logo ? '' : ', no logo (the project icon is used)'}`
          const undrawn = notDrawn.length ? {
            not_drawn: notDrawn,
            not_drawn_why: said.not_drawn_why ?? '',
            note: `Diagram(s) ${notDrawn.join(', ')} were printed as their Mermaid source: the browser that draws diagrams did not start where this ran, which is a fault in trace's installation, not in the document. The rest of the document printed; print it again later to draw them.`,
          } : {}
          const result = { kind: k, file, run_id: id, pdf, bytes: bytes.length, diagrams: said.diagrams ?? 0, logo: logo ?? null, commit, where: r.where, ...(said.browser ? { browser: said.browser } : {}), ...undrawn, ...(kept ? { sha256: kept.sha256 } : {}), ...(written ? { written } : {}) }
          work.finish(id, 'pass', summary, result)
          results.push(result)
          const entry: Printed | null = kept ? { kind: k, sha256: kept.sha256, bytes: bytes.length, commit, run: id, at: Date.now() } : null
        if (entry) newest.push(entry)
        if (entry && a.release) released.push(entry)
        } finally {
          rmSync(revFile, { force: true })
        }
      }
    } catch (e) {
      // what printed before a failure is still the revision's, and the newest: the next print adds the rest
      if (printed) await recordLatest(printed.store, printed.repository, newest)
      if (a.release && printed && released.length) await recordRelease(printed.store, printed.repository, a.release, released)
      throw e
    }
    if (printed) await recordLatest(printed.store, printed.repository, newest)
    if (!a.release || !printed) return { documents: results }
    const rel = await recordRelease(printed.store, printed.repository, a.release, released)
    return {
      documents: results, release: { revision: a.release, ...rel },
      ...(rel.kept.length ? { note: `Revision ${a.release} already had release copies of ${rel.kept.join(', ')}: those were kept as they were.` } : {}),
    }
  },
})

/** Where printed copies go: the central bucket's project prefix, for a worker session (TRACE_PROJECT_HOME); else none. */
function printedStore(): { store: Backend; repository: string } | null {
  if (!process.env.TRACE_PROJECT_HOME?.trim()) return null
  const p = projectsFromEnv()
  return p ? { store: projectsBackend(p.projects), repository: p.repository } : null
}

export const tools: AnyTool[] = [check, publish, ...figureTools, ...scribeTools]
