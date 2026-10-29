/**
 * Whether a case build still stands for the repository as it is (mech.fit, mech.order and the Case design skill's fit
 * check, src/api/skill-checks.ts, all use staleReasons): a build records its inputs, and any that changed since makes
 * its fit no evidence until it is built again.
 *
 *   board, board_sha256           the board file
 *   case_json_sha256              mechanical/case.json
 *   case_py_sha256                mechanical/case.py (a scripted case)
 *   case_file, case_file_sha256   the handed-in STEP (a case from a file)
 *   facts_sha256                  the board facts the engine was given (changes with trace's facts reader and height
 *                                 table, not only the board)
 *   capabilities_checked          the date the process capabilities were read (src/tools/mech/capabilities.ts)
 *   engine                        ENGINE_VERSION (this side's contract with the engine), the Python package's
 *                                 tracebridge.mech.__version__ when it states one, and a sha256 over its source files
 *
 * A field the caller cannot compute now (the API reads files from GitHub and has no Python engine) is left undefined
 * and not compared.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASE_JSON, CASE_PY } from './settings.js'

/** The TypeScript side's engine contract version: bump it when what mech.build sends or reads changes. */
export const ENGINE_VERSION = '1'

export interface EngineStamp { ts: string; py_version: string | null; py_sha256: string | null }

export interface BuildInputs {
  board: string
  board_sha256: string
  case_json_sha256: string | null
  case_py_sha256: string | null
  case_file: string | null
  case_file_sha256: string | null
  facts_sha256?: string
  capabilities_checked?: string
  engine?: EngineStamp
}

export const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex')

/**
 * The Python engine's stamp from its source folder (`<pyDir>/tracebridge/mech`): `__version__ = "…"` in __init__.py
 * when it states one, and a sha256 over its .py files (sorted by name, templates/ included). Nulls when the folder is
 * not there.
 */
export function engineStamp(pyDir: string | null): EngineStamp {
  const dir = pyDir ? join(pyDir, 'tracebridge', 'mech') : null
  if (!dir || !existsSync(dir)) return { ts: ENGINE_VERSION, py_version: null, py_sha256: null }
  const files: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '__pycache__' || e.name.startsWith('.')) continue
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`)
      else if (e.isFile() && e.name.endsWith('.py')) files.push(`${rel}${e.name}`)
    }
  }
  walk(dir, '')
  const h = createHash('sha256')
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update('\0')
  let version: string | null = null
  try {
    version = /^__version__\s*=\s*["']([^"']+)["']/m.exec(readFileSync(join(dir, '__init__.py'), 'utf8'))?.[1] ?? null
  } catch { /* no __init__.py */ }
  return { ts: ENGINE_VERSION, py_version: version, py_sha256: files.length ? h.digest('hex') : null }
}

/**
 * Why a build made with `was` no longer stands for `now`: one line per input that changed, naming the file or what
 * changed. Empty: current. A field undefined in `now` is not compared; one missing from an older build's record is.
 */
export function staleReasons(was: Partial<BuildInputs> | null | undefined, now: Partial<BuildInputs>): string[] {
  if (!was || typeof was !== 'object') return ['the build recorded no inputs']
  const out: string[] = []
  const boardChanged = (now.board !== undefined && was.board !== now.board) || (now.board_sha256 !== undefined && was.board_sha256 !== now.board_sha256)
  if (now.board !== undefined && was.board !== now.board) out.push(`the case's board is now ${now.board} (it was ${was.board ?? 'not recorded'})`)
  else if (now.board_sha256 !== undefined && was.board_sha256 !== now.board_sha256) out.push(`${now.board ?? was.board ?? 'the board'} changed since the build`)
  if (now.case_json_sha256 !== undefined && was.case_json_sha256 !== now.case_json_sha256) out.push(`${CASE_JSON} changed since the build`)
  if (now.case_py_sha256 !== undefined && was.case_py_sha256 !== now.case_py_sha256) out.push(`${CASE_PY} changed since the build`)
  if ((now.case_file !== undefined && was.case_file !== now.case_file) || (now.case_file_sha256 !== undefined && was.case_file_sha256 !== now.case_file_sha256)) {
    out.push(`the handed-in case file ${now.case_file ?? was.case_file ?? ''} changed since the build`)
  }
  // the facts follow the board; reported on their own only when the board did not change (trace's reader or heights did)
  if (now.facts_sha256 !== undefined && was.facts_sha256 !== now.facts_sha256 && !boardChanged) {
    out.push('the board facts trace reads from the board changed since the build (the facts reader or the height table)')
  }
  if (now.capabilities_checked !== undefined && was.capabilities_checked !== now.capabilities_checked) {
    out.push(`the process capabilities were re-read (${now.capabilities_checked}; the build used ${was.capabilities_checked ?? 'an older table'})`)
  }
  if (now.engine) {
    const w = was.engine
    if (!w) out.push('the build records no engine version')
    else if (w.ts !== now.engine.ts) out.push(`trace's enclosure engine contract changed (${w.ts} to ${now.engine.ts})`)
    else if (now.engine.py_version !== null && w.py_version !== now.engine.py_version) out.push(`the enclosure engine changed (tracebridge.mech ${w.py_version ?? 'unversioned'} to ${now.engine.py_version})`)
    else if (now.engine.py_sha256 !== null && w.py_sha256 !== null && w.py_sha256 !== now.engine.py_sha256) out.push('the enclosure engine\'s code changed since the build')
  }
  return out
}

/** The first stale reason as the Case design skill words it: "the case was built before <file> changed". */
export function staleSentence(reasons: readonly string[]): string {
  const r = reasons[0] ?? ''
  const m = /^(.*) changed since the build$/.exec(r)
  const what = m ? m[1] : r
  return `The case was built before ${what}${m ? ' changed' : ''}: run mech.build.${reasons.length > 1 ? ` (${reasons.length - 1} more: ${reasons.slice(1).join('; ')})` : ''}`
}

/**
 * The inputs as they are now, for the files a build recorded, read through `read` (repository path → bytes, null when
 * absent): the board, case.json, case.py and the handed-in file, plus the capabilities' date. The facts and the engine
 * are left undefined (not compared): a reader of files alone, such as the API reading the default branch from GitHub,
 * cannot compute them.
 */
export async function filesNow(was: Partial<BuildInputs>, read: (path: string) => Promise<Uint8Array | null>, capabilitiesChecked?: string): Promise<Partial<BuildInputs>> {
  const hash = async (p: string | null | undefined): Promise<string | null> => {
    if (!p) return null
    const b = await read(p)
    return b ? sha256(b) : null
  }
  const now: Partial<BuildInputs> = {}
  if (was.board) {
    now.board = was.board
    now.board_sha256 = (await hash(was.board)) ?? ''
  }
  now.case_json_sha256 = await hash(CASE_JSON)
  if (was.case_py_sha256 !== undefined) now.case_py_sha256 = was.case_py_sha256 === null ? null : await hash(CASE_PY)
  if (was.case_file) {
    now.case_file = was.case_file
    now.case_file_sha256 = await hash(was.case_file)
  }
  if (capabilitiesChecked !== undefined) now.capabilities_checked = capabilitiesChecked
  return now
}
