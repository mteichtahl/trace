/**
 * The npm lock file the CDK's NodejsFunction bundling needs (it walks up from the entry looking for one and fails
 * without it). In a clone it is the root's; in an installed trace (`npm install -g github:…`) npm has left the root's
 * out of the package, and the copy scripts/stage-image.mjs makes in agent/ is used instead.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function lockFile(root: string): string {
  for (const p of [join(root, 'package-lock.json'), join(root, 'agent', 'package-lock.json')]) if (existsSync(p)) return p
  throw new Error(`no package-lock.json in ${root} or ${join(root, 'agent')}: run \`npm run build\` (scripts/stage-image.mjs) first`)
}

/** The NodejsFunction settings that make it find the project and its lock file in both layouts. */
export const bundlingRoot = (root: string): { projectRoot: string; depsLockFilePath: string } => ({ projectRoot: root, depsLockFilePath: lockFile(root) })

/** Refreshes agent/package-lock.json and agent/npmrc (scripts/stage-image.mjs) in a clone, before the stack hashes and
 * uploads the image sources. They are gitignored copies that only `npm run build` made, so a deploy after a dependency
 * change without a full build (`tracectl upgrade --no-pull` from a clone, `tsc` alone) shipped a stale lock, and the
 * image's `npm ci` refused it (EUSAGE: package.json and the lock file out of sync). An installed trace has no .git and
 * keeps the copies made when it was packed. */
export function stageImageFiles(root: string): void {
  if (!existsSync(join(root, '.git')) || !existsSync(join(root, 'scripts', 'stage-image.mjs'))) return
  execFileSync(process.execPath, [join(root, 'scripts', 'stage-image.mjs')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** Fails the synth, in seconds, when the lock file the images install from does not match package.json: otherwise
 * the image build's `npm ci` fails minutes into the deploy and the stack rolls back. */
export function assertImageLockInSync(root: string): void {
  const lockPath = join(root, 'agent', 'package-lock.json')
  if (!existsSync(lockPath)) throw new Error(`no ${lockPath}: run \`npm run build\` (scripts/stage-image.mjs) first`)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
  const top = (JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: Record<string, Record<string, Record<string, string> | undefined>> }).packages?.[''] ?? {}
  const off: string[] = []
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const want = pkg[k] ?? {}, have = top[k] ?? {}
    for (const n of new Set([...Object.keys(want), ...Object.keys(have)])) if (want[n] !== have[n]) off.push(`${n} (package.json ${want[n] ?? 'none'}, lock ${have[n] ?? 'none'})`)
  }
  if (off.length) throw new Error(`agent/package-lock.json does not match package.json, so the agent image's npm ci would fail: ${off.slice(0, 8).join('; ')}${off.length > 8 ? ` and ${off.length - 8} more` : ''}. Run \`npm install && npm run build\` and deploy again`)
}
