/**
 * Every area that keeps rows in a project database (.trace/project.db), loaded so its table and merge rule are
 * registered (store.ensureProjectSchema). The project-database merge (dbmerge.ts) imports this, so whichever process
 * merges the file applies each table's own rule.
 *
 * Without it, a process that had not loaded an area merged that area's tables as a plain union (INSERT OR IGNORE): the
 * pull request's row was kept and the newer row from the default branch dropped. The harness (the update queue's
 * project-database merge, src/harness/db-conflict.ts) loads no area, so merging the default branch into an older
 * change reverted a requirement a person had accepted since, and Define reopened (test-esp32, change #8 after #9).
 *
 * A new area that calls ensureProjectSchema adds its module here; test/core/project-tables.test.ts fails until it does.
 */
import '../prompts/store.js'
import '../tools/ams/spec.js'
import '../tools/design/db.js'
import '../tools/kb/sync.js'
import '../tools/protocol/spec.js'
import '../tools/thermal/store.js'
import '../tools/verify/db.js'
import './bench.js'
import './build-tables.js'
import './journey.js'

/** The modules above, as paths from src/ (the test checks that every module calling ensureProjectSchema is listed). */
export const PROJECT_TABLE_MODULES = [
  'prompts/store.ts', 'tools/ams/spec.ts', 'tools/design/db.ts', 'tools/kb/sync.ts', 'tools/protocol/spec.ts',
  'tools/thermal/store.ts', 'tools/verify/db.ts', 'core/bench.ts', 'core/build-tables.ts', 'core/journey.ts',
] as const
