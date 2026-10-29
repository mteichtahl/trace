/**
 * A kicad-cli run as a job (kind kicad), inside the tools image or the GPU image (src/tools/kicad/remote.ts sends it):
 *
 *   node kicad-job.js {in:project.tar} {out:out.tar} {dir} <output name> <file|dir> -- <kicad-cli arguments>
 *
 * The project archive (the KiCad files under the project's repository or folder, src/tools/kicad/remote.ts packProject)
 * is unpacked into {dir}/project; in the arguments @PROJECT@ stands for that folder and @OUT@ for {dir}/out, where
 * kicad-cli writes its output (a file, or a folder made first when the output is one). Then everything in {dir}/out,
 * and .trace-kicad-job.json naming the two folders (the caller puts its own paths back where KiCad wrote these), goes
 * into out.tar. The exit code is kicad-cli's (127: it could not be started).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PROJECT_TOKEN = '@PROJECT@'
export const OUT_TOKEN = '@OUT@'
/** In out.tar: the folders this run used, { project, out } */
export const SIDECAR = '.trace-kicad-job.json'

export interface KicadJobArgs { projectTar: string; outTar: string; work: string; outName: string; outKind: 'file' | 'dir'; cli: string[] }

export function parseArgs(argv: readonly string[]): KicadJobArgs {
  const sep = argv.indexOf('--')
  const [projectTar, outTar, work, outName, outKind] = argv
  if (sep !== 5 || !projectTar || !outTar || !work || !outName || (outKind !== 'file' && outKind !== 'dir')) {
    throw new Error('usage: kicad-job.js <project.tar> <out.tar> <work dir> <output name> <file|dir> -- <kicad-cli arguments>')
  }
  if (outName.includes('/') || outName === '.' || outName === '..') throw new Error(`the output name ${outName} is not a plain name`)
  return { projectTar, outTar, work, outName, outKind, cli: argv.slice(sep + 1) }
}

const tar = (args: string[]): void => {
  const r = spawnSync('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error(`tar ${args[0]} failed (exit ${r.status ?? 'none'})`)
}

/** Run it; resolves to kicad-cli's exit code. */
export async function run(a: KicadJobArgs, o: { kicadCli?: string } = {}): Promise<number> {
  const project = join(a.work, 'project')
  const out = join(a.work, 'out')
  mkdirSync(project, { recursive: true })
  mkdirSync(out, { recursive: true })
  tar(['-xf', a.projectTar, '-C', project])
  if (a.outKind === 'dir') mkdirSync(join(out, a.outName), { recursive: true })
  const args = a.cli.map((s) => s.replaceAll(PROJECT_TOKEN, project).replaceAll(OUT_TOKEN, out))
  const code = await new Promise<number>((resolve) => {
    const p = spawn(o.kicadCli ?? process.env.KICAD_CLI ?? 'kicad-cli', args, { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('error', (e: NodeJS.ErrnoException) => { console.error(e.code === 'ENOENT' ? 'kicad-cli is not installed in this image' : e.message); resolve(127) })
    p.on('close', (c) => resolve(c ?? 1))
  })
  writeFileSync(join(out, SIDECAR), JSON.stringify({ project, out }))
  tar(['-cf', a.outTar, '-C', out, '.'])
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let a: KicadJobArgs
  try {
    a = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(127)
  }
  run(a).then((code) => process.exit(code), (e: unknown) => {
    console.error(`trace kicad job: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(127)
  })
}
