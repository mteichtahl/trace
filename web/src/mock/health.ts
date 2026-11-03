/**
 * Mock answers for the build's health (docs/stay-in-trace.md "3. A broken build"): the Soil sensor's build fails at its
 * schematic check, trace is on its second try at a fix (the running job_v1), and two requests for a fix are open, one
 * of which trace gave up on. Every other project's build passes. health.log answers a long log for the failing job.
 * VITE_MOCK_HEALTH=passing makes every build pass. Registered in handlers.ts with one line.
 */
import type { HealthView } from '@/lib/types'
import { JOURNEYS } from './fixtures'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000

const TAIL = [
  'Run kicad-cli sch erc --severity-error --exit-code-violations hardware/soil-sensor.kicad_sch',
  'Running the electrical rules check on 4 sheets',
  'Power and USB-C input (power.kicad_sch)',
  '  [pin_not_connected]: Pin not connected',
  '    @(152.40 mm, 88.90 mm): Symbol U3 Pin 4 [EN, Input, Line]',
  '  [power_pin_not_driven]: Input power pin not driven by any output power pins',
  '    @(140.97 mm, 101.60 mm): Symbol U3 Pin 1 [VIN, Power input, Line]',
  'Found 2 violations',
  'Error: Process completed with exit code 5.',
].join('\n')

const FAILING: HealthView = {
  build: {
    state: 'failing', sha: '7f3e21a0c5d2b9e84f61a3c7d0e2b5f9a8c4d1e6', at: ago(34 * MIN),
    failing: [{ job_id: 31001, name: 'schematic', step: 'Check the schematic (ERC)', tail: TAIL }],
    why: 'trace looked at the failure: "schematic" failed at its step "Check the schematic (ERC)". It is a problem in the project itself, not in the machines that build it.',
    fixing: { job_id: 'job_v1', attempt: 2, of: 3 },
  },
  asks: [
    { number: 41, title: 'The power light is too bright on the bench', state: 'working', job_id: 'job_r1', opened_at: ago(3 * 60 * MIN) },
    { number: 38, title: 'Rename the sensor nets to match the firmware', state: 'stuck', job_id: null, opened_at: ago(2 * 24 * 60 * MIN) },
  ],
}

const passing = (): HealthView => ({ build: { state: 'passing', sha: 'a41c9e2000000000000000000000000000000000', at: ago(2 * 60 * MIN), failing: [], why: null, fixing: null }, asks: [] })

/** The full log of the failing job: setup, then the check's output, ending in its tail. */
const LOG = [
  ...Array.from({ length: 120 }, (_, i) => `Setting up the runner: step ${i + 1} of 120`),
  'Run actions/checkout@v7', 'Fetching the repository', 'Run kicad-cli version', '9.0.2', TAIL, 'Post job cleanup.',
].join('\n')

export function healthAction(name: string, a: Record<string, unknown>): Response | undefined {
  if (name !== 'health.get' && name !== 'health.log') return undefined
  const repo = String(a.repo ?? '')
  if (!JOURNEYS[repo]) return json({ ok: false, error: 'no access' }, 403)
  const fails = repo === 'acme/soil-sensor' && import.meta.env.VITE_MOCK_HEALTH !== 'passing'
  if (name === 'health.get') {
    return ok(fails ? FAILING : passing())
  }
  if (!fails || a.job_id !== 31001) return json({ ok: false, error: `${repo} has no build job ${String(a.job_id)}.` })
  return ok({ name: 'schematic', text: LOG, truncated: false })
}
