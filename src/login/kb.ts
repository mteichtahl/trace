/**
 * The knowledge base commands.
 *
 *   trace kb sync [--force] [--dry-run] [--wait MINUTES] [--allow-branch]   this clone's default branch into its
 *   trace kb search "query" [--top N] [--source S] [--kind K] [--path P]    knowledge base, with your own (or the
 *   trace kb status                                                         workflow's OIDC role's) AWS credentials:
 *                                                                           TRACE_KB_ID, TRACE_KB_DATA_SOURCE_ID,
 *                                                                           TRACE_HOME and the project (--repo, else
 *                                                                           TRACE_PROJECT, GITHUB_REPOSITORY or origin)
 *
 *   `trace kb sync` waits for the ingestion job on a timer (Bedrock sends no event when one finishes) and says so on
 *   stderr each time its state changes: what it is waiting for, when it last checked and when it checks next.
 *
 *   trace remote kb search OWNER/REPO "query" [--top N] [--source S] [--kind K] [--path P]   through the API
 *   trace remote kb sync OWNER/REPO [--force] [--wait MINUTES]                                 (signed in)
 *
 *   `trace remote kb sync` prints the same lines on stderr while the worker waits: it follows the API's tools.waits,
 *   a held call that answers the moment the wait is checked or changes (no asking on a timer), and stops when the
 *   sync answers. Lines it could not follow live come from the answer's `progress` instead.
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import { kbFromEnv } from '../tools/kb/env.js'
import { FilterSchema, type Hit, awsRetrieve, searchKb } from '../tools/kb/search.js'
import { kbStatus, syncHere } from '../tools/kb/tools.js'
import { invokeApi } from './invoke.js'
import { originRepository } from './memory.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')

export const KB_USAGE = 'usage: trace kb sync [--force] [--dry-run] [--wait MINUTES] [--allow-branch] [--repo OWNER/REPO] | search "query" [--top N] [--source repo|summary|datasheet] [--kind K] [--path FOLDER] | status'
export const REMOTE_KB_USAGE = 'usage: trace remote kb search OWNER/REPO "query" [--top N] [--source S] [--kind K] [--path FOLDER] | sync OWNER/REPO [--force] [--wait MINUTES]'

const OPTIONS = {
  force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'allow-branch': { type: 'boolean' }, wait: { type: 'string' }, repo: { type: 'string' },
  top: { type: 'string' }, source: { type: 'string' }, kind: { type: 'string' }, path: { type: 'string' }, json: { type: 'boolean' },
} as const

const filterOf = (v: { source?: string | undefined; kind?: string | undefined; path?: string | undefined }) => {
  const f = FilterSchema.parse({ ...(v.source ? { source: v.source } : {}), ...(v.kind ? { kind: v.kind } : {}), ...(v.path ? { path_prefix: v.path } : {}) })
  return Object.keys(f).length ? f : undefined
}

function printHits(hits: readonly Hit[]): void {
  if (!hits.length) { out('(nothing found)'); return }
  for (const h of hits) {
    out(`${h.score === null ? '    ' : h.score.toFixed(2)}  ${h.citation}`)
    out(`      ${h.text.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
}

function printSync(r: Awaited<ReturnType<typeof syncHere>>): void {
  out(`${r.repository} at ${r.commit.slice(0, 12)}: ${r.documents} documents (${r.objects} objects with their metadata): ${r.uploaded} uploaded, ${r.unchanged} unchanged, ${r.deleted} deleted.`)
  if (r.kicad.length) out(`KiCad summaries: ${r.kicad.join(', ')}`)
  const ds = r.datasheets.filter((d) => d.datasheet)
  if (r.datasheets.length) out(`Datasheets: ${ds.length} of ${r.datasheets.length} BOM part numbers (${ds.reduce((n, d) => n + d.pages, 0)} pages)${r.datasheets.length > ds.length ? `; none for ${r.datasheets.filter((d) => !d.datasheet).map((d) => d.mpn).slice(0, 20).join(', ')}` : ''}`)
  if (r.skipped.length) out(`Skipped ${r.skipped.length} matching file(s): ${r.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join('; ')}${r.skipped.length > 5 ? '; …' : ''}`)
  const j = r.ingestion
  if (r.ingest === 'dry run') out('Dry run: nothing changed.')
  else if (r.ingest === 'nothing changed') out(`Nothing changed; no ingestion job started.${j ? ` The last one (${j.job_id}) is ${j.status}.` : ''}`)
  else if (!j) out('No ingestion job.')
  else {
    const st = j.statistics
    out(`Ingestion job ${j.job_id} (${r.ingest}): ${j.status}${r.waiting ? ' (still running; see `trace kb status`)' : ''}`
      + `${Object.keys(st).length ? `: ${st.numberOfDocumentsScanned ?? 0} scanned, ${(st.numberOfNewDocumentsIndexed ?? 0) + (st.numberOfModifiedDocumentsIndexed ?? 0)} indexed, ${st.numberOfDocumentsDeleted ?? 0} deleted, ${st.numberOfDocumentsFailed ?? 0} failed` : ''}`)
    for (const f of j.failure_reasons) err(`  ${f}`)
  }
}

/** `trace kb …` on this clone, with the credentials of the environment (yours, or the workflow's OIDC role). */
export async function cmdKb(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [sub, ...rest] = argv
  let parsed
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS })
  } catch (e) {
    err(`trace kb: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  const { values, positionals } = parsed
  if (sub !== 'sync' && sub !== 'search' && sub !== 'status') { err(KB_USAGE); return 2 }
  if (values.repo && env.TRACE_PROJECT && values.repo.toLowerCase() !== env.TRACE_PROJECT.trim().toLowerCase()) {
    err(`trace kb: this runtime serves ${env.TRACE_PROJECT.trim().toLowerCase()} only, not ${values.repo.toLowerCase()}`)
    return 2
  }
  const repo = values.repo ?? env.TRACE_PROJECT ?? env.GITHUB_REPOSITORY ?? originRepository()
  const e = { ...env, ...(repo && Repo.safeParse(repo).success ? { TRACE_PROJECT: repo } : {}) }
  const t = kbFromEnv(e)
  if (!t) { err('trace kb: no knowledge base here (TRACE_KB_ID is not set); through the API use `trace remote kb`'); return 1 }
  try {
    if (sub === 'sync') {
      const wait = values.wait === undefined ? 15 : Number(values.wait)
      if (!Number.isFinite(wait) || wait < 0) { err('trace kb sync: --wait takes minutes'); return 2 }
      const r = await syncHere({ env: e, force: values.force === true, dryRun: values['dry-run'] === true, allowBranch: values['allow-branch'] === true, waitMinutes: wait, progress: err })
      if (values.json) out(JSON.stringify(r, null, 2))
      else printSync(r)
      return r.ingestion && ['FAILED', 'STOPPED'].includes(r.ingestion.status) ? 1 : 0
    }
    if (sub === 'search') {
      const query = positionals.join(' ').trim()
      if (!query) { err(KB_USAGE); return 2 }
      const filter = filterOf(values)
      const r = await searchKb(await awsRetrieve(t.region), t.knowledgeBaseId, { query, ...(values.top ? { top_k: Number(values.top) } : {}), ...(filter ? { filter } : {}) })
      if (values.json) out(JSON.stringify(r, null, 2))
      else printHits(r.results)
      return 0
    }
    out(JSON.stringify(await kbStatus({ env: e }), null, 2))
    return 0
  } catch (x) {
    if (x instanceof z.ZodError) { err(`trace kb: ${x.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`); return 2 }
    err(`trace kb: ${x instanceof ToolError || x instanceof Error ? x.message : String(x)}`)
    return 1
  }
}

const RemoteHit = z.object({ text: z.string(), score: z.number().nullable(), citation: z.string() }).loose()

const SyncProgress = z.object({ progress: z.array(z.object({ line: z.string() }).loose()).default([]) }).loose()
const ToolWaits = z.object({
  version: z.number().nullable(),
  waits: z.array(z.object({ id: z.string(), what: z.string(), text: z.string() }).loose()),
}).loose()

/**
 * Print each wait line of the project's tool calls as it happens, until `signal`: tools.waits, held on the worker
 * until a wait opens, is checked, changes or ends. A failed call ends the following quietly (the sync's own answer
 * still carries its lines).
 */
export async function followToolWaits(repo: string, say: (line: string) => void, signal: AbortSignal, invoke: typeof invokeApi = invokeApi): Promise<void> {
  let after: number | null = null
  while (!signal.aborted) {
    let r: z.infer<typeof ToolWaits>
    try {
      r = ToolWaits.parse(await invoke('tools.waits', { repo, ...(after !== null ? { afterVersion: after, waitS: 60 } : {}) }, { signal }))
    } catch {
      return
    }
    for (const w of r.waits) if (/knowledge base/i.test(w.what)) say(w.text)
    // a worker without change counters cannot hold the answer: stop rather than ask again and again
    if (r.version === null) return
    after = r.version
  }
}

/** `trace remote kb …` (the caller handles errors and prints usage on 2). */
export async function remoteKb(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS })
  const [repo, ...words] = positionals
  switch (sub) {
    case 'search': {
      const query = words.join(' ').trim()
      if (!repo || !query) break
      const filter = filterOf(values)
      const r = z.object({ enabled: z.boolean(), results: z.array(RemoteHit) }).loose().parse(await invokeApi('kb.search', {
        repo: Repo.parse(repo), query, ...(values.top ? { top_k: Number(values.top) } : {}), ...(filter ? { filter } : {}),
      }))
      if (!r.enabled) { out('This installation has no knowledge bases.'); return 0 }
      if (values.json) out(JSON.stringify(r, null, 2))
      else printHits(r.results.map((h) => ({ ...h, source: null, kind: null, path: null, commit: null })))
      return 0
    }
    case 'sync': {
      if (!repo) break
      const slug = Repo.parse(repo)
      const seen = new Set<string>()
      const say = (line: string): void => { if (!seen.has(line)) { seen.add(line); err(line) } }
      const stop = new AbortController()
      const following = followToolWaits(slug, say, stop.signal)
      let r: unknown
      try {
        r = await invokeApi('kb.sync', { repo: slug, ...(values.force ? { force: true } : {}), ...(values.wait !== undefined ? { wait_minutes: Number(values.wait) } : {}) })
      } finally {
        stop.abort()
        await following
      }
      // what the live lines missed (an older worker, or a wait that began and ended between two answers)
      for (const p of SyncProgress.safeParse(r).data?.progress ?? []) say(p.line)
      out(JSON.stringify(r, null, 2))
      return 0
    }
  }
  err(REMOTE_KB_USAGE)
  return 2
}
