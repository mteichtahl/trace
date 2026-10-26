// Bundles the installer page's script (src/installer/ui/app.ts, browser code) into dist/installer/ui.js.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/installer/ui/app.ts'],
  outfile: 'dist/installer/ui.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})
