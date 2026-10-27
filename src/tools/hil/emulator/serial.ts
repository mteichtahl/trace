/**
 * The sample board's firmware console, for the bench emulator: a pseudo-terminal (/dev/pts/N) that the hil serial
 * tools open like a USB serial adapter.
 *
 * Node cannot create a pty without a native module, so a small Python script (standard library only:
 * python/tracebridge/ptyrelay.py) opens one and relays bytes over its stdin/stdout; the firmware itself is
 * played here. POSIX only (Linux, macOS), and it needs python3 (or TRACE_PYTHON).
 *
 * The firmware, while VIN is at least 4 V:
 *   at power-up      boot trace-sample fw 0.1.0
 *   once a second    adc raw=3722 mv=11998          (the ADC code and VIN worked back from it)
 *   every 5 s        temp mcu_c=25.0
 *   READ             adc raw=3722 mv=11998          (answered at once)
 *   ID               trace-sample fw 0.1.0
 *   HELP             the commands
 *   anything else    ERR unknown command: <it>
 * With VIN below 4 V it is unpowered: no output, and commands get no answer. Output written while no program has the
 * port open is dropped, as on a UART with nothing listening.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AMBIENT_C, BOOT_V, firmwareReading } from './board.js'

const RELAY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'python', 'tracebridge', 'ptyrelay.py')
export const FIRMWARE_ID = 'trace-sample fw 0.1.0'

function python(): string {
  const env = process.env.TRACE_PYTHON
  if (env && existsSync(env)) return env
  return 'python3'
}

/** Why the emulated serial port cannot be offered here, or null when it can. */
export function serialUnavailable(): string | null {
  if (process.platform === 'win32') return 'Windows has no pseudo-terminals; the emulated serial port needs Linux or macOS'
  if (!existsSync(RELAY)) return `the pty relay is missing (${RELAY})`
  const r = spawnSync(python(), ['-c', 'import os, pty, tty, termios'], { timeout: 10_000 })
  if (r.error || r.status !== 0) return `python3 is needed for the emulated serial port (${r.error?.message ?? `exit ${r.status}`})`
  return null
}

export class FirmwareConsole {
  private proc: ChildProcessWithoutNullStreams | null = null
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private powered = false
  private rx = ''
  /** the pty's device path */
  device = ''
  /** a stable symlink to it, when one could be made (settings written once survive restarts) */
  link: string | null = null

  constructor(private readonly vin: () => number) {}

  /** the path to put in hil.serial */
  get path(): string {
    return this.link ?? this.device
  }

  async start(linkPath?: string): Promise<void> {
    const why = serialUnavailable()
    if (why) throw new Error(why)
    const proc = spawn(python(), [RELAY], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
    this.device = await new Promise<string>((resolve, reject) => {
      let first = ''
      const timer = setTimeout(() => reject(new Error(`the pty relay did not start in 10 s: ${stderr}`)), 10_000)
      const onData = (d: Buffer): void => {
        first += d.toString('latin1')
        const i = first.indexOf('\n')
        if (i < 0) return
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        const rest = first.slice(i + 1)
        if (rest) this.onInput(rest)
        proc.stdout.on('data', (x: Buffer) => this.onInput(x.toString('latin1')))
        resolve(first.slice(0, i).trim())
      }
      proc.stdout.on('data', onData)
      proc.once('error', (e) => { clearTimeout(timer); reject(e) })
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the pty relay exited (${code}): ${stderr}`)) })
    })
    proc.on('error', () => undefined)
    if (linkPath) {
      try {
        mkdirSync(dirname(linkPath), { recursive: true })
        rmSync(linkPath, { force: true })
        symlinkSync(this.device, linkPath)
        this.link = linkPath
      } catch {
        this.link = null
      }
    }
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
    this.poll()
  }

  /** Power follows VIN: called when the supply changes, so the boot line comes at power-up rather than up to 1 s later. */
  poll(): void {
    const on = this.vin() >= BOOT_V
    if (on && !this.powered) { this.ticks = 0; this.write(`boot ${FIRMWARE_ID}`) }
    if (!on) this.rx = ''
    this.powered = on
  }

  private tick(): void {
    this.poll()
    if (!this.powered) return
    this.ticks++
    this.write(this.adcLine())
    if (this.ticks % 5 === 0) this.write(`temp mcu_c=${AMBIENT_C.toFixed(1)}`)
  }

  private adcLine(): string {
    const r = firmwareReading(this.vin())
    return `adc raw=${r.raw} mv=${r.mv}`
  }

  private write(line: string): void {
    if (!this.proc || this.proc.stdin.destroyed) return
    this.proc.stdin.write(`${line}\r\n`)
  }

  private onInput(s: string): void {
    if (!this.powered) return
    this.rx += s
    let i: number
    while ((i = this.rx.search(/[\r\n]/)) >= 0) {
      const line = this.rx.slice(0, i).trim()
      this.rx = this.rx.slice(i + 1)
      if (!line) continue
      const cmd = line.toUpperCase()
      if (cmd === 'READ') this.write(this.adcLine())
      else if (cmd === 'ID') this.write(FIRMWARE_ID)
      else if (cmd === 'HELP') this.write('commands: READ ID HELP')
      else this.write(`ERR unknown command: ${line.slice(0, 60)}`)
    }
    if (this.rx.length > 4096) this.rx = ''
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const proc = this.proc
    this.proc = null
    if (this.link) { try { rmSync(this.link, { force: true }) } catch { /* gone */ } }
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 2000)
      proc.once('exit', () => { clearTimeout(timer); resolve() })
      proc.stdin.end()
    })
  }
}
