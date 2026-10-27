/**
 * `tracectl prompts …`: the prompt catalog and its overrides, for people.
 *
 *   tracectl prompts list [--json]                          every prompt id: editable or locked, and where its text
 *                                                        comes from now (default, installation or project, vN)
 *   tracectl prompts get ID [--json]                        its default, installation and project text, the effective
 *                                                        text and the locked parts that always follow it
 *   tracectl prompts set ID --reason "why" [--file F]       override it (the text from --file, else stdin)
 *   tracectl prompts reset ID [--reason "why"]              back to the layer below
 *   tracectl prompts revert ID VERSION [--reason "why"]     back to an earlier version (a number or a history uid)
 *   tracectl prompts history ID [--json]                    every change in that layer
 *   tracectl prompts diff ID [FROM [TO]]                    FROM and TO: default, effective, or a version (vN or a
 *                                                        uid); by default the default against the effective text
 *   tracectl prompts preview TARGET [--marked] [--json] [--request "…"]
 *                                                        a whole prompt as the model gets it: a specialist kind,
 *                                                        a prompt's name (worker.task, router, …) or an id
 *
 * Locally (`tracectl prompts`) the project layer is this clone's .trace/project.db (commit it: .trace/** is a protected
 * path, so its pull request waits for a person) and --installation works on the installation's store with your own
 * credentials (TRACE_HOME's sibling `prompts`, or TRACE_PROMPTS_HOME). Through the API (`tracectl remote prompts …
 * [--repo OWNER/REPO]`, src/login/prompts.ts) the same commands run as the API's prompts.* actions.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { load } from '../core/config.js'
import { findRoot, projectPath } from '../core/store.js'
import { readProjectNotes, readRules } from '../agents/rules.js'
import { entry } from './catalog.js'
import type { Layers } from './resolve.js'
import { type HistoryEntry, InstallationPrompts, PromptError, type PromptWrite, diffLines, findVersion, loadLayers, localUser, projectHistory, writeProject } from './store.js'
import { TemplateError } from './template.js'
import { getView, listView, preview } from './views.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

export type Scope = 'installation' | 'project'

/** What the commands need of a place prompts live: local (the clone and the store) or the API. */
export interface PromptBackend {
  list(): Promise<unknown>
  get(id: string): Promise<unknown>
  write(scope: Scope, w: PromptWrite): Promise<unknown>
  history(scope: Scope, id: string): Promise<unknown>
  preview(target: string, request?: string): Promise<unknown>
}

const Row = z.object({ id: z.string(), mode: z.string(), layer: z.string(), version: z.number().nullable(), description: z.string() }).loose()
const Problem = z.object({ id: z.string(), layer: z.string(), version: z.number(), reason: z.string() }).loose()
const ListResult = z.object({ prompts: z.array(Row), problems: z.array(Problem).default([]), unavailable: z.array(z.object({ layer: z.string(), reason: z.string() }).loose()).nullish() }).loose()
const Over = z.object({ text: z.string().nullable(), version: z.number(), updated: z.string(), by: z.string().nullable() }).loose().nullable()
const GetResult = z.object({
  id: z.string(), mode: z.string(), description: z.string(), default: z.string(), installation: Over, project: Over,
  effective: z.object({ layer: z.string(), version: z.number().nullable(), text: z.string() }).loose(), composed: z.string(),
  vars: z.record(z.string(), z.object({ type: z.string(), description: z.string() }).loose()),
}).loose()
const History = z.object({ history: z.array(z.object({ uid: z.string(), version: z.number(), action: z.string(), text: z.string().nullable(), by: z.string().nullable(), at: z.union([z.string(), z.number()]), reason: z.string().nullable() }).loose()) }).loose()
const Preview = z.object({ text: z.string(), marked: z.string() }).loose()
const Written = z.object({ version: z.number(), uid: z.string(), action: z.string(), branch: z.string().optional(), commit: z.string().optional() }).loose()

export const PROMPTS_USAGE = 'usage: tracectl prompts list | get ID | set ID --reason "why" [--file F] | reset ID [--reason "why"] | revert ID VERSION [--reason "why"] | history ID | diff ID [FROM [TO]] | preview TARGET [--marked] [--request "…"]  (--installation: the installation\'s store; --json)'

const show = (v: unknown): void => out(JSON.stringify(v, null, 2))

function readText(file: string | undefined): string {
  return file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
}

/** The commands, on a backend. Returns the exit code; refusals (a bad variable, a locked id, no access) are printed. */
export async function runPrompts(argv: string[], b: PromptBackend, usage = PROMPTS_USAGE): Promise<number> {
  const [sub, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      json: { type: 'boolean' }, file: { type: 'string' }, reason: { type: 'string' }, installation: { type: 'boolean' },
      marked: { type: 'boolean' }, request: { type: 'string' }, repo: { type: 'string' }, scope: { type: 'string' },
    },
  })
  const scope: Scope = values.installation || values.scope === 'installation' ? 'installation' : 'project'
  const [id, a, c] = positionals
  const by = localUser()
  try {
    switch (sub) {
      case 'list': {
        const r = ListResult.parse(await b.list())
        if (values.json) { show(r); return 0 }
        for (const p of r.prompts) out(`${p.id.padEnd(34)} ${p.mode.padEnd(8)} ${p.layer}${p.version === null ? '' : ` v${p.version}`}`)
        for (const u of r.unavailable ?? []) err(`note: the ${u.layer} overrides could not be read: ${u.reason}`)
        for (const p of r.problems) err(`not used: ${p.layer} override v${p.version} of ${p.id}: ${p.reason}`)
        return 0
      }
      case 'get': {
        if (!id) break
        const r = GetResult.parse(await b.get(id))
        if (values.json) { show(r); return 0 }
        out(`${r.id} (${r.mode}): ${r.description}`)
        out(`variables: ${Object.entries(r.vars).map(([k, v]) => `{{${k}}} (${v.type})`).join(', ') || '(none)'}`)
        out(`installation: ${r.installation?.text != null ? `v${r.installation.version} by ${r.installation.by ?? '?'} at ${r.installation.updated}` : '(none)'}`)
        out(`project: ${r.project?.text != null ? `v${r.project.version} by ${r.project.by ?? '?'} at ${r.project.updated}` : '(none)'}`)
        out(`\n${r.composed}`)
        return 0
      }
      case 'set': {
        if (!id) break
        if (!values.reason) { err('tracectl prompts set: give --reason "why"'); return 2 }
        const text = readText(values.file)
        report(Written.parse(await b.write(scope, { op: 'set', id, text, reason: values.reason, by })), scope, id)
        return 0
      }
      case 'reset': {
        if (!id) break
        report(Written.parse(await b.write(scope, { op: 'reset', id, reason: values.reason ?? 'reset to the layer below', by })), scope, id)
        return 0
      }
      case 'revert': {
        if (!id || !a) break
        report(Written.parse(await b.write(scope, { op: 'revert', id, to: a, reason: values.reason, by })), scope, id)
        return 0
      }
      case 'history': {
        if (!id) break
        const r = History.parse(await b.history(scope, id))
        if (values.json) { show(r); return 0 }
        if (!r.history.length) out(`(no changes to ${id} in the ${scope} layer)`)
        for (const h of r.history) {
          const at = typeof h.at === 'number' ? new Date(h.at * 1000).toISOString() : h.at
          out(`v${String(h.version).padEnd(3)} ${h.uid}  ${at.slice(0, 16).replace('T', ' ')}  ${h.action.padEnd(6)} ${(h.by ?? '?').padEnd(16)} ${h.reason ?? ''}`)
        }
        return 0
      }
      case 'diff': {
        if (!id) break
        const g = GetResult.parse(await b.get(id))
        const needsHistory = [a, c].some((x) => x !== undefined && x !== 'default' && x !== 'effective')
        const history = needsHistory ? History.parse(await b.history(scope, id)).history as unknown as HistoryEntry[] : []
        const textOf = (w: string | undefined, fallback: 'default' | 'effective'): { label: string; text: string } => {
          const which = w ?? fallback
          if (which === 'default') return { label: 'default', text: g.default }
          if (which === 'effective') return { label: `effective (${g.effective.layer}${g.effective.version === null ? '' : ` v${g.effective.version}`})`, text: g.effective.text }
          const h = findVersion(history, which)
          return { label: `${scope} v${h.version} (${h.uid}${h.action === 'reset' ? ', a reset' : ''})`, text: h.text ?? g.default }
        }
        const from = textOf(a, 'default')
        const to = textOf(c, 'effective')
        out(`--- ${from.label}\n+++ ${to.label}`)
        out(diffLines(from.text, to.text))
        return 0
      }
      case 'preview': {
        if (!id) break
        const r = Preview.parse(await b.preview(id, values.request))
        if (values.json) { show(r); return 0 }
        out(values.marked ? r.marked : r.text)
        return 0
      }
    }
  } catch (e) {
    if (e instanceof TemplateError || e instanceof PromptError) { err(`trace: ${e.message}`); return 1 }
    if (e instanceof z.ZodError) { err(`trace: ${e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`); return 2 }
    throw e
  }
  err(usage)
  return 2
}

function report(w: z.infer<typeof Written>, scope: Scope, id: string): void {
  if (w.branch) out(`${id}: ${w.action} as project v${w.version} (${w.uid}), committed to ${w.branch} (${(w.commit ?? '').slice(0, 12)}); its pull request waits for a person.`)
  else if (scope === 'project') out(`${id}: ${w.action} as project v${w.version} (${w.uid}) in ${projectPath()}. Commit .trace/project.db; .trace/** is a protected path, so its pull request waits for a person.`)
  else out(`${id}: ${w.action} as installation v${w.version} (${w.uid}). Jobs that start from now on use it.`)
}

// ------------------------------------------------------------------ local

/** The layers here: this clone's .trace/project.db and the installation's store (when it can be read). */
export async function localLayers(installation = new InstallationPrompts()): Promise<Layers> {
  return loadLayers({ projectDb: projectPath(), installation })
}

export function localBackend(installation = new InstallationPrompts()): PromptBackend {
  return {
    list: async () => listView(await localLayers(installation)),
    get: async (id) => { entry(id); return getView(id, await localLayers(installation)) },
    write: async (scope, w) => (scope === 'installation' ? installation.write(w) : writeProject(w)),
    history: async (scope, id) => ({ history: scope === 'installation' ? await installation.history(id) : projectHistory(projectPath(), id) }),
    preview: async (target, request) => {
      const root = findRoot()
      const cfg = load(undefined, { strict: false })
      const p = preview({
        target, cfg, repository: repositoryHere(), rules: root ? readRules(root) : null, notes: root ? readProjectNotes(root) : null,
        layers: await localLayers(installation), ...(request ? { job: { kind: 'task' as const, request } } : {}),
      })
      return { text: p.composed.text, marked: p.marked, parts: p.composed.parts.map(({ text: _t, ...x }) => x) }
    },
  }
}

function repositoryHere(): string {
  return process.env.GITHUB_REPOSITORY || process.env.TRACE_MEMORY_REPOSITORY || 'OWNER/REPO'
}

export async function cmdPrompts(argv: string[]): Promise<number> {
  return runPrompts(argv, localBackend())
}
