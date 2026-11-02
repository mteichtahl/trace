/**
 * Bundles the web backend (src/web/lambda.ts) with esbuild into `out/index.mjs`, and the live events' authorizer
 * (src/web/events-auth.ts) into `out/authorizer.mjs`, and the agents' facts' live updates (src/web/journey-events.ts)
 * into `out/journey-events.mjs`, and GitHub's webhook's function (src/web/hooks-lambda.ts) into `out/hooks.mjs`: ESM, node22, everything bundled,
 * the AWS SDK v3 clients included, so the function runs the versions this repository pins rather than whichever the
 * Lambda runtime carries. The CDK construct calls it from a local bundling step, as bundleLibraryLambda
 * (src/infra/gateway.ts); scripts/bundle-web-backend.mjs runs it by hand.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

export function bundleWebBackend(root: string, out: string): void {
  const req = createRequire(join(root, 'package.json'))
  const esbuild = req('esbuild') as typeof import('esbuild')
  for (const [entry, file] of [['lambda.ts', 'index.mjs'], ['events-auth.ts', 'authorizer.mjs'], ['journey-events.ts', 'journey-events.mjs'], ['hooks-lambda.ts', 'hooks.mjs']] as const) build(esbuild, join(root, 'src', 'web', entry), join(out, file))
}

function build(esbuild: typeof import('esbuild'), entry: string, outfile: string): void {
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
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
