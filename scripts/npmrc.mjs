// What of an .npmrc goes into the images (agent/npmrc, read by agent/Dockerfile* and the Lambda bundling): its settings
// (legacy-peer-deps, registry, …), never a credential. A clone's .npmrc may carry a person's token
// (`//registry.npmjs.org/:_authToken=…`, `_auth`, `_password`): copied into the image it would sit in the build's
// layers and its source asset, and once it expires every `npm ci` there fails with E401, public packages included.

/** Lines of `text` that set a credential: any `//host/:key=` line (per-registry settings carry the auth), and the
 * global auth keys. */
const CREDENTIAL = /^\s*(\/\/|(_authToken|_auth|_password|username|password|email|certfile|keyfile|cert|key)\s*=)/i

/** The .npmrc without its credentials (comments and blank lines kept), and how many lines were dropped. */
export function withoutCredentials(text) {
  const lines = text.split(/\r?\n/)
  const kept = lines.filter((l) => !CREDENTIAL.test(l))
  return { text: kept.join('\n'), dropped: lines.length - kept.length }
}
