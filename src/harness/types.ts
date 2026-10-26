/**
 * The harness's view of a GitHub Actions run: the Octokit client(s), the event, the job's output functions, and the
 * project's settings. The event payload is parsed with zod into exactly the fields the harness reads, so nothing
 * downstream touches an untyped webhook body.
 */
import type { Octokit } from '@octokit/rest'
import { z } from 'zod'
import type { Layers } from '../prompts/resolve.js'
import type { TraceConfig } from '../core/config.js'

export type GitHub = Octokit

export interface Core {
  info(message: string): void
  warning(message: string): void
  setFailed(message: string): void
  setOutput(name: string, value: string): void
  summary: { addRaw(text: string): { write(): Promise<unknown> } }
}

export interface Context {
  repo: { owner: string; repo: string }
  serverUrl: string
  runId: number
  eventName: string
  ref: string
  sha: string
  actor: string
  payload: Record<string, unknown>
}

/** Values a workflow step passes in (action inputs → environment). */
export interface TaskEnv {
  OWN_TOKEN?: string
  ITEM?: string
  /** worker-prompt/worker-dispatch: the specialist to use instead of the item's route. */
  AGENT?: string
  SHA?: string
  ISSUE?: string
  BY?: string
  STATUS?: string
  GUARD?: string
  HELD?: string
  ROLLBACK?: string
  REASONS?: string
  TRIGGERING_ACTOR?: string
  /** The login the agents act as (TRACE_AGENT_LOGIN): never an approver; its markers are trusted. */
  AGENT_LOGIN?: string
}

export interface Deps {
  github: GitHub
  /** The job's own GITHUB_TOKEN client (the Checks API, and the fallback when TRACE_TOKEN is rejected). */
  jobApi: GitHub
  context: Context
  core: Core
  cfg: TraceConfig
  env: TaskEnv
  /** The prompt overrides in force (src/prompts): the default branch's project overrides and the installation's. */
  prompts?: Layers | undefined
}

// ------------------------------------------------------------------ the payload fields the harness reads

const Label = z.union([z.string(), z.object({ name: z.string() }).loose()])
export type LabelLike = string | { readonly name?: string | undefined }
export const labelNames = (labels: readonly LabelLike[] | undefined): string[] =>
  (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean)

export const PullRequestPayload = z.object({
  number: z.number(),
  node_id: z.string(),
  draft: z.boolean().optional().default(false),
  base: z.object({ ref: z.string() }).loose(),
  head: z.object({ sha: z.string() }).loose(),
  labels: z.array(Label).default([]),
}).loose()

export const WorkflowRunPayload = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  run_number: z.number(),
  run_attempt: z.number().default(1),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  event: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  pull_requests: z.array(z.object({ number: z.number(), base: z.object({ repo: z.object({ name: z.string() }).loose() }).loose() }).loose()).default([]),
}).loose()
export type WorkflowRun = z.infer<typeof WorkflowRunPayload>

export const IssueCommentPayload = z.object({
  issue: z.object({
    number: z.number(),
    state: z.string(),
    labels: z.array(Label).default([]),
    pull_request: z.unknown().optional(),
  }).loose(),
  comment: z.object({ body: z.string().default(''), user: z.object({ login: z.string(), type: z.string().optional() }).loose() }).loose(),
}).loose()

export const ActorPayload = z.object({ sender: z.object({ type: z.string().optional() }).loose().optional() }).loose()

export function payload<S extends z.ZodType>(context: Context, key: string | null, schema: S): z.output<S> | null {
  const raw = key === null ? context.payload : context.payload[key]
  const r = schema.safeParse(raw)
  return r.success ? r.data : null
}

export const short = (sha: string | null | undefined): string => (sha ?? '').slice(0, 12)

export function errorStatus(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number'
    ? (e as { status: number }).status
    : undefined
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
