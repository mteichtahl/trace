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

// With CDK_OUTDIR set, every new App() synthesizes itself again on beforeExit (its autoSynth), into the cdk.out this
// file removes below. An app a test never synthesized (one built to throw, whose assets were already staged there)
// then fails writing into the removed folder when the worker exits, and vitest counts that as an unhandled error
// (ENOENT … cdk.out/tree.json). That output would be deleted anyway, so this file's apps are kept from it: the
// beforeExit listeners added while it ran are removed with the folder.
const listenersBefore = new Set(process.listeners('beforeExit'))

afterAll(() => {
  for (const l of process.listeners('beforeExit')) if (!listenersBefore.has(l)) process.removeListener('beforeExit', l)
  rmSync(base, { recursive: true, force: true })
})
