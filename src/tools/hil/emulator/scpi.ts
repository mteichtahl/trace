/**
 * A simulated SCPI instrument on a local TCP port: newline-terminated commands, an error queue, and state. It can be
 * a power supply (Rigol DP800 or Keysight E36 dialect), an oscilloscope (Rigol DS1000Z dialect, by default a 1 kHz
 * square wave with known amplitude) or a DMM (Keysight 34465A). Every command received is logged so tests can check
 * the exact text a dialect generates. State is plain TypeScript; nothing is read from fixture files.
 *
 * On its own it is the hil tests' fake instrument (test/tools/hil/fake-scpi.ts re-exports it). With a `model` it is
 * one instrument of the bench emulator (bench.ts), which wires the instruments to a model of a circuit: what the DMM
 * reads and what the scope shows then follow the power supply.
 */
import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

export type FakeKind = 'rigol-dp832' | 'keysight-e36312a' | 'rigol-ds1104z' | 'keysight-34465a'

export interface PsuChannel {
  v: number
  i: number
  on: boolean
  /** load resistance in ohms (measured current = v / r, clamped at the limit) */
  r: number
}

/** Hooks that tie an instrument to a circuit model (bench.ts). Anything left out keeps the plain fake's behaviour. */
export interface ScpiModel {
  /** the DMM's reading for its configured function (VOLT:DC, CURR:DC, RES, FRES, TEMP, …) */
  dmmReading?(func: string): number
  /** a scope channel's samples in volts (`points` of them, `xinc` apart, starting at `xorig`), or null for the default square */
  waveform?(ch: number, points: number, xinc: number, xorig: number): Float64Array | null
  /** a scope measurement item (VPP, RTIM, …) the model knows better than the samples, or null */
  measureItem?(item: string, ch: number): number | null
  /** called after each command the instrument understood (a PSU tells the model its output changed) */
  onCommand?(cmd: string): void
}

/** The scope's time of the first sample, relative to the trigger (the fixed DS1000Z screen the fake shows). */
const XORIG = -6e-4

export class FakeScpi {
  readonly log: string[] = []
  readonly errors: string[] = []
  psu: PsuChannel[] = [1, 2, 3].map(() => ({ v: 0, i: 0.1, on: false, r: 100 }))
  selected = 1
  /** scope state */
  scope = { running: true, triggerStatus: 'STOP', source: 1, points: 1200, vpp: 3.2, freq: 1000, xinc: 5e-6, chanScale: [1, 1, 1, 1] }
  dmm = { func: 'VOLT:DC', reading: 3.3012 }
  /** do not answer this command (to test timeouts) */
  silent: RegExp | null = null
  /** a scope whose trigger never comes */
  neverTrigger = false
  /** keep the command log (a long-running emulator turns it off so it does not grow for ever) */
  keepLog = true
  model: ScpiModel = {}
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  constructor(readonly kind: FakeKind) {}

  get idn(): string {
    switch (this.kind) {
      case 'rigol-dp832': return 'RIGOL TECHNOLOGIES,DP832,DP8C000001,00.01.16'
      case 'keysight-e36312a': return 'Keysight Technologies,E36312A,MY00000001,2.1.0-1.0.4-1.12'
      case 'rigol-ds1104z': return 'RIGOL TECHNOLOGIES,DS1104Z,DS1ZA000000001,00.04.04.SP3'
      case 'keysight-34465a': return 'Keysight Technologies,34465A,MY00000002,A.03.01-02.40-03.01-00.52-02-01'
    }
  }

  /** The port it listens on (after start). */
  port = 0
  host = '127.0.0.1'

  /** Listen on `host`:`port` (0: any free port). Returns the address in hil.instruments form. */
  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((sock) => {
      this.sockets.add(sock)
      sock.on('close', () => this.sockets.delete(sock))
      let buf = ''
      sock.on('data', (d: Buffer) => {
        buf += d.toString('latin1')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) for (const cmd of line.split(';')) this.handle(cmd.trim(), sock)
        }
      })
      sock.on('error', () => undefined)
    })
    const server = this.server
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        reject(e.code === 'EADDRINUSE' ? new Error(`${host}:${port} is already in use (choose another port, or 0 for any free one)`) : e)
      })
      server.listen(port, host, () => resolve())
    })
    this.port = (server.address() as AddressInfo).port
    this.host = host
    return `TCPIP::${host}::${this.port}::SOCKET`
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    const server = this.server
    this.server = null
    await new Promise<void>((r) => (server?.listening ? server.close(() => r()) : r()))
  }

  /** Commands received, without the identification/error-queue chatter every session has. */
  commands(): string[] {
    return this.log.filter((c) => !/^\*IDN\?$|^SYST:ERR\?$/i.test(c))
  }

  private reply(sock: Socket, s: string | Buffer): void {
    sock.write(typeof s === 'string' ? `${s}\n` : Buffer.concat([s, Buffer.from('\n')]))
  }

  private ch(n: number): PsuChannel {
    const c = this.psu[n - 1]
    if (!c) throw new Error(`no channel ${n}`)
    return c
  }

  measuredI(c: PsuChannel): number {
    return c.on ? Math.min(c.v / c.r, c.i) : 0
  }

  private handle(cmd: string, sock: Socket): void {
    if (this.keepLog) this.log.push(cmd)
    if (this.silent?.test(cmd)) return
    const u = cmd.toUpperCase()
    if (u === '*IDN?') return this.reply(sock, this.idn)
    if (u === '*RST') return
    if (u === '*OPC?') return this.reply(sock, '1')
    if (u === 'SYST:ERR?' || u === ':SYST:ERR?') return this.reply(sock, this.errors.shift() ?? '0,"No error"')
    try {
      const known = (this.kind === 'rigol-dp832' && this.rigolPsu(u, sock)) ||
        (this.kind === 'keysight-e36312a' && this.keysightPsu(u, sock)) ||
        (this.kind === 'rigol-ds1104z' && this.rigolScope(u, sock)) ||
        (this.kind === 'keysight-34465a' && this.dmmCmd(u, sock))
      if (known) { this.model.onCommand?.(u); return }
    } catch {
      /* fall through to the error */
    }
    this.errors.push('-113,"Undefined header"')
    // an instrument's error queue is bounded (the 34465A keeps 20); a long-running emulator must not grow for ever
    if (this.errors.length > 20) this.errors.splice(0, this.errors.length - 20)
  }

  private rigolPsu(u: string, sock: Socket): boolean {
    let m: RegExpExecArray | null
    if ((m = /^:SOUR(\d):VOLT ([\d.eE+-]+)$/.exec(u))) { this.ch(Number(m[1])).v = Number(m[2]); return true }
    if ((m = /^:SOUR(\d):CURR ([\d.eE+-]+)$/.exec(u))) { this.ch(Number(m[1])).i = Number(m[2]); return true }
    if ((m = /^:SOUR(\d):VOLT\?$/.exec(u))) { this.reply(sock, this.ch(Number(m[1])).v.toFixed(3)); return true }
    if ((m = /^:SOUR(\d):CURR\?$/.exec(u))) { this.reply(sock, this.ch(Number(m[1])).i.toFixed(3)); return true }
    if ((m = /^:OUTP CH(\d),(ON|OFF)$/.exec(u))) { this.ch(Number(m[1])).on = m[2] === 'ON'; return true }
    if ((m = /^:OUTP\? CH(\d)$/.exec(u))) { this.reply(sock, this.ch(Number(m[1])).on ? 'ON' : 'OFF'); return true }
    if ((m = /^:MEAS:VOLT\? CH(\d)$/.exec(u))) { const c = this.ch(Number(m[1])); this.reply(sock, (c.on ? c.v : 0).toFixed(4)); return true }
    if ((m = /^:MEAS:CURR\? CH(\d)$/.exec(u))) { this.reply(sock, this.measuredI(this.ch(Number(m[1]))).toFixed(4)); return true }
    return false
  }

  private keysightPsu(u: string, sock: Socket): boolean {
    let m: RegExpExecArray | null
    const c = (): PsuChannel => this.ch(this.selected)
    if ((m = /^INST:NSEL (\d)$/.exec(u))) { this.selected = Number(m[1]); return true }
    if ((m = /^VOLT ([\d.eE+-]+)$/.exec(u))) { c().v = Number(m[1]); return true }
    if ((m = /^CURR ([\d.eE+-]+)$/.exec(u))) { c().i = Number(m[1]); return true }
    if (u === 'VOLT?') { this.reply(sock, `+${c().v.toExponential(5)}`); return true }
    if (u === 'CURR?') { this.reply(sock, `+${c().i.toExponential(5)}`); return true }
    if ((m = /^OUTP (ON|OFF)$/.exec(u))) { c().on = m[1] === 'ON'; return true }
    if (u === 'OUTP?') { this.reply(sock, c().on ? '1' : '0'); return true }
    if (u === 'MEAS:VOLT?') { this.reply(sock, `+${(c().on ? c().v : 0).toExponential(5)}`); return true }
    if (u === 'MEAS:CURR?') { this.reply(sock, `+${this.measuredI(c()).toExponential(5)}`); return true }
    return false
  }

  /** The model's samples for a channel, or null when it shows the default square. */
  private modelVolts(ch: number): Float64Array | null {
    const s = this.scope
    return this.model.waveform?.(ch, s.points, s.xinc, XORIG) ?? null
  }

  /** Rigol DS1000Z: 8-bit codes of the source channel. By default a square wave of `vpp` volts at `freq` Hz, centred on 0 V. */
  waveCodes(): Buffer {
    const s = this.scope
    const yinc = this.yinc()
    const codes = Buffer.alloc(s.points)
    const volts = this.modelVolts(s.source)
    if (volts) {
      for (let i = 0; i < s.points; i++) codes[i] = Math.max(0, Math.min(255, Math.round((volts[i] ?? 0) / yinc + 127)))
      return codes
    }
    const half = s.vpp / 2
    for (let i = 0; i < s.points; i++) {
      const t = i * s.xinc
      const high = (t * s.freq) % 1 < 0.5
      const v = high ? half : -half
      codes[i] = Math.round(v / yinc + 127)
    }
    return codes
  }

  yinc(): number {
    return (this.scope.chanScale[this.scope.source - 1] ?? 1) * 8 / 200
  }

  private measure(item: string, ch: number): number {
    const own = this.model.measureItem?.(item, ch)
    if (own !== undefined && own !== null) return own
    const volts = this.modelVolts(ch)
    if (!volts) {
      if (item === 'VPP') return this.scope.vpp
      if (item === 'FREQ') return this.scope.freq
      return 9.9e37
    }
    let max = -Infinity, min = Infinity, sum = 0, sq = 0
    for (const v of volts) { max = Math.max(max, v); min = Math.min(min, v); sum += v; sq += v * v }
    switch (item) {
      case 'VPP': return max - min
      case 'VMAX': return max
      case 'VMIN': return min
      case 'VAVG': return sum / volts.length
      case 'VRMS': return Math.sqrt(sq / volts.length)
      default: return 9.9e37
    }
  }

  private rigolScope(u: string, sock: Socket): boolean {
    let m: RegExpExecArray | null
    const s = this.scope
    if (u === ':RUN') { s.running = true; s.triggerStatus = 'AUTO'; return true }
    if (u === ':STOP') { s.running = false; s.triggerStatus = 'STOP'; return true }
    if (u === ':SING') { s.triggerStatus = 'WAIT'; if (!this.neverTrigger) setTimeout(() => { s.triggerStatus = 'STOP' }, 150); return true }
    if (u === ':TRIG:STAT?') { this.reply(sock, s.triggerStatus); return true }
    if ((m = /^:WAV:SOUR CHAN(\d)$/.exec(u))) { s.source = Number(m[1]); return true }
    if (/^:WAV:(MODE|FORM) /.test(u)) return true
    if ((m = /^:CHAN(\d):SCAL ([\d.eE+-]+)$/.exec(u))) { s.chanScale[Number(m[1]) - 1] = Number(m[2]); return true }
    if (/^:CHAN\d:(DISP|PROB|COUP|OFFS) /.test(u)) return true
    if (/^:TIM:MAIN:(SCAL|OFFS) /.test(u)) return true
    if (/^:TRIG:(MODE|EDGE:SOUR|EDGE:SLOP|EDGE:LEV) /.test(u)) return true
    if (u === ':WAV:PRE?') {
      // format,type,points,count,xinc,xorig,xref,yinc,yorig,yref
      this.reply(sock, `0,0,${s.points},1,${s.xinc.toExponential(6)},${XORIG.toExponential(6)},0,${this.yinc().toExponential(6)},0,127`)
      return true
    }
    if (u === ':WAV:DATA?') {
      const d = this.waveCodes()
      const len = String(d.length)
      this.reply(sock, Buffer.concat([Buffer.from(`#9${len.padStart(9, '0')}`), d]))
      return true
    }
    if ((m = /^:MEAS:ITEM\? (\w+),CHAN(\d)$/.exec(u))) {
      this.reply(sock, this.measure(m[1] ?? '', Number(m[2])).toExponential(4))
      return true
    }
    return false
  }

  private dmmCmd(u: string, sock: Socket): boolean {
    let m: RegExpExecArray | null
    if ((m = /^CONF:([A-Z:]+)( .+)?$/.exec(u))) { this.dmm.func = m[1] ?? ''; return true }
    if (/^[A-Z:]+:NPLC [\d.]+$/.test(u)) return true
    if (/^UNIT:TEMP [CFK]$/.test(u)) return true
    if (u === 'READ?') {
      const v = this.model.dmmReading?.(this.dmm.func) ?? this.dmm.reading
      this.reply(sock, `${v < 0 ? '-' : '+'}${Math.abs(v).toExponential(8).toUpperCase()}`)
      return true
    }
    return false
  }
}
