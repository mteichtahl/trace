/** Every test file runs against throwaway databases: nothing touches ~/.trace, ~/.cache or a real project database.
 * Its scratch folder, and CDK's synth output (cdk.out, about 40 MB a synth), go when the file's tests finish. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'trace-test-'))
process.env.TRACE_HOME = join(base, 'home')
process.env.TRACE_CACHE_DB = join(base, 'cache.db')
process.env.TRACE_PROJECT_DB = join(base, 'project.db')
delete process.env.TRACE_HARDWARE
process.env.NODE_NO_WARNINGS = '1'
// new App() writes here rather than a fresh /tmp/cdk.out* per synth
process.env.CDK_OUTDIR = join(base, 'cdk.out')

afterAll(() => { rmSync(base, { recursive: true, force: true }) })
