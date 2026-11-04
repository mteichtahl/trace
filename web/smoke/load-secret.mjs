// Reads the smoke user's sign-in from a Secrets Manager secret (a JSON object of TRACE_SMOKE_* variables, docs/smoke-test.md
// "Live runs") and hands it to the next steps of a GitHub Actions job: each value is masked in the logs, then appended to
// $GITHUB_ENV. Uses the AWS CLI, which both GitHub's and CodeBuild's Ubuntu runners have.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [secretId] = process.argv.slice(2)
if (!secretId || !process.env.GITHUB_ENV) {
  console.error('usage (in a GitHub Actions step): node load-secret.mjs <secret name or ARN>')
  process.exit(2)
}
const raw = execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' })
const values = JSON.parse(raw)
const allowed = /^TRACE_SMOKE_[A-Z_]+$/
let n = 0
for (const [k, v] of Object.entries(values)) {
  if (!allowed.test(k) || typeof v !== 'string' || /[\r\n]/.test(v)) {
    console.error(`skipped ${k}: only single-line TRACE_SMOKE_* strings are taken`)
    continue
  }
  // URLs and the project name are not secret, but masking them costs nothing
  console.log(`::add-mask::${v}`)
  appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`)
  n++
}
console.error(`loaded ${n} smoke settings from ${secretId}`)
