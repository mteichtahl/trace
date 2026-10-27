// Resolves one of trace's published images to its digest, before an installation copies it (src/infra/images.ts):
//
//   node scripts/resolve-image.mjs public.ecr.aws/<alias>/trace-agent:<tag>
//     prints  public.ecr.aws/<alias>/trace-agent@sha256:<digest>   and exits 0
//     exits   3 when the tag is not published (an unreleased commit, a fork) or the registry can't be reached: the
//             caller then builds the image instead
//
// It asks ECR Public's registry API anonymously (a pull token from public.ecr.aws/token, then the tag's manifest),
// and accepts the digest only when the manifest it fetched hashes to the digest the registry states for the tag, so
// the copy is pinned to exactly what was published under that tag at this moment. No dependencies: it runs on the
// CodeBuild image before anything is installed (Node is on every CodeBuild standard image).
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** The manifest kinds a published image may be: a multi-platform index or a single manifest, OCI or Docker. */
export const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** `host/path:tag` → its parts; null when it is not such a reference (a digest reference is already pinned). */
export function parseRef(ref) {
  const m = /^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9._/-]+):([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/.exec(ref)
  return m ? { host: m[1], repository: m[2], tag: m[3] } : null
}

/**
 * The tag's digest, checked against the manifest's own bytes: `{ digest, pinned }`, or `{ missing: reason }` when it
 * is not published or can't be read. `fetchImpl`: the global fetch (tests give a fake).
 */
export async function resolveImage(ref, fetchImpl = fetch) {
  const r = parseRef(ref)
  if (!r) return { missing: `${ref} is not a registry/repository:tag reference` }
  let token = ''
  try {
    const t = await fetchImpl(`https://${r.host}/token/?scope=repository:${r.repository}:pull`)
    if (t.ok) token = String((await t.json()).token ?? '')
  } catch (e) {
    return { missing: `the registry ${r.host} can't be reached (${e instanceof Error ? e.message : String(e)})` }
  }
  let res
  try {
    res = await fetchImpl(`https://${r.host}/v2/${r.repository}/manifests/${r.tag}`, {
      headers: { Accept: ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
  } catch (e) {
    return { missing: `the registry ${r.host} can't be reached (${e instanceof Error ? e.message : String(e)})` }
  }
  if (res.status === 404) return { missing: `${ref} is not published` }
  if (!res.ok) return { missing: `${ref}: the registry answered ${res.status}` }
  const body = Buffer.from(await res.arrayBuffer())
  const actual = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const stated = res.headers.get('docker-content-digest') ?? ''
  if (stated && stated !== actual) return { missing: `${ref}: the registry states ${stated} but its manifest hashes to ${actual}` }
  return { digest: actual, pinned: `${r.host}/${r.repository}@${actual}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.argv[2] ?? ''
  const r = await resolveImage(ref)
  if (r.pinned) process.stdout.write(`${r.pinned}\n`)
  else {
    process.stderr.write(`trace: ${r.missing}\n`)
    process.exitCode = 3
  }
}
