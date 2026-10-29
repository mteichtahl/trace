#!/usr/bin/env node
/**
 * Starts the built runtime entry (dist/agents/runtime/main.js) in every TRACE_AGENT_MODE, the way AgentCore starts the
 * image, and fails unless each one answers GET /ping with 200 before it gives up:
 *
 *   node scripts/check-runtime-start.mjs [--entry dist/agents/runtime/main.js] [--require <module>] [--modes a,b] [--timeout-ms 30000]
 *
 * Why: main.ts loads the API and MCP servers with a dynamic `import()` whose path is only resolved at run time, in the
 * built layout. Unit tests import the sources directly and scripts/check-imports.mjs does not follow dynamic imports,
 * so a wrong path (or a package the image removed) passes everything and is found only when the deployed runtime
 * crashes on every start. This runs the real entry instead. agent/Dockerfile runs it after the image is pruned
 * (with ADOT's --require, as the image's CMD does) and ci.yml runs it after the build.
 *
 * Each mode gets placeholder settings: nothing at start-up may reach AWS or GitHub, so none is contacted. The MCP mode
 * listens on 8000 (AgentCore's MCP port, fixed in src/mcp-remote/server.ts); the others on PORT. Modes run one at a time.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const entry = opt('--entry', 'dist/agents/runtime/main.js')
const preload = opt('--require', undefined)
const modes = opt('--modes', 'worker,api,external,mcp').split(',').filter(Boolean)
const timeoutMs = Number(opt('--timeout-ms', '30000'))

if (!existsSync(entry)) { console.error(`${entry} does not exist: build first (npm run build:image)`); process.exit(2) }

const REGION = 'us-east-1'
const POOL = `${REGION}_check`
const COMMON = {
  AWS_REGION: REGION,
  AWS_DEFAULT_REGION: REGION,
  TRACE_PREFIX: 'trace-check',
  // the ADOT preload: no exporter is reachable here, and none is needed to start
  OTEL_SDK_DISABLED: 'true',
  AGENT_OBSERVABILITY_ENABLED: 'false',
}
const API = {
  TRACE_COGNITO_POOL_ID: POOL,
  TRACE_COGNITO_CLIENT_ID: 'check-client',
  TRACE_COGNITO_ISSUER: `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`,
  TRACE_GITHUB_SECRET_ARN: `arn:aws:secretsmanager:${REGION}:123456789012:secret:trace-check-github`,
  TRACE_AWS_ACCOUNT: '123456789012',
}
const ENV = {
  worker: { TRACE_AGENT_MODE: 'worker' },
  api: { TRACE_AGENT_MODE: 'api', ...API },
  external: { TRACE_AGENT_MODE: 'external', ...API },
  mcp: { TRACE_AGENT_MODE: 'mcp', TRACE_EXTERNAL_URL: 'https://127.0.0.1:9/invocations' },
}

/** A free TCP port on this machine. */
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function check(mode) {
  if (!ENV[mode]) return { ok: false, detail: `unknown mode ${mode} (one of ${Object.keys(ENV).join(', ')})` }
  const port = mode === 'mcp' ? 8000 : await freePort()
  const env = { ...process.env, ...COMMON, ...ENV[mode], PORT: String(port), NODE_ENV: 'production' }
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  let exited = null
  child.once('exit', (code, signal) => { exited = signal ?? code })
  const t0 = Date.now()
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (exited !== null) return { ok: false, detail: `exited (${exited}) before answering /ping`, out }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2000) })
        if (r.status === 200) return { ok: true, detail: `answered /ping in ${Date.now() - t0} ms` }
        return { ok: false, detail: `/ping answered ${r.status}`, out }
      } catch { /* not listening yet */ }
      await sleep(250)
    }
    return { ok: false, detail: `no answer from /ping within ${timeoutMs} ms`, out }
  } finally {
    if (exited === null) {
      child.kill('SIGTERM')
      const t1 = Date.now()
      while (exited === null && Date.now() - t1 < 5000) await sleep(100)
      if (exited === null) child.kill('SIGKILL')
    }
  }
}

let failed = 0
for (const mode of modes) {
  const r = await check(mode)
  if (r.ok) {
    console.log(`ok    ${mode}: ${r.detail}`)
  } else {
    failed++
    console.error(`FAIL  ${mode}: ${r.detail}`)
    if (r.out) console.error(r.out.trim().split('\n').slice(-30).map((l) => `      ${l}`).join('\n'))
  }
}
if (failed) {
  console.error(`${failed} of ${modes.length} runtime modes did not start: the deployed runtimes would crash the same way`)
  process.exit(1)
}
console.log(`all ${modes.length} runtime modes start (${entry})`)
