// Bundles the web backend (src/web/lambda.ts) into <out>/index.mjs for the Lambda (src/web/bundle.ts does the work).
//   node scripts/bundle-web-backend.mjs [out]      default out: dist/web-backend
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(root, 'dist', 'web-backend'))
mkdirSync(out, { recursive: true })
// the bundler is TypeScript: build it first, then run it (no TypeScript loader needed)
const tmp = join(out, '.bundle.mjs')
await build({ entryPoints: [join(root, 'src', 'web', 'bundle.ts')], outfile: tmp, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error', packages: 'external' })
const { bundleWebBackend } = await import(tmp)
bundleWebBackend(root, out)
const { rmSync } = await import('node:fs')
rmSync(tmp)
process.stdout.write(`web backend bundled into ${join(out, 'index.mjs')}\n`)
