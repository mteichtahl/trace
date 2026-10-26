#!/usr/bin/env node
/**
 * The `trace` command.
 *
 *   Installation
 *     trace install [--port N] [--no-open]   a local web page that sets up AWS (CDK, AgentCore, Cognito) and GitHub
 *
 *   Repositories
 *     trace onboard OWNER/REPO [--path DIR] [--apply-settings] [--no-push] [--no-ruleset] [--escalate-to LOGIN]
 *     trace new OWNER/REPO [--template empty|python|kicad|rust] [--public] [--description TEXT]
 *     trace doctor OWNER/REPO          what's missing for the loop to run
 *     trace projects                   every onboarded repository (central database)
 *     trace worker-prompt [OWNER/REPO ...]   the hourly cloud worker's prompt
 *
 *   This project (run inside its clone)
 *     trace config show | keys | get KEY | set KEY VALUE | unset KEY     settings in .trace/project.db
 *     trace check                      ERC/DRC on every KiCad project and a build of every firmware target
 *     trace runs [--kind K] [--limit N] | trace run ID | trace artifact ID NAME [--out PATH]
 *     trace db merge BASE OURS THEIRS | trace db prune [--keep N]
 *
 *   Prompts (the catalog of every prompt the agents get, and its overrides: README "Managing prompts")
 *     trace prompts list | get ID | set ID --reason "why" [--file F] | reset ID | revert ID VERSION | history ID
 *                 | diff ID [FROM [TO]] | preview TARGET [--marked]      this clone's .trace/project.db, or with
 *                                      --installation the installation's store (your own credentials)
 *
 *   Specialist agents (verify, impl, ams, emc, render, thermal)
 *     trace agent list [--json]        each specialist, its settings and its tools
 *     trace agent route <issue|pr|text> [--repo OWNER/REPO] [--labels a,b] [--files f,g] [--checks c,d] [--model]
 *                                      a dry run of the router
 *     trace agent prompt <kind>        the composed system prompt, for review
 *
 *   Tools
 *     trace tools [--hardware]         every tool (the set the MCP server offers)
 *     trace tool NAME [key=value ...] [--args '{...}'] [--hardware]
 *     trace mcp                        the MCP server on stdio (claude mcp add trace -- trace mcp)
 *
 *   Agent memory (a local installation: your credentials, TRACE_MEMORY_ID; through the API: trace remote memory)
 *     trace memory list [--repo OWNER/REPO] [--all] | deactivate RECORD_ID --reason "…" | reactivate RECORD_ID
 *
 *   The project's knowledge base (your credentials, or the workflow's role; TRACE_KB_ID; through the API: trace remote kb)
 *     trace kb sync [--force] [--dry-run] [--wait MINUTES] | search "query" [--source S] [--kind K] [--path P] | status
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigError, changed, leaves, load, parseCliValue, resolve, setValue, unset } from './core/config.js'
import { mergeMain } from './core/dbmerge.js'
// registers the prompts tables of .trace/project.db, so `trace db merge` merges them by their rule
import './prompts/store.js'
import { workerPrompt } from './core/cloudworker.js'
import { doctor } from './core/doctor.js'
import { serve } from './core/mcp.js'
import { OnboardError, SCAFFOLDS, type Scaffold, createNew, onboard, projects } from './core/onboard.js'
import { ToolError } from './core/registry.js'
import { flush } from './core/telemetry.js'
import { Work, transaction } from './core/store.js'
import { allTools } from './tools/index.js'
import { cmdConnect, cmdLogin, cmdLogout, cmdRemote, cmdUsers, cmdWhoami } from './login/commands.js'
import { cmdKb } from './login/kb.js'
import { cmdMemory } from './login/memory.js'

// node:sqlite is stable in practice but still prints an experimental warning; keep the CLI's output clean.
const emit = process.emitWarning.bind(process)
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const msg = typeof w === 'string' ? w : w.message
  if (/SQLite is an experimental feature/.test(msg)) return
  ;(emit as (w: string | Error, ...r: unknown[]) => void)(w, ...rest)
}) as typeof process.emitWarning

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

function pretty(v: unknown, indent = 0): void {
  const pad = '  '.repeat(indent)
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x !== null && typeof x === 'object') { out(`${pad}-`); pretty(x, indent + 1) } else out(`${pad}- ${String(x)}`)
    }
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (x !== null && typeof x === 'object' && Object.keys(x).length) { out(`${pad}${k}:`); pretty(x, indent + 1) } else out(`${pad}${k}: ${JSON.stringify(x)}`)
    }
  } else out(`${pad}${String(v)}`)
}

function kvArgs(pairs: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i < 1) throw new ToolError(`argument ${JSON.stringify(p)} is not key=value`)
    o[p.slice(0, i)] = parseCliValue(p.slice(i + 1))
  }
  return o
}

const hardwareEnv = (): boolean => ['1', 'true', 'yes'].includes(process.env.TRACE_HARDWARE ?? '')

async function cmdTool(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { args: { type: 'string' }, hardware: { type: 'boolean' }, json: { type: 'boolean' } } })
  const [name, ...pairs] = positionals
  if (!name) { err('usage: trace tool NAME [key=value ...]'); return 2 }
  const args = { ...(values.args ? (JSON.parse(values.args) as Record<string, unknown>) : {}), ...kvArgs(pairs) }
  const result = await allTools().call(name, args, { hardware: Boolean(values.hardware) || hardwareEnv(), via: 'cli' })
  if (values.json) out(JSON.stringify(result, null, 1))
  else pretty(result)
  return 0
}

function cmdTools(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { hardware: { type: 'boolean' } } })
  const list = allTools().list()
  for (const t of list) out(`${t.name.padEnd(28)} ${(t.description.split('\n')[0] ?? '').slice(0, 100)}${t.hardware ? ' [hardware]' : ''}`)
  out(`\n${list.length} tools${values.hardware ? '' : `, ${list.filter((t) => t.hardware).length} of them drive hardware (TRACE_HARDWARE=1 to use)`}`)
  return 0
}

function cmdConfig(argv: string[]): number {
  const [action, key, value] = argv
  switch (action) {
    case 'show': {
      const own = changed()
      const { config, errors } = resolve(own)
      for (const [k, v] of Object.entries(leaves(config as unknown as Record<string, unknown>))) out(`${k in own ? '*' : ' '} ${k} = ${JSON.stringify(v)}`)
      out('\n* set for this project; the rest are defaults')
      for (const e of errors) err(`error: ${e}`)
      return errors.length ? 1 : 0
    }
    case 'keys':
      for (const [k, v] of Object.entries(leaves())) out(`${k} (default ${JSON.stringify(v)})`)
      return 0
    case 'get': {
      if (!key) break
      let node: unknown = load(undefined, { strict: false })
      for (const part of key.split('.')) {
        if (node === null || typeof node !== 'object' || !(part in node)) { err(`no setting ${key}`); return 1 }
        node = (node as Record<string, unknown>)[part]
      }
      out(JSON.stringify(node, null, 1))
      return 0
    }
    case 'set':
      if (!key || value === undefined) break
      setValue(key, parseCliValue(value))
      out(`${key} = ${value}`)
      return 0
    case 'unset':
      if (!key) break
      out(`${key}: ${unset(key) ? 'back to its default' : 'was not set'}`)
      return 0
  }
  err('usage: trace config show | keys | get KEY | set KEY VALUE | unset KEY')
  return 2
}

/** ERC and DRC on every KiCad project, and a build of every firmware target: what a hardware repository's build
 * runs. Exits 1 when any of them reports errors. */
async function cmdCheck(): Promise<number> {
  const cfg = load()
  const reg = allTools()
  const root = cfg.root ?? process.cwd()
  const find = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('.') || e.name === 'node_modules' || e.name.endsWith('-backups') ? [] : e.isDirectory() ? find(join(dir, e.name)) : e.name.endsWith('.kicad_pro') ? [join(dir, e.name)] : [])
  const projectsList = cfg.electronics.projects.length ? cfg.electronics.projects : find(root).map((p) => relative(root, p))
  let failures = 0
  let ran = 0
  const num = (r: unknown, k: string): number => (r !== null && typeof r === 'object' && typeof (r as Record<string, unknown>)[k] === 'number' ? (r as Record<string, number>)[k] ?? 0 : 0)
  for (const proj of projectsList) {
    for (const kind of ['kicad.erc', 'kicad.drc']) {
      if (!reg.get(kind)) { out(`skip   ${kind} ${proj}: not available`); continue }
      ran++
      try {
        const r = await reg.call(kind, { project: join(root, proj) }, { hardware: false, via: 'cli' })
        const e = num(r, 'errors')
        failures += e ? 1 : 0
        out(`${e ? 'FAIL' : 'ok  '}   ${kind} ${proj}: ${e} errors, ${num(r, 'warnings')} warnings`)
      } catch (x) {
        failures++
        out(`FAIL   ${kind} ${proj}: ${x instanceof Error ? x.message : String(x)}`)
      }
    }
  }
  for (const t of cfg.firmware.targets) {
    if (!reg.get('firmware.build')) { out(`skip   firmware.build ${t.name}: not available`); continue }
    ran++
    try {
      const r = (await reg.call('firmware.build', { target: t.name }, { hardware: false, via: 'cli' })) as Record<string, unknown>
      const ok = r.ok === true || ['pass', 'ok', 'success'].includes(String(r.status))
      failures += ok ? 0 : 1
      const said = r.summary ?? (r.errors !== undefined ? `${String(r.errors)} errors, ${String(r.warnings ?? 0)} warnings${r.seconds !== undefined ? ` in ${String(r.seconds)} s` : ''}` : r.status ?? '')
      out(`${ok ? 'ok  ' : 'FAIL'}   firmware.build ${t.name}: ${String(said)}`)
    } catch (x) {
      failures++
      out(`FAIL   firmware.build ${t.name}: ${x instanceof Error ? x.message : String(x)}`)
    }
  }
  if (!ran) out('Nothing to check: no KiCad projects and no firmware targets.')
  return failures ? 1 : 0
}

function cmdRuns(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { kind: { type: 'string' }, limit: { type: 'string' } } })
  const w = new Work()
  for (const r of w.runs(values.kind, Number(values.limit ?? 20))) {
    const when = new Date(r.started * 1000).toISOString().slice(0, 16).replace('T', ' ')
    out(`${r.id}  ${when}  ${r.status.padEnd(7)} ${r.kind.padEnd(22)} ${r.subject ?? ''}  ${r.summary ?? ''}`)
  }
  return 0
}

function cmdDb(argv: string[]): number {
  const [action, ...rest] = argv
  if (action === 'merge') return mergeMain(rest)
  if (action === 'prune') {
    const { values } = parseArgs({ args: rest, options: { keep: { type: 'string' } } })
    const keep = Number(values.keep ?? 50)
    const w = new Work()
    const n = transaction(w.db, () => Number(w.db.prepare(`DELETE FROM runs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER
      (PARTITION BY kind ORDER BY started DESC) AS rn FROM runs) WHERE rn > ?)`).run(keep).changes))
    w.db.exec('VACUUM')
    out(`removed ${n} older runs (kept the newest ${keep} of each kind)`)
    return 0
  }
  err('usage: trace db merge BASE OURS THEIRS | trace db prune [--keep N]')
  return 2
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'tools': return cmdTools(rest)
    case 'tool': return cmdTool(rest)
    case 'mcp': await serve(allTools()); return new Promise<number>(() => undefined)
    case 'config': return cmdConfig(rest)
    case 'check': return cmdCheck()
    case 'runs': return cmdRuns(rest)
    case 'run': {
      const r = rest[0] ? new Work().run(rest[0]) : null
      if (!r) { err(`no run ${rest[0] ?? ''}`); return 1 }
      pretty(r)
      return 0
    }
    case 'artifact': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: 'string' } } })
      const [id, name] = positionals
      const data = id && name ? new Work().getArtifact(id, name) : null
      if (!data) { err(`no artifact ${name ?? ''} on run ${id ?? ''}`); return 1 }
      if (values.out) { writeFileSync(values.out, data); out(`wrote ${values.out} (${data.length} bytes)`) } else process.stdout.write(data)
      return 0
    }
    case 'db': return cmdDb(rest)
    case 'onboard': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        path: { type: 'string' }, 'no-push': { type: 'boolean' }, 'apply-settings': { type: 'boolean' }, 'no-ruleset': { type: 'boolean' },
        'escalate-to': { type: 'string' }, ref: { type: 'string' } } })
      if (!positionals[0]) break
      pretty(await onboard(positionals[0], {
        ...(values.path ? { path: values.path } : {}), push: !values['no-push'], apply: Boolean(values['apply-settings']),
        ruleset: !values['no-ruleset'], ...(values['escalate-to'] ? { escalateTo: values['escalate-to'] } : {}), ...(values.ref ? { ref: values.ref } : {}),
      }))
      return 0
    }
    case 'new': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        template: { type: 'string' }, public: { type: 'boolean' }, description: { type: 'string' }, 'escalate-to': { type: 'string' }, ref: { type: 'string' } } })
      const template = (values.template ?? 'empty') as Scaffold
      if (!positionals[0] || !SCAFFOLDS.includes(template)) { err(`usage: trace new OWNER/REPO [--template ${SCAFFOLDS.join('|')}]`); return 2 }
      pretty(await createNew(positionals[0], {
        template, private: !values.public, ...(values.description ? { description: values.description } : {}),
        ...(values['escalate-to'] ? { escalateTo: values['escalate-to'] } : {}), ...(values.ref ? { ref: values.ref } : {}),
      }))
      return 0
    }
    case 'doctor': {
      if (!rest[0]) break
      const findings = doctor(rest[0])
      for (const f of findings) out(`${f.ok ? 'ok ' : 'NO '} ${f.what}${f.ok ? '' : `\n     → ${f.fix}`}`)
      return findings.every((f) => f.ok) ? 0 : 1
    }
    case 'projects':
      for (const p of await projects()) out(p)
      return 0
    case 'install': {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } } })
      const { startInstaller } = await import('./installer/server.js')
      const { url } = await startInstaller({ ...(values.port ? { port: Number(values.port) } : {}), open: !values['no-open'] })
      out(`The installer is at ${url}\n(keep this running until it says it is done; Ctrl-C to stop)`)
      return new Promise<number>(() => undefined)
    }
    case 'connect': return cmdConnect(rest)
    case 'login': return cmdLogin(rest)
    case 'logout': return cmdLogout(rest)
    case 'whoami': return cmdWhoami(rest)
    case 'remote': return cmdRemote(rest)
    case 'agent': {
      const { cmdAgent } = await import('./agents/cli.js')
      return cmdAgent(rest)
    }
    case 'users': return cmdUsers(rest)
    case 'memory': return cmdMemory(rest)
    case 'kb': return cmdKb(rest)
    case 'worker-prompt': {
      // it spans projects: only the installation's overrides apply (when this machine can read them)
      const { InstallationPrompts, loadLayers } = await import('./prompts/store.js')
      const layers = await loadLayers({ installation: new InstallationPrompts() })
      for (const u of layers.unavailable ?? []) err(`(the installation's prompt overrides are not used: ${u.reason})`)
      process.stdout.write(workerPrompt(rest.length ? rest : await projects(), layers))
      return 0
    }
    case 'prompts': {
      const { cmdPrompts } = await import('./prompts/cli.js')
      return cmdPrompts(rest)
    }
    case undefined: case '-h': case '--help': case 'help': {
      const { readFileSync } = await import('node:fs')
      const { fileURLToPath } = await import('node:url')
      const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      out(/\/\*\*([\s\S]*?)\*\//.exec(src)?.[1]?.replace(/^ \* ?/gm, '').trim() ?? 'trace')
      return 0
    }
  }
  err(`trace: unknown command or missing argument: ${argv.join(' ')} (trace help)`)
  return 2
}

// flush(): spans buffered by an OpenTelemetry SDK, when one was loaded (README "Observability"); otherwise nothing
main(process.argv.slice(2)).then(async (code) => { await flush(); process.exitCode = code }, async (e: unknown) => {
  await flush()
  if (e instanceof ToolError || e instanceof ConfigError || e instanceof OnboardError) { err(`trace: ${e.message}`); process.exitCode = 1; return }
  throw e
})
