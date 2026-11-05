/**
 * docs.check and docs.publish (src/tools/docs/tools.ts; docs/scribe.md): the images a document sends with it, the
 * quality bar over the repository's documents, and, where pandoc, Mermaid and Typst are installed, a document printed
 * to a PDF kept as the run's artifact. The 'docs' job kind runs on the tools function.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { skeleton } from '../../../src/docs/catalog.js'
import { replaceSection } from '../../../src/docs/markers.js'
import { FUNCTION_KINDS } from '../../../src/gpu/jobs.js'
import { PY_DIR } from '../../../src/tools/mech/engine.js'
import { imagesOf } from '../../../src/tools/docs/tools.js'
import { allTools } from '../../../src/tools/index.js'
import { backendFor } from '../../../src/core/central.js'
import { latestOf, readPrinted, releasesOf } from '../../../src/docs/printed.js'

type Dict = Record<string, any>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const dir = mkdtempSync(join(tmpdir(), 'trace-docs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const CTX = { project: 'test-esp32', revision: 'A', commit: '0123456789abcdef', date: '2026-11-05' }

function repo(name: string, files: Record<string, string>): string {
  const r = join(dir, name)
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(r, p, '..'), { recursive: true })
    writeFileSync(join(r, p), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: r })
  return r
}
async function inRepo<T>(r: string, f: () => Promise<T>): Promise<T> {
  const cwd = process.cwd()
  process.chdir(r)
  try { return await f() } finally { process.chdir(cwd) }
}

describe('docs tools', () => {
  it('a document sends the images it names, never a URL or a path outside the repository', () => {
    expect(imagesOf('![a](figures/top.png) ![b](https://x/y.png) ![c](../secret.png) ![d](/etc/x.png) ![e](./figures/top.png)')).toEqual(['figures/top.png'])
  })

  it('printing runs on the tools function', () => {
    expect(FUNCTION_KINDS.has('docs')).toBe(true)
  })

  it('docs.check holds each document to the quality bar at the stage', async () => {
    const r = repo('check', { 'docs/design/high-level-design.md': skeleton('hld', CTX) })
    const early = await inRepo(r, () => call('docs.check', { stage: 'define' }))
    expect(early.documents).toMatchObject([{ kind: 'hld', passes: true, errors: 0 }])
    const late = await inRepo(r, () => call('docs.check', { stage: 'prove' }))
    expect(late.documents[0].passes).toBe(false)
    expect(late.documents[0].findings.some((f: Dict) => f.code === 'pending' && f.section === 'context')).toBe(true)
    const none = await inRepo(repo('none', { 'README.md': '# x' }), () => call('docs.check', { stage: 'define' }))
    expect(none.note).toMatch(/No documents/)
  })
})

// ------------------------------------------------------------------ end to end, where the programs are

// TRACE_CHROMIUM, else Playwright's headless shell or browser wherever it was installed (any version)
function findChromium(): string | undefined {
  if (process.env.TRACE_CHROMIUM) return process.env.TRACE_CHROMIUM
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')].filter((r): r is string => !!r && existsSync(r))
  const tails = [['chromium_headless_shell-', ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell']], ['chromium-', ['chrome-linux64/chrome', 'chrome-linux/chrome']]] as const
  for (const [prefix, files] of tails) {
    for (const root of roots) {
      for (const d of readdirSync(root).filter((n) => n.startsWith(prefix)).sort().reverse()) {
        const hit = files.map((f) => join(root, d, f)).find((f) => existsSync(f))
        if (hit) return hit
      }
    }
  }
  return undefined
}
const chromium = findChromium()
const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const programs = has('pandoc', ['--version']) && has('mmdc', ['--version']) && has(process.env.TRACE_PYTHON || 'python3', ['-c', 'import typst']) && !!chromium && existsSync(join(PY_DIR, 'tracebridge', 'docs'))

describe.skipIf(!programs)('docs.publish, with pandoc, Mermaid and Typst here', () => {
  it('prints a document with its diagram, image and logo, keeping the PDF as the run\'s artifact', async () => {
    if (chromium) process.env.TRACE_CHROMIUM = chromium
    const md = replaceSection(skeleton('hld', CTX), 'data-flow', '## Data flow\n\n<!-- scribe:figure kind="data-flow" source="ontology:architecture" -->\n```mermaid\nflowchart LR\n  A[USB] --> B[ESP32] --> C[Display]\n```\n_How readings reach the display._')
    const r = repo('publish', {
      'docs/design/high-level-design.md': md,
      'docs/design/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#0b5cad"/></svg>',
    })
    const out = await inRepo(r, () => call('docs.publish', { out_dir: 'out' }))
    expect(out.documents).toHaveLength(1)
    const d = out.documents[0]
    expect(d).toMatchObject({ kind: 'hld', diagrams: 1, logo: 'docs/design/logo.svg', where: 'local' })
    expect(readFileSync(d.written).subarray(0, 5).toString()).toBe('%PDF-')
    const run = await inRepo(r, () => call('trace.run', { id: d.run_id }))
    expect(run.status).toBe('pass')
    expect(run.artifacts.map((x: Dict) => x.name)).toEqual(['hld.pdf'])
  }, 180_000)

  it('on a worker, keeps the PDF in the central bucket and the run only where; a release\'s copies once', async () => {
    const projects = join(dir, 'bucket', 'projects')
    const env = { home: process.env.TRACE_PROJECT_HOME, project: process.env.TRACE_PROJECT }
    process.env.TRACE_PROJECT_HOME = join(projects, 'acme', 'printed')
    process.env.TRACE_PROJECT = 'acme/printed'
    try {
      const r = repo('bucket-print', { 'docs/design/high-level-design.md': skeleton('hld', CTX) })
      const out = await inRepo(r, () => call('docs.publish', { release: 'A' }))
      const d = out.documents[0]
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(out.release).toEqual({ revision: 'A', added: ['hld'], kept: [] })
      const store = backendFor(projects)
      expect(Buffer.from((await readPrinted(store, 'acme/printed', d.sha256))!).subarray(0, 5).toString()).toBe('%PDF-')
      const run = await inRepo(r, () => call('trace.run', { id: d.run_id }))
      // the run record keeps where, never the PDF
      expect(run.artifacts.map((x: Dict) => x.name)).toEqual(['hld.pdf.json'])
      expect((await releasesOf(store, 'acme/printed'))[0]!.documents).toMatchObject([{ kind: 'hld', sha256: d.sha256, run: d.run_id }])
      expect((await latestOf(store, 'acme/printed')).hld).toMatchObject({ sha256: d.sha256, run: d.run_id })
      // printed again for the same revision: the first copy stands
      const again = await inRepo(r, () => call('docs.publish', { release: 'A' }))
      expect(again.release).toEqual({ revision: 'A', added: [], kept: ['hld'] })
      expect(again.note).toMatch(/kept as they were/)
    } finally {
      if (env.home === undefined) delete process.env.TRACE_PROJECT_HOME; else process.env.TRACE_PROJECT_HOME = env.home
      if (env.project === undefined) delete process.env.TRACE_PROJECT; else process.env.TRACE_PROJECT = env.project
    }
  }, 180_000)

  it('release copies need the central bucket', async () => {
    const r = repo('no-bucket', { 'docs/design/high-level-design.md': skeleton('hld', CTX) })
    await expect(inRepo(r, () => call('docs.publish', { release: 'A' }))).rejects.toThrow(/central bucket/)
  })

  it('a diagram that does not draw fails the run, naming it', async () => {
    const md = replaceSection(skeleton('hld', CTX), 'data-flow', '## Data flow\n\n<!-- scribe:figure kind="data-flow" source="x" -->\n```mermaid\nflowchart LR\n  A --> \n  ((((\n```\n_Broken._')
    const r = repo('broken', { 'docs/design/high-level-design.md': md })
    await expect(inRepo(r, () => call('docs.publish', {}))).rejects.toThrow(/diagram 1 \(flowchart LR\) does not draw/)
  }, 180_000)

  // Log #34, #94: the browser behind Mermaid could not start on the tools function, so no PDF was made and the
  // documentation specialist stopped to ask the person to fix trace
  it('a browser that cannot start leaves the diagram as its source, and the document still prints', async () => {
    const was = process.env.TRACE_CHROMIUM
    process.env.TRACE_CHROMIUM = '/bin/false'
    try {
      const md = replaceSection(skeleton('hld', CTX), 'data-flow', '## Data flow\n\n<!-- scribe:figure kind="data-flow" source="ontology:architecture" -->\n```mermaid\nflowchart LR\n  A[USB] --> B[ESP32]\n```\n_How readings reach the display._')
      const r = repo('no-browser', { 'docs/design/high-level-design.md': md })
      const out = await inRepo(r, () => call('docs.publish', { out_dir: 'out' }))
      const d = out.documents[0]
      expect(d).toMatchObject({ kind: 'hld', diagrams: 1, not_drawn: [1] })
      expect(d.not_drawn_why).toMatch(/not the diagram/)
      expect(d.note).toMatch(/printed as their Mermaid source.*not in the document/)
      expect(readFileSync(d.written).subarray(0, 5).toString()).toBe('%PDF-')
      const run = await inRepo(r, () => call('trace.run', { id: d.run_id }))
      expect(run.status).toBe('pass')
      expect(run.summary).toMatch(/1 printed as Mermaid source/)
      // a release copy is kept for good, so never one without its diagrams
      process.env.TRACE_PROJECT_HOME = join(dir, 'bucket2', 'projects', 'acme', 'nob')
      process.env.TRACE_PROJECT = 'acme/nob'
      await expect(inRepo(r, () => call('docs.publish', { release: 'A' }))).rejects.toThrow(/not kept as revision A's release copy: diagram\(s\) 1 could not be drawn/)
    } finally {
      delete process.env.TRACE_PROJECT_HOME
      delete process.env.TRACE_PROJECT
      if (was === undefined) delete process.env.TRACE_CHROMIUM; else process.env.TRACE_CHROMIUM = was
    }
  }, 180_000)
})
