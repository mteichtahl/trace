/** Every test file runs against throwaway databases: nothing touches ~/.trace, ~/.cache or a real project database. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'trace-test-'))
process.env.TRACE_HOME = join(base, 'home')
process.env.TRACE_CACHE_DB = join(base, 'cache.db')
process.env.TRACE_PROJECT_DB = join(base, 'project.db')
delete process.env.TRACE_HARDWARE
process.env.NODE_NO_WARNINGS = '1'
