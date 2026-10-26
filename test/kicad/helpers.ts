import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findKicadCli } from '../../src/kicad/project.js'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
/** A temporary copy of the demo project: kicad-cli writes local settings (.kicad_prl) beside the files it opens. */
export const DEMO = join(mkdtempSync(join(tmpdir(), 'kicad-fixture-')), 'demo')
cpSync(join(FIXTURES, 'demo'), DEMO, { recursive: true })
export const DEMO_PRO = join(DEMO, 'demo.kicad_pro')
export const DEMO_SCH = join(DEMO, 'demo.kicad_sch')
export const DEMO_PCB = join(DEMO, 'demo.kicad_pcb')

const cli = findKicadCli()
let works = false
if (cli) {
  try {
    execFileSync(cli, ['version'], { timeout: 30_000, stdio: 'pipe' })
    works = true
  } catch {
    works = false
  }
}
/** kicad-cli is installed and answers. */
export const hasKicad = works

/** A real KiCad 10 project used for regression checks when it is present on this machine. */
export const REAL = '/home/claude/potroller/supervisor/pcb/potroller-supervisor'
export const hasReal = existsSync(`${REAL}.kicad_pcb`) && existsSync(`${REAL}.kicad_sch`)
