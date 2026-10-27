/**
 * Bundles the web backend (src/web/lambda.ts) with esbuild into `out/index.mjs`: ESM, node22, everything bundled,
 * the AWS SDK v3 clients included, so the function runs the versions this repository pins rather than whichever the
 * Lambda runtime carries. The CDK construct calls it from a local bundling step, as bundleLibraryLambda
 * (src/infra/gateway.ts); scripts/bundle-web-backend.mjs runs it by hand.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

export function bundleWebBackend(root: string, out: string): void {
  const req = createRequire(join(root, 'package.json'))
  const esbuild = req('esbuild') as typeof import('esbuild')
  esbuild.buildSync({
    entryPoints: [join(root, 'src', 'web', 'lambda.ts')],
    outfile: join(out, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'error',
    mainFields: ['module', 'main'],
    // CommonJS dependencies get a require
    banner: { js: "import { createRequire as __traceRequire } from 'node:module'; const require = __traceRequire(import.meta.url);" },
  })
}
