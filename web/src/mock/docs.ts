/**
 * The Documents tab in mock mode (documents.get and documents.pdf): Soil sensor, at Capture. Its high level design is
 * current and printed; its low level design is behind (the schematic changed, and sections due by Capture are still
 * to write) while the Documentation agent updates it; its protocol specification is current but printed from an
 * earlier text; its user guide comes at Layout. Rev A and Rev B have release copies. The PDFs are real prints of
 * these documents by trace's own pipeline (python -m tracebridge.docs), kept small.
 */
import type { DocSection, DocumentsView, ProjectDocument } from '@/lib/types-docs'
import hldPdf from './docs/high-level-design.pdf?inline'
import lldPdf from './docs/low-level-design.pdf?inline'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const SOIL = 'acme/soil-sensor'
const NOW = Date.now()
const MIN = 60_000
const DAY = 86_400_000

const HLD_SHA = 'cb55bed67beea653af1cf447967a334df1ecb0959767f73d1ac3fda4091f1de2'
const LLD_SHA = '143982798bd96ceab96e56e5d461d4acc5b3167e7df720af3bfb14c74423ecf7'
// the protocol specification and Rev A's copies open the same two prints: what matters here is the screen
const PDFS: Readonly<Record<string, string>> = { [HLD_SHA]: hldPdf, [LLD_SHA]: lldPdf, ['a'.repeat(64)]: hldPdf, ['b'.repeat(64)]: lldPdf, ['c'.repeat(64)]: hldPdf }

const sec = (id: string, title: string, due: string, written: boolean, overdue = false): DocSection => ({ id, title, due, written, overdue })

const DOCS: ProjectDocument[] = [
  {
    kind: 'hld', title: 'High level design', file: 'docs/design/high-level-design.md', exists: true, due: true, from: 'architect', state: 'current',
    revision: 'B', commit: 'a41e9d0c2b17', updated: '2026-11-05', behind: [],
    sections: [
      sec('overview', 'Overview', 'architect', true), sec('context', 'System context', 'architect', true), sec('requirements', 'Requirements', 'architect', true),
      sec('architecture', 'Architecture', 'architect', true), sec('data-flow', 'Data flow', 'architect', true), sec('key-parts', 'Key parts', 'architect', true),
      sec('power-summary', 'Power and thermal summary', 'prove', false), sec('mechanical', 'Mechanical summary', 'layout', false), sec('journey', 'Journey', 'architect', true),
      sec('decisions', 'Decisions', 'architect', true), sec('risks', 'Risks and open questions', 'architect', true), sec('glossary', 'Glossary', 'architect', true),
    ],
    printed: { kind: 'hld', sha256: HLD_SHA, bytes: 121_964, commit: 'a41e9d0c2b17', run: 'run_doc_hld', at: NOW - 40 * MIN, current: true },
  },
  {
    kind: 'lld', title: 'Low level design', file: 'docs/design/low-level-design.md', exists: true, due: true, from: 'capture', state: 'behind',
    revision: 'B', commit: '7f3c21b08e44', updated: '2026-11-03', behind: ['schematic', 'parts'],
    sections: [
      sec('modules', 'Modules', 'capture', true), sec('pin-plan', 'Pin plan', 'capture', false, true), sec('power-tree', 'Power tree', 'capture', true),
      sec('power-budget', 'Power budget', 'prove', false), sec('thermal', 'Thermal', 'prove', false), sec('loads', 'Loads', 'layout', false),
      sec('interfaces', 'Interfaces', 'capture', true), sec('firmware', 'Firmware', 'capture', false, true), sec('board', 'Board', 'layout', false),
      sec('mechanical', 'Mechanical', 'layout', false), sec('verification', 'Verification', 'prove', false), sec('glossary', 'Glossary', 'capture', true),
    ],
    printed: { kind: 'lld', sha256: LLD_SHA, bytes: 81_823, commit: '7f3c21b08e44', run: 'run_doc_lld', at: NOW - 2 * DAY, current: true },
  },
  {
    kind: 'protocol', title: 'Protocol specification', file: 'docs/design/protocol-specification.md', exists: true, due: true, from: 'capture', state: 'current',
    revision: 'B', commit: 'a41e9d0c2b17', updated: '2026-11-05', behind: [],
    sections: [
      sec('scope', 'Scope', 'capture', true), sec('physical', 'Physical layer', 'capture', true), sec('messages', 'Messages', 'capture', true),
      sec('sequences', 'Sequences', 'capture', true), sec('timing', 'Timing', 'prove', false), sec('errors', 'Errors', 'capture', true), sec('glossary', 'Glossary', 'capture', true),
    ],
    printed: { kind: 'protocol', sha256: 'c'.repeat(64), bytes: 64_210, commit: '7f3c21b08e44', run: 'run_doc_proto', at: NOW - 2 * DAY, current: false },
  },
  {
    kind: 'guide', title: 'User guide', file: 'docs/design/user-guide.md', exists: false, due: false, from: 'layout', state: 'later',
    revision: null, commit: null, updated: null, behind: [], sections: [], printed: null,
  },
]

const VIEW: DocumentsView = {
  repo: SOIL, branch: 'main', commit: 'b52d77e19a03', stage: 'capture',
  documents: DOCS,
  releases: [
    {
      revision: 'B', cut: { at: NOW - 22 * MIN, commit: 'a41e9d0c2b17', branch: 'trace/release-b-1730790000' },
      documents: [
        { kind: 'hld', title: 'High level design', sha256: HLD_SHA, bytes: 121_964, commit: 'a41e9d0c2b17', run: 'run_doc_rel_b1', at: NOW - 18 * MIN },
        { kind: 'lld', title: 'Low level design', sha256: LLD_SHA, bytes: 81_823, commit: 'a41e9d0c2b17', run: 'run_doc_rel_b2', at: NOW - 17 * MIN },
        { kind: 'protocol', title: 'Protocol specification', sha256: 'c'.repeat(64), bytes: 64_210, commit: 'a41e9d0c2b17', run: 'run_doc_rel_b3', at: NOW - 16 * MIN },
      ],
    },
    {
      revision: 'A', cut: { at: NOW - 15 * DAY, commit: '9c02e1f4d6a8', branch: 'trace/release-a-1729500000' },
      documents: [
        { kind: 'hld', title: 'High level design', sha256: 'a'.repeat(64), bytes: 98_400, commit: '9c02e1f4d6a8', run: 'run_doc_rel_a1', at: NOW - 15 * DAY },
        { kind: 'lld', title: 'Low level design', sha256: 'b'.repeat(64), bytes: 70_150, commit: '9c02e1f4d6a8', run: 'run_doc_rel_a2', at: NOW - 15 * DAY },
      ],
    },
  ],
  writing: { job: 'doc_lld_1', state: 'running', since: new Date(NOW - 6 * MIN).toISOString() },
  next_check: (() => { const t = new Date(); t.setUTCHours(17, 0, 0, 0); if (t.getTime() <= NOW) t.setUTCDate(t.getUTCDate() + 1); return t.toISOString() })(),
}

/** documents.get and documents.pdf; undefined for anything else. */
export function docsAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = String(a.repo ?? '')
  if (name === 'documents.get') {
    if (repo === SOIL) return ok(VIEW)
    return ok({ ...VIEW, repo, stage: 'architect', writing: null, releases: [], documents: DOCS.map((d) => ({ ...d, exists: false, state: d.kind === 'hld' ? 'missing' : 'later', due: d.kind === 'hld', revision: null, commit: null, updated: null, behind: [], printed: null, sections: d.sections.map((s) => ({ ...s, written: false, overdue: false })) })) })
  }
  if (name === 'documents.pdf') {
    const url = PDFS[String(a.sha256)]
    if (!url) return fail('There is no printed copy with that hash for this project.')
    const base64 = url.slice(url.indexOf(',') + 1)
    return ok({ repo, sha256: a.sha256, bytes: Math.floor((base64.length * 3) / 4), mime: 'application/pdf', base64 })
  }
  return undefined
}
