/**
 * Projects created from the web app (projects.create, src/api/actions-projects.ts) that wait for their own cloud
 * resources: a worker runtime, roles, token secret, memory, knowledge base and build runner, which only a deploy of the
 * stack adds. The API records each request at installation/pending-projects/<owner>/<repo>.json in the central bucket;
 * two things pick them up:
 *
 *   the update   `tracectl update-installation` (src/installer/update.ts, the self-update job): adds the records to
 *                the saved settings' repositories (addPending: the `added` ones of earlier updates, then the pending
 *                ones), deploys, and marks each pending record `added`, or counts a failed attempt (after MAX_ATTEMPTS
 *                it is `failed` and left for the installer). It never rewrites installation/props.json (its role may
 *                not): the `added` records are what keep those projects in later updates
 *   the installer  (src/installer/bootstrap.ts): takes every record, pending or added, into its answers as an existing,
 *                already onboarded repository (absorb), so its deploy keeps the project and its saved answers list it
 *                from then on; the records are deleted once the run is done
 *
 * What is checked before a project is added: it is not one already (then it is simply marked added), not a build-only
 * repository, the installation is in the nested layout (a flat stack has room for about 20 projects, and an update
 * cannot move it), and the settings with it still validate (at most 60 projects, no short-hash clash). A project's own
 * settings (projectSettings: memory expiry, generation) already in the saved settings are kept.
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { AwsCredentialIdentity } from '@smithy/types'
import { z } from 'zod'
import { type InfraInput, InfraPropsSchema } from '../infra/props.js'
import { projectSlug } from '../core/project.js'
import type { Answers } from './answers.js'

type ProjectAnswer = Answers['projects'][number]

/** Under the central bucket (the API's PENDING_PREFIX + pendingKey). */
export const PENDING_PROJECTS_PREFIX = 'installation/pending-projects/'

/** Failed deploys a pending project takes part in before the update stops adding it (the installer still does). */
export const MAX_ATTEMPTS = 2

export const PendingRecordSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  name: z.string().optional(),
  template: z.string().optional(),
  requested_by: z.string().optional(),
  requested_at: z.string().optional(),
  /** absent: pending (as the API writes it) */
  status: z.enum(['pending', 'added', 'failed']).default('pending'),
  attempts: z.number().int().min(0).default(0),
  last_error: z.string().optional(),
  added_at: z.string().optional(),
  /** the default branch the update gave it */
  branch: z.string().optional(),
}).loose()
export type PendingRecord = z.output<typeof PendingRecordSchema>

export interface PendingEntry { key: string; record: PendingRecord }

/** The records under PENDING_PROJECTS_PREFIX, parsed; an unreadable one is reported, not fatal. */
export function parsePending(objects: readonly { key: string; text: string }[], log: (l: string) => void = () => undefined): PendingEntry[] {
  const out: PendingEntry[] = []
  for (const o of objects) {
    try {
      out.push({ key: o.key, record: PendingRecordSchema.parse(JSON.parse(o.text) as unknown) })
    } catch (e) {
      log(`Skipped ${o.key}: not a pending project (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return out
}

const repoOf = (entry: string): string => (entry.split('@')[0] ?? '').toLowerCase()

export interface AddResult {
  props: InfraInput
  /** added to the repositories now (lower-case OWNER/REPO), with their branch */
  added: { key: string; repo: string; branch: string }[]
  /** already projects: marked added without changing anything */
  already: { key: string; repo: string }[]
  skipped: { key: string; repo: string; why: string }[]
}

/**
 * The saved settings with the pending projects added to `repositories`, one at a time, each kept only when the
 * settings still validate. `branchOf` gives a repository's default branch (main when unknown).
 */
export function addPending(props: InfraInput, pending: readonly PendingEntry[], branchOf: (repo: string) => string = () => 'main'): AddResult {
  const r: AddResult = { props, added: [], already: [], skipped: [] }
  const layout = InfraPropsSchema.parse(props).layout
  for (const { key, record } of pending) {
    if (record.status !== 'pending') continue
    const repo = record.repo.toLowerCase()
    const repos = (r.props.repositories ?? []) as string[]
    if (repos.some((x) => repoOf(x) === repo)) { r.already.push({ key, repo }); continue }
    if ((r.props.ciRepositories ?? []).some((x) => x.toLowerCase() === repo)) { r.skipped.push({ key, repo, why: 'it is built here as a build-only repository; run the installer to make it a project' }); continue }
    if (layout !== 'nested') { r.skipped.push({ key, repo, why: 'this installation keeps every project in one stack (the flat layout), which an update does not grow; run the installer' }); continue }
    if (record.attempts >= MAX_ATTEMPTS) { r.skipped.push({ key, repo, why: `${record.attempts} updates with it failed${record.last_error ? ` (last: ${record.last_error})` : ''}; run the installer` }); continue }
    const branch = branchOf(repo) || 'main'
    const next: InfraInput = { ...r.props, repositories: [...repos, `${repo}@${branch}`] }
    const ok = InfraPropsSchema.safeParse(next)
    if (!ok.success) { r.skipped.push({ key, repo, why: ok.error.issues.map((i) => i.message).join('; ') }); continue }
    r.props = next
    r.added.push({ key, repo, branch })
  }
  return r
}

/** A record after an update: added, or one more failed attempt (failed once there have been MAX_ATTEMPTS). */
export function markAdded(rec: PendingRecord, o: { branch: string; now?: Date }): PendingRecord {
  const { last_error: _e, ...rest } = rec
  return { ...rest, status: 'added', branch: o.branch, added_at: (o.now ?? new Date()).toISOString() }
}
export function markAttempt(rec: PendingRecord, error: string): PendingRecord {
  const attempts = rec.attempts + 1
  return { ...rec, attempts, last_error: error.slice(0, 300), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending' }
}

/**
 * The installer's answers with every recorded project (pending, added or failed) as an existing repository, already
 * onboarded by the API: no onboarding pull request and no settings applied again. Returns the repositories taken in.
 */
export function absorb<P extends Pick<ProjectAnswer, 'repo'>>(projects: readonly P[], pending: readonly PendingEntry[], make: (repo: string, branch: string) => P): { projects: P[]; absorbed: string[] } {
  const out = [...projects]
  const absorbed: string[] = []
  for (const { record } of pending) {
    const repo = projectSlug(record.repo)
    if (out.some((p) => p.repo.toLowerCase() === repo)) continue
    out.push(make(repo, record.branch || 'main'))
    absorbed.push(repo)
  }
  return { projects: out, absorbed }
}

// ------------------------------------------------------------------ the records in S3

/** What reads and writes the records (S3 by default; tests replace it). */
export interface PendingIo {
  list: (creds: AwsCredentialIdentity, region: string, bucket: string) => Promise<{ key: string; text: string }[]>
  put: (creds: AwsCredentialIdentity, region: string, bucket: string, key: string, text: string) => Promise<void>
  remove: (creds: AwsCredentialIdentity, region: string, bucket: string, key: string) => Promise<void>
}

export const s3PendingIo: PendingIo = {
  list: async (creds, region, bucket) => {
    const s3 = new S3Client({ region, credentials: creds })
    const out: { key: string; text: string }[] = []
    let token: string | undefined
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PENDING_PROJECTS_PREFIX, ...(token ? { ContinuationToken: token } : {}) }))
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
  remove: async (creds, region, bucket, key) => {
    await new S3Client({ region, credentials: creds }).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  },
}
