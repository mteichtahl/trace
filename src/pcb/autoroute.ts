/**
 * pcb.autoroute: route a KiCad board with OrthoRoute (GPU), Freerouting (CPU), or both in turn.
 *
 *   plan     planRoute (./plan.ts) finds the board's complex core (area arrays, buses, backplane fans) and picks the
 *            stages; the plan is part of the answer, so the decision can be read and overridden (engine, include/exclude)
 *   stage 1  OrthoRoute on the core nets: the .ORP is written here (./orp.ts), the router runs through runJob
 *            (kind orthoroute, gpu: true → the GPU queue when this machine has no GPU), and its .ORS is vetted and
 *            written into a copy of the board, locked (./ors.ts). Nets it could not route cleanly fall to stage 2.
 *   stage 2  Freerouting on the rest: python/kicad/autoroute.py, run with KiCad's Python through runJob (kind
 *            freerouting, gpu: true — it lands on the same GPU job host, where it uses the many CPU cores; Freerouting
 *            itself never touches the GPU), exports the DSN with the locked copper as fixed wiring, routes, imports the
 *            SES. Then the locked copper is checked to be exactly where stage 1 put it.
 *   check    DRC by KiCad on the result (zones refilled, the project's rules), and the per-stage report.
 *
 * Every stage is a separate job, so `engine: orthoroute` or `engine: freerouting` re-runs one alone (stage 2 on a
 * board that already holds locked copper respects it the same way). The input board is never written unless
 * in_place is set.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError } from '../core/registry.js'
import { scratchDir } from '../core/store.js'
import { backendFor, localGpu, runJob, type JobResult } from '../gpu/jobs.js'
import { drc, type CheckReport } from '../kicad/checks.js'
import { designRules, Net, parseBoard, type Board } from '../kicad/pcb.js'
import { candidates, needPcb, relTo, resolveProject, type Project } from '../kicad/project.js'
import { recorded, type RunHandle } from '../kicad/record.js'
import { dsnWiring, lockedChanges, lockedItems } from './locked.js'
import { applyOrs, readOrs } from './ors.js'
import { buildOrp, encodeOrp, type OrpRules } from './orp.js'
import { DEFAULT_AUTOROUTE, planRoute, type AutorouteSettings, type Engine, type RoutePlan } from './plan.js'

const PY = join(import.meta.dirname, '..', '..', 'python')
export const FREEROUTING_SCRIPT = join(PY, 'kicad', 'autoroute.py')
export const ORTHOROUTE_SCRIPT = join(PY, 'orthoroute', 'route.py')

/** The Python that runs a job's script: this machine's (env) when the job runs here, the GPU image's otherwise. */
export function pythonFor(kind: 'kicad' | 'orthoroute'): string {
  const local = backendFor({ gpu: true }) === 'local'
  if (kind === 'kicad') return local ? process.env.TRACE_KICAD_PYTHON ?? 'python3' : 'python3'
  return local ? process.env.TRACE_ORTHOROUTE_PYTHON ?? 'python3' : '/opt/orthoroute/venv/bin/python'
}

export function gpuBackend(): { available: boolean; how: string } {
  if (localGpu()) return { available: true, how: 'a GPU on this machine' }
  if (process.env.TRACE_GPU_QUEUE && process.env.TRACE_GPU_REMOTE !== 'never') return { available: true, how: `the AWS Batch GPU queue ${process.env.TRACE_GPU_QUEUE}` }
  return { available: false, how: 'no GPU here and TRACE_GPU_QUEUE is not set' }
}

/** The board's default net-class rules from its .kicad_pro (mm), with KiCad's own defaults. */
export function defaultRules(board: Board, pro: string | null): OrpRules {
  const dr = designRules(board, pro)
  const d = dr.net_classes?.find((c) => c.name === 'Default') ?? dr.net_classes?.[0] ?? {}
  const n = (k: string, v: number): number => (typeof d[k] === 'number' && (d[k] as number) > 0 ? (d[k] as number) : v)
  return { track_width: n('track_width', 0.2), clearance: n('clearance', 0.2), via_diameter: n('via_diameter', 0.6), via_drill: n('via_drill', 0.3) }
}

/** Nets with pads that tracks and vias do not join (nets with a pour are skipped: the pour joins them). */
export function unroutedNets(b: Board, skip: ReadonlySet<string> = new Set()): string[] {
  const poured = new Set(b.zones.filter((z) => z.copper && !z.keepout && z.net).map((z) => z.net as string))
  return Object.keys(b.pads).filter((n) => !skip.has(n) && !poured.has(n) && (b.pads[n]?.length ?? 0) >= 2 && new Net(b, n).unreached().length > 0).sort()
}

/** Copy a board with its project file (and custom rules) into a folder, as `stem`.*, so KiCad applies its rules. */
function stage(dir: string, stem: string, pcbText: string, p: Project): string {
  mkdirSync(dir, { recursive: true })
  const pcb = join(dir, `${stem}.kicad_pcb`)
  writeFileSync(pcb, pcbText)
  if (p.pro) copyFileSync(p.pro, join(dir, `${stem}.kicad_pro`))
  const dru = p.pro?.replace(/\.kicad_pro$/, '.kicad_dru')
  if (dru && existsSync(dru)) copyFileSync(dru, join(dir, `${stem}.kicad_dru`))
  return pcb
}

const tail = (s: string, n = 1500): string => s.trim().slice(-n)

/** Remove a finished job's local folder (runLocal's and runBatch's are fresh scratch folders holding out/). */
function cleanup(r: JobResult): void {
  const any = Object.values(r.outputs)[0]
  if (!any) return
  const dir = dirname(dirname(any))
  if (/^(trace|gpu)-/.test(basename(dir))) rmSync(dir, { recursive: true, force: true })
}

function readReport(r: JobResult, what: string): Record<string, unknown> {
  const f = r.outputs['report.json']
  if (!f) throw new ToolError(`${what} wrote no report (exit ${r.exitCode}, ${r.where}): ${tail(r.stderr || r.stdout)}`)
  const rep = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
  if (rep.ok !== true) throw new ToolError(`${what} failed (${r.where}${r.jobId ? ` job ${r.jobId}` : ''}): ${String(rep.error ?? `exit ${r.exitCode}`)}\n${tail(r.stderr || r.stdout, 800)}`)
  return rep
}

const where = (r: JobResult): Record<string, unknown> => ({ where: r.where, ...(r.jobId ? { job_id: r.jobId } : {}), job_seconds: Math.round(r.seconds * 10) / 10 })

const input = z.object({
  project: z.string().optional().describe('the board: a .kicad_pcb, .kicad_pro or project folder; omit for the configured/only project'),
  output: z.string().optional().describe('where the routed board goes (default <name>.routed.kicad_pcb beside the board)'),
  in_place: z.boolean().default(false).describe('write the routed board over the input (only when asked)'),
  engine: z.enum(['auto', 'orthoroute', 'freerouting', 'both']).default('auto')
    .describe('auto: decided from the board (see the plan in the answer); orthoroute or freerouting re-run one stage alone; both forces the two stages'),
  plan_only: z.boolean().default(false).describe('only return the plan: what would be routed by which router, and why'),
  include_nets: z.array(z.string()).optional().describe('nets OrthoRoute must route (added to the detected core; replaces electronics.autoroute.include_nets)'),
  exclude_nets: z.array(z.string()).optional().describe('nets OrthoRoute must not route (replaces electronics.autoroute.exclude_nets)'),
  ignore_nets: z.array(z.string()).default([]).describe('nets Freerouting leaves alone, e.g. GND when a pour connects it'),
  passes: z.number().int().min(1).max(10_000).optional().describe('Freerouting passes (default electronics.autoroute.freerouting_passes, 100)'),
  iterations: z.number().int().min(1).max(10_000).optional().describe('OrthoRoute iterations (default electronics.autoroute.orthoroute_iterations, 200)'),
  threads: z.number().int().min(0).max(512).default(0).describe('Freerouting optimizer threads (0: its default, cores − 1)'),
  max_seconds: z.number().int().min(30).max(8 * 3600 - 600).default(3600).describe('time limit of each stage'),
  drc: z.boolean().default(true).describe('run KiCad DRC on the result (zones refilled)'),
})

export const autoroute = defineTool({
  name: 'pcb.autoroute',
  description: 'Autoroute a KiCad board. OrthoRoute (a CUDA GPU lattice router, for BGA escapes, dense buses and backplane fans; '
    + 'not a general-purpose router) routes the board\'s complex core when a GPU is reachable, and Freerouting (CPU, '
    + 'push-and-shove) routes the rest around it; engine auto decides from the board and the answer shows the plan. Both run '
    + 'as jobs that go to the AWS Batch GPU queue when this machine has no GPU (Freerouting there uses the host\'s CPU cores, '
    + 'not the GPU). Writes <name>.routed.kicad_pcb (never the input unless in_place), then reports per stage (nets attempted/'
    + 'routed/failed, time, where it ran), the unrouted count and KiCad DRC. Slow: minutes to hours.',
  input,
  run: async (a) => {
    const p = await resolveProject(a.project)
    const pcb = needPcb(p)
    const { root } = await candidates()
    let settings: AutorouteSettings & { blind_buried_vias: boolean; orthoroute_iterations: number; freerouting_passes: number }
      = { ...DEFAULT_AUTOROUTE, blind_buried_vias: false, orthoroute_iterations: 200, freerouting_passes: 100 }
    try {
      const { load } = await import('../core/config.js')
      settings = { ...settings, ...load(root ?? undefined, { strict: false }).electronics.autoroute }
    } catch {
      // no project settings: the defaults
    }
    if (a.include_nets) settings.include_nets = a.include_nets
    if (a.exclude_nets) settings.exclude_nets = a.exclude_nets
    const board = parseBoard(pcb)
    const plan: RoutePlan = planRoute(board, { engine: a.engine as Engine, gpu: gpuBackend(), settings })
    if (a.plan_only) return { project: p.name, board: relTo(root, pcb), plan }

    const out = a.in_place ? pcb : resolve(a.output ? resolve(root ?? process.cwd(), a.output) : join(dirname(pcb), `${p.name}.routed.kicad_pcb`))
    if (!out.endsWith('.kicad_pcb')) throw new ToolError(`output must be a .kicad_pcb file: ${out}`)
    if (out === pcb && !a.in_place) throw new ToolError('output is the input board: pass in_place: true to overwrite it')

    return recorded('pcb.autoroute', pcb, a, async (run: RunHandle) => {
      const work = scratchDir('trace-autoroute-')
      try {
        const t0 = Date.now()
        const rules = defaultRules(board, p.pro)
        let text = readFileSync(pcb, 'utf8')
        const stages: Record<string, unknown>[] = []
        run.artifact('plan.json', JSON.stringify(plan, null, 1), 'application/json')

        // ---------------------------------------------------------- stage 1: OrthoRoute
        if (plan.stages.includes('orthoroute')) {
          const nets = plan.core.nets
          if (!nets.length) throw new ToolError('OrthoRoute has no nets to route on this board')
          const orp = join(work, 'core.ORP')
          writeFileSync(orp, encodeOrp(buildOrp(board, { nets, rules, boardName: basename(pcb) })))
          const blind = settings.blind_buried_vias && board.layers.length >= 4
          const r = await runJob({
            kind: 'orthoroute', gpu: true, timeoutSeconds: a.max_seconds,
            argv: [pythonFor('orthoroute'), '{in:route.py}', '--orp', '{in:core.ORP}', '--ors', '{out:core.ORS}', '--report', '{out:report.json}',
              '--max-iterations', String(a.iterations ?? settings.orthoroute_iterations), ...(plan.orthoroute_cpu_only ? ['--cpu-only'] : []), ...(blind ? ['--blind-buried'] : [])],
            inputs: { 'route.py': ORTHOROUTE_SCRIPT, 'core.ORP': orp },
            outputs: ['core.ORS', 'report.json'],
          })
          run.artifact('orthoroute.log', tail(`${r.stdout}\n${r.stderr}`, 200_000))
          const rep = readReport(r, 'OrthoRoute')
          const ors = r.outputs['core.ORS']
          if (!ors) throw new ToolError('OrthoRoute reported success but wrote no solution')
          const sol = readOrs(readFileSync(ors), board.layers.map((l) => l.name))
          const applied = applyOrs(text, board, sol, { nets, blindBuried: blind, clearance: rules.clearance })
          text = applied.text
          run.measure('orthoroute.routed', applied.routed.length)
          run.measure('orthoroute.failed', applied.failed.length)
          stages.push({
            stage: 'orthoroute', ...where(r), device: rep.gpu ?? 'cpu', cpu_only: rep.cpu_only === true,
            nets_attempted: nets.length, nets_routed: applied.routed.length, nets_failed: applied.failed.length,
            failed: applied.failed.slice(0, 50), tracks: applied.tracks, vias: applied.vias, through_vias_from_blind: applied.through_from_blind,
            via_policy: blind ? 'blind/buried allowed' : 'through vias only', router_seconds: rep.seconds, iterations: sol.iterations,
            converged: sol.metadata.converged ?? null,
          })
          cleanup(r)
        }

        // ---------------------------------------------------------- stage 2: Freerouting
        let dsnInfo: ReturnType<typeof dsnWiring> | null = null
        if (plan.stages.includes('freerouting')) {
          const skip = new Set(a.ignore_nets)
          const s1 = stage(join(work, 's1'), 'board', text, p)
          const beforeBoard = parseBoard(s1)
          const attempted = unroutedNets(beforeBoard, skip)
          const lockedBefore = lockedItems(text)
          const inputs: Record<string, string> = { 'autoroute.py': FREEROUTING_SCRIPT, 'board.kicad_pcb': s1 }
          if (existsSync(join(work, 's1', 'board.kicad_pro'))) inputs['board.kicad_pro'] = join(work, 's1', 'board.kicad_pro')
          if (existsSync(join(work, 's1', 'board.kicad_dru'))) inputs['board.kicad_dru'] = join(work, 's1', 'board.kicad_dru')
          const r = await runJob({
            kind: 'freerouting', gpu: true, timeoutSeconds: a.max_seconds + 300,
            argv: [pythonFor('kicad'), '{in:autoroute.py}', '--board', '{in:board.kicad_pcb}', '--out', '{out:routed.kicad_pcb}',
              '--dsn', '{out:board.dsn}', '--ses', '{out:board.ses}', '--report', '{out:report.json}', '--work', '{dir}',
              '--passes', String(a.passes ?? settings.freerouting_passes), '--threads', String(a.threads), '--max-seconds', String(a.max_seconds),
              ...(a.ignore_nets.length ? ['--ignore-nets', a.ignore_nets.join(',')] : [])],
            inputs,
            outputs: ['routed.kicad_pcb', 'board.dsn', 'board.ses', 'report.json'],
          })
          run.artifact('freerouting.log', tail(`${r.stdout}\n${r.stderr}`, 200_000))
          const rep = readReport(r, 'Freerouting')
          const routedFile = r.outputs['routed.kicad_pcb']
          if (!routedFile) throw new ToolError('Freerouting reported success but no routed board came back')
          const routedText = readFileSync(routedFile, 'utf8')
          if (r.outputs['board.dsn']) {
            const dsn = readFileSync(r.outputs['board.dsn'], 'utf8')
            dsnInfo = dsnWiring(dsn)
            run.artifact('board.dsn', dsn)
          }
          if (r.outputs['board.ses']) run.artifact('board.ses', readFileSync(r.outputs['board.ses'], 'utf8'))
          const lost = lockedChanges(lockedBefore, lockedItems(routedText))
          if (lost.length) {
            throw new ToolError(`${lost.length} locked tracks/vias moved or vanished in the Freerouting round trip (first: ${lost.slice(0, 3).map((l) => l.key).join('; ')}); the result was not written`)
          }
          text = routedText
          const afterBoard = parseBoard(stage(join(work, 's2'), 'board', text, p))
          const still = new Set(unroutedNets(afterBoard, skip))
          stages.push({
            stage: 'freerouting', ...where(r), device: 'cpu',
            nets_attempted: attempted.length, nets_routed: attempted.filter((n) => !still.has(n)).length,
            nets_failed: attempted.filter((n) => still.has(n)).length, failed: attempted.filter((n) => still.has(n)).slice(0, 50),
            locked_kept: lockedBefore.length, dsn_wiring: dsnInfo, dsn_fixed: rep.dsn_fixed ?? null, ignored_nets: rep.ignored_nets ?? [],
            unknown_nets: rep.unknown_nets ?? [], router_seconds: rep.route_seconds, passes: a.passes ?? settings.freerouting_passes,
            before: rep.before, after: rep.after,
          })
          cleanup(r)
        }

        // ---------------------------------------------------------- result and DRC
        writeFileSync(out, text)
        run.artifact('routed.kicad_pcb', text)
        let drcOut: Record<string, unknown> | null = null
        let report: CheckReport | null = null
        if (a.drc) {
          const chk = stage(join(work, 'drc'), p.name, text, p)
          const [rpt, raw] = await drc(chk, { refillZones: true })
          report = rpt
          run.artifact('drc-report.json', raw, 'application/json')
          drcOut = { errors: rpt.errors, warnings: rpt.warnings, unconnected: rpt.unconnected ?? 0, by_type: Object.fromEntries(Object.entries(rpt.by_type).slice(0, 12)) }
          run.measure('drc.errors', rpt.errors)
          run.measure('unconnected', rpt.unconnected ?? 0)
        }
        const finalUnrouted = report ? report.unconnected ?? 0 : unroutedNets(parseBoard(stage(join(work, 'fin'), 'board', text, p)), new Set(a.ignore_nets)).length
        const seconds = Math.round((Date.now() - t0) / 100) / 10
        run.measure('seconds', seconds, 's')
        const ok = finalUnrouted === 0 && (report?.errors ?? 0) === 0
        return {
          status: ok ? 'pass' as const : 'fail' as const,
          summary: `${plan.stages.join(' → ')}: ${finalUnrouted} unrouted${report ? `, DRC ${report.errors} errors` : ''} (${seconds} s)`,
          result: {
            project: p.name, board: relTo(root, pcb), output: relTo(root, out), plan, stages,
            unrouted: finalUnrouted, unrouted_source: report ? 'KiCad DRC unconnected items, zones refilled' : 'tracks and vias only (no DRC)',
            drc: drcOut, seconds,
          },
        }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    })
  },
})

