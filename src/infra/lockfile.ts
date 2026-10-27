/**
 * The npm lock file the CDK's NodejsFunction bundling needs (it walks up from the entry looking for one and fails
 * without it). In a clone it is the root's; in an installed trace (`npm install -g github:…`) npm has left the root's
 * out of the package, and the copy scripts/stage-image.mjs makes in agent/ is used instead.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function lockFile(root: string): string {
  for (const p of [join(root, 'package-lock.json'), join(root, 'agent', 'package-lock.json')]) if (existsSync(p)) return p
  throw new Error(`no package-lock.json in ${root} or ${join(root, 'agent')}: run \`npm run build\` (scripts/stage-image.mjs) first`)
}

/** The NodejsFunction settings that make it find the project and its lock file in both layouts. */
export const bundlingRoot = (root: string): { projectRoot: string; depsLockFilePath: string } => ({ projectRoot: root, depsLockFilePath: lockFile(root) })
