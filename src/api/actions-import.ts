/**
 * Starting a project from fabrication files (docs/fab-import.md): the Gerbers, the bill of materials, the pick and
 * place and a written overview, checked and then put into the new project's repository, with the journey entered at
 * Fabricate (or Bring up for boards already built).
 *
 *   projects.import_upload  admin  { upload, file, give, part, parts, base64 } → { file, part, parts, received }
 *                                  one part (at most 3 MB) of one file, kept under imports/<uploader>/<upload>/ in the
 *                                  central bucket (expired after a day): parts keep a 25 MB zip within the 5,000,000
 *                                  bytes AWS WAF lets through to /api/* (src/infra/edge.ts BodyTooLarge); `give` (the
 *                                  time the person gave the file, in ms) keeps a file given again apart from the last
 *   projects.import_check   admin  { upload, overview, quantity?, built? } → the inspection (src/tools/fab/inspect.ts),
 *                                  with each file's size; answers what is missing as blocking findings, never throws
 *                                  for a file it cannot read
 *
 * projects.create takes `import: { upload, overview, entry }` with `start: 'import'` (src/api/actions-projects.ts)
 * and calls importProject here once the journey is started: one commit of the files on trace/import-<slug>-<time>,
 * its change recorded (kind import: it applies once its checks pass), the journey entered (enterImported), and the
 * entry stage's work asked of the agents (queued until the project's agent is set up, src/api/agent-queue.ts).
 */
import { z } from 'zod'
import { type Evidence, type StageId, enterImported, STAGE_NAMES } from '../core/journey.js'
import { IMPORTS_PREFIX } from '../core/project.js'
import { type Entry, importPaths, inspect, type Inspection, inspectionView, MAX_CSV, MAX_GERBER_ZIP, MAX_OVERVIEW, MB } from '../tools/fab/inspect.js'
import { ActionError, type Context, def, hashOf, label, slugify, storeAt, writeJourney } from './action-kit.js'
import { publicName } from './actions-changes.js'
import { editorName, recordEdit } from './edits.js'

/** The most of one file one request carries: 3 MB, so as base64 (4 MB) with the rest it stays under WAF's 5,000,000 bytes. */
export const IMPORT_PART = 3 * MB
export const IMPORT_FILES = ['gerbers', 'bom', 'cpl'] as const
export type ImportFile = (typeof IMPORT_FILES)[number]
/** the most of each file, in bytes */
export const IMPORT_MAX: Readonly<Record<ImportFile, number>> = { gerbers: MAX_GERBER_ZIP, bom: MAX_CSV, cpl: MAX_CSV }
export const MAX_PARTS = Math.ceil(MAX_GERBER_ZIP / IMPORT_PART)

/** An upload's id: the app makes one (a UUID) for each import it starts. */
export const UploadId = z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/, 'an upload id: lowercase letters, digits and dashes')
const Base64 = z.string().min(1).max(Math.ceil(IMPORT_PART / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'the part\'s bytes as base64')
export const Overview = z.string().max(MAX_OVERVIEW + 1000)

/** Where an uploader's part is kept, under the imports prefix: the uploader is in the key, so another's is not found. */
export const partKey = (who: string, upload: string, file: ImportFile, give: string, part: number, parts: number): string => `${who}/${upload}/${file}.${give}.${part}-of-${parts}`

/**
 * The files an upload holds, each joined from the parts of its newest give; a file whose newest give is missing a part
 * is answered as missing, with why. Pure over the keys and bodies given.
 */
export function joinParts(keys: readonly string[], body: (key: string) => Uint8Array | null): { files: Partial<Record<ImportFile, Uint8Array>>; incomplete: Partial<Record<ImportFile, string>> } {
  const files: Partial<Record<ImportFile, Uint8Array>> = {}
  const incomplete: Partial<Record<ImportFile, string>> = {}
  for (const file of IMPORT_FILES) {
    const mine = keys.map((k) => /([a-z]+)\.(\d{13})\.(\d+)-of-(\d+)$/.exec(k)).filter((m): m is RegExpExecArray => !!m && m[1] === file)
    if (!mine.length) continue
    // the newest give of a file wins: a file given again leaves the old give's parts beside it
    const give = mine.map((m) => m[2]!).sort().at(-1)!
    const latest = mine.filter((m) => m[2] === give)
    const parts = Number(latest[0]![4])
    const byPart = new Map(latest.filter((m) => Number(m[4]) === parts).map((m) => [Number(m[3]), m.input]))
    const missing = Array.from({ length: parts }, (_, i) => i).filter((i) => !byPart.has(i))
    if (missing.length) { incomplete[file] = `${missing.length} of its ${parts} parts did not arrive: give it again.`; continue }
    const chunks = Array.from({ length: parts }, (_, i) => body(byPart.get(i)!))
    if (chunks.some((c) => !c)) { incomplete[file] = 'a part could not be read back: give it again.'; continue }
    const total = chunks.reduce((n, c) => n + c!.length, 0)
    if (total > IMPORT_MAX[file]) { incomplete[file] = `it is ${(total / MB).toFixed(1)} MB, and at most ${IMPORT_MAX[file] / MB} MB is taken.`; continue }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) { out.set(c!, at); at += c!.length }
    files[file] = out
  }
  return { files, incomplete }
}

/** An admin's upload, read back from the bucket. */
export async function readUpload(ctx: Context, upload: string): Promise<ReturnType<typeof joinParts>> {
  const store = storeAt(ctx, IMPORTS_PREFIX)
  const prefix = `${hashOf(ctx.principal)}/${upload}/`
  const keys = await store.list(prefix)
  const bodies = new Map<string, Uint8Array>()
  for (const k of keys) {
    const got = await store.get(k).catch(() => null)
    if (got) bodies.set(k, got.body)
  }
  return joinParts(keys, (k) => bodies.get(k) ?? null)
}

const text = (b: Uint8Array | undefined): string | null => (b ? new TextDecoder('utf-8').decode(b) : null)

/** Inspect an upload with the overview: the inspection, and each file's size (null: not given). */
export async function checkUpload(ctx: Context, a: { upload: string; overview: string; quantity?: number | undefined; built?: boolean | undefined }): Promise<{ inspection: Inspection; sizes: Record<ImportFile, number | null>; files: Partial<Record<ImportFile, Uint8Array>> }> {
  const { files, incomplete } = await readUpload(ctx, a.upload)
  const inspection = inspect({ gerbers: files.gerbers ?? null, bom: text(files.bom), cpl: text(files.cpl), overview: a.overview, ...(a.quantity ? { quantity: a.quantity } : {}), ...(a.built ? { built: true } : {}) })
  // a file whose parts did not all arrive reads as not given: say why instead
  for (const [file, why] of Object.entries(incomplete) as [ImportFile, string][]) {
    const f = inspection.findings.find((x) => x.id === `${file}.missing`)
    if (f) f.text = /taken\.$/.test(why) ? `The ${FILE_WORDS[file]} is too large: ${why}` : `The ${FILE_WORDS[file]} did not arrive whole: ${why}`
  }
  return { inspection, files, sizes: { gerbers: files.gerbers?.length ?? null, bom: files.bom?.length ?? null, cpl: files.cpl?.length ?? null } }
}

export const FILE_WORDS: Readonly<Record<ImportFile, string>> = { gerbers: 'Gerber zip', bom: 'bill of materials', cpl: 'pick and place file' }

/** The blocking findings as one refusal, or null. Pure. */
export function refusalOf(x: Pick<Inspection, 'findings'>): string | null {
  const b = x.findings.filter((f) => f.severity === 'blocking')
  return b.length ? `The fabrication files cannot start a project yet: ${b.map((f) => f.text).join(' ')}` : null
}

/** The change's branch: trace/import-<board>-<base36 time>. Pure. */
export const importBranch = (board: string, now: number = Date.now()): string => `trace/import-${slugify(board) || 'board'}-${now.toString(36)}`

/** The overview as the repository keeps it: the person's words under a heading naming the project. Pure. */
export function overviewDoc(name: string, overview: string, by: string, at: string): string {
  return [`# ${name}: project overview`, '', `Given by ${by} when the project was started from its fabrication files (${at.slice(0, 10)}). trace's intent and requirements start from it.`, '', overview.trim(), ''].join('\n')
}

/** What the entry stage's agents are asked (docs/fab-import.md "What trace sets up", step 3). Pure. */
export function importWork(o: { entry: Entry; dir: string; bom: string; quantity: number; change: string }): { agent: 'impl' | 'verify'; headline: string; started: string; request: string }[] {
  const waitFor = `The files come onto the default branch with the change "${o.change}", which applies once its checks pass: if they are not there yet, wait for it rather than writing them yourself.`
  const out: ReturnType<typeof importWork> = []
  if (o.entry === 'fabricate') {
    out.push({
      agent: 'impl', headline: 'Recording the imported release package', started: 'The Implementation agent records the imported package and checks stock and prices again today.',
      request: [
        'This project was started from fabrication files (docs/fab-import.md): it has no KiCad design, and it is in Fabricate. Prepare the order for JLCPCB from the imported package.',
        waitFor,
        `Record the package with fab.import (dir ${o.dir}, boards ${o.quantity}): it inspects the Gerbers, BOM and placement file and records the order options. Do not run kicad.fab or kicad.board: there is no board file. Record fabricate.order.package with journey.check, citing the fab.import run.`,
        `Check stock and prices again today: parts.bom_check on ${o.bom} at ${o.quantity} board${o.quantity === 1 ? '' : 's'}, fresh, then shape.check fabricate.order.stock records the criterion. A line now short or out of stock is a question for a person (journey.ask), with an in-stock alternative where there is one.`,
        'Change no file: a problem the package shows is a question for a person. Do not order, pay or sign anything: a person checks the order sheet in Order submit and signs the order gate.',
      ].join('\n'),
    })
  }
  out.push({
    agent: 'verify', headline: 'Drafting requirements from the overview', started: 'The Verification agent drafts the requirements from the project overview.',
    request: [
      `This project was started from fabrication files (docs/fab-import.md): its intent is the overview in docs/overview.md, and it is in ${STAGE_NAMES[o.entry]}. ${STAGE_NAMES.bringup} verifies the board against its requirements, so they are needed before the boards reach the bench.`,
      waitFor,
      'Read docs/overview.md and draft the requirements it states (verify.requirements extract with its path, then add each you keep), each with a kind and a measurable acceptance criterion, and the overview\'s words as its source. Add them as proposed, never accepted: each is inferred from the overview, so say so in its source.',
      'Then ask a person to confirm them (journey.ask), listing what you inferred and anything the overview leaves open (limits, ranges, tolerances). Do not accept, waive or sign anything yourself.',
    ].join('\n'),
  })
  return out
}

export interface ImportRequest { upload: string; overview: string; entry: Entry }

/**
 * Bring the files into `repo` and enter its journey at the entry stage (projects.create, after its journey step).
 * Answers the steps' words; throws for the step that failed.
 */
export async function importFiles(ctx: Context, repo: string, o: ImportRequest & { name: string; quantity: number; files: Partial<Record<ImportFile, Uint8Array>>; inspection: Inspection }): Promise<{ change: number | null; branch: string; title: string; paths: ReturnType<typeof importPaths> }> {
  const gh = await ctx.deps.github()
  if (!gh.commitFiles) throw new ActionError('This installation cannot write files into a repository from the app.')
  const board = o.inspection.summary.project.name ?? o.name
  const paths = importPaths(board)
  const { branch: base } = await gh.defaultBranch(repo)
  const branch = importBranch(board)
  if (branch === base) throw new ActionError('refusing to write the default branch')
  const by = label(ctx.principal)
  const at = new Date().toISOString()
  const view = inspectionView(o.inspection)
  const files = [
    { path: paths.gerbers, content: o.files.gerbers! },
    { path: paths.bom, content: o.files.bom! },
    { path: paths.cpl, content: o.files.cpl! },
    { path: paths.inspection, content: new TextEncoder().encode(`${JSON.stringify({ imported_at: at, by, ...view }, null, 2)}\n`) },
    { path: paths.overview, content: new TextEncoder().encode(overviewDoc(o.name, o.overview, await publicName(ctx), at)) },
  ]
  const title = 'Import the fabrication files'
  const message = [title, '', ...files.map((f) => `- ${f.path}`), '', `Imported by ${by} through the trace API (docs/fab-import.md).`].join('\n')
  const { commit } = await gh.commitFiles(repo, { branch, base, message, files })
  const s = o.inspection.summary
  const body = [
    title, '',
    `A ${s.board.layers}-layer board, ${s.board.width_mm} × ${s.board.height_mm} mm${s.tool ? `, made in ${s.tool}` : ''}: ${s.bom.lines} BOM lines (${s.bom.parts} parts), ${s.placements.total} placements.`, '',
    ...files.map((f) => `- \`${f.path}\``), '',
    `Imported through trace by ${await editorName(ctx)}.`,
  ].join('\n')
  const edit = await recordEdit(ctx, { repo, branch, base, commit, kind: 'import', title, body, redo: null, paths: files.map((f) => f.path) })
  return { change: edit.number, branch, title, paths }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Where the imported design came from and where it is kept, one sentence: "The files are revision M.20 of
 * potroller-supervisor, made in KiCad Pcbnew 10.0.8; trace keeps them as its revision A, under
 * hardware/potroller-supervisor/release/revA, named after the design." Empty when the Gerbers name nothing. Pure.
 */
export function sourceWords(s: Pick<Inspection['summary'], 'project' | 'tool'>, dir: string): string {
  const what = [s.project.revision ? `revision ${s.project.revision}` : null, s.project.name ? `of ${s.project.name}` : null].filter(Boolean).join(' ')
  if (!what && !s.tool) return ''
  const rev = /\/rev([^/]+)$/.exec(dir)?.[1] ?? 'A'
  return `The files are ${what || 'the design'}${s.tool ? `, made in ${s.tool}` : ''}; trace keeps them as its revision ${rev}, under ${dir}${s.project.name ? ', named after the design' : ''}.`
}

/** Enter the journey at the import's stage, on the import's evidence. Answers the gates it signed. */
export async function enterAtImport(ctx: Context, repo: string, o: { entry: Entry; paths: ReturnType<typeof importPaths>; inspection: Inspection; change: number | null }): Promise<{ signed: string[] }> {
  const evidence: Evidence[] = [
    { kind: 'file', ref: o.paths.overview, label: 'The project overview' },
    { kind: 'file', ref: o.paths.gerbers, label: 'The imported Gerbers' },
    { kind: 'file', ref: o.paths.bom, label: 'The imported bill of materials' },
    { kind: 'file', ref: o.paths.cpl, label: 'The imported pick and place' },
    { kind: 'file', ref: o.paths.inspection, label: 'trace\'s inspection of the files' },
  ]
  const s = o.inspection.summary
  const warnings = o.inspection.findings.filter((f) => f.severity === 'warning').map((f) => ({ id: f.id, text: f.text }))
  return writeJourney(ctx, repo, (db) => {
    const r = enterImported(db, {
      entry: o.entry as StageId, signer: { hash: hashOf(ctx.principal), label: label(ctx.principal) }, evidence,
      // the design's own name and revision, and where its files are kept under trace's revision: the import keeps the
      // files under the Gerbers' project name, not the names they were given with (potroller-carrier-m20: revision M.20
      // of "potroller-supervisor" became "Rev A" and renamed files, with nothing saying so)
      summary: [
        `The project was started from its fabrication files: a ${s.board.layers}-layer ${s.board.width_mm} × ${s.board.height_mm} mm board, ${s.bom.lines} BOM lines and ${s.placements.total} placements, with ${plural(warnings.length, 'warning')} carried in.`,
        sourceWords(s, o.paths.dir),
      ].filter(Boolean).join(' '),
      detail: { change: o.change, warnings, source: { name: s.project.name, revision: s.project.revision, tool: s.tool, dir: o.paths.dir } },
    })
    return { result: { signed: r.signed } }
  })
}

export const IMPORT_ACTIONS = {
  'projects.import_upload': def('admin', z.object({
    upload: UploadId,
    file: z.enum(IMPORT_FILES),
    /** when the person gave the file (ms since 1970, 13 digits): the newest give of a file is the one checked */
    give: z.string().regex(/^\d{13}$/, 'the time the file was given, in milliseconds'),
    part: z.number().int().min(0).max(MAX_PARTS - 1),
    parts: z.number().int().min(1).max(MAX_PARTS),
    base64: Base64,
  }), async (a, ctx) => {
    if (a.part >= a.parts) throw new ActionError(`Part ${a.part + 1} of ${a.parts} is not a part of this file.`)
    const bytes = new Uint8Array(Buffer.from(a.base64, 'base64'))
    if (bytes.length > IMPORT_PART) throw new ActionError(`A part is at most ${IMPORT_PART / MB} MB; this one is ${(bytes.length / MB).toFixed(1)} MB.`)
    await storeAt(ctx, IMPORTS_PREFIX).put(partKey(hashOf(ctx.principal), a.upload, a.file, a.give, a.part, a.parts), bytes)
    return { upload: a.upload, file: a.file, part: a.part, parts: a.parts, received: bytes.length }
  }),

  'projects.import_check': def('admin', z.object({
    upload: UploadId,
    overview: Overview.default(''),
    quantity: z.number().int().min(1).max(1_000_000).optional(),
    built: z.boolean().optional(),
  }), async (a, ctx) => {
    const { inspection, sizes } = await checkUpload(ctx, a)
    return { upload: a.upload, sizes, ...inspectionView(inspection) }
  }),
}

/** projects.create's import argument. */
export const ImportArg = z.object({ upload: UploadId, overview: Overview, entry: z.enum(['fabricate', 'bringup']).default('fabricate') })
