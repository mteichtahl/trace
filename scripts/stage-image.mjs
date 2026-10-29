// Copies the files npm never packs (package-lock.json and .npmrc are always left out of a package, so a global
// `npm install -g github:…` has neither) to agent/, which is packed: the image builds (agent/Dockerfile*) and the
// CDK Lambda bundling (src/infra/lockfile.ts) read them there. Run by `npm run build`, which npm runs before it packs a
// git dependency; in a packed install the root files are gone and the copies made at pack time stay.
//
// The .npmrc is trace's own, as committed (`git show HEAD:.npmrc`), never a clone's local edits: a person's .npmrc may
// point npm at a private registry (CodeArtifact, a proxy) or carry a token, and in the image build either fails every
// `npm ci` with E401 (public packages included), while a token would sit in the build's layers. Without git (a pack of
// a pack) it is the file there; credentials are left out either way (scripts/npmrc.mjs).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutCredentials } from './npmrc.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The committed .npmrc, or null when this is no git checkout (or it has none committed). */
function committedNpmrc() {
  if (!existsSync(join(root, '.git'))) return null
  try {
    return execFileSync('git', ['-C', root, 'show', 'HEAD:.npmrc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return null }
}

for (const [from, to] of [['package-lock.json', 'agent/package-lock.json'], ['.npmrc', 'agent/npmrc']]) {
  if (from === '.npmrc') {
    const committed = committedNpmrc()
    const local = existsSync(join(root, from)) ? readFileSync(join(root, from), 'utf8') : null
    const source = committed ?? local
    if (source === null) {
      if (!existsSync(join(root, to))) throw new Error(`neither ${from} nor ${to} exists: the agent image cannot be built`)
      continue
    }
    if (committed !== null && local !== null && local !== committed) process.stderr.write('stage-image: .npmrc has local changes; the images get trace\'s committed .npmrc, not this clone\'s\n')
    const { text, dropped } = withoutCredentials(source)
    if (dropped) process.stderr.write(`stage-image: left ${dropped} credential line${dropped === 1 ? '' : 's'} of .npmrc out of agent/npmrc (the images get its settings only)\n`)
    writeFileSync(join(root, to), text)
  } else if (existsSync(join(root, from))) copyFileSync(join(root, from), join(root, to))
  else if (!existsSync(join(root, to))) throw new Error(`neither ${from} nor ${to} exists: the agent image cannot be built`)
}
