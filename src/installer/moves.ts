/**
 * Applying the moves asked for in the web app (project.move, src/api/actions-move.ts; the record:
 * src/core/forge-move-record.ts), in the installation's update (src/installer/update.ts) — the installer takes the
 * records in too, so the project's home in its saved settings follows them.
 *
 * Before the deploy, every record sets its project's forge in the settings (withForges): a move the update takes now
 * gets its new home, and so does one that is done; any other keeps the home it has (the record's `from`). The update
 * never rewrites the installer's saved settings, so the records are what keep a moved project where it is until the
 * installer runs again. Those it takes are marked moving at the deploy step. After the deploy (which gives the project
 * its roles and runner for its new home) each is moved (applyMove): the mover copies its history, open changes and
 * issues and archives the old home (src/core/forge-move.ts), then the new home is set up for trace. Each step is
 * written to the record as it starts, for the progress view. A failure is recorded with its step and leaves the old
 * home as it was (it is archived only once everything is across); the API keeps the project paused until it is tried
 * again or set aside, and resumes it once the record says moved.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { AwsCredentialIdentity } from '@smithy/types'
import { type Git, type MoveSide, moveRepository } from '../core/forge-move.js'
import { type ForgeName, type MoveRecord, MoveRecordSchema, MOVES_PREFIX, type MoveStep, forgeLabel, forgeNow, readyToMove } from '../core/forge-move-record.js'
import { projectSlug } from '../core/project.js'
import { type InfraInput, InfraPropsSchema } from '../infra/props.js'

export interface MoveEntry { key: string; record: MoveRecord }

/** The records under MOVES_PREFIX, parsed; an unreadable one is reported, not fatal. */
export function parseMoves(objects: readonly { key: string; text: string }[], log: (l: string) => void = () => undefined): MoveEntry[] {
  const out: MoveEntry[] = []
  for (const o of objects) {
    try { out.push({ key: o.key, record: MoveRecordSchema.parse(JSON.parse(o.text) as unknown) }) } catch (e) {
      log(`Skipped ${o.key}: not a move (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return out
}

const repoOf = (entry: string): string => (entry.split('@')[0] ?? '').toLowerCase()

export interface ForgesResult {
  props: InfraInput
  /** the moves this update makes */
  taken: MoveEntry[]
  /** moves ready that it cannot make, and why */
  skipped: { entry: MoveEntry; why: string }[]
}

/** The settings with each recorded project's home set (projectSettings[repo].forge), and the moves to make now. */
export function withForges(props: InfraInput, moves: readonly MoveEntry[]): ForgesResult {
  const r: ForgesResult = { props, taken: [], skipped: [] }
  const set = (p: InfraInput, repo: string, forge: ForgeName): InfraInput => {
    const settings = { ...((p.projectSettings ?? {}) as Record<string, Record<string, unknown>>) }
    const key = Object.keys(settings).find((k) => k.toLowerCase() === repo) ?? repo
    return { ...p, projectSettings: { ...settings, [key]: { ...(settings[key] ?? {}), forge } } } as InfraInput
  }
  for (const entry of moves) {
    const repo = projectSlug(entry.record.repo)
    if (!((r.props.repositories ?? []) as string[]).some((x) => repoOf(x) === repo)) {
      if (readyToMove(entry.record)) r.skipped.push({ entry, why: 'it is not one of this installation\'s projects yet (run the installer, or wait for the update that adds it)' })
      continue
    }
    const take = readyToMove(entry.record)
    const next = set(r.props, repo, forgeNow(entry.record, take))
    const ok = InfraPropsSchema.safeParse(next)
    if (!ok.success) {
      if (take) r.skipped.push({ entry, why: ok.error.issues.map((i) => i.message).join('; ') })
      continue
    }
    r.props = next
    if (take) r.taken.push(entry)
  }
  return r
}

/** The project answers' homes as the records leave them (the installer's take-in): moved projects at their new home. */
export function forgesOf(moves: readonly MoveEntry[]): Map<string, ForgeName> {
  return new Map(moves.map((m) => [projectSlug(m.record.repo), forgeNow(m.record)]))
}

export interface MoveDeps {
  /** write the record back (its progress) */
  put: (key: string, record: MoveRecord) => Promise<void>
  /** the old home and the new one */
  sides: (record: MoveRecord) => Promise<{ from: MoveSide; to: MoveSide }>
  /** set the new home up for trace: lines done, and what is left to do by hand */
  setup: (record: MoveRecord) => Promise<{ lines: string[]; todo: string[] }>
  git?: Git
  now?: () => Date
  log: (line: string) => void
}

/** What a step's line of moveRepository leads to next. */
const after = (line: string): MoveStep | null =>
  line.startsWith('copied') ? 'changes' : / open changes?$/.test(line) ? 'issues' : / open issues?$/.test(line) ? 'archive' : line.startsWith('archived') ? 'setup' : null

/** Move one project, writing each step to its record; answers the record as it ends (moved or failed). */
export async function applyMove(d: MoveDeps, entry: MoveEntry): Promise<MoveRecord> {
  const now = (): string => (d.now?.() ?? new Date()).toISOString()
  let rec: MoveRecord = { ...entry.record, status: 'moving', step: 'copy' }
  let writes = Promise.resolve()
  const save = (r: MoveRecord): Promise<void> => {
    rec = r
    writes = writes.then(() => d.put(entry.key, r)).catch((e: unknown) => d.log(`${r.repo}: its progress could not be written (${e instanceof Error ? e.message : String(e)})`))
    return writes
  }
  await save(rec)
  try {
    const { from, to } = await d.sides(rec)
    const moved = await moveRepository(from, to, {
      ...(d.git ? { git: d.git } : {}),
      report: (line) => {
        d.log(`${rec.repo}: ${line}`)
        const next = after(line)
        void save({ ...rec, lines: [...rec.lines, line], ...(next ? { step: next } : {}) })
      },
    })
    await writes
    rec = { ...rec, step: 'setup', changes: { ...moved.changes }, issues: { ...moved.issues } }
    await save(rec)
    let todo: string[] = []
    try {
      const s = await d.setup(rec)
      for (const l of s.lines) d.log(`${rec.repo}: ${l}`)
      todo = s.todo
      rec = { ...rec, lines: [...rec.lines, `set up on ${forgeLabel(rec.to)} for trace`] }
    } catch (e) {
      // everything is across and the old home archived: the move stands, and what is left is said
      todo = [`set up on ${forgeLabel(rec.to)} could not finish (${e instanceof Error ? e.message : String(e)}): run the installer again to carry on`]
    }
    const { error: _e, ...rest } = rec
    await save({ ...rest, status: 'moved', step: null, todo, finished_at: now() })
  } catch (e) {
    await writes
    await save({ ...rec, status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 500), finished_at: now() })
  }
  return rec
}

// ------------------------------------------------------------------ the records in S3

export interface MovesIo {
  list: (creds: AwsCredentialIdentity, region: string, bucket: string) => Promise<{ key: string; text: string }[]>
  put: (creds: AwsCredentialIdentity, region: string, bucket: string, key: string, text: string) => Promise<void>
}

export const s3MovesIo: MovesIo = {
  list: async (creds, region, bucket) => {
    const s3 = new S3Client({ region, credentials: creds })
    const out: { key: string; text: string }[] = []
    let token: string | undefined
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: MOVES_PREFIX, ...(token ? { ContinuationToken: token } : {}) }))
      for (const o of r.Contents ?? []) {
        if (!o.Key?.endsWith('.json')) continue
        const g = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }))
        out.push({ key: o.Key, text: (await g.Body?.transformToString('utf8')) ?? '' })
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined
    } while (token)
    return out
  },
  put: async (creds, region, bucket, key, text) => {
    await new S3Client({ region, credentials: creds }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: 'application/json' }))
  },
}
