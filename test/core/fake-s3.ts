import type { S3Api } from '../../src/core/central.js'

/** An in-memory S3 with real ETag semantics; `raceOnce` makes the next conditional put lose to another writer. */
export class FakeS3 implements S3Api {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>()
  puts = 0
  conflicts = 0
  private n = 0
  /** Called before a conditional put is judged: lets a test write "from another process" in between. */
  interleave: (() => Promise<unknown>) | null = null

  private miss(): Error {
    return Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
  }

  async getObject(i: { Bucket: string; Key: string }) {
    const o = this.objects.get(`${i.Bucket}/${i.Key}`)
    if (!o) throw this.miss()
    return { Body: new Uint8Array(o.body), ETag: o.etag }
  }

  async headObject(i: { Bucket: string; Key: string }) {
    const o = this.objects.get(`${i.Bucket}/${i.Key}`)
    if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
    return { ETag: o.etag }
  }

  async putObject(i: { Bucket: string; Key: string; Body: Uint8Array; IfMatch?: string; IfNoneMatch?: string }) {
    this.puts++
    const k = `${i.Bucket}/${i.Key}`
    if (this.interleave) {
      const f = this.interleave
      this.interleave = null
      await f()
    }
    const cur = this.objects.get(k)
    if ((i.IfMatch !== undefined && cur?.etag !== i.IfMatch) || (i.IfNoneMatch === '*' && cur)) {
      this.conflicts++
      throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
    }
    const etag = `"e${++this.n}"`
    this.objects.set(k, { body: new Uint8Array(i.Body), etag })
    return { ETag: etag }
  }

  async listObjectsV2(i: { Bucket: string; Prefix: string }) {
    return { Contents: [...this.objects.keys()].filter((k) => k.startsWith(`${i.Bucket}/${i.Prefix}`)).map((k) => ({ Key: k.slice(i.Bucket.length + 1) })), IsTruncated: false }
  }
}

