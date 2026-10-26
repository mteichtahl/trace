/**
 * A project's settings: rows in the `settings` table of its database (.trace/project.db), laid over the defaults that
 * the schema below declares.
 *
 *   const cfg = load()                                   // the project around the current directory
 *   setValue('prs.merge_method', 'squash')
 *   setValue('hil.instruments', [{ name: 'bench-psu', kind: 'psu', address: 'TCPIP::10.0.0.5::5025::SOCKET', ... }])
 *   unset('worker.model')
 *
 * A setting's key is a dotted path to a leaf of the schema (a scalar or a whole list). The schema is the single
 * definition of every setting, its type and its default: unknown keys and wrong types are errors, so a typo can never
 * silently turn a setting into its default. The harness's GitHub actions resolve the same rows from the default
 * branch's copy of the database with this module.
 */
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { dec, enc, findRoot, open, openProject, projectPath, transaction } from './store.js'

// ------------------------------------------------------------------ the electronics sections' items

/** Instrument addresses trace can reach: raw SCPI sockets and serial in TypeScript, the VISA kinds through the bridge. */
export const INSTRUMENT_ADDRESS = /^(TCPIP\d*::[^:]+::(\d+::SOCKET|[^:]*INSTR|hislip\d+(::INSTR)?)|USB\d*::.+|ASRL.+::INSTR|GPIB\d*::\d+(::\d+)?::INSTR|tcp:\/\/[^:/]+:\d+)$/i

const resourceName = z.string().regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '.', '_' and '-' only")

export const SerialPortSchema = z.object({
  name: resourceName,
  /** a device path (/dev/ttyACM0, COM3), or a USB match "VID:PID" or "VID:PID:serial" (hex, e.g. 2e8a:000a) */
  port: z.string().min(1),
  baud: z.number().int().positive().default(115200),
  data_bits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  parity: z.enum(['none', 'even', 'odd']).default('none'),
  stop_bits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  rtscts: z.boolean().default(false),
  xon: z.boolean().default(false),
  /** what `send` steps end with */
  newline: z.enum(['\n', '\r\n', '\r', '']).default('\n'),
  note: z.string().optional(),
}).strict()

export const CAN_INTERFACES = ['socketcan', 'virtual', 'slcan', 'pcan', 'kvaser', 'vector', 'ixxat', 'gs_usb', 'neovi',
  'serial', 'socketcand', 'udp_multicast', 'cantact', 'usb2can', 'nican', 'nixnet', 'systec', 'seeedstudio', 'robotell',
  'canalystii', 'etas'] as const

export const CanBusSchema = z.object({
  name: resourceName,
  /** a python-can interface */
  interface: z.enum(CAN_INTERFACES),
  /** can0, PCAN_USBBUS1, /dev/ttyACM0@115200 (slcan), 0 (kvaser), any name (virtual) */
  channel: z.union([z.string().min(1), z.number().int().min(0)]).transform(String),
  bitrate: z.number().int().positive().default(500_000),
  fd: z.boolean().default(false),
  data_bitrate: z.number().int().positive().optional(),
  /** a DBC file, relative to the repository: frames are decoded when cantools is installed */
  dbc: z.string().optional(),
  note: z.string().optional(),
}).strict()

const LimitSchema = z.object({
  max_voltage_v: z.number().positive().optional(),
  max_current_a: z.number().positive().optional(),
}).strict()

export const InstrumentSchema = z.object({
  name: resourceName,
  kind: z.enum(['psu', 'scope', 'dmm', 'eload', 'siggen']),
  /** dialect: rigol-dp800, keysight-e36, siglent-spd, rs-ngx, rigol-ds1000z, rigol-mso5000, siglent-sds,
   * keysight-infiniivision, tek-mso, generic; omitted → identified from *IDN? */
  model: z.string().optional(),
  /** TCPIP::host::5025::SOCKET, tcp://host:port, TCPIP::host::INSTR, TCPIP::host::hislip0, USB0::…::INSTR,
   * ASRL/dev/ttyUSB0::INSTR, GPIB0::5::INSTR */
  address: z.string().regex(INSTRUMENT_ADDRESS, 'expected TCPIP::host::port::SOCKET, TCPIP::host::INSTR, USB::…, ASRL<dev>::INSTR, GPIB::n::INSTR or tcp://host:port'),
  channels: z.array(z.number().int().positive()).default([1]),
  /** a PSU's set-points are refused above these, and without both its output is never enabled */
  limits: LimitSchema.extend({
    /** tighter limits for one channel: { "3": { max_voltage_v: 3.4 } } */
    per_channel: z.record(z.string().regex(/^\d+$/), LimitSchema).default({}),
  }).strict().prefault({}),
  timeout_s: z.number().positive().max(600).default(5),
  note: z.string().optional(),
}).strict()

export const FIRMWARE_PRESETS = ['cargo', 'pico-sdk', 'platformio', 'zephyr', 'esp-idf', 'arduino', 'make', 'custom'] as const

export const FirmwareTargetSchema = z.object({
  name: resourceName,
  /** the project folder, relative to the repository */
  path: z.string().default('.'),
  preset: z.enum(FIRMWARE_PRESETS),
  /** shell commands; each defaults from the preset. Placeholders: {chip} {probe} {artifact} {port} {path} {env} */
  build: z.string().optional(),
  flash: z.string().optional(),
  logs: z.string().optional(),
  /** probe-rs/openocd chip (RP235x, STM32G071RBTx), Zephyr board, Arduino FQBN, ESP-IDF target */
  chip: z.string().optional(),
  /** probe selector (probe-rs VID:PID[:serial]) or openocd interface (cmsis-dap, picoprobe) */
  probe: z.string().optional(),
  /** the image, relative to `path`; defaults from the preset */
  artifact: z.string().optional(),
  /** the serial port (a hil.serial name) its logs come out of, when not RTT; also the upload port */
  serial: z.string().optional(),
  /** a PlatformIO environment */
  pio_env: z.string().optional(),
  build_timeout_s: z.number().positive().default(1200),
  flash_timeout_s: z.number().positive().default(300),
  env: z.record(z.string(), z.string()).default({}),
}).strict()

export type SerialPortConfig = z.output<typeof SerialPortSchema>
export type CanBusConfig = z.output<typeof CanBusSchema>
export type InstrumentConfig = z.output<typeof InstrumentSchema>
export type FirmwareTarget = z.output<typeof FirmwareTargetSchema>

export const DispatchOnSchema = z.object({ match: z.string(), workflow: z.string(), note: z.string().optional() }).strict()

const regex = z.string().max(200, 'at most 200 characters').refine((s) => { try { new RegExp(s); return true } catch { return false } }, 'not a valid regular expression')

// ------------------------------------------------------------------ every setting

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  branch: z.string().min(1).default('main'),
  build: z.object({
    workflow: z.string().min(1).default('build.yml'),
    required_check: z.string().min(1).default('tests pass'),
  }).strict().prefault({}),
  prs: z.object({
    auto_open: z.boolean().default(true),
    auto_merge: z.boolean().default(true),
    merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
    update_queue: z.boolean().default(true),
    skip_branches: z.array(z.string()).default(['dependabot/**', 'gh-readonly-queue/**']),
    wip_marker: z.string().default('wip'),
    /** A PR touching any of these never merges itself: a person reviews and merges it. They are the files that steer
     * the harness itself (its workflows, settings, rules and ownership), so an agent can't change them unreviewed. */
    protected_paths: z.array(z.string()).default(['.github/**', '.trace/**', '.gitattributes', 'CODEOWNERS', '**/CODEOWNERS']),
  }).strict().prefault({}),
  ci_doctor: z.object({
    enabled: z.boolean().default(true),
    rerun_flaky: z.boolean().default(true),
    flaky_patterns: z.array(regex).default([]),
    dispatch_on: z.array(DispatchOnSchema).default([]),
  }).strict().prefault({}),
  worker: z.object({
    enabled: z.boolean().default(true),
    model: z.string().default(''),
    max_parallel: z.number().int().min(1).max(20).default(4),
    max_attempts: z.number().int().min(1).default(3),
    claim_hours: z.number().min(0.25).default(3),
    max_turns: z.number().int().min(1).default(200),
    setup: z.string().default(''),
    validate: z.string().default(''),
    escalate_to: z.string().regex(/^(@?[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?)?$/, 'expected a login or @org/team').default('')
      .transform((s) => (s && !s.startsWith('@') ? `@${s}` : s)),
    own_branch_prefix: z.string().default('claude/'),
    others_branches_after_minutes: z.number().min(0).default(30),
    /** where each item runs: 'agentcore' (the trace agent on Bedrock AgentCore Runtime) or 'actions' (claude-code-action) */
    runner: z.enum(['agentcore', 'actions']).default('agentcore'),
  }).strict().prefault({}),
  deploy: z.object({
    enabled: z.boolean().default(false),
    auto: z.boolean().default(false),
    environment: z.string().min(1).default('production'),
    approvers: z.array(z.string()).default([]),
    setup: z.string().default(''),
    risk_check: z.string().default(''),
    command: z.string().default(''),
    smoke: z.string().default(''),
    rollback: z.string().default(''),
    url: z.string().default(''),
  }).strict().prefault({}),
  labels: z.object({
    hold: z.string().min(1).default('no-automerge'),
    ci_red: z.string().min(1).default('ci-red'),
    agent_fix: z.string().min(1).default('agent-fix'),
    deploy: z.string().min(1).default('deploy'),
    deploy_held: z.string().min(1).default('deploy-held'),
  }).strict().prefault({}),
  electronics: z.object({
    /** KiCad project files (.kicad_pro), relative to the repository; empty = every one found */
    projects: z.array(z.string()).default([]),
    /** SPICE model files or folders, relative to the repository, included in every simulation */
    models: z.array(z.string()).default([]),
    /** pcb.autoroute: how the board's complex core is found (src/tools/pcb/plan.ts) and how the two routers run */
    autoroute: z.object({
      /** area arrays (BGAs): at most this pitch, at least this many pads, at least this fraction of the grid filled */
      bga_max_pitch_mm: z.number().positive().default(0.8),
      bga_min_pads: z.number().int().min(4).default(64),
      bga_min_fill: z.number().min(0).max(1).default(0.35),
      /** this many nets with one name stem between the same footprints are a bus */
      bus_min_nets: z.number().int().min(2).default(8),
      /** this many nets between two connectors are a backplane fan */
      backplane_min_nets: z.number().int().min(2).default(32),
      /** reference prefixes of connectors */
      connector_prefixes: z.array(z.string().min(1)).default(['J', 'P', 'CN', 'X']),
      /** nets always / never given to OrthoRoute, whatever the classifier says */
      include_nets: z.array(z.string()).default([]),
      exclude_nets: z.array(z.string()).default([]),
      /** OrthoRoute is planned only on boards with at least this many copper layers */
      orthoroute_min_layers: z.number().int().min(2).default(4),
      /** let OrthoRoute keep blind/buried vias (needs 4+ copper layers); otherwise every via is a through via */
      blind_buried_vias: z.boolean().default(false),
      orthoroute_iterations: z.number().int().min(1).max(10_000).default(200),
      freerouting_passes: z.number().int().min(1).max(10_000).default(100),
    }).strict().prefault({}),
  }).strict().prefault({}),
  parts: z.object({
    providers: z.array(z.enum(['lcsc', 'mouser', 'digikey', 'nexar'])).default(['lcsc']),
    currency: z.string().length(3).default('USD'),
  }).strict().prefault({}),
  firmware: z.object({
    targets: z.array(FirmwareTargetSchema).default([]),
  }).strict().prefault({}),
  hil: z.object({
    serial: z.array(SerialPortSchema).default([]),
    can: z.array(CanBusSchema).default([]),
    instruments: z.array(InstrumentSchema).default([]),
  }).strict().prefault({}),
}).strict().superRefine((c, ctx) => {
  if (c.deploy.enabled && !c.deploy.command) ctx.addIssue({ code: 'custom', path: ['deploy', 'command'], message: 'required when deploy.enabled is true' })
  for (const [i, p] of c.hil.instruments.entries()) {
    if (p.kind === 'psu' && (p.limits.max_voltage_v === undefined || p.limits.max_current_a === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['hil', 'instruments', i, 'limits'], message: 'a PSU needs max_voltage_v and max_current_a; without them its output is never enabled' })
    }
  }
  const seen = new Map<string, string>()
  const sections = [['serial', c.hil.serial], ['can', c.hil.can], ['instruments', c.hil.instruments]] as const
  for (const [section, items] of sections) {
    for (const [i, item] of items.entries()) {
      const prev = seen.get(item.name)
      if (prev) ctx.addIssue({ code: 'custom', path: ['hil', section, i, 'name'], message: `${item.name} is also ${prev}` })
      seen.set(item.name, `hil.${section}[${i}]`)
    }
  }
  const targets = new Set<string>()
  for (const [i, t] of c.firmware.targets.entries()) {
    if (targets.has(t.name)) ctx.addIssue({ code: 'custom', path: ['firmware', 'targets', i, 'name'], message: `${t.name} is listed twice` })
    targets.add(t.name)
    if (t.preset === 'custom' && !t.build) ctx.addIssue({ code: 'custom', path: ['firmware', 'targets', i, 'build'], message: 'a custom target needs a build command' })
  }
})

export type TraceConfig = z.output<typeof ConfigSchema>
export type ResolvedConfig = TraceConfig & { readonly root: string | null }

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Every settable key with its default: 'prs.merge_method' → 'merge', 'hil.instruments' → [] … */
export function leaves(obj: Record<string, unknown> = defaults(), prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, leaves(v as Record<string, unknown>, `${key}.`))
    else out[key] = v
  }
  return out
}

export function defaults(): TraceConfig {
  return ConfigSchema.parse({})
}

const typeOf = (v: unknown): string => (Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v === 'object' ? 'mapping' : typeof v)

/** Lay {dotted key: value} over the defaults. Returns the config, or the errors. */
export function resolve(settings: Record<string, unknown>): { config: TraceConfig; errors: string[] } {
  const known = leaves()
  const errors: string[] = []
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in known)) {
      const tail = key.split('.').at(-1)
      const close = Object.keys(known).filter((k) => k.endsWith(`.${tail}`))
      errors.push(`${key}: unknown setting${close.length ? ` (did you mean ${close.slice(0, 3).join(', ')}?)` : ''}`)
      continue
    }
    if (typeOf(known[key]) !== typeOf(value)) { errors.push(`${key}: expected ${typeOf(known[key])}, got ${typeOf(value)}`); continue }
    let node = raw
    const path = key.split('.')
    for (const p of path.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>
    node[path.at(-1)!] = value
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(`${i.path.join('.')}: ${i.message}`)
    return { config: defaults(), errors }
  }
  return { config: parsed.data, errors }
}

/** The settings rows of a project database file (read-only). */
export function readSettings(dbPath: string): Record<string, unknown> {
  if (!existsSync(dbPath)) return {}
  const db = open(dbPath, { readonly: true })
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all()
    if (!rows.length) return {}
    return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [String(r.key), dec(r.value)]))
  } finally {
    db.close()
  }
}

/** The resolved settings of the project at/above `root` (the defaults when it has no database yet). */
export function load(root?: string, opts: { strict?: boolean } = {}): ResolvedConfig {
  const { config, errors } = resolve(readSettings(projectPath(root)))
  if (errors.length && opts.strict !== false) throw new ConfigError(`${projectPath(root)}: invalid settings:\n- ${errors.join('\n- ')}`)
  return { ...config, root: findRoot(root) }
}

/** Only the settings this project has set. */
export function changed(root?: string): Record<string, unknown> {
  return readSettings(projectPath(root))
}

/** `trace config set` values: JSON literals (true, 3, ["a"], {"k": 1}) or else a plain string. */
export function parseCliValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function setValue(key: string, value: unknown, root?: string, by?: string): void {
  const db = openProject(root)
  try {
    const current = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [String(r.key), dec(r.value)]))
    const { errors } = resolve({ ...current, [key]: value })
    if (errors.length) throw new ConfigError(errors.join('; '))
    transaction(db, () => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value, updated, by) VALUES (?,?,?,?)')
        .run(key, enc(value), Date.now() / 1000, by ?? safeUser())
    })
  } finally {
    db.close()
  }
}

export function unset(key: string, root?: string): boolean {
  const db = openProject(root)
  try {
    return Number(db.prepare('DELETE FROM settings WHERE key=?').run(key).changes) > 0
  } finally {
    db.close()
  }
}

function safeUser(): string | null {
  try {
    return userInfo().username
  } catch {
    return null
  }
}
