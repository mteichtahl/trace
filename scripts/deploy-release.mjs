// `npm run deploy:release [-- <cdk deploy arguments>]`: builds, then deploys TraceRelease (src/infra/release.ts) in
// us-east-1, the stack alone. `trace release setup` does this and everything after it (the registry alias, the source
// repository's variables, the runner); this is for deploying the stack by hand.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const built = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)
const r = spawnSync(process.execPath, [require.resolve('aws-cdk/bin/cdk'), 'deploy', 'TraceRelease', '--app', 'node dist/infra/release.js', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, AWS_REGION: 'us-east-1', CDK_DEFAULT_REGION: 'us-east-1' },
})
process.exitCode = r.status ?? 1
