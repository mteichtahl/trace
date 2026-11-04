/**
 * The project's documents (docs/scribe.md): checking them against Scribe's quality bar and printing them to PDF.
 *
 *   docs.check    each document under docs/design against src/docs/checks.ts at the project's stage: errors block a
 *                 change, warnings are shown with it. No program runs.
 *   docs.publish  each document printed to a PDF with the project's logo (python -m tracebridge.docs, the `docs` job
 *                 kind: pandoc, Mermaid's mmdc and Typst, on the tools function where there is one). The PDF is kept
 *                 as the run's artifact, with its size, page-ready diagram count and the commit; a diagram that does
 *                 not draw or an image not beside the document fails the run, saying which.
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
import { DOC_KINDS, DOCS, type DocKind } from '../../docs/catalog.js'
import { checkDoc, passes } from '../../docs/checks.js'
import { logoPaths } from '../../docs/logo.js'
import { PY_DIR } from '../mech/engine.js'
import { commitOf } from '../render/model.js'
import { figureTools } from './figures.js'
import { scribeTools } from './scribe.js'

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
  description: 'Check the project\'s documents (docs/design: high level design, low level design, protocol specification, user guide) against Scribe\'s quality bar at a stage: every section present, sections due by the stage written, figures with kind, source, caption and the right diagram type, values with a basis and a source, no unexplained acronyms. Errors block a change.',
  input: z.object({ docs: Kinds, stage: z.enum(STAGE_IDS).describe('the project\'s current stage: sections due by it must be written') }),
  run: (a) => {
    const root = process.cwd()
    const kinds = present(root, a.docs)
    if (!kinds.length) return { documents: [], note: 'No documents yet under docs/design.' }
    return {
      documents: kinds.map((k) => {
        const findings = checkDoc(k, readFileSync(join(root, DOCS[k].file), 'utf8'), { stage: a.stage as StageId })
        return { kind: k, file: DOCS[k].file, passes: passes(findings), errors: findings.filter((f) => f.severity === 'error').length, findings }
      }),
    }
  },
})

const publish = defineTool({
  name: 'docs.publish',
  description: 'Print the project\'s documents to PDF with the project\'s logo: a cover, revisions, contents, every Mermaid diagram drawn, the renders, drawings and traces they name, page headers and numbers. Runs pandoc, Mermaid and Typst on the tools function (or here). Each PDF is kept as the run\'s artifact. A diagram that does not draw fails, naming it.',
  input: z.object({
    docs: Kinds,
    revisions: z.array(z.object({ revision: z.string().max(20), date: z.string().max(40), commit: z.string().regex(/^[0-9a-f]{4,40}$/), note: z.string().max(300) })).max(50).optional()
      .describe('the revision table, oldest first; default: this revision only'),
    out_dir: z.string().optional().describe('also write the PDFs to this folder of the repository'),
    timeout_s: z.number().int().min(30).max(840).default(600),
  }),
  run: async (a) => {
    const root = process.cwd()
    const kinds = present(root, a.docs)
    if (!kinds.length) throw new ToolError('there are no documents under docs/design to print')
    const logo = logoPaths('light').find((p) => existsSync(join(root, p)))
    const commit = commitOf(root)
    const work = new Work()
    // here: this machine's Python with tracebridge; on the tools function: its venv's, first on its PATH
    const local = backendFor({ kind: 'docs' }) === 'local'
    const python = local ? process.env.TRACE_PYTHON || 'python3' : 'python3'
    const env: Record<string, string> = { PYTHONUNBUFFERED: '1', ...(local ? { PYTHONPATH: [PY_DIR, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
      ...(process.env.TRACE_CHROMIUM ? { TRACE_CHROMIUM: process.env.TRACE_CHROMIUM } : {}) }
    const results: Record<string, unknown>[] = []
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
        let said: { error?: string; bytes?: number; diagrams?: number } = {}
        try { said = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') } catch { /* a crash: stderr says why */ }
        const got = r.outputs[pdf]
        if (r.exitCode !== 0 || !got) {
          const why = said.error ?? (r.stderr || r.stdout).trim().slice(-600)
          work.finish(id, 'fail', `${DOCS[k].title} was not printed: ${why}`)
          throw new ToolError(`${DOCS[k].title} was not printed: ${why}`)
        }
        const bytes = readFileSync(got)
        rmSync(got, { force: true })
        work.artifact(id, pdf, bytes, 'application/pdf')
        work.measure(id, 'bytes', bytes.length, 'B')
        work.measure(id, 'diagrams', said.diagrams ?? null, '')
        let written: string | undefined
        if (a.out_dir) {
          const target = resolve(root, a.out_dir, pdf)
          if (!target.startsWith(resolve(root) + '/')) throw new ToolError('out_dir must be inside the repository')
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, bytes)
          written = target
        }
        const summary = `${DOCS[k].title}: ${(bytes.length / 1024).toFixed(0)} KB, ${said.diagrams ?? 0} diagram(s)${logo ? '' : ', no logo (the project icon is used)'}`
        const result = { kind: k, file, run_id: id, pdf, bytes: bytes.length, diagrams: said.diagrams ?? 0, logo: logo ?? null, commit, where: r.where, ...(written ? { written } : {}) }
        work.finish(id, 'pass', summary, result)
        results.push(result)
      } finally {
        rmSync(revFile, { force: true })
      }
    }
    return { documents: results }
  },
})

export const tools: AnyTool[] = [check, publish, ...figureTools, ...scribeTools]
