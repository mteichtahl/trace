import { it } from 'vitest'
import { createRequire } from 'node:module'
import { allTools } from '../../../src/tools.js'
import { writeEmcBoard } from './boards.js'
const require = createRequire(import.meta.url)
const ctx = { hardware: false, via: 'test' } as const
it('debug', async () => {
  const b = writeEmcBoard({ layers: 2, h: 1.0, width: 40, height: 20, zones: [{ net: 'GND', layer: 'B.Cu', poly: [[0.5, 0.5], [39.5, 0.5], [39.5, 19.5], [0.5, 19.5]] }], segments: [{ net: '/RF', layer: 'F.Cu', x1: 10, y1: 10, x2: 30, y2: 10, w: 1.9 }], footprints: [{ ref: 'J1', x: 10, y: 10, pads: [{ num: '1', x: 0, y: 0, w: 1.9, h: 1.9, net: '/RF' }] }, { ref: 'J2', x: 30, y: 10, pads: [{ num: '1', x: 0, y: 0, w: 1.9, h: 1.9, net: '/RF' }] }] })
  const s = await allTools().call('emc.setup', { board: b, nets: ['/RF'], ports: [{ at: 'J1.1' }, { at: 'J2.1' }], fstop: 3e9, points: 300, fine_cell_mm: 0.475, cells_per_dielectric: 4, end_criteria_db: -30, radiated: { frequencies: [1.5e9, 2.5e9] } }, ctx) as any
  const { Work } = await import('../../../src/core/store.js')
  const w = new Work(); require('node:fs').writeFileSync('/tmp/claude-0/-home-claude/ee604380-6b8a-5bda-8ea8-1872ee2fc5fb/scratchpad/model.py', w.getArtifact(s.run_id, 'model.py')); w.close()
  const r = await allTools().call('emc.run', { setup_run_id: s.run_id, frequencies: [0.5e9, 1e9, 2e9, 3e9], drive: { amplitude_v: 3.3, freq_hz: 100e6, rise_s: 1e-9 } }, ctx) as any
  const w2 = new Work(); require('node:fs').writeFileSync('/tmp/claude-0/-home-claude/ee604380-6b8a-5bda-8ea8-1872ee2fc5fb/scratchpad/openems.log', w2.getArtifact(r.run_id, 'openems.log')); w2.close()
  for (const t of r.tdr) delete t.profile
  require('node:fs').writeFileSync('/tmp/claude-0/-home-claude/ee604380-6b8a-5bda-8ea8-1872ee2fc5fb/scratchpad/emc.json', JSON.stringify({ s, r }, null, 1))
}, 900000)
