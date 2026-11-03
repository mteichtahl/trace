/**
 * Handing in design files (docs/stay-in-trace.md "4. Getting and handing in design files"): a person who finished
 * trace's draft in KiCad hands the files back in the app, and never needs git or GitHub for it.
 *
 *   design.handin  write  { repo, files: { path, base64 }[], note } → { change, changed, same }
 *                    paths      inside the repository; a KiCad file type (HANDIN_TYPES); an existing file, or a new one
 *                               in a folder that already holds KiCad files (anywhere, when the repository has none yet);
 *                               never .trace/**, .github/** or another path the project's prs.protected_paths names
 *                    limits     at most 20 files, 3 MB each and 3.5 MB together: as base64 in one request that is just
 *                               under the 5,000,000 bytes AWS WAF lets through to /api/* (src/infra/edge.ts BodyTooLarge)
 *                    same       a file identical to the default branch's is left out ("Same as the design"); when every
 *                               file is the same, nothing is handed in and the person is told so
 *                    commit     one commit of the changed files (GitHubApi.commitFiles) on a new branch
 *                               trace/handin-<slug>-<base36 time> made from the default branch's head, its pull request
 *                               opened and the edit recorded (recordEdit, kind handin: it applies once its checks pass,
 *                               like every push, which the checks look at again)
 *
 * The web app's "Get the design files" needs no action: it zips files.list's KiCad files from files.url itself.
 */
import { z } from 'zod'
import { RepoSlug } from '../core/access.js'
import { defaults, readSettings, resolve } from '../core/config.js'
import { globMatch } from '../harness/util.js'
import { ActionError, type Context, PROJECT_DB_PATH, def, label, slugify, tempDb } from './action-kit.js'
import { quote } from './actions-changes.js'
import { editorName, recordEdit } from './edits.js'

/** The KiCad files a person may hand in: by extension, and the two library tables by name. */
export const HANDIN_TYPES = ['.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_sym', '.kicad_mod', '.kicad_dru', 'fp-lib-table', 'sym-lib-table'] as const
export const MAX_HANDIN_FILES = 20
export const MAX_HANDIN_FILE = 3 * 1024 * 1024
export const MAX_HANDIN_TOTAL = 3.5 * 1024 * 1024

/** Paths trace never takes from a person's hand-in, whatever the project's settings say. */
const ALWAYS_PROTECTED = ['.trace/**', '.github/**']

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Whether this path is a KiCad file type a person may hand in. Pure. */
export const isKiCadPath = (path: string): boolean => {
  const name = baseName(path)
  return HANDIN_TYPES.some((t) => (t.startsWith('.') ? name.toLowerCase().endsWith(t) : name === t))
}

/** A path inside the repository: no leading slash, no backslash, no empty, `.` or `..` segment. Pure. */
export const insideRepo = (path: string): boolean =>
  path.length > 0 && path.length <= 500 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((x) => x === '' || x === '.' || x === '..')

/** Whether a path is protected: .trace/**, .github/** or one of the project's prs.protected_paths. Pure. */
export const isProtected = (path: string, protectedPaths: readonly string[]): boolean =>
  [...ALWAYS_PROTECTED, ...protectedPaths].some((g) => globMatch(g, path))

/**
 * Why a handed-in path is refused, in the person's words, or null when it may be handed in. `existing` is every path on
 * the default branch, `kicadFolders` the folders holding KiCad files there. Pure.
 */
export function pathRefusal(path: string, o: { existing: ReadonlySet<string>; kicadFolders: ReadonlySet<string>; protectedPaths: readonly string[] }): string | null {
  if (!insideRepo(path)) return `${path} is not a path inside the repository.`
  if (isProtected(path, o.protectedPaths)) return `${path} steers trace itself, so it is not changed by handing in design files.`
  if (!isKiCadPath(path)) return `${baseName(path)} is not a KiCad file: only schematics, boards, projects, symbol and footprint libraries, design rules and library tables are handed in.`
  if (o.existing.has(path)) return null
  if (o.kicadFolders.size && !o.kicadFolders.has(folderOf(path))) return `${path} is new and not beside the design's KiCad files: put it in ${[...o.kicadFolders].map((f) => f || 'the top folder').slice(0, 3).join(' or ')}.`
  return null
}

/** The size refusal for these decoded files, or null. Pure. */
export function sizeRefusal(files: readonly { path: string; bytes: Uint8Array }[]): string | null {
  if (files.length > MAX_HANDIN_FILES) return `At most ${MAX_HANDIN_FILES} files are handed in at once; this was ${files.length}.`
  const big = files.find((f) => f.bytes.length > MAX_HANDIN_FILE)
  if (big) return `${baseName(big.path)} is ${mb(big.bytes.length)}; a file handed in is at most ${mb(MAX_HANDIN_FILE)}.`
  const total = files.reduce((n, f) => n + f.bytes.length, 0)
  if (total > MAX_HANDIN_TOTAL) return `These files are ${mb(total)} together; at most ${mb(MAX_HANDIN_TOTAL)} are handed in at once. Hand them in in two parts.`
  const seen = new Set<string>()
  for (const f of files) {
    if (seen.has(f.path)) return `${f.path} is named twice.`
    seen.add(f.path)
  }
  return null
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`

/** The edit's title: "Hand in: power.kicad_sch", "Hand in: 3 files". Pure. */
export const handinTitle = (changed: readonly string[]): string => (changed.length === 1 ? `Hand in: ${baseName(changed[0]!)}` : `Hand in: ${changed.length} files`)

/** The branch: trace/handin-<the one file's name, or the project's>-<base36 time>. Pure. */
export const handinBranch = (repo: string, changed: readonly string[], now: number = Date.now()): string =>
  `trace/handin-${slugify(changed.length === 1 ? baseName(changed[0]!).replace(/\.[^.]+$/, '') : repo.split('/')[1] ?? 'files')}-${now.toString(36)}`

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

const Base64 = z.string().max(Math.ceil(MAX_HANDIN_FILE / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'the file\'s bytes as base64')

/** The project's prs.protected_paths from its settings on the default branch; the defaults when they cannot be read. */
export async function protectedPathsOf(ctx: Context, repo: string, branch: string): Promise<string[]> {
  const gh = await ctx.deps.github()
  try {
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
    try {
      return resolve(readSettings(t.db)).config.prs.protected_paths
    } finally {
      t.cleanup()
    }
  } catch {
    return defaults().prs.protected_paths
  }
}

export const HANDIN_ACTIONS = {
  'design.handin': def('write', z.object({
    repo: RepoSlug,
    files: z.array(z.object({ path: z.string().min(1).max(500), base64: Base64 })).min(1).max(MAX_HANDIN_FILES),
    note: z.string().trim().max(2000).default(''),
  }), async (a, ctx) => {
    const files = a.files.map((f) => ({ path: f.path, bytes: new Uint8Array(Buffer.from(f.base64, 'base64')) }))
    const tooBig = sizeRefusal(files)
    if (tooBig) throw new ActionError(tooBig)

    const gh = await ctx.deps.github()
    if (!gh.commitFiles) throw new ActionError('This installation cannot take design files handed in through the app.')
    const { branch: base } = await gh.defaultBranch(a.repo)
    const tree = await gh.tree(a.repo, base)
    const sizes = new Map(tree.files.map((f) => [f.path, f.size]))
    const kicadFolders = new Set(tree.files.filter((f) => isKiCadPath(f.path)).map((f) => folderOf(f.path)))
    const protectedPaths = await protectedPathsOf(ctx, a.repo, base)
    for (const f of files) {
      const why = pathRefusal(f.path, { existing: new Set(sizes.keys()), kicadFolders, protectedPaths })
      if (why) throw new ActionError(why)
    }

    // a file identical to the default branch's is left out
    const changed: typeof files = []
    const same: string[] = []
    for (const f of files) {
      const size = sizes.get(f.path)
      if (size === undefined || size !== f.bytes.length) { changed.push(f); continue }
      const now = await gh.rawFile(a.repo, f.path, base)
      if (now && sameBytes(now, f.bytes)) same.push(f.path)
      else changed.push(f)
    }
    if (!changed.length) throw new ActionError(`${files.length === 1 ? 'This file is' : 'Every file is'} the same as the design: there is nothing to hand in.`)

    const paths = changed.map((f) => f.path)
    const title = handinTitle(paths)
    const branch = handinBranch(a.repo, paths)
    if (branch === base) throw new ActionError('refusing to write the default branch')
    const by = label(ctx.principal)
    const message = [title, '', ...paths.map((p) => `- ${p}`), ...(a.note ? ['', a.note] : []), '', `Handed in by ${by} through the trace API.`].join('\n')
    const { commit } = await gh.commitFiles(a.repo, { branch, base, message, files: changed.map((f) => ({ path: f.path, content: f.bytes })) })
    const body = [title, '', ...paths.map((p) => `- \`${p}\``), ...(a.note ? ['', quote(a.note)] : []), '', `Handed in through trace by ${await editorName(ctx)}.`].join('\n')
    const edit = await recordEdit(ctx, { repo: a.repo, branch, base, commit, kind: 'handin', title, body, redo: null, paths })
    return { repo: a.repo, change: edit.number, branch, commit, changed: paths, same }
  }),
}
