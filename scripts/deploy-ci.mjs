// `npm run deploy:ci [-- <cdk deploy arguments>]`: builds, then deploys TraceCi, trace's own CI runner, with nothing to
// give up front: it reuses a GitHub connection already authorized in the account and region, or lets the stack create
// one, shows where to authorize it, waits, and deploys again with the runner. See src/infra/ci-deploy.ts.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const built = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const { main } = await import(pathToFileURL(join(root, 'dist', 'infra', 'ci-deploy.js')).href)
try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
  console.error(`deploy:ci stopped: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
}
