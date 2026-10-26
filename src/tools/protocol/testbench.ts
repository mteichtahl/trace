/**
 * A self-checking Verilog testbench from a protocol model run: the signals the initiator drives are replayed into
 * the DUT edge for edge (the model's timing, at 1 ps), and every bit the DUT must drive is checked at the instant the
 * initiator samples it. So an HDL SPI slave, I2C target or UART receiver is tested against exactly the transactions
 * (and timing) the model was given.
 *
 *   spi   DUT ports for sck, cs (cs0 …), mosi, miso; MISO checked at each sampling edge against the transfer's miso
 *         words. Words the DUT is not expected to answer (miso omitted) are checked as the model's default 0.
 *   i2c   DUT ports for scl, sda_in and sda_low (the DUT pulls SDA low while sda_low is 1): the bus is the wired AND
 *         of the testbench master and the DUT. ACKs and read data are checked on SCL's high phase.
 *   uart  DUT ports for rx, data and valid, and a clock: each valid strobe's data is checked against the next
 *         expected byte, and the count at the end.
 *
 * Every check that fails prints MISMATCH and the run ends with $fatal; a clean run prints ALL TESTS PASSED (sim.logic
 * pass pattern). Functional coverage goes out as TRACE_COVER lines (verify.run records them as hits): one per
 * transaction that completed without a mismatch, and one per response value seen (0 and 1, or each byte).
 */
import { ModelError, type WaveBuilder } from './waveform.js'

export interface DutSpec {
  module: string
  instance?: string | undefined
  /** role → DUT port name */
  ports: Record<string, string>
  /** DUT inputs tied to constants: port → Verilog expression, e.g. {"sample": "12'h5a3"} */
  ties?: Record<string, string> | undefined
  params?: Record<string, string | number> | undefined
  clock?: { port: string; hz: number } | undefined
  reset?: { port: string; active: 0 | 1; s: number } | undefined
  /** data width for a UART receiver's data port (default 8) */
  data_bits?: number | undefined
}

const PS = (t: number): number => Math.round(t * 1e12)

const vName = (n: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n)) throw new ModelError(`${JSON.stringify(n)} is not a Verilog identifier`)
  return n
}

export function verilogTestbench(o: { protocol: 'spi' | 'i2c' | 'uart'; wave: WaveBuilder; dut: DutSpec; name?: string; expectedBytes?: readonly number[]; txWindows?: readonly [number, number][] }): string {
  const w = o.wave
  const tb = vName(o.name ?? `${o.dut.module}_tb`)
  const dut = o.dut
  const inst = vName(dut.instance ?? 'dut')
  const port = (role: string): string => {
    const p = dut.ports[role]
    if (!p) throw new ModelError(`dut.ports needs ${role}`)
    return vName(p)
  }
  const offset = dut.reset ? dut.reset.s : 0
  const decl: string[] = []
  const conn: string[] = []
  const stim: [number, string, string][] = [] // [ps, reg, value]
  const checks: string[] = []
  const cover: string[] = []
  const initial: string[] = []
  // the replayed initiator signals
  const replay = (sig: string, reg: string): void => {
    const ch = w.changes(sig)
    initial.push(`${reg} = 1'b${toBit(ch[0]?.[1] ?? '0')};`)
    for (const [t, v] of ch.slice(1)) stim.push([PS(t + offset), reg, toBit(v)])
  }
  if (o.protocol === 'spi') {
    const css = w.names().filter((n) => /^cs\d*$/.test(n))
    decl.push('reg sck;', 'reg mosi;', ...css.map((c) => `reg ${c};`), 'wire miso;')
    replay('sck', 'sck')
    if (w.has('mosi')) replay('mosi', 'mosi')
    for (const c of css) replay(c, c)
    conn.push(`.${port('sck')}(sck)`, `.${port('mosi')}(mosi)`, `.${port('miso')}(miso)`)
    for (const c of css) conn.push(`.${port(c)}(${c})`)
    // checked 1 ps before the sampling edge: the value a flip-flop clocked by that edge takes
    w.samples.filter((s) => s.signal === 'miso').forEach((s) => checks.push(check(PS(s.t + offset) - 1, 'miso', s.expected, s.label)))
  } else if (o.protocol === 'i2c') {
    decl.push('reg scl;', 'reg sda_m;', 'wire dut_sda_low;', 'wire sda = sda_m & ~dut_sda_low;')
    replay('scl', 'scl')
    replay('sda_m', 'sda_m')
    conn.push(`.${port('scl')}(scl)`, `.${port('sda_in')}(sda)`, `.${port('sda_low')}(dut_sda_low)`)
    w.samples.filter((s) => s.signal === 'sda').forEach((s) => checks.push(check(PS(s.t + offset), 'sda', s.expected, s.label)))
  } else {
    if (!dut.clock) throw new ModelError('a UART receiver needs dut.clock (its port and frequency)')
    const bits = dut.data_bits ?? 8
    decl.push('reg rx;', `wire [${bits - 1}:0] rx_data;`, 'wire rx_valid;')
    replay('tx', 'rx')
    conn.push(`.${port('rx')}(rx)`, `.${port('data')}(rx_data)`, `.${port('valid')}(rx_valid)`)
  }
  if (dut.clock) {
    decl.push('reg clk = 1\'b0;')
    conn.push(`.${vName(dut.clock.port)}(clk)`)
  }
  if (dut.reset) {
    decl.push(`reg rst = 1'b${dut.reset.active};`)
    conn.push(`.${vName(dut.reset.port)}(rst)`)
  }
  for (const [p, e] of Object.entries(dut.ties ?? {})) {
    if (/[;`$]/.test(e)) throw new ModelError(`tie ${p}: ${JSON.stringify(e)} is not a constant expression`)
    conn.push(`.${vName(p)}(${e})`)
  }
  stim.sort((a, b) => a[0] - b[0])
  const lines: string[] = []
  let now = 0
  for (const [t, reg, v] of stim) {
    if (t > now) { lines.push(`    #${t - now};`); now = t }
    lines.push(`    ${reg} = 1'b${v};`)
  }
  const end = PS(w.end + offset) + 1000
  const params = Object.entries(dut.params ?? {}).map(([k, v]) => `.${vName(k)}(${typeof v === 'number' ? v : v})`)
  // per transaction coverage: a transaction is covered when none of its checks failed
  const windows = o.txWindows ?? []
  const nTx = windows.length
  const out: string[] = [
    '// Generated by trace protocol.testbench: the model\'s initiator signals replayed into the DUT, its responses checked.',
    `// ${o.protocol}, ${w.samples.length} response bit check(s), ${nTx} transaction(s), DUT ${dut.module}. Regenerate it rather than edit it.`,
    '`timescale 1ps/1ps',
    `module ${tb};`,
    ...decl.map((d) => `  ${d}`),
    '  integer errors = 0;',
    '  integer checked = 0;',
    nTx ? `  reg [${Math.max(1, nTx) - 1}:0] tx_bad = 0;` : '',
    '  reg seen0 = 0, seen1 = 0;',
    `  ${dut.module}${params.length ? ` #(${params.join(', ')})` : ''} ${inst} (${conn.join(', ')});`,
  ].filter(Boolean)
  if (dut.clock) out.push(`  always #${Math.max(1, Math.round(1e12 / dut.clock.hz / 2))} clk = ~clk;`)
  out.push('  initial begin', ...initial.map((l) => `    ${l}`))
  // the reset is released before the first stimulus: the reset time is added to every stimulus time
  if (dut.reset) out.push(`    #${PS(dut.reset.s)}; rst = 1'b${1 - dut.reset.active};`)
  out.push('  end')
  out.push('  initial begin', ...lines, '  end')
  if (checks.length) {
    out.push('  initial begin')
    let t0 = 0
    for (const c of checks) {
      const m = /^#(\d+) /.exec(c)
      const t = Number(m?.[1] ?? 0)
      out.push(`    #${t - t0};`, `    ${c.replace(/^#\d+ /, '')}`)
      t0 = t
    }
    out.push('  end')
  }
  if (o.protocol === 'uart') {
    const exp = o.expectedBytes ?? []
    out.push(`  reg [${(dut.data_bits ?? 8) - 1}:0] expected [0:${Math.max(0, exp.length - 1)}];`, '  integer idx = 0;', '  initial begin', ...exp.map((v, k) => `    expected[${k}] = ${dut.data_bits ?? 8}'h${v.toString(16)};`), '  end')
    out.push('  always @(posedge clk) if (rx_valid) begin',
      `    if (idx >= ${exp.length}) begin errors = errors + 1; $display("MISMATCH: an extra byte %h at %0t", rx_data, $time); end`,
      '    else if (rx_data !== expected[idx]) begin errors = errors + 1; $display("MISMATCH byte %0d at %0t: got %h expected %h", idx, $time, rx_data, expected[idx]); end',
      '    else $display("TRACE_COVER uart_byte_%0d", idx);',
      '    checked = checked + 1;',
      '    idx = idx + 1;',
      '  end')
    cover.push(`    if (idx !== ${exp.length}) begin errors = errors + 1; $display("MISMATCH: received %0d bytes, expected ${exp.length}", idx); end`)
  }
  out.push('  initial begin', `    #${end};`, ...cover)
  if (nTx && o.protocol !== 'uart') {
    for (let k = 0; k < nTx; k++) out.push(`    if (!tx_bad[${k}]) $display("TRACE_COVER ${o.protocol}_tx_${k}");`)
  }
  if (o.protocol !== 'uart') out.push(`    if (seen0) $display("TRACE_COVER ${o.protocol}_response_0");`, `    if (seen1) $display("TRACE_COVER ${o.protocol}_response_1");`)
  out.push('    $display("checked %0d response(s), %0d mismatch(es)", checked, errors);',
    '    if (errors == 0) $display("ALL TESTS PASSED");',
    '    else $fatal(1, "%0d mismatch(es)", errors);',
    '    $finish;',
    '  end',
    'endmodule',
    '')
  // each failing check marks its transaction (tx_bad), so a transaction's coverage point is printed only when clean
  if (nTx && checks.length) {
    const text = out.join('\n')
    return text.replace(/__TX__\((\d+)\)/g, (_m, ps: string) => {
      const t = Number(ps) / 1e12 - offset
      const k = windows.findIndex(([a, b]) => t >= a - 1e-12 && t <= b + 1e-12)
      return k >= 0 ? `tx_bad[${k}] = 1'b1;` : ''
    })
  }
  return out.join('\n').replace(/__TX__\(\d+\)/g, '')
}

function toBit(v: string): string {
  if (v === '0' || v === '1') return v
  if (v === 'z') return 'z'
  return 'x'
}

function check(ps: number, sig: string, expected: '0' | '1', label: string): string {
  const safe = label.replace(/["\\]/g, '')
  return `#${ps} begin checked = checked + 1; if (${sig} === 1'b0) seen0 = 1; if (${sig} === 1'b1) seen1 = 1; if (${sig} !== 1'b${expected}) begin errors = errors + 1; __TX__(${ps}) $display("MISMATCH ${safe} at %0t: ${sig}=%b expected ${expected}", $time, ${sig}); end end`
}
