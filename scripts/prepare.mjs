// `prepare` entry point: builds trace, making sure its build tools exist first.
//
// `npm install -g github:mteichtahl/trace#main` clones the repo and runs `npm install` + `prepare` in the clone,
// but npm leaks the outer `--global` into that inner install (npm_config_global=true). It then installs the
// clone as a global link, so devDependencies (TypeScript, Vite) never land in its node_modules and the build
// fails with `tsc: command not found`; npm is also still filling that node_modules while `prepare` runs.
//
// So when the build tools are missing, build in an isolated copy instead: copy the sources to a temporary
// directory, `npm ci` there with the global flag cleared, build, and copy the build outputs back. A normal
// clone (`npm ci` / `npm install`) already has the tools and builds in place, exactly as before.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const npm = win ? 'npm.cmd' : 'npm'

// Everything `npm run build` writes that the installed package needs.
const OUTPUTS = ['dist', 'harness/dist', 'agent/package-lock.json', 'agent/npmrc']

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^npm_config_(global|location|prefix|production|omit|include)$/i.test(key)) delete env[key]
}

function run(args, cwd) {
  const r = spawnSync(npm, args, { cwd, env, stdio: 'inherit', shell: win })
  if (r.status !== 0) {
    console.error(`trace: \`npm ${args.join(' ')}\` failed in ${cwd}`)
    process.exit(r.status ?? 1)
  }
}

if (existsSync(join(root, 'node_modules', '.bin', win ? 'tsc.cmd' : 'tsc'))) {
  run(['run', 'build'], root)
} else {
  const work = mkdtempSync(join(tmpdir(), 'trace-build-'))
  try {
    console.log('trace: build tools missing (global install from git); building in an isolated copy')
    cpSync(root, work, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(root.length)),
    })
    // --ignore-scripts keeps this install from running `prepare` again.
    run(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], work)
    run(['run', 'build'], work)
    for (const out of OUTPUTS) {
      const from = join(work, out)
      if (!existsSync(from)) continue
      rmSync(join(root, out), { recursive: true, force: true })
      cpSync(from, join(root, out), { recursive: true })
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
