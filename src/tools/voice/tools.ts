/**
 * The dictation vocabulary tool (MCP: voice_vocabulary): the project's own words as an Amazon Transcribe custom
 * vocabulary, so dictation in the web app writes "U4" and "VCC_3V3" rather than "you for" and "VCC three V three".
 *
 *   voice.vocabulary   write   read the checked-out default branch (its KiCad schematics: reference designators, part
 *                              numbers, net labels and power nets; its .trace/project.db: requirement ids), make the
 *                              table (vocabulary.ts), and for each language in `voice.languages`:
 *                                1. put it at projects/<slug>/voice/<language>.txt when its sha256 changed (S3's
 *                                   x-amz-meta-trace-sha256, the knowledge base's way)
 *                                2. CreateVocabulary (tagged trace:project=<slug>) when there is none, UpdateVocabulary
 *                                   when the table changed or the last one FAILED; nothing when it is unchanged
 *                                3. with wait_minutes, wait until it is READY (or FAILED)
 *
 * Where it runs: the project's worker runtime (the API's `voice.vocabulary.sync` and `tool`), and the repository's
 * kb-sync job on every push to the default branch (templates/workflows/trace-worker.yml), with the project's own role
 * either way. Those roles may Create only vocabularies tagged with their project, Update and Get only
 * `<prefix>-<project hash>-*`, and Transcribe reads the table with their S3 access to projects/<slug>/
 * (src/infra/voice.ts).
 *
 * The wait is a timer, declared: Transcribe sends its "Vocabulary State Change" event to EventBridge only when a
 * vocabulary is first made (CreateVocabulary), never for an update, which is nearly every change here, and the
 * dictation screen does not need it (it asks for the state when the microphone opens, src/web/voice.ts). Each check
 * is one GetVocabulary, every 10 seconds growing to 60, and each says when the next one is.
 *
 * The vocabulary's name is `<prefix>-<project hash>-<language>`: TRACE_VOCABULARY_BASE (`<prefix>-<project hash>`, set
 * on the worker runtime), else read from TRACE_AGENT_RUNTIME_ARN's runtime name (`<prefix with _>_w_<hash>`, the
 * repository variable the workflows have; a prefix has no underscores, so the reading is exact).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { projectsFromEnv } from '../../core/agent-facts.js'
import { load, VOICE_LANGUAGES } from '../../core/config.js'
import { PROJECT_TAG, projectDataPrefix, projectHash, projectSlug } from '../../core/project.js'
import { ToolError, defineTool } from '../../core/registry.js'
import { open, projectPath } from '../../core/store.js'
import { describeWait, waitWithTimer } from '../../core/wait.js'
import { candidates, fromPath } from '../kicad/project.js'
import { mpnOf, parts, powerNets, readSchematic } from '../kicad/schematic.js'
import { type DesignTerms, type Table, vocabularyName, vocabularyTable } from './vocabulary.js'

export const VOICE_FOLDER = 'voice'
export const tableKey = (repository: string, language: string): string => `${projectDataPrefix(repository)}/${VOICE_FOLDER}/${language}.txt`
export const SHA_META = 'trace-sha256'

/** How the wait checks: GetVocabulary every 10 s, growing to 60 s. */
export const VOCABULARY_CHECK = { intervalMs: 10_000, factor: 1.5, maxIntervalMs: 60_000 }
export const WHY_TIMER = 'Transcribe sends its "Vocabulary State Change" event only when a vocabulary is first made, not when it is updated, so each check is one GetVocabulary'

export type VocabularyState = 'READY' | 'PENDING' | 'FAILED'

/** The Transcribe and S3 calls the tool makes (the SDK's in production, fakes in tests). */
export interface VoiceClients {
  get(name: string): Promise<{ state: VocabularyState; failure?: string | undefined } | null>
  create(i: { name: string; language: string; uri: string; tags: Record<string, string> }): Promise<void>
  update(i: { name: string; language: string; uri: string }): Promise<void>
  /** the stored table's sha256 (S3 metadata), null when there is none */
  storedSha(bucket: string, key: string): Promise<string | null>
  put(bucket: string, key: string, text: string, sha256: string): Promise<void>
}

/** `<prefix>-<project hash>`: TRACE_VOCABULARY_BASE, else from the runtime ARN's name; null when neither says. */
export function vocabularyBase(env: Record<string, string | undefined>, repository: string): string | null {
  const hash = projectHash(repository)
  const given = env.TRACE_VOCABULARY_BASE?.trim()
  if (given) return given.endsWith(`-${hash}`) ? given : null
  const m = /:runtime\/([a-z][a-z0-9_]{1,20})_w_([0-9a-f]{8})-[A-Za-z0-9]+$/.exec(env.TRACE_AGENT_RUNTIME_ARN?.trim() ?? '')
  if (!m?.[1] || m[2] !== hash) return null
  return `${m[1].replace(/_/g, '-')}-${hash}`
}

/** The bucket the project's data is in (TRACE_PROJECT_HOME, else TRACE_HOME's), and the project. */
function where(env: Record<string, string | undefined>): { bucket: string; repository: string } | null {
  const p = projectsFromEnv(env)
  const bucket = p ? /^s3:\/\/([^/]+)/.exec(p.projects)?.[1] : undefined
  return p && bucket ? { bucket, repository: projectSlug(p.repository) } : null
}

const configured = (): boolean => {
  const w = where(process.env)
  return Boolean(w && vocabularyBase(process.env, w.repository))
}

/** The requirement ids still in play (not rejected or obsolete), from a project database; none without the table. */
export function requirementIds(db: DatabaseSync): string[] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requirements'").get()
  if (!has) return []
  return db.prepare("SELECT id FROM requirements WHERE status NOT IN ('rejected', 'obsolete') ORDER BY id").all().map((r) => String(r.id))
}

/** The words of the design around `root`: every KiCad project's schematic, and the requirement ids. */
export async function designTerms(root: string): Promise<DesignTerms & { problems: string[] }> {
  const refs: string[] = []
  const mpns: string[] = []
  const nets: string[] = []
  const problems: string[] = []
  const cwd = process.cwd()
  let files: string[] = []
  try {
    process.chdir(root)
    files = (await candidates()).files
  } finally {
    process.chdir(cwd)
  }
  for (const f of files) {
    try {
      const p = fromPath(f)
      if (!p.sch) continue
      const sch = readSchematic(p.sch, p.name)
      for (const s of parts(sch)) {
        refs.push(s.ref)
        const mpn = mpnOf(s)
        if (mpn) mpns.push(mpn)
      }
      nets.push(...powerNets(sch), ...sch.labels.map((l) => l.text))
    } catch (e) {
      problems.push(`${f}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
    }
  }
  let requirements: string[] = []
  const dbPath = projectPath(root)
  if (existsSync(dbPath)) {
    const db = open(dbPath, { readonly: true })
    try { requirements = requirementIds(db) } finally { db.close() }
  }
  const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
  return { refs: uniq(refs), parts: uniq(mpns), nets: uniq(nets), requirements: uniq(requirements), problems }
}

export interface LanguageOutcome {
  language: string
  name: string
  action: 'created' | 'updated' | 'unchanged' | 'skipped'
  state: VocabularyState | 'NONE'
  failure?: string
  why?: string
  /** when no wait was asked for, or it ran out: what happens next */
  next?: string
}

export interface SyncOptions {
  root: string
  repository: string
  bucket: string
  base: string
  languages: readonly string[]
  clients: VoiceClients
  waitMs?: number
  log?: (line: string) => void
  now?: () => number
  sleep?: (ms: number, early: AbortSignal) => Promise<void>
}

/** Make or update the project's vocabularies from its design (see the file's comment). */
export async function syncVocabulary(o: SyncOptions): Promise<{ terms: number; rows: number; omitted: number; problems: string[]; languages: LanguageOutcome[] }> {
  const design = await designTerms(o.root)
  const table: Table = vocabularyTable(design)
  const out: LanguageOutcome[] = []
  for (const language of o.languages) {
    const name = vocabularyName(o.base, language)
    if (!table.rows) {
      out.push({ language, name, action: 'skipped', state: (await o.clients.get(name))?.state ?? 'NONE', why: 'the design has no reference designators, part numbers, net names or requirement ids yet' })
      continue
    }
    const key = tableKey(o.repository, language)
    const uri = `s3://${o.bucket}/${key}`
    const changed = (await o.clients.storedSha(o.bucket, key)) !== table.sha256
    if (changed) await o.clients.put(o.bucket, key, table.text, table.sha256)
    let now = await o.clients.get(name)
    let action: LanguageOutcome['action'] = 'unchanged'
    if (!now) {
      await o.clients.create({ name, language, uri, tags: { [PROJECT_TAG]: o.repository } })
      action = 'created'
    } else if (changed || now.state === 'FAILED') {
      // an update while one is still being processed is refused: wait for it first (on the same timer)
      if (now.state === 'PENDING') now = await waitReady(o, name, o.waitMs ?? 0) ?? now
      if (now.state === 'PENDING') {
        out.push({ language, name, action: 'skipped', state: 'PENDING', why: 'an earlier update is still being processed', next: 'The next push to the default branch, or running this again, updates it.' })
        continue
      }
      await o.clients.update({ name, language, uri })
      action = 'updated'
    }
    if (action === 'unchanged' && now) { out.push({ language, name, action, state: now.state, ...(now.failure ? { failure: now.failure } : {}) }); continue }
    const done = o.waitMs ? await waitReady(o, name, o.waitMs) : null
    const state = done?.state ?? 'PENDING'
    out.push({
      language, name, action, state, ...(done?.failure ? { failure: done.failure } : {}),
      ...(state === 'PENDING' ? { next: 'Transcribe is preparing it (usually a few minutes); dictation uses it from the first time the microphone opens after it is ready.' } : {}),
    })
  }
  return { terms: table.terms, rows: table.rows, omitted: table.omitted, problems: design.problems.slice(0, 20), languages: out }
}

/** Wait on the declared timer until the vocabulary is no longer PENDING, or `ms` passes. */
async function waitReady(o: SyncOptions, name: string, ms: number): Promise<{ state: VocabularyState; failure?: string | undefined } | null> {
  if (!(ms > 0)) return null
  const now = o.now ?? Date.now
  type Seen = { state: VocabularyState; failure?: string | undefined }
  let last: Seen | null = null
  const r = await waitWithTimer<Seen | null>({
    what: `the dictation vocabulary ${name} to be ready`,
    why: WHY_TIMER,
    intervalMs: VOCABULARY_CHECK.intervalMs, factor: VOCABULARY_CHECK.factor, maxIntervalMs: VOCABULARY_CHECK.maxIntervalMs,
    deadlineAt: now() + ms,
    ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}),
    report: (n) => { if (n.nextCheckAt) o.log?.(describeWait(n, now())) },
    check: async () => {
      last = await o.clients.get(name)
      const state = last?.state ?? 'PENDING'
      return state === 'PENDING' ? { done: false, state } : { done: true, value: last, state }
    },
  })
  return r.done ? r.value : last
}

// ------------------------------------------------------------------ the AWS clients

/**
 * Whether Transcribe's GetVocabulary said there is no such vocabulary (a project's first sync). It answers that as a
 * BadRequestException, worded "The requested vocabulary couldn't be found. …", not a NotFoundException.
 */
export function vocabularyMissing(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.name === 'NotFoundException' || (e.name === 'BadRequestException' && /not found|couldn'?t be found|couldn'?t find|doesn'?t exist|does not exist/i.test(e.message))
}

export async function awsVoiceClients(region?: string): Promise<VoiceClients> {
  const [t, s3] = await Promise.all([import('@aws-sdk/client-transcribe'), import('@aws-sdk/client-s3')])
  const transcribe = new t.TranscribeClient(region ? { region } : {})
  const storage = new s3.S3Client(region ? { region } : {})
  return {
    async get(name) {
      try {
        const r = await transcribe.send(new t.GetVocabularyCommand({ VocabularyName: name }))
        const state = r.VocabularyState === 'READY' || r.VocabularyState === 'FAILED' ? r.VocabularyState : 'PENDING'
        return { state, ...(r.FailureReason ? { failure: r.FailureReason } : {}) }
      } catch (e) {
        if (vocabularyMissing(e)) return null
        throw e
      }
    },
    async create(i) {
      await transcribe.send(new t.CreateVocabularyCommand({
        VocabularyName: i.name, LanguageCode: i.language as never, VocabularyFileUri: i.uri, Tags: Object.entries(i.tags).map(([Key, Value]) => ({ Key, Value })),
      }))
    },
    async update(i) {
      await transcribe.send(new t.UpdateVocabularyCommand({ VocabularyName: i.name, LanguageCode: i.language as never, VocabularyFileUri: i.uri }))
    },
    async storedSha(bucket, key) {
      try {
        return (await storage.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }))).Metadata?.[SHA_META] ?? null
      } catch (e) {
        if (e instanceof Error && (e.name === 'NotFound' || e.name === 'NoSuchKey')) return null
        throw e
      }
    },
    async put(bucket, key, text, sha256) {
      await storage.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: 'text/plain; charset=utf-8', Metadata: { [SHA_META]: sha256 } }))
    },
  }
}

export const vocabulary = defineTool({
  name: 'voice.vocabulary',
  description: 'Make or update this project\'s dictation vocabulary (Amazon Transcribe) from its design: reference designators, part numbers, net names and requirement ids, so dictation in the web app writes them as the design spells them. Runs by itself on every push to the default branch; run it after a change that has not been pushed yet. Changes only this project\'s vocabularies.',
  input: z.object({
    wait_minutes: z.number().min(0).max(15).default(3).describe('how long to wait for Transcribe to have it ready (it carries on afterwards)'),
  }),
  available: configured,
  run: async (a) => {
    const env = process.env
    const w = where(env)
    if (!w) throw new ToolError('voice.vocabulary: no project or bucket here (TRACE_PROJECT_HOME or TRACE_HOME s3://…, and TRACE_PROJECT or GITHUB_REPOSITORY)')
    const base = vocabularyBase(env, w.repository)
    if (!base) throw new ToolError('voice.vocabulary: the vocabulary\'s name is unknown here (TRACE_VOCABULARY_BASE, or TRACE_AGENT_RUNTIME_ARN of this project)')
    const cfg = load(undefined, { strict: false })
    const root = cfg.root ?? process.cwd()
    if (!cfg.voice.vocabulary) return { repository: w.repository, skipped: 'voice.vocabulary is off in this project\'s settings' }
    const languages = cfg.voice.languages.filter((l) => (VOICE_LANGUAGES as readonly string[]).includes(l))
    const lines: string[] = []
    const r = await syncVocabulary({
      root, repository: w.repository, bucket: w.bucket, base, languages, clients: await awsVoiceClients(env.AWS_REGION),
      waitMs: Math.round(a.wait_minutes * 60_000), log: (l) => { lines.push(l); process.stderr.write(`voice.vocabulary: ${l}\n`) },
    })
    return { repository: w.repository, ...r, progress: lines.slice(-20), table: join(projectDataPrefix(w.repository), VOICE_FOLDER) }
  },
})

export const tools = [vocabulary]
