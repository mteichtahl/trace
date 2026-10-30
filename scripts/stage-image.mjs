// Copies the files npm never packs (package-lock.json and .npmrc are always left out of a package, so a global
// `npm install -g github:…` has neither) to agent/, which is packed: the image builds (agent/Dockerfile*) and the
// CDK Lambda bundling (src/infra/lockfile.ts) read them there. Run by `npm run build`, which npm runs before it packs a
// git dependency; in a packed install the root files are gone and the copies made at pack time stay.
//
// The .npmrc is trace's own, as committed (`git show HEAD:.npmrc`), never a clone's local edits: a person's .npmrc may
// point npm at a private registry (CodeArtifact, a proxy) or carry a token, and in the image build either fails every
// `npm ci` with E401 (public packages included), while a token would sit in the build's layers. Without git (a pack of
// a pack) it is the file there; credentials are left out either way (scripts/npmrc.mjs).
//
// The lock file likewise: npm ci installs exactly its `resolved` URLs, and an `npm install` run with a private registry
// in the person's ~/.npmrc rewrites them to that registry, which the image build cannot reach (E401). While package.json
// is as committed the images get the committed lock; a clone that changed its dependencies keeps its own, with a
// warning when it resolves packages anywhere but the public registry.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutCredentials } from './npmrc.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A file as committed (HEAD), or null when this is no git checkout (or it has none committed). */
function committed(file) {
  if (!existsSync(join(root, '.git'))) return null
  try {
    return execFileSync('git', ['-C', root, 'show', `HEAD:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch { return null }
}

/** The registries a lock file resolves packages from, other than the public one. */
function privateRegistries(lock) {
  const hosts = new Set()
  for (const m of lock.matchAll(/"resolved":\s*"(https?:\/\/[^/"]+)/g)) if (m[1] !== 'https://registry.npmjs.org') hosts.add(m[1])
  return [...hosts]
}

for (const [from, to] of [['package-lock.json', 'agent/package-lock.json'], ['.npmrc', 'agent/npmrc']]) {
  if (from === '.npmrc') {
    const committedText = committed('.npmrc')
    const local = existsSync(join(root, from)) ? readFileSync(join(root, from), 'utf8') : null
    const source = committedText ?? local
    if (source === null) {
      if (!existsSync(join(root, to))) throw new Error(`neither ${from} nor ${to} exists: the agent image cannot be built`)
      continue
    }
    if (committedText !== null && local !== null && local !== committedText) process.stderr.write('stage-image: .npmrc has local changes; the images get trace\'s committed .npmrc, not this clone\'s\n')
    const { text, dropped } = withoutCredentials(source)
    if (dropped) process.stderr.write(`stage-image: left ${dropped} credential line${dropped === 1 ? '' : 's'} of .npmrc out of agent/npmrc (the images get its settings only)\n`)
    writeFileSync(join(root, to), text)
  } else {
    const local = existsSync(join(root, from)) ? readFileSync(join(root, from), 'utf8') : null
    const pkg = existsSync(join(root, 'package.json')) ? readFileSync(join(root, 'package.json'), 'utf8') : null
    const lock = pkg !== null && committed('package.json') === pkg ? committed(from) : null
    const source = lock ?? local
    if (source === null) {
      if (!existsSync(join(root, to))) throw new Error(`neither ${from} nor ${to} exists: the agent image cannot be built`)
      continue
    }
    if (lock !== null && local !== null && local !== lock) process.stderr.write('stage-image: package-lock.json has local changes; the images get the committed lock (package.json is as committed)\n')
    const elsewhere = privateRegistries(source)
    if (elsewhere.length) process.stderr.write(`stage-image: WARNING agent/package-lock.json resolves packages from ${elsewhere.join(', ')}, which the image builds cannot authenticate to (npm ci fails with E401): run npm install with the public registry (npm install --registry=https://registry.npmjs.org) and build again\n`)
    writeFileSync(join(root, to), source)
  }
}
