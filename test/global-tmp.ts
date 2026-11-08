/**
 * Every test run's temporary folders in one folder of its own, removed when the run ends (test-esp32-run2 R36: the
 * suites' mkdtemp folders were left in /tmp, about 71,000 of them, until the disk filled). TMPDIR is set before the
 * forks start, so os.tmpdir() in every test (and every child process it runs) is the run's folder; a test that cleans
 * up after itself still does, and one that doesn't leaves nothing behind. TRACE_KEEP_TMP=1 keeps it, to look into.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  const was = process.env.TMPDIR
  const dir = mkdtempSync(join(was || tmpdir(), 'trace-test-run-'))
  process.env.TMPDIR = dir
  return () => {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
    if (process.env.TRACE_KEEP_TMP === '1') { process.stdout.write(`trace: kept the run's temporary folders in ${dir}\n`); return }
    rmSync(dir, { recursive: true, force: true })
  }
}
