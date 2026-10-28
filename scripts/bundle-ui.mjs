// Bundles the installer page (src/installer/ui, React with the web app's shadcn components and Tailwind) into
// dist/installer/ui.js and dist/installer/ui.css. The page is served by `tracectl install` from this machine, so
// everything it needs (its fonts too) is inside these two files: nothing is fetched from anywhere else.
//
// The shadcn components are the web app's own (web/src/components/ui, imported as "@/components/ui/..."), so the
// installer and the app look the same. Their packages (react, radix-ui, ...) always come from trace's own
// node_modules: web/node_modules may not exist (an installed trace), and when it does a second React would break
// the page.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'installer')
const web = join(root, 'web', 'src')
mkdirSync(out, { recursive: true })

/** "@/..." is the web app's src; a bare package imported from the web app's files resolves from trace's root. */
const shared = {
  name: 'trace-shared-ui',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => b.resolve(`./${args.path.slice(2)}`, { kind: args.kind, resolveDir: web }))
    b.onResolve({ filter: /^[a-z@][^:]*$/ }, (args) => {
      if (!args.importer.startsWith(web) || args.pluginData?.shared) return undefined
      return b.resolve(args.path, { kind: args.kind, resolveDir: root, pluginData: { shared: true } })
    })
  },
}

await build({
  entryPoints: [join(root, 'src/installer/ui/main.tsx')],
  outfile: join(out, 'ui.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [shared],
})

// Tailwind: the classes used by the installer and the shared components, on the app's design tokens.
const work = mkdtempSync(join(tmpdir(), 'trace-ui-css-'))
try {
  const css = join(work, 'tw.css')
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss')
  const r = spawnSync(bin, ['-i', join(root, 'src/installer/ui/installer.css'), '-o', css, '--minify'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`tailwindcss failed: ${r.stderr || r.stdout || r.error?.message}`)
  // the fonts, inlined (Latin only: the page's words are English)
  const fonts = await build({
    entryPoints: [join(root, 'src/installer/ui/fonts.css')],
    bundle: true,
    write: false,
    minify: true,
    loader: { '.woff2': 'dataurl' },
    logLevel: 'warning',
    outdir: work,
  })
  const fontCss = fonts.outputFiles.map((f) => f.text).join('')
  writeFileSync(join(out, 'ui.css'), fontCss + readFileSync(css, 'utf8'))
} finally {
  rmSync(work, { recursive: true, force: true })
}
