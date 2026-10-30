/**
 * Files the mech tools read and write in a repository, checked on the file system and not only by their spelling: the
 * path resolves (realpath; for a new file, its nearest existing parent) inside the repository's own realpath, not
 * under .git/, and is not itself a symbolic link (lstat). A symlinked mechanical/case.py, a handed-in file that points
 * at ~/.aws/credentials or /proc/self/environ, or a mechanical/ folder linked elsewhere is refused with a ToolError.
 *
 * Writes open the file with O_NOFOLLOW as well, so a link made between the check and the write is not followed, and
 * check by fstat against lstat that what was opened is the file at that path (same device and inode): a folder on the
 * path swapped for a link between the check and the open is caught, the descriptor closed and a file this call made
 * removed. The .git/ check ignores letter case (a case-insensitive file system has one .git whatever its spelling).
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError } from '../../core/registry.js'

/** A repository-relative path as case.json may hold it: no absolute path, no '..' or '.' segment, no backslash. */
export function isRepoRelative(p: string): boolean {
  if (!p || p.includes('\\') || p.includes('\0') || isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const under = (base: string, p: string): boolean => {
  const rel = relative(base, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The nearest existing path at or above `p`. */
function nearestExisting(p: string): string {
  let q = p
  for (;;) {
    try {
      lstatSync(q)
      return q
    } catch { /* not there */ }
    const up = dirname(q)
    if (up === q) return q
    q = up
  }
}

/**
 * `p` (absolute, or relative to the repository `root`) as a file inside it: { abs, rel }. Refuses a path outside the
 * repository (by spelling or through a symlinked folder), one under .git/, and a symbolic link. `what` names the file
 * in the error ("the handed-in file", "mechanical/case.py").
 */
export function repoFile(root: string, p: string, what = p): { abs: string; rel: string } {
  const realRoot = realpathSync(root)
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  // the spelling first: a relative path is under root, an absolute one under root or its realpath
  const base = under(resolve(root), abs) ? resolve(root) : under(realRoot, abs) ? realRoot : null
  if (!base) throw new ToolError(`${what} (${p}) is outside the repository (${root})`)
  const rel = relative(base, abs).split(sep).join('/')
  const name = what === p || what === rel ? rel : `${what} (${rel})`
  let st: ReturnType<typeof lstatSync> | null = null
  try {
    st = lstatSync(abs)
  } catch { /* a new file */ }
  if (st?.isSymbolicLink()) throw new ToolError(`${name} is a symbolic link: the mech tools read and write only regular files in the repository`)
  const real = st ? realpathSync(abs) : resolve(realpathSync(nearestExisting(abs)), relative(nearestExisting(abs), abs))
  if (!under(realRoot, real)) throw new ToolError(`${name} resolves outside the repository (to ${real}): a folder on its path is a symbolic link`)
  const realRel = relative(realRoot, real).split(sep)
  if (realRel.some((seg) => seg.toLowerCase() === '.git')) throw new ToolError(`${name} is inside .git/`)
  if (st && !st.isFile() && !st.isDirectory()) throw new ToolError(`${name} is not a regular file`)
  return { abs, rel }
}

/** Read a repository file after repoFile's checks. */
export function readRepoFile(root: string, p: string, what = p): Buffer {
  const { abs, rel } = repoFile(root, p, what)
  if (!existsSync(abs)) throw new ToolError(`${what === p || what === rel ? rel : `${what} (${rel})`} does not exist`)
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Whether the open descriptor is a regular file and the very file now at `path` (lstat: same device and inode). */
export function openedIsAt(fd: number, path: string): boolean {
  const opened = fstatSync(fd)
  let at: ReturnType<typeof lstatSync>
  try {
    at = lstatSync(path)
  } catch {
    return false
  }
  return opened.isFile() && at.isFile() && opened.dev === at.dev && opened.ino === at.ino
}

/** Write a repository file (its folders made as needed) after repoFile's checks, never through a symbolic link. */
export function writeRepoFile(root: string, p: string, data: string | Uint8Array, what = p): string {
  const { abs } = repoFile(root, p, what)
  mkdirSync(dirname(abs), { recursive: true })
  // the folders just made are checked again: nothing on the path may lead out
  repoFile(root, p, what)
  const existed = existsSync(abs)
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644)
  try {
    // what was opened is the file at that path now (same device and inode), and a regular file: a folder on the path
    // replaced by a link between the check and the open would have opened something else
    if (!openedIsAt(fd, abs)) {
      closeSync(fd)
      if (!existed) {
        try {
          unlinkSync(abs)
        } catch { /* already gone */ }
      }
      throw new ToolError(`${what === p ? p : `${what} (${p})`} changed under the write (the path no longer leads to the file that was opened): nothing written`)
    }
    const buf = typeof data === 'string' ? Buffer.from(data) : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
  } catch (e) {
    if (!(e instanceof ToolError)) closeSync(fd)
    throw e
  }
  closeSync(fd)
  return abs
}

/** Copy one repository file to another, both checked (a no-op when they are the same file). */
export function copyRepoFile(root: string, from: string, to: string, what = { from, to }): void {
  const a = repoFile(root, from, what.from)
  const b = repoFile(root, to, what.to)
  if (a.abs === b.abs) return
  writeRepoFile(root, to, readRepoFile(root, from, what.from), what.to)
}

/** Remove a repository file, checked (a symbolic link there is refused, not followed or removed). */
export function removeRepoFile(root: string, p: string, what = p): void {
  const { abs } = repoFile(root, p, what)
  rmSync(abs, { force: true })
}

/** Make a repository folder, checked. */
export function repoDir(root: string, p: string, what = p): string {
  const { abs } = repoFile(root, p, what)
  mkdirSync(abs, { recursive: true })
  repoFile(root, p, what)
  return abs
}
