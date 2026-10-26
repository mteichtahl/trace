/**
 * Where a session's knowledge base is, from its environment, and the AWS clients the kb tools use.
 *
 *   TRACE_KB_ID               the project's knowledge base (its worker runtime's, set by the stack; the repository
 *                             variable of the same name for GitHub Actions). Without it the kb tools are hidden.
 *   TRACE_KB_DATA_SOURCE_ID   its S3 data source: syncing and ingestion status need it
 *   TRACE_PROJECT_HOME        s3://<bucket>/projects/<slug> (the worker runtime), else TRACE_HOME s3://<bucket>/central:
 *                             the bucket the documents go to, under projects/<slug>/kb/
 *   TRACE_PROJECT, TRACE_MEMORY_REPOSITORY, GITHUB_REPOSITORY   the project (owner/repo)
 *   TRACE_PROJECT_KBS         the API's: `owner/repo=<knowledge base id> …`, space-separated, written by the stack
 *
 * The clients are the SDK's own (@aws-sdk/client-bedrock-agent-runtime for Retrieve, @aws-sdk/client-bedrock-agent
 * for the ingestion jobs, @aws-sdk/client-s3), loaded on first use, behind small interfaces a test can fake.
 */
import { z } from 'zod'
import { projectKbPrefix, projectSlug } from '../../core/project.js'

export const KbIdSchema = z.string().regex(/^[0-9a-zA-Z]{10}$/, 'a knowledge base id: 10 letters and digits')
const RepositorySchema = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)

export interface KbTarget {
  knowledgeBaseId: string
  /** its data source (null: syncing and ingestion status are unavailable here) */
  dataSourceId: string | null
  region: string | undefined
  /** the bucket its documents are in (null: no S3 here) */
  bucket: string | null
  /** owner/repo, lower case (null: unknown here) */
  repository: string | null
  /** projects/<slug>/kb (null without the repository) */
  prefix: string | null
}

const bucketOf = (url: string | undefined): string | null => {
  if (!url?.startsWith('s3://')) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** The session's knowledge base, or null when it has none (TRACE_KB_ID unset or not an id). */
export function kbFromEnv(env: Record<string, string | undefined> = process.env): KbTarget | null {
  const id = env.TRACE_KB_ID?.trim()
  if (!id || !KbIdSchema.safeParse(id).success) return null
  const ds = env.TRACE_KB_DATA_SOURCE_ID?.trim()
  const repo = [env.TRACE_PROJECT, env.TRACE_MEMORY_REPOSITORY, env.GITHUB_REPOSITORY].map((r) => r?.trim()).find((r) => r && RepositorySchema.safeParse(r).success) ?? null
  const repository = repo ? projectSlug(repo) : null
  return {
    knowledgeBaseId: id,
    dataSourceId: ds && KbIdSchema.safeParse(ds).success ? ds : null,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    bucket: bucketOf(env.TRACE_PROJECT_HOME) ?? bucketOf(env.TRACE_HOME),
    repository,
    prefix: repository ? projectKbPrefix(repository) : null,
  }
}

/** `owner/repo=<knowledge base id> …` → slug → id. Malformed entries are refused (the stack writes this). */
export function parseProjectKbs(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of (text ?? '').split(/\s+/).filter(Boolean)) {
    const at = entry.lastIndexOf('=')
    const id = entry.slice(at + 1)
    const repo = RepositorySchema.safeParse(entry.slice(0, at))
    if (at <= 0 || !repo.success || !KbIdSchema.safeParse(id).success) throw new Error(`TRACE_PROJECT_KBS: not owner/repo=<knowledge base id>: ${JSON.stringify(entry)}`)
    out.set(repo.data.toLowerCase(), id)
  }
  return out
}

// ------------------------------------------------------------------ the clients

/** The S3 calls syncing needs, on the project's kb prefix. */
export interface KbS3 {
  /** every object under the prefix: key, ETag */
  list(bucket: string, prefix: string): Promise<{ key: string; etag: string }[]>
  /** an object's ETag and the content hash trace stored with it (x-amz-meta-trace-sha256), null when absent */
  head(bucket: string, key: string): Promise<{ etag: string; sha256: string | null }>
  put(bucket: string, key: string, body: Uint8Array, contentType: string, sha256: string): Promise<{ etag: string }>
  remove(bucket: string, keys: readonly string[]): Promise<void>
}

export const SHA_META = 'trace-sha256'

export async function awsKbS3(region?: string): Promise<KbS3> {
  const s3 = await import('@aws-sdk/client-s3')
  const client = new s3.S3Client(region ? { region } : {})
  return {
    async list(bucket, prefix) {
      const out: { key: string; etag: string }[] = []
      let token: string | undefined
      for (;;) {
        const r = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }))
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, etag: o.ETag ?? '' })
        if (!r.IsTruncated || !r.NextContinuationToken) return out
        token = r.NextContinuationToken
      }
    },
    async head(bucket, key) {
      const r = await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }))
      return { etag: r.ETag ?? '', sha256: r.Metadata?.[SHA_META] ?? null }
    },
    async put(bucket, key, body, contentType, sha256) {
      const r = await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: { [SHA_META]: sha256 } }))
      return { etag: r.ETag ?? '' }
    },
    async remove(bucket, keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000)
        const r = await client.send(new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }))
        if (r.Errors?.length) throw new Error(`S3 refused to delete ${r.Errors.length} object(s): ${r.Errors[0]?.Code ?? ''} ${r.Errors[0]?.Key ?? ''}`)
      }
    },
  }
}
