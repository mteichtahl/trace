/**
 * Mock answers for progress and logs (docs/progress-and-logs.md): what trace is doing across the projects
 * (activity.list), the checks on Soil sensor's change 13 as GitHub's jobs (change.runs), and run.log for each run, a
 * believable board-checks log that grows a line or two on every call, as if the check were writing it. Registered in
 * handlers.ts with one line.
 */
import type { ActivityItem, CheckJob, LogLine, RunLogResult } from '@/lib/types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const S = 1000
const MIN = 60 * S
/** when the page loaded: every run's clock counts from here, so the times stay believable however long it is open */
const T0 = Date.now()
const at = (ms: number) => new Date(T0 + ms).toISOString()
const nowIso = () => new Date().toISOString()

// ------------------------------------------------------------------ the board checks' log

const BOARD: [number, string][] = [
  [-3 * MIN - 31 * S, '▸ Step 1 · Get the design'],
  [-3 * MIN - 30 * S, 'Fetched soil-sensor @ 7c1e9a2 (change #13)'],
  [-3 * MIN - 24 * S, '▸ Step 2 · Load the board'],
  [-3 * MIN - 22 * S, 'kicad-cli 9.0.2 · soil-sensor.kicad_pcb · 4 layers, 62 nets, 118 parts'],
  [-3 * MIN - 2 * S, '▸ Step 3 · Check the schematic still matches the board'],
  [-2 * MIN - 35 * S, '✓ parity: 62 of 62 nets match'],
  [-2 * MIN - 31 * S, '▸ Step 4 · Design rule check (JLCPCB 4-layer rules, updated 1 Nov)'],
  [-2 * MIN - 30 * S, 'drc: clearance, track width, annular ring, silkscreen over mask, courtyards'],
  [-1 * MIN - 53 * S, 'drc: 412 of 2,480 items checked'],
  [-1 * MIN - 12 * S, '⚠ silkscreen: R14 label overlaps solder mask opening by 0.06 mm (moved automatically)'],
  [-38 * S, 'drc: 980 of 2,480 items checked'],
  [-2 * S, 'drc: 1,204 of 2,480 items checked'],
]
/** what it says next, a line or two per read */
const MORE = [
  'drc: courtyards, U4 to C7 0.31 mm (rule 0.25 mm) ok',
  'drc: 1,388 of 2,480 items checked',
  'drc: annular ring, 212 vias ok',
  'drc: 1,640 of 2,480 items checked',
  'drc: track width, 3 V3 power traces 0.4 mm ok',
  'drc: 1,902 of 2,480 items checked',
  'drc: 2,210 of 2,480 items checked',
  'drc: 2,480 of 2,480 items checked',
  '✓ design rules: 0 errors, 1 fixed automatically',
  '▸ Step 5 · Make the fabrication files',
  'gerbers: 4 copper, 2 mask, 2 silk, edge cuts, drill',
  'bom: 31 lines, 118 parts, every part in stock at LCSC',
]

const FIRMWARE: [number, string][] = [
  [-72 * S, '▸ Step 1 · Get the firmware'],
  [-70 * S, 'Fetched motor-driver @ 3b9d2e1 (change #88)'],
  [-61 * S, '▸ Step 2 · Compile'],
  [-60 * S, 'cargo build --release --target thumbv7em-none-eabihf'],
  [-31 * S, 'Compiling 412 of 980 files'],
  [-1 * S, 'Compiling embassy-stm32 v0.2.0'],
]

const ROUTING: [number, string][] = [
  [-12 * MIN, '▸ Stage 1 of 2 · OrthoRoute on the dense core near U4'],
  [-11 * MIN - 40 * S, 'router: 62 nets, 48 already routed and locked'],
  [-8 * MIN, 'router: 54 of 62 nets routed'],
  [-70 * S, 'router: thinking about the 3 nets between U4 pins 12 to 16'],
]

const THERMAL: [number, string][] = [
  [-9 * MIN, '▸ thermal_simulation'],
  [-8 * MIN - 50 * S, 'Reading the enclosure (panel-controller.step)'],
  [-7 * MIN, 'Meshing the enclosure: 1.2 million cells'],
  [-4 * MIN, 'Meshing the enclosure: 2.6 million cells'],
]

const SIM: [number, string][] = [
  [-42 * S, '▸ transient_simulation'],
  [-41 * S, 'ngspice: probe circuit, power-on to 10 ms'],
  [-2 * S, 'ngspice: t = 6.2 ms of 10 ms, step 2.0 µs'],
]

const SCHEMATIC_DONE: [number, string][] = [
  [-6 * MIN, '▸ Step 1 · Get the design'],
  [-6 * MIN + 2 * S, 'Fetched soil-sensor @ 7c1e9a2 (change #13)'],
  [-6 * MIN + 6 * S, '▸ Step 2 · Electrical rules check'],
  [-5 * MIN - 30 * S, '✓ erc: 0 errors on 4 sheets'],
  [-5 * MIN - 12 * S, '✓ done in 48 s'],
]

interface MockRun { lines: [number, string][]; more: string[]; done: boolean; given: number; step: string | null; usualQuietS: number }
const RUNS: Record<string, MockRun> = {
  'check:5512': { lines: BOARD, more: MORE, done: false, given: 0, step: 'Design rule check', usualQuietS: 60 },
  'check:5513': { lines: FIRMWARE, more: ['Compiling 498 of 980 files', 'Compiling 560 of 980 files', 'Compiling 640 of 980 files'], done: false, given: 0, step: 'Compile', usualQuietS: 45 },
  'check:5510': { lines: SCHEMATIC_DONE, more: [], done: true, given: 0, step: null, usualQuietS: 60 },
  'check:5514': { lines: [], more: [], done: false, given: 0, step: null, usualQuietS: 60 },
  'check:7701': { lines: FIRMWARE, more: [], done: false, given: 0, step: 'Compile', usualQuietS: 45 },
  'job:job_route': { lines: ROUTING, more: [], done: false, given: 0, step: 'OrthoRoute on the dense core near U4', usualQuietS: 240 },
  'tool:t_thermal': { lines: THERMAL, more: [], done: false, given: 0, step: 'Meshing the enclosure', usualQuietS: 120 },
  'tool:t_sim': { lines: SIM, more: ['ngspice: t = 7.0 ms of 10 ms, step 2.0 µs', 'ngspice: t = 8.1 ms of 10 ms, step 2.0 µs'], done: false, given: 0, step: null, usualQuietS: 20 },
}

const asLine = ([ms, text]: [number, string]): LogLine => ({ at: at(ms), text, mark: markOf(text) })
function markOf(text: string): LogLine['mark'] {
  if (text.startsWith('▸')) return 'step'
  if (text.startsWith('✗') || /^error/i.test(text)) return 'error'
  if (text.startsWith('⚠')) return 'warn'
  if (text.startsWith('✓')) return 'ok'
  return null
}

/** One read: everything after the cursor, and a line or two more each time while it runs. */
function readLog(repo: string, run: string, after: string | null | undefined): RunLogResult {
  // any other job of the fixtures: a short log of its own, so Watch shows something believable
  if (!RUNS[run] && run.startsWith('job:')) RUNS[run] = { lines: [[-4 * MIN, '▸ Starting'], [-4 * MIN + 3 * S, `Picked up ${run.slice(4)}`], [-20 * S, 'Working through the plan, step by step']], more: ['Checked the result against the requirements'], done: false, given: 0, step: 'Working', usualQuietS: 120 }
  const r = RUNS[run]
  if (!r) return { repo, run, source: 'none', lines: [], next: null, done: true, heardAt: null, step: null, usualQuietS: 120, note: 'trace keeps no log for this run.' }
  if (run === 'check:5514') return { repo, run, source: 'none', lines: [], next: null, done: false, heardAt: null, step: null, usualQuietS: 60, note: 'It is waiting for a build machine.' }
  // grow: one or two new lines per read, at "now"
  if (!r.done && r.more.length) {
    const n = Math.random() < 0.5 ? 1 : 2
    for (const text of r.more.splice(0, n)) r.lines = [...r.lines, [Date.now() - T0, text]]
  }
  const from = after ? Number(after) || 0 : 0
  const lines = r.lines.slice(from).map(asLine)
  const last = r.lines.at(-1)
  return {
    repo, run, source: 'cloudwatch',
    lines, next: String(r.lines.length), done: r.done, heardAt: last ? at(last[0]) : null, step: r.step, usualQuietS: r.usualQuietS,
    cloudwatch: 'https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups',
  }
}

// ------------------------------------------------------------------ change.runs

const steps = (names: string[], running: number, base: number, each: number[]): CheckJob['steps'] =>
  names.map((name, i) => ({
    name,
    state: i < running ? 'passed' : i === running ? 'running' : 'queued',
    startedAt: i <= running ? at(base + each.slice(0, i).reduce((a, b) => a + b, 0)) : null,
    completedAt: i < running ? at(base + each.slice(0, i + 1).reduce((a, b) => a + b, 0)) : null,
  }))

function changeRuns(repo: string, number: number): CheckJob[] {
  if (repo === 'acme/soil-sensor' && number === 13) {
    const newest = (run: string) => { const r = RUNS[run]!; const l = r.lines.at(-1); return { heardAt: l ? at(l[0]) : null, newest: l ? l[1] : null } }
    return [
      {
        id: 5512, run: 'check:5512', name: 'Board checks', workflow: 'trace checks', state: 'running', startedAt: at(-3 * MIN - 31 * S), completedAt: null,
        steps: steps(['Get the design', 'Load the board', 'Check the schematic still matches the board', 'Design rule check', 'Make the fabrication files', 'Check the parts are in stock', 'Render the board', 'Compare with the last release', 'Record the result'], 3, -3 * MIN - 31 * S, [6 * S, 20 * S, 27 * S]),
        step: "Checking the routed board against JLCPCB's design rules", stepIndex: 4, stepCount: 9, typicalS: 6 * 60, queuedS: null,
        ...newest('check:5512'), usualQuietS: 60, runner: 'aws',
      },
      {
        id: 5513, run: 'check:5513', name: 'Firmware build', workflow: 'trace checks', state: 'running', startedAt: at(-72 * S), completedAt: null,
        steps: steps(['Get the firmware', 'Compile', 'Run the unit tests', 'Check the size fits', 'Record the result'], 1, -72 * S, [11 * S]),
        step: 'Compiling the firmware: 412 of 980 files', stepIndex: 2, stepCount: 5, typicalS: 3 * 60, queuedS: null,
        ...newest('check:5513'), usualQuietS: 45, runner: 'aws',
      },
      {
        id: 5514, run: 'check:5514', name: 'Simulation', workflow: 'trace checks', state: 'queued', startedAt: null, completedAt: null,
        steps: [], step: null, stepIndex: null, stepCount: 0, typicalS: 4 * 60, queuedS: Math.round((Date.now() - T0) / 1000) + 40,
        heardAt: null, newest: null, usualQuietS: 60, runner: null,
      },
      {
        id: 5510, run: 'check:5510', name: 'Schematic checks', workflow: 'trace checks', state: 'passed', startedAt: at(-6 * MIN), completedAt: at(-6 * MIN + 48 * S),
        steps: [{ name: 'Get the design', state: 'passed', startedAt: at(-6 * MIN), completedAt: at(-6 * MIN + 6 * S) }, { name: 'Electrical rules check', state: 'passed', startedAt: at(-6 * MIN + 6 * S), completedAt: at(-6 * MIN + 48 * S) }],
        step: null, stepIndex: null, stepCount: 2, typicalS: 50, queuedS: null, heardAt: at(-5 * MIN - 12 * S), newest: '✓ done in 48 s', usualQuietS: 60, runner: 'aws',
      },
    ]
  }
  return []
}

// ------------------------------------------------------------------ activity.list

function activity(): ActivityItem[] {
  const heard = (run: string) => { const l = RUNS[run]?.lines.at(-1); return { heardAt: l ? at(l[0]) : null, newest: l ? l[1] : null } }
  return [
    { kind: 'check', repo: 'acme/soil-sensor', run: 'check:5512', title: 'Board checks', change: 13, state: 'running', step: 'Design rule check, 1,204 of 2,480 items', stepIndex: 4, stepCount: 9, startedAt: at(-3 * MIN - 31 * S), typicalS: 360, ...heard('check:5512'), usualQuietS: 60 },
    { kind: 'check', repo: 'acme/motor-driver', run: 'check:7701', title: 'Firmware build', change: 88, state: 'running', step: 'Compiling, 412 of 980 files', stepIndex: 2, stepCount: 5, startedAt: at(-72 * S), typicalS: 180, heardAt: nowIso(), newest: 'Compiling embassy-stm32 v0.2.0', usualQuietS: 45 },
    { kind: 'job', repo: 'acme/soil-sensor', run: 'job:job_route', title: 'Routing the board', state: 'running', step: 'Stage 1 of 2: OrthoRoute on the dense core near U4', stepIndex: null, stepCount: null, startedAt: at(-12 * MIN), typicalS: 20 * 60, ...heard('job:job_route'), usualQuietS: 240, overdueAt: at(10 * MIN), lostAt: at(25 * MIN) },
    { kind: 'tool', repo: 'acme/panel-controller', run: 'tool:t_thermal', title: 'Thermal simulation', state: 'running', step: 'Meshing the enclosure', stepIndex: null, stepCount: null, startedAt: at(-9 * MIN), typicalS: 5 * 60, ...heard('tool:t_thermal'), usualQuietS: 120, overdueAt: at(-1 * MIN), lostAt: at(11 * MIN) },
  ]
}

/** run.log, change.runs and activity.list; undefined for any other action. */
export function progressAction(name: string, a: Record<string, unknown>): Response | undefined {
  switch (name) {
    case 'run.log': return ok(readLog(String(a.repo), String(a.run), a.after as string | null | undefined))
    case 'change.runs': return ok({ repo: a.repo, number: a.number, sha: '7c1e9a2', jobs: changeRuns(String(a.repo), Number(a.number)), updatedAt: nowIso() })
    case 'activity.list': return ok({ items: activity(), waits: 0, updatedAt: nowIso() })
    default: return undefined
  }
}
