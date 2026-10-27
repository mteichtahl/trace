/**
 * `trace integrations`: the installation's optional integrations (src/core/integrations.ts), after installing.
 *
 *   trace integrations list                          which are configured, what each enables, where to get a key
 *   trace integrations set NAME [KEY=VALUE ...]      store one (keys not given are read from the environment, then
 *                                                    asked for); checked with the service first, never refused for it
 *   trace integrations check NAME                    check the stored credentials with the service
 *   trace integrations remove NAME                   delete its secret
 *
 * With your own AWS credentials (the default: the installation's region, the prefix from the installer's answers or
 * --prefix), or with --remote through the API as a signed-in admin (`trace login`).
 */
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { answers, installation } from '../core/client.js'
import {
  INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName, IntegrationNameSchema, IntegrationStore, type IntegrationStatus, checkIntegration, secretsManagerApi,
} from '../core/integrations.js'
import { ApiError, invokeApi } from './invoke.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

const USAGE = 'usage: trace integrations list | set NAME [KEY=VALUE ...] | check NAME | remove NAME   [--remote] [--prefix P] [--region R]'

/** The installation's prefix on this machine: --prefix, else the installer's saved answers, else trace. */
export function localPrefix(given?: string): string {
  if (given) return given
  const saved = answers().answers as { agents?: { prefix?: unknown } } | undefined
  return typeof saved?.agents?.prefix === 'string' && saved.agents.prefix ? saved.agents.prefix : 'trace'
}

/** KEY=VALUE arguments, then the environment, for the keys an integration takes. */
export function givenValues(name: IntegrationName, pairs: readonly string[], env: NodeJS.ProcessEnv = process.env): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i < 1) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(p.slice(0, 40))}`)
    values[p.slice(0, i)] = p.slice(i + 1)
  }
  for (const k of INTEGRATIONS[name].keys) if (!values[k] && env[k]) values[k] = env[k] ?? ''
  return { values, missing: INTEGRATIONS[name].keys.filter((k) => !values[k]) }
}

/** Ask for a value on the terminal without echoing it. */
async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question.trim()} is missing (pass it as KEY=VALUE or in the environment)`)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const w = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
  let asked = false
  w._writeToOutput = (s: string) => { if (!asked) { w.output.write(s); asked = true } }
  try {
    return await new Promise<string>((resolveP) => rl.question(question, (a) => resolveP(a.trim())))
  } finally {
    rl.close()
    process.stdout.write('\n')
  }
}

function show(list: readonly IntegrationStatus[]): void {
  for (const i of list) {
    out(`${i.configured ? 'set ' : '--  '} ${i.name.padEnd(8)} ${i.title}${i.changed ? ` (changed ${i.changed.slice(0, 10)})` : ''}`)
    out(`      ${i.enables}`)
    if (!i.configured) out(`      get one at ${i.url}, then: trace integrations set ${i.name}`)
  }
}

export async function cmdIntegrations(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    remote: { type: 'boolean' }, prefix: { type: 'string' }, region: { type: 'string' }, 'skip-check': { type: 'boolean' },
  } })
  const [action, rawName, ...pairs] = positionals
  try {
    if (action === 'list') {
      if (o.remote) { show(await invokeApi('integrations.list') as IntegrationStatus[]); return 0 }
      show(await (await localStore(o)).list())
      return 0
    }
    if (!action || !['set', 'check', 'remove'].includes(action) || !rawName) { err(USAGE); return 2 }
    const parsed = IntegrationNameSchema.safeParse(rawName)
    if (!parsed.success) { err(`trace: unknown integration ${rawName} (one of ${INTEGRATION_NAMES.join(', ')})`); return 2 }
    const name = parsed.data
    if (action === 'set') {
      const { values, missing } = givenValues(name, pairs)
      for (const k of missing) values[k] = await ask(`${INTEGRATIONS[name].title} ${k}: `)
      if (o.remote) {
        const r = await invokeApi('integrations.set', { name, values }) as { secret: string; check: { ok: boolean; detail: string } }
        out(`${r.check.ok ? 'checked: ' : 'not confirmed: '}${r.check.detail}`)
        out(`stored in ${r.secret}`)
        return 0
      }
      if (!o['skip-check']) {
        const c = await checkIntegration(name, values)
        out(`${c.ok ? 'checked: ' : 'not confirmed: '}${c.detail}`)
      }
      out(`stored in ${await (await localStore(o)).set(name, values)}`)
      out('Workers pick it up when they next start a session; nothing to redeploy.')
      return 0
    }
    if (action === 'remove') {
      const removed = o.remote ? ((await invokeApi('integrations.remove', { name })) as { removed: boolean }).removed : await (await localStore(o)).remove(name)
      out(removed ? `removed ${name}` : `${name} was not set`)
      return 0
    }
    // check: the stored credentials (local only: the API never reads them back)
    if (o.remote) { err('trace: `check` reads the stored credentials, which the API never returns: run it without --remote, with your AWS credentials'); return 2 }
    const stored = await (await localStore(o)).get(name)
    if (!stored) { out(`${name} is not set: trace integrations set ${name}`); return 1 }
    const c = await checkIntegration(name, stored)
    out(`${c.ok ? 'ok: ' : 'failed: '}${c.detail}`)
    return c.ok ? 0 : 1
  } catch (e) {
    if (e instanceof ApiError || e instanceof Error) { err(`trace: ${e.message}`); return 1 }
    throw e
  }
}

async function localStore(o: { prefix?: string | undefined; region?: string | undefined }): Promise<IntegrationStore> {
  const region = o.region ?? installation()?.region ?? process.env.AWS_REGION
  if (!region) throw new Error('no region: run `trace install` first, or pass --region')
  return new IntegrationStore(localPrefix(o.prefix), await secretsManagerApi({ region }))
}
