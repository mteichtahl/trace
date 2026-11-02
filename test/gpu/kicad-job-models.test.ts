/**
 * The remote kicad job points KiCad's model variables at the board's library models when the caller staged them with
 * the project (src/tools/kicad/models3d.ts MODELS_DIR), and leaves them alone otherwise.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, run } from '../../src/gpu/kicad-job.js'
import { MODELS_DIR } from '../../src/tools/kicad/models3d.js'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'kjm-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A project archive (with the staged models folder or not), and a kicad-cli that writes the model variables it sees. */
async function runWith(staged: boolean): Promise<string> {
  const src = tmp()
  writeFileSync(join(src, 'b.kicad_pcb'), '(kicad_pcb)')
  if (staged) {
    mkdirSync(join(src, MODELS_DIR, 'Resistor_SMD.3dshapes'), { recursive: true })
    writeFileSync(join(src, MODELS_DIR, 'Resistor_SMD.3dshapes', 'R_0603_1608Metric.step'), 'STEP')
  }
  const work = tmp()
  const tar = join(work, 'project.tar')
  expect(spawnSync('tar', ['-cf', tar, '-C', src, '.']).status).toBe(0)
  const cli = join(tmp(), 'kicad-cli')
  writeFileSync(cli, '#!/bin/sh\nout=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\nprintf "%s|%s" "$KICAD10_3DMODEL_DIR" "$KICAD9_3DMODEL_DIR" > "$out"\n', { mode: 0o755 })
  const outTar = join(work, 'out.tar')
  const code = await run(parseArgs([tar, outTar, join(work, 'job'), 'board.glb', 'file', '--', 'pcb', 'export', 'glb', '-o', '@OUT@/board.glb', '@PROJECT@/b.kicad_pcb']), { kicadCli: cli })
  expect(code).toBe(0)
  const back = tmp()
  expect(spawnSync('tar', ['-xf', outTar, '-C', back]).status).toBe(0)
  return readFileSync(join(back, 'board.glb'), 'utf8')
}

describe('the remote kicad job and the board\'s library models', () => {
  it('points every KiCad version\'s model variable at the staged folder', async () => {
    const seen = await runWith(true)
    const [k10, k9] = seen.split('|')
    expect(k10).toMatch(new RegExp(`[/\\\\]project[/\\\\]${MODELS_DIR}$`))
    expect(k9).toBe(k10)
  })
  it('leaves them as the image has them when nothing was staged', async () => {
    const was = { k10: process.env.KICAD10_3DMODEL_DIR, k9: process.env.KICAD9_3DMODEL_DIR }
    delete process.env.KICAD10_3DMODEL_DIR
    delete process.env.KICAD9_3DMODEL_DIR
    try {
      expect(await runWith(false)).toBe('|')
    } finally {
      if (was.k10 !== undefined) process.env.KICAD10_3DMODEL_DIR = was.k10
      if (was.k9 !== undefined) process.env.KICAD9_3DMODEL_DIR = was.k9
    }
  })
})
