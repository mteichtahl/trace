/**
 * What people see of the prompts (the API's prompts.* actions and `tracectl prompts`): the catalog with each id's
 * effective layer, one id in every layer, and a whole prompt composed with the overrides, its parts marked.
 */
import { z } from 'zod'
import type { TraceConfig } from '../core/config.js'
import { SPECIALISTS } from '../agents/index.js'
import { SPECIALIST_KINDS, type SpecialistKind, SpecialistKindSchema } from '../agents/kinds.js'
import { composeRendering } from '../agents/render/prompt.js'
import { composeDelegated } from '../agents/runtime/delegation.js'
import { composeClassification } from '../agents/router.js'
import { composeSpecialist } from '../agents/specialist.js'
import { composeTask } from '../agents/worker/prompt.js'
import { composeCloudWorker } from '../core/cloudworker.js'
import { composeCheck } from '../harness/actions.js'
import { WorkItemSchema, composeItem } from '../harness/worker.js'
import { CATALOG, COMPOSED, type ComposedName, entry } from './catalog.js'
import { type Composed, Composer, type Layers, type Override, type OverrideLayer, effective, marked, problems } from './resolve.js'
import { systemAppend } from './system.js'

export interface ListRow {
  id: string
  mode: 'editable' | 'locked'
  prompt: ComposedName
  description: string
  /** Where its text comes from now. */
  layer: 'default' | OverrideLayer
  version: number | null
}

/** Every catalog id with its effective layer, and the overrides that are not used (unknown ids, locked ids, bad templates). */
export function listView(layers: Layers): { prompts: ListRow[]; problems: ReturnType<typeof problems>; unavailable: Layers['unavailable'] } {
  const rows = [...CATALOG.values()].map((e): ListRow => {
    const p = effective(e.id, layers).provenance
    return { id: e.id, mode: e.mode, prompt: e.prompt, description: e.description, layer: p.layer, version: p.version }
  })
  return { prompts: rows, problems: problems(layers), unavailable: layers.unavailable }
}

const overrideView = (o: Override | undefined): { text: string | null; version: number; updated: string; by: string | null } | null =>
  (o ? { text: o.text, version: o.version, updated: new Date(o.updated * 1000).toISOString(), by: o.by } : null)

/**
 * One id: its default, its installation and project overrides, and its effective template, followed by the locked
 * parts the composer always puts after it (`then`), each marked.
 */
export function getView(id: string, layers: Layers) {
  const e = entry(id)
  const eff = effective(id, layers)
  const locked = (e.then ?? []).map((t) => ({ id: t, text: entry(t).default }))
  return {
    id, mode: e.mode, prompt: e.prompt, description: e.description,
    vars: Object.fromEntries(Object.entries(e.vars).map(([k, v]) => [k, { type: v.type, description: v.description }])),
    default: e.default,
    installation: overrideView(layers.installation?.get(id)),
    project: overrideView(layers.project?.get(id)),
    effective: { layer: eff.provenance.layer, version: eff.provenance.version, sha: eff.provenance.sha, text: eff.template, ...(eff.provenance.skipped ? { skipped: eff.provenance.skipped } : {}) },
    followed_by_locked: locked.map((l) => l.id),
    composed: [
      `[${e.mode} ${id} · ${eff.provenance.layer}${eff.provenance.version === null ? '' : ` v${eff.provenance.version}`}]`, eff.template,
      ...locked.flatMap((l) => ['', `[locked ${l.id}]`, l.text]),
    ].join('\n'),
  }
}

// ------------------------------------------------------------------ preview

/** What a preview may be given to stand for the job (else a placeholder). */
export const PreviewJob = z.union([
  z.object({ kind: z.literal('task'), request: z.string().min(1).max(20_000), requestedBy: z.string().max(320).optional(), issue: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('work-item'), item: WorkItemSchema }).strict(),
])
export type PreviewJob = z.infer<typeof PreviewJob>

/** A preview target: a specialist kind, a composed prompt's name, or a prompt id (its prompt is shown). */
export const PreviewTarget = z.string().min(1).max(200)

export interface PreviewInput {
  target: string
  cfg: TraceConfig
  repository: string
  rules: string | null
  notes?: string | null
  layers: Layers
  job?: PreviewJob | undefined
}

const SAMPLE_ITEM = { kind: 'ci-red' as const, number: 1, ref: 'claude/example', sha: '0'.repeat(40), own: true, title: '(the item\'s title)' }

/** The composed prompt a target stands for, with the overrides applied: what the model would be sent. */
export function preview(i: PreviewInput): { prompt: ComposedName; kind?: SpecialistKind; composed: Composed; marked: string } {
  const { cfg, repository, layers } = i
  let name: ComposedName
  let kind: SpecialistKind | undefined
  let itemKind: z.infer<typeof WorkItemSchema>['kind'] | undefined
  const k = SpecialistKindSchema.safeParse(i.target)
  if (k.success) { name = 'specialist'; kind = k.data } else if ((COMPOSED as readonly string[]).includes(i.target)) name = i.target as ComposedName
  else {
    const e = entry(i.target)
    name = e.prompt
    kind = SPECIALIST_KINDS.find((x) => e.id.startsWith(`specialist.${x}.`))
    itemKind = (['ci-red', 'conflict', 'agent-fix'] as const).find((x) => e.id === `worker.item.${x}`)
  }
  const item = i.job?.kind === 'work-item' ? i.job.item : { ...SAMPLE_ITEM, ...(itemKind ? { kind: itemKind } : {}) }
  const task = { repository, request: i.job?.kind === 'task' ? i.job.request : '(the request)', requestedBy: i.job?.kind === 'task' ? i.job.requestedBy ?? '(who asked)' : '(who asked)', ...(i.job?.kind === 'task' && i.job.issue ? { issue: i.job.issue } : {}) }
  const s = SPECIALISTS[kind ?? cfg.agents.default]
  const specialist = (delivery: 'delegate' | 'actions'): Composed => composeSpecialist(s, {
    cfg, repository, rules: i.rules, hardware: false, delivery, prompts: layers, ...(delivery === 'actions' ? { where: 'in GitHub Actions' } : {}),
    route: { kind: s.kind, reason: '(why the job was routed here)', confidence: 1, source: 'explicit' },
    job: i.job?.kind === 'task' ? { kind: 'task', request: task.request, requestedBy: task.requestedBy, issue: task.issue, branch: 'claude/task-preview' }
      : i.job?.kind === 'work-item' ? { kind: 'work-item', item: i.job.item } : { kind: 'preview' },
  })
  const brief = { brief: '(the specialist\'s brief)', acceptance: ['(an acceptance criterion)'] }
  let composed: Composed
  switch (name) {
    case 'specialist': composed = specialist('delegate'); break
    case 'worker.task': composed = composeTask(task, cfg, 'claude/task-preview', layers); break
    case 'worker.item': composed = composeItem(item, cfg, repository, undefined, { prompts: layers }); break
    case 'delegate': composed = composeDelegated(s.kind, 'job-preview', brief.brief, brief.acceptance, layers); break
    case 'actions.check': composed = composeCheck(specialist('actions'), brief, layers); break
    case 'router': composed = composeClassification({ text: task.request }, cfg, layers); break
    case 'memory': composed = new Composer(layers).add('memory.block', { legacy: '', items: ['- [fact] (a remembered item)'] }).done(); break
    case 'system': composed = systemAppend(i.notes ?? '(the default branch\'s CLAUDE.md)', layers); break
    case 'render': composed = composeRendering(task.request, cfg, layers); break
    case 'cloudworker': composed = composeCloudWorker([repository], layers); break
  }
  return { prompt: name, ...(kind ? { kind } : {}), composed, marked: marked(composed) }
}
