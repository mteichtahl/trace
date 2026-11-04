/**
 * A run output's bytes for the app: from the run record's row, or, for an output kept in the bucket
 * (src/core/artifact-store.ts), from the project's `artifacts/` folder there. The API reads the bucket with its own
 * role (src/infra/api-grants.ts: read on projects/<project>/artifacts), only after the person's read access to the
 * project was checked by the action that calls this.
 */
import { getStored } from '../core/artifact-store.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { storedRef, unpackArtifact } from '../core/store.js'
import { ActionError, type Context, storeAt } from './action-kit.js'

export async function artifactBytes(ctx: Context, repo: string, row: Record<string, unknown>, name: string): Promise<{ mime: string | null; bytes: Uint8Array }> {
  const mime = row.mime === null || row.mime === undefined ? null : String(row.mime)
  const ref = storedRef(mime)
  if (!ref) return unpackArtifact(mime, row.bytes as Uint8Array)
  const bytes = await getStored(storeAt(ctx, PROJECTS_PREFIX), repo, ref.sha256)
  if (!bytes) throw new ActionError(`${name} is kept in the installation's storage, which no longer has it`)
  return { mime: ref.mime, bytes }
}

/** An artifact row's size as people know it: the stored output's, else the row's own bytes. */
export const artifactSize = (mime: unknown, length: number): number => storedRef(typeof mime === 'string' ? mime : null)?.size ?? length
