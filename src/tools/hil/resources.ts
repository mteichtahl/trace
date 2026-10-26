/**
 * The bench's named resources: the project settings hil.serial, hil.can and hil.instruments (their item schemas are
 * in core/config.ts). A tool names a resource ("bench-psu", "dut-console", "vehicle") and gets its connection details
 * and, for a power supply, its safety limits. A tool may instead be given an explicit port or address: an ad-hoc
 * resource has no limits, so a PSU reached that way never has its output enabled.
 */
import { CanBusSchema, ConfigError, InstrumentSchema, SerialPortSchema, load, type CanBusConfig, type InstrumentConfig,
  type ResolvedConfig, type SerialPortConfig } from '../../core/config.js'
import { ToolError } from '../../core/registry.js'

export function settings(): ResolvedConfig {
  try {
    return load()
  } catch (e) {
    if (e instanceof ConfigError) throw new ToolError(e.message)
    throw e
  }
}

const names = (items: readonly { name: string }[]): string => items.map((i) => i.name).join(', ') || 'none'

export function serialPort(name?: string, port?: string, baud?: number): SerialPortConfig {
  if (name) {
    const list = settings().hil.serial
    const hit = list.find((s) => s.name === name)
    if (hit) return baud ? { ...hit, baud } : hit
    if (!port) throw new ToolError(`no serial port ${JSON.stringify(name)} in hil.serial (have: ${names(list)})`)
  }
  if (!port) throw new ToolError('name a serial port (hil.serial) or give port: a path or USB VID:PID[:serial]')
  return SerialPortSchema.parse({ name: name ?? 'adhoc', port, ...(baud ? { baud } : {}) })
}

export function canBus(name?: string, iface?: string, channel?: string, bitrate?: number): CanBusConfig {
  if (name) {
    const list = settings().hil.can
    const hit = list.find((c) => c.name === name)
    if (hit) return bitrate ? { ...hit, bitrate } : hit
    if (!iface) throw new ToolError(`no CAN bus ${JSON.stringify(name)} in hil.can (have: ${names(list)})`)
  }
  if (!iface || !channel) throw new ToolError('name a CAN bus (hil.can) or give interface and channel')
  const parsed = CanBusSchema.safeParse({ name: name ?? `${iface}-${channel}`.replace(/[^A-Za-z0-9_.-]/g, '_'), interface: iface, channel, ...(bitrate ? { bitrate } : {}) })
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return parsed.data
}

export type Instrument = InstrumentConfig & { readonly adhoc: boolean }

export function instrument(name: string | undefined, address: string | undefined, kind?: InstrumentConfig['kind']): Instrument {
  if (name) {
    const list = settings().hil.instruments
    const hit = list.find((i) => i.name === name)
    if (hit) {
      if (kind && hit.kind !== kind) throw new ToolError(`${name} is a ${hit.kind}, not a ${kind}`)
      return { ...hit, adhoc: false }
    }
    if (!address) throw new ToolError(`no instrument ${JSON.stringify(name)} in hil.instruments (have: ${names(list)})`)
  }
  if (!address) throw new ToolError('name an instrument (hil.instruments) or give address')
  const parsed = InstrumentSchema.safeParse({ name: 'adhoc', kind: kind ?? 'dmm', address })
  if (!parsed.success) throw new ToolError(`address: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  return { ...parsed.data, adhoc: true }
}

export interface ChannelLimits {
  max_voltage_v: number | undefined
  max_current_a: number | undefined
}

/** A PSU channel's limits: the tighter of the instrument's and the channel's own. */
export function channelLimits(inst: InstrumentConfig, ch: number): ChannelLimits {
  const own = inst.limits.per_channel[String(ch)]
  const min = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b)
  return { max_voltage_v: min(inst.limits.max_voltage_v, own?.max_voltage_v), max_current_a: min(inst.limits.max_current_a, own?.max_current_a) }
}
