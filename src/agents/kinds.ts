/**
 * The specialist agents' names, with nothing else in this file: the settings schema (src/core/config.ts), the
 * harness bundle and the job schemas all need the list, and none of them may pull in the prompts or the Agent SDK.
 *
 *   verify   Verification: specs → requirements → test plan → simulation/formal runs → coverage closure
 *   impl     Implementation: floor planning, placement, routing and timing closure (FPGA and PCB)
 *   ams      Analog & Mixed-Signal: specs, corners, Monte Carlo yield, stability, noise, mixed-signal co-simulation
 *   emc      EMC & Simulation: rule prechecks, field-solver setup (boundaries, ports, mesh), runs, SI, spectra
 *   render   Renders of boards and models (the rendering agent, kept as a specialist of its own)
 *   thermal  Thermal: envelope, power budget, junction temperatures across corners, board models, measurements
 *
 * The generic worker (code changes, pushes, pull requests) is not in this list: it is started only by a specialist
 * through agent.delegate (src/agents/delegate.ts).
 */
import { z } from 'zod'

export const SPECIALIST_KINDS = ['verify', 'impl', 'ams', 'emc', 'render', 'thermal'] as const
export type SpecialistKind = (typeof SPECIALIST_KINDS)[number]
export const SpecialistKindSchema = z.enum(SPECIALIST_KINDS)

/** Each specialist in the words people read ("Asked by the Analog and mixed-signal specialist: …"). */
export const SPECIALIST_WORDS: Readonly<Record<SpecialistKind, string>> = {
  verify: 'Verification', impl: 'Implementation', ams: 'Analog and mixed-signal', emc: 'EMC', render: 'Rendering', thermal: 'Thermal',
}

/** How a job came to its specialist: an explicit request, a label, the evidence, keywords, the model, or the default. */
export const ROUTE_SOURCES = ['explicit', 'label', 'evidence', 'keyword', 'model', 'default'] as const
export type RouteSource = (typeof ROUTE_SOURCES)[number]

export const RouteSchema = z.object({
  kind: SpecialistKindSchema,
  /** One line a person can check: which label, check, file or words decided it. */
  reason: z.string().min(1).max(500),
  /** 0..1: 1 for an explicit kind or a label, lower the weaker the evidence. */
  confidence: z.number().min(0).max(1),
  source: z.enum(ROUTE_SOURCES),
}).strict()
export type Route = z.infer<typeof RouteSchema>

/** The memory agent of the delegated worker (its actor is `<owner>/<repo>/worker`). */
export const WORKER = 'worker'
