/**
 * Real buses into VCD: what protocol.capture drives, and the conversions it makes.
 *
 *   sigrok   sigrok-cli with a logic analyser driver (fx2lafw for the common Cypress FX2 analysers), written straight
 *            to VCD. trace does not install sigrok-cli; when it is not on PATH the capture says so.
 *   scope    hil.scope_capture's waveform.csv (volts per channel), turned into logic with a threshold or VIL/VIH
 *            hysteresis, channel by channel, named by role.
 *   mso      an oscilloscope's digital channels over SCPI, one hil.scpi call per channel: by default the Rigol MSO5000 /
 *            DS1000Z-style sequence :WAV:SOUR D<n>, :WAV:MODE NORM, :WAV:FORM BYTE, :WAV:XINC?, :WAV:XOR?, :WAV:DATA?
 *            (one byte per sample, bit 0 the level). Other instruments need their own commands (`commands`, with {n}
 *            for the channel). This path has not been run against an instrument here: verified: null.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ToolError } from '../../core/registry.js'
import { readCsv, Signal, writeVcd } from '../sim/wave.js'

const run = promisify(execFile)

export async function sigrokCli(): Promise<string | null> {
  const exe = process.env.SIGROK_CLI || 'sigrok-cli'
  try {
    await run(exe, ['--version'], { timeout: 10_000 })
    return exe
  } catch {
    return null
  }
}

export interface SigrokArgs { driver: string; channels: readonly string[]; samplerate: number; samples?: number | undefined; time_ms?: number | undefined; trigger?: string | undefined; config?: readonly string[] | undefined; timeout_s: number }

export function sigrokArgs(a: SigrokArgs, out: string): string[] {
  if (!/^[a-z0-9_-]+(:[A-Za-z0-9_=.,/-]+)?$/.test(a.driver)) throw new ToolError(`driver ${JSON.stringify(a.driver)} does not look like a sigrok driver spec (e.g. fx2lafw)`)
  for (const c of a.channels) if (!/^[A-Za-z0-9_]+(=[A-Za-z0-9_]+)?$/.test(c)) throw new ToolError(`channel ${JSON.stringify(c)}: use sigrok names such as D0 or D0=scl`)
  const args = ['-d', a.driver, '--config', [`samplerate=${Math.round(a.samplerate)}`, ...(a.config ?? [])].join(':'), '--channels', a.channels.join(',')]
  if (a.samples !== undefined) args.push('--samples', String(a.samples))
  else args.push('--time', String(a.time_ms ?? 100))
  if (a.trigger) {
    if (!/^[A-Za-z0-9_]+=[01rfec](,[A-Za-z0-9_]+=[01rfec])*$/.test(a.trigger)) throw new ToolError('trigger: sigrok syntax, e.g. D0=f or D0=0,D1=r')
    args.push('--triggers', a.trigger)
  }
  args.push('-O', 'vcd', '-o', out)
  return args
}

/** Capture with sigrok-cli to VCD text. */
export async function sigrokCapture(a: SigrokArgs): Promise<{ vcd: string; argv: string[] }> {
  const exe = await sigrokCli()
  if (!exe) throw new ToolError('sigrok-cli is not installed (apt install sigrok-cli, or set SIGROK_CLI); trace does not install it')
  const dir = mkdtempSync(join(tmpdir(), 'trace-sigrok-'))
  try {
    const out = join(dir, 'capture.vcd')
    const argv = sigrokArgs(a, out)
    try {
      await run(exe, argv, { timeout: a.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024 })
    } catch (e) {
      const err = e as { stderr?: string; message: string }
      throw new ToolError(`sigrok-cli failed: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`)
    }
    if (!existsSync(out)) throw new ToolError('sigrok-cli wrote no capture (no device found, or no trigger in time)')
    return { vcd: readFileSync(out, 'utf8'), argv: [exe, ...argv] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A scope's CSV (time, CH1_v, CH2_v, …) as logic, renamed by role: {sda: "CH1_v"} or {sda: "CH1"}. */
export async function analogCsvToVcd(csv: string | Uint8Array, roles: Readonly<Record<string, string>>, levels: { threshold?: number | undefined; vil?: number | undefined; vih?: number | undefined }): Promise<{ vcd: string; signals: string[] }> {
  const cap = await readCsv(typeof csv === 'string' ? new TextEncoder().encode(csv) : csv, 'waveform.csv')
  const lv = { ...(levels.threshold !== undefined ? { threshold: levels.threshold } : {}), ...(levels.vil !== undefined ? { vil: levels.vil } : {}), ...(levels.vih !== undefined ? { vih: levels.vih } : {}) }
  if (lv.threshold === undefined && (lv.vil === undefined || lv.vih === undefined)) throw new ToolError('a scope capture needs threshold, or vil and vih, to become logic')
  const out: Record<string, [number, string][]> = {}
  for (const [role, ch] of Object.entries(roles)) {
    const name = cap.resolve(ch) ?? cap.resolve(`${ch}_v`)
    if (!name) throw new ToolError(`${role}: the capture has no channel ${ch} (it has ${cap.names().join(', ')})`)
    const s = cap.get(name, lv)
    out[role] = s.t.map((t, k) => [t - cap.start, s.v[k] as string])
  }
  return { vcd: writeVcd(out, { timescale: '1ps', scope: 'capture' }), signals: Object.keys(out) }
}

/** Digital channel blocks (one byte per sample, bit 0 the level) as signals. */
export function msoToVcd(channels: readonly { role: string; bytes: Uint8Array; xinc: number; xorig: number }[]): string {
  const out: Record<string, [number, string][]> = {}
  for (const c of channels) {
    if (!(c.xinc > 0)) throw new ToolError(`${c.role}: the instrument gave no sample interval`)
    const s = new Signal(c.role)
    c.bytes.forEach((b, i) => s.push(i * c.xinc, String(b & 1)))
    out[c.role] = s.t.map((t, k) => [t, s.v[k] as string])
  }
  return writeVcd(out, { timescale: '1ps', scope: 'mso' })
}
