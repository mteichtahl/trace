/**
 * The sample project's tour (templates/sample/tour.json) must exercise the whole system: every agent, every tool in the
 * registry (hardware tools included: the bench emulator stands in for the instruments) and every kind of remote job,
 * so every simulation runs at least once. A tool or job kind added later without a tour task fails here.
 */
import { describe, expect, it } from 'vitest'
import { SPECIALIST_KINDS, WORKER } from '../../src/agents/kinds.js'
import { JobKind } from '../../src/gpu/jobs.js'
import { sampleFiles, tour } from '../../src/installer/sample.js'
import { allTools } from '../../src/tools/index.js'

/** Which tool, with what said in the task, makes each kind of remote job run. */
const JOB_REACH: Record<JobKind, { tools: string[]; says: RegExp }> = {
  blender: { tools: ['render.board', 'render.model', 'render.turntable', 'thermal.render'], says: /render|blender|turntable/i },
  freerouting: { tools: ['pcb.autoroute'], says: /freerouting|strategy[^.]*both/i },
  orthoroute: { tools: ['pcb.autoroute'], says: /orthoroute|strategy[^.]*both/i },
  verilator: { tools: ['verify.verilator'], says: /verilator/i },
  cocotb: { tools: ['verify.cocotb'], says: /cocotb/i },
  formal: { tools: ['verify.formal'], says: /formal|\.sby/i },
  yosys: { tools: ['fpga.synth'], says: /synth|yosys/i },
  nextpnr: { tools: ['fpga.pnr', 'fpga.closure'], says: /place and route|nextpnr|pnr/i },
  'fpga-pack': { tools: ['fpga.bitstream'], says: /bitstream/i },
  openems: { tools: ['emc.run'], says: /openems|emc\.run/i },
  thermal: { tools: ['thermal.board'], says: /2\.5d|thermal\.board/i },
  calculix: { tools: ['thermal.board'], says: /calculix/i },
  openfoam: { tools: ['thermal.board'], says: /cfd|openfoam/i },
  // the tools function's own kinds (src/gpu/jobs.ts FUNCTION_KINDS) where the agent image has no kicad-cli, ffmpeg or build123d:
  // not sent to the queue, so not marked remote (TOOLS_FUNCTION_ONLY)
  kicad: { tools: ['kicad.erc', 'kicad.drc', 'kicad.export'], says: /erc|drc|kicad|export/i },
  ffmpeg: { tools: ['render.turntable'], says: /turntable/i },
  cad: { tools: ['mech.build', 'mech.hand_in'], says: /enclosure|build123d|cad job/i },
  // the case script's own kind: the project's cad function (docs/enclosure-build.md "Trust"), never the queue
  'cad-script': { tools: ['mech.build', 'mech.hand_in'], says: /cad-script|case script/i },
}
const TOOLS_FUNCTION_ONLY: ReadonlySet<JobKind> = new Set<JobKind>(['kicad', 'ffmpeg', 'cad', 'cad-script'])

describe('the sample project\'s tour', () => {
  const tasks = tour()
  const registry = allTools()
  const names = registry.list().map((t) => t.name)

  it('is well formed: unique ids and titles, each routed to the agent it is for', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(SPECIALIST_KINDS.length + 1)
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length)
    expect(new Set(tasks.map((t) => t.title)).size).toBe(tasks.length)
    for (const t of tasks) {
      expect(t.labels, t.id).toContain('agent-fix')
      const routing = t.labels.filter((l) => l.startsWith('agent:'))
      expect(routing, `${t.id}: exactly one agent:* label`).toHaveLength(1)
      const kind = routing[0]?.slice('agent:'.length)
      expect(SPECIALIST_KINDS as readonly string[], t.id).toContain(kind)
      // a specialist task is labelled for that specialist; a worker task for the specialist that delegates to it
      if (t.agent !== WORKER) expect(kind, t.id).toBe(t.agent)
      expect(t.body.length, t.id).toBeLessThanOrEqual(2000)
    }
  })

  it('gives every agent at least one task', () => {
    const agents = new Set(tasks.map((t) => t.agent))
    for (const k of [...SPECIALIST_KINDS, WORKER]) expect(agents, k).toContain(k)
  })

  it('runs every tool in the registry, and names only real tools', () => {
    const exercised = new Set(tasks.flatMap((t) => t.exercises))
    const unknown = [...exercised].filter((x) => !registry.get(x))
    expect(unknown, 'not tools').toEqual([])
    const missing = names.filter((n) => !exercised.has(n))
    expect(missing, 'tools no tour task runs').toEqual([])
  })

  it('reaches every kind of remote job, and marks those tasks remote', () => {
    for (const kind of JobKind.options) {
      const reach = JOB_REACH[kind]
      const hit = tasks.filter((t) => reach.tools.some((x) => t.exercises.includes(x)) && reach.says.test(t.body))
      expect(hit.length, `no task runs a ${kind} job`).toBeGreaterThan(0)
      if (!TOOLS_FUNCTION_ONLY.has(kind)) expect(hit.some((t) => t.remote !== null), `the ${kind} task must be marked remote`).toBe(true)
    }
  })

  it('names only files the sample has', () => {
    const files = new Set(sampleFiles().map((f) => f.path))
    for (const t of tasks) {
      for (const m of t.body.matchAll(/`((?:docs|hardware|sim|power|logic|fpga|protocol|emc|thermal|layout|firmware|bench)\/[^`\s]+\.[A-Za-z0-9_]+)`/g)) {
        expect(files, `${t.id} names ${m[1]}`).toContain(m[1])
      }
    }
  })
})
