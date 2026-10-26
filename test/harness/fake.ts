/**
 * A fake GitHub for the harness tests: each REST call is answered by a handler keyed "namespace.method"
 * (e.g. "pulls.list"), and every call is recorded so a test can assert what the harness did.
 */
import type { TraceConfig } from '../../src/core/config.js'
import { resolve } from '../../src/core/config.js'
import type { Context, Core, Deps, GitHub, TaskEnv } from '../../src/harness/types.js'

export interface Call { key: string; args: Record<string, unknown> }
type Handler = unknown | ((args: Record<string, unknown>) => unknown)

export interface Fake { gh: GitHub; calls: Call[]; called(key: string): Call[] }

export function fakeGithub(handlers: Record<string, Handler> = {}): Fake {
  const calls: Call[] = []
  const answer = (key: string, args: Record<string, unknown>): { data: unknown } => {
    calls.push({ key, args })
    const h = handlers[key]
    if (h === undefined) return { data: {} }
    const out = typeof h === 'function' ? (h as (a: Record<string, unknown>) => unknown)(args) : h
    if (out instanceof Error) throw out
    return out && typeof out === 'object' && 'data' in out ? (out as { data: unknown }) : { data: out }
  }
  const rest = new Proxy({}, {
    get: (_t, ns) => new Proxy({}, {
      get: (_u, method) => async (args: Record<string, unknown>) => answer(`${String(ns)}.${String(method)}`, args ?? {}),
    }),
  })
  const gh = {
    rest,
    paginate: async (fn: (a: Record<string, unknown>) => Promise<{ data: unknown }>, args: Record<string, unknown>) => {
      const d = (await fn(args)).data as unknown
      if (Array.isArray(d)) return d
      const o = d as Record<string, unknown>
      return (o.items ?? o.workflow_runs ?? o.check_runs ?? []) as unknown[]
    },
    graphql: async (query: string, vars: Record<string, unknown>) => answer('graphql', { query, ...vars }).data,
    request: async (route: string, args: Record<string, unknown>) => answer(`request ${route}`, args),
  }
  return { gh: gh as unknown as GitHub, calls, called: (key) => calls.filter((c) => c.key === key) }
}

export interface FakeCore extends Core { outputs: Record<string, string>; infos: string[]; warnings: string[]; failed: string | null; text: string }

export function fakeCore(): FakeCore {
  const c: FakeCore = {
    outputs: {}, infos: [], warnings: [], failed: null, text: '',
    info: (s) => { c.infos.push(s) },
    warning: (s) => { c.warnings.push(s) },
    setFailed: (s) => { c.failed = s },
    setOutput: (k, v) => { c.outputs[k] = v },
    summary: { addRaw: (s) => { c.text += s; return { write: async () => undefined } } },
  }
  return c
}

export function context(extra: Partial<Context> = {}): Context {
  return {
    repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 99, eventName: 'push',
    ref: 'refs/heads/feature', sha: 'f'.repeat(40), actor: 'marc', payload: {}, ...extra,
  }
}

/** Settings as nested objects, flattened to the dotted keys the project database stores, then resolved. */
export function cfgOf(raw: Record<string, unknown> = {}): TraceConfig {
  const flat: Record<string, unknown> = {}
  const walk = (o: Record<string, unknown>, pre: string): void => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !['limits', 'env'].includes(k)) walk(v as Record<string, unknown>, `${pre}${k}.`)
      else flat[pre + k] = v
    }
  }
  walk(raw, '')
  const { config, errors } = resolve(flat)
  if (errors.length) throw new Error(errors.join('; '))
  return config
}

export function deps(f: Fake, core: FakeCore, cfg: TraceConfig, ctx: Context = context(), env: TaskEnv = {}, job?: Fake): Deps {
  return { github: f.gh, jobApi: (job ?? f).gh, context: ctx, core, cfg, env }
}

export const SHA = (c: string): string => c.repeat(40)
