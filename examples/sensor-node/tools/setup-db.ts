/**
 * Writes the sample's settings into its project database, .trace/project.db, the way `trace config set` would:
 * through config.setValue, which checks every value against the settings schema before storing it.
 *
 *   electronics.projects  the KiCad project the kicad.* tools and `trace check` use
 *   electronics.models    SPICE models included in every simulation (the BAT54S clamp diode)
 *   firmware.targets      the C module, built and unit-tested on the host with make
 *
 * Run once from the repository root: `npx tsx examples/sensor-node/tools/setup-db.ts`. The database is rebuilt from
 * scratch, so it holds these settings and no run history. .trace/rules.md is the owner's to write and is left empty.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, setValue } from '../../../src/core/config.js'
import { open, PROJECT_SCHEMA } from '../../../src/core/store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB = join(ROOT, '.trace', 'project.db')
const BY = 'examples/sensor-node/tools/setup-db.ts'

mkdirSync(dirname(DB), { recursive: true })
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
// The database must exist before settings are written: it is what marks this folder as a project root.
const db = open(DB, { wal: false })
db.exec(PROJECT_SCHEMA)
db.close()

setValue('electronics.projects', ['hardware/sensor-node.kicad_pro'], ROOT, BY)
setValue('electronics.models', ['sim/models'], ROOT, BY)
setValue('firmware.targets', [{
  name: 'adc-convert',
  path: 'firmware',
  preset: 'make',
  build: 'make all test',
  artifact: 'build/libadc.a',
  env: {},
}], ROOT, BY)

const rules = join(ROOT, '.trace', 'rules.md')
if (!existsSync(rules)) writeFileSync(rules, '')

const cfg = load(ROOT)
console.log(JSON.stringify({ root: cfg.root, electronics: cfg.electronics, firmware: cfg.firmware }, null, 1))
