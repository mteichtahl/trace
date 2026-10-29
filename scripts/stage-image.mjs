// Copies the files npm never packs (package-lock.json and .npmrc are always left out of a package, so a global
// `npm install -g github:…` has neither) to agent/, which is packed: the image builds (agent/Dockerfile*) and the
// CDK Lambda bundling (src/infra/lockfile.ts) read them there. Run by `npm run build`, which npm runs before it packs a
// git dependency; in a packed install the root files are gone and the copies made at pack time stay. The .npmrc goes
// without its credentials (scripts/npmrc.mjs): a token in a clone's .npmrc never reaches an image.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutCredentials } from './npmrc.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const [from, to] of [['package-lock.json', 'agent/package-lock.json'], ['.npmrc', 'agent/npmrc']]) {
  if (existsSync(join(root, from))) {
    if (from !== '.npmrc') copyFileSync(join(root, from), join(root, to))
    else {
      const { text, dropped } = withoutCredentials(readFileSync(join(root, from), 'utf8'))
      if (dropped) process.stderr.write(`stage-image: left ${dropped} credential line${dropped === 1 ? '' : 's'} of .npmrc out of agent/npmrc (the images get its settings only)\n`)
      writeFileSync(join(root, to), text)
    }
  } else if (!existsSync(join(root, to))) throw new Error(`neither ${from} nor ${to} exists: the agent image cannot be built`)
}
