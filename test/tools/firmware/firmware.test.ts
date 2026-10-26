/**
 * The firmware loop offline: fixture project trees written by the tests (no fixture files in the repository), a fake
 * `make` project whose build prints gcc- and rustc-style diagnostics, canned `size` output, and the refusal paths of
 * flash and logs. Programs that are not installed (probe-rs, pio, west…) are exercised by their absence.
 */
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolve as resolveCfg, setValue } from '../../../src/core/config.js'
import { Registry } from '../../../src/core/registry.js'
import { Work } from '../../../src/core/store.js'
import { detectAll, detectWithEvidence, tomlStrings } from '../../../src/tools/firmware/detect.js'
import { fill } from '../../../src/tools/firmware/presets.js'
import { diagnostics, memoryRegions, parseSize, programsIn, run } from '../../../src/tools/firmware/run.js'
import { tools } from '../../../src/tools/firmware/tools.js'

const reg = new Registry(tools)
const hw = { hardware: true, via: 'test' as const }
type Obj = Record<string, unknown>
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, hw)) as Obj

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fw-'))
  mkdirSync(join(root, '.git'))
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}

/** Run the tools with the repository at `root` (settings in its own .trace/project.db). */
function inRepo(root: string): void {
  delete process.env.TRACE_PROJECT_DB
  process.chdir(root)
}

describe('detect', () => {
  it('recognises each preset from a small tree', () => {
    const root = tree({
      'fw/rust/Cargo.toml': '[package]\nname = "supervisor-fw"\n\n[[bin]]\nname = "supervisor"\npath = "src/main.rs"\n\n[dependencies]\nembassy-rp = "0.10"\n',
      'fw/rust/.cargo/config.toml': "[target.'cfg(all(target_arch = \"arm\", target_os = \"none\"))']\nrunner = \"probe-rs run --chip RP235x\"\n\n[build]\ntarget = \"thumbv8m.main-none-eabihf\"\n",
      'fw/rust/memory.x': 'MEMORY { FLASH : ORIGIN = 0x10000000, LENGTH = 2048K\n RAM : ORIGIN = 0x20000000, LENGTH = 512K }\n',
      'fw/rust/src/main.rs': '#![no_std]\n',
      'fw/pio/platformio.ini': '[platformio]\ndefault_envs = pico\n\n[env:pico]\nplatform = raspberrypi\nboard = pico\nframework = arduino\n\n[env:esp]\nboard = esp32dev\n',
      'fw/zephyr-app/prj.conf': 'CONFIG_GPIO=y\n',
      'fw/zephyr-app/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nset(BOARD nrf52840dk_nrf52840)\nfind_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})\nproject(blinky)\n',
      'fw/idf/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(sensor-node)\n',
      'fw/idf/sdkconfig.defaults': 'CONFIG_IDF_TARGET="esp32s3"\n',
      'fw/pico/CMakeLists.txt': 'include(pico_sdk_import.cmake)\nproject(blink C CXX ASM)\nset(PICO_PLATFORM rp2350)\npico_sdk_init()\nadd_executable(blink blink.c)\n',
      'fw/sketch/sketch.ino': 'void setup() {}\nvoid loop() {}\n',
      'fw/sketch/sketch.yaml': 'default_fqbn: arduino:avr:uno\n',
      'fw/bare/Makefile': 'TARGET = bare\nCC = arm-none-eabi-gcc\nall:\n\t$(CC) main.c\nflash:\n\topenocd -f x\n',
      'docs/Makefile': 'html:\n\tsphinx-build . _build\n', // not firmware
      'node_modules/x/platformio.ini': '[env:x]\n', // skipped
    })
    const found = detectWithEvidence(root)
    const by = Object.fromEntries(found.map((d) => [d.target.preset, d.target]))
    expect(found.map((d) => d.target.preset).sort()).toEqual(['arduino', 'cargo', 'esp-idf', 'make', 'pico-sdk', 'platformio', 'zephyr'])
    expect(by.cargo).toMatchObject({ name: 'supervisor-fw', path: 'fw/rust', chip: 'RP235x', artifact: 'target/thumbv8m.main-none-eabihf/release/supervisor' })
    expect(by.platformio).toMatchObject({ path: 'fw/pio', pio_env: 'pico', chip: 'pico', artifact: '.pio/build/pico/firmware.elf' })
    expect(by.zephyr).toMatchObject({ path: 'fw/zephyr-app', chip: 'nrf52840dk_nrf52840' })
    expect(by['esp-idf']).toMatchObject({ name: 'sensor-node', chip: 'esp32s3', artifact: 'build/sensor-node.elf' })
    expect(by['pico-sdk']).toMatchObject({ name: 'blink', chip: 'rp2350', artifact: 'build/blink.elf' })
    expect(by.arduino).toMatchObject({ name: 'sketch', chip: 'arduino:avr:uno' })
    expect(by.make).toMatchObject({ name: 'bare', path: 'fw/bare' })
    // onboarding's entry point gives the same targets, valid against the settings schema
    const targets = detectAll(root)
    expect(targets).toHaveLength(7)
    expect(resolveCfg({ 'firmware.targets': targets }).errors).toEqual([])
  })

  it('does not take a host-only Rust crate for firmware', () => {
    const root = tree({ 'Cargo.toml': '[package]\nname = "cli"\n[dependencies]\nclap = "4"\n', 'src/main.rs': 'fn main(){}' })
    expect(detectAll(root)).toEqual([])
  })

  it('reads the TOML it needs', () => {
    const t = tomlStrings('[build]\ntarget = "thumbv6m-none-eabi" # comment\n[target.thumbv6m-none-eabi]\nrunner = \'probe-rs run --chip RP2040\'\n')
    expect(t.get('build.target')).toBe('thumbv6m-none-eabi')
    expect(t.get('target.thumbv6m-none-eabi.runner')).toBe('probe-rs run --chip RP2040')
  })

  it('is offered as a tool, relative to the repository', async () => {
    const root = tree({ 'firmware/Makefile': 'flash:\n\techo\n' })
    inRepo(root)
    const r = await call('firmware.detect', {})
    expect(r.found).toBe(1)
    expect((r.targets as Obj[])[0]).toMatchObject({ preset: 'make', path: 'firmware' })
  })
})

describe('parsing', () => {
  it('counts gcc/clang and rustc diagnostics and keeps the first errors with file:line', () => {
    const out = [
      '\x1b[1msrc/main.c:12:5: \x1b[31merror:\x1b[0m implicit declaration of function \'foo\'',
      'src/main.c:30:1: warning: unused variable \'x\' [-Wunused-variable]',
      'include/board.h:7: error: expected \';\' before \'}\' token',
      'drivers/spi.c:88:12: fatal error: hal.h: No such file or directory',
      '/usr/bin/arm-none-eabi-ld: build/app.elf section `.text\' will not fit in region `FLASH\'',
      'error[E0308]: mismatched types',
      '  --> src/slots.rs:42:17',
      '   |',
      'warning: unused import: `core::fmt`',
      ' --> src/lib.rs:3:5',
      'warning: `fw` (bin "fw") generated 1 warning',
      'error: could not compile `fw` (bin "fw") due to 1 previous error',
      'error: aborting due to 1 previous error',
    ].join('\n')
    const d = diagnostics(out)
    expect(d.errors).toBe(5)
    expect(d.warnings).toBe(2)
    expect(d.first_errors[0]).toEqual({ severity: 'error', file: 'src/main.c', line: 12, col: 5, message: "implicit declaration of function 'foo'" })
    expect(d.first_errors[1]).toMatchObject({ file: 'include/board.h', line: 7 })
    expect(d.first_errors[2]).toMatchObject({ file: 'drivers/spi.c', message: 'hal.h: No such file or directory' })
    expect(d.first_errors[3]?.message).toMatch(/will not fit in region `FLASH'/)
    expect(d.first_errors[4]).toEqual({ severity: 'error', code: 'E0308', message: 'mismatched types', file: 'src/slots.rs', line: 42, col: 17 })
    expect(d.first_warnings[1]).toMatchObject({ file: 'src/lib.rs', line: 3 })
  })

  it('tells an environment failure from a code failure', () => {
    expect(diagnostics('error: failed to create directory `/root/.cargo/registry/cache`\nPermission denied (os error 13)').environment).toMatch(/cargo home/)
    expect(diagnostics('error[E0463]: can\'t find crate for `core`\n  = note: the `thumbv6m-none-eabi` target may not be installed').environment).toMatch(/rustup target add/)
  })

  it('parses size output into flash and RAM', () => {
    const berkeley = '   text\t   data\t    bss\t    dec\t    hex\tfilename\n  48212\t    616\t  12840\t  61668\t   f0e4\tbuild/app.elf\n'
    expect(parseSize(berkeley)).toEqual([{ file: 'build/app.elf', text: 48212, data: 616, bss: 12840, flash_bytes: 48828, ram_bytes: 13456 }])
    const cargoSize = '    Finished release [optimized] target(s) in 0.05s\n   text    data     bss     dec     hex filename\n 131072    1024   40960  173056   2a400 potroller-supervisor\n'
    expect(parseSize(cargoSize)[0]).toMatchObject({ flash_bytes: 132096, ram_bytes: 41984 })
    expect(parseSize('size: build/x.elf: file format not recognized')).toEqual([])
    expect(memoryRegions('MEMORY {\n  FLASH : ORIGIN = 0x10000000, LENGTH = 2048K\n  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 0x80000\n}')).toEqual({ FLASH: 2097152, RAM: 524288 })
  })

  it('fills command templates and names a missing setting', () => {
    expect(fill('probe-rs download --chip {chip} {artifact}', { chip: 'RP235x', artifact: 'a.elf' }, 't')).toBe('probe-rs download --chip RP235x a.elf')
    expect(() => fill('probe-rs download --chip {chip}', {}, 'sup')).toThrow(/sup: the command needs \{chip\}: set chip/)
    expect(programsIn('FOO=1 cmake -S . -B build && cmake --build build; probe-rs reset')).toEqual(['cmake', 'probe-rs'])
  })
})

describe('the runner', () => {
  it('times out and kills the whole process group', async () => {
    const t0 = Date.now()
    const r = await run('sleep 30 & sleep 30; wait', { cwd: tmpdir(), timeoutMs: 300 })
    expect(r.timed_out).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('stops when a regex appears', async () => {
    const r = await run('i=0; while true; do echo "tick $i"; i=$((i+1)); [ $i = 5 ] && echo READY; sleep 0.02; done', { cwd: tmpdir(), timeoutMs: 10_000, until: /READY/ })
    expect(r.matched).toBe(true)
    expect(r.timed_out).toBe(false)
    expect(r.output).toContain('tick 4')
  })

  it('keeps the head and tail of a huge output', async () => {
    const r = await run('yes x | head -c 300000', { cwd: tmpdir(), timeoutMs: 10_000, maxBytes: 10_000 })
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBeLessThan(11_000)
  })
})

describe('build, size, flash and logs on a fake make project', () => {
  let root: string
  const sources = {
    'fw/main.c': 'int main(void) { return 0; }\n',
    // `make` "builds" by writing an ELF stand-in and printing gcc diagnostics; BREAK=1 fails like a compile error
    'fw/Makefile': [
      'all:',
      '\t@echo "arm-none-eabi-gcc -c main.c"',
      '\t@echo "main.c:3:9: warning: unused variable \'n\' [-Wunused-variable]"',
      '\t@if [ -n "$(BREAK)" ]; then echo "main.c:7:1: error: expected \';\' before \'}\' token" >&2; exit 2; fi',
      '\t@mkdir -p build && printf "ELF" > build/app.elf',
      'flash:',
      '\t@echo "Programming Started"; echo "Programming Finished"; echo "Verified OK"',
      '',
    ].join('\n'),
    // a canned `size` for the artifact, put first on PATH
    'bin/arm-none-eabi-size': '#!/bin/sh\nprintf "   text\\t   data\\t    bss\\t    dec\\t    hex\\tfilename\\n  20480\\t    512\\t   4096\\t  25088\\t   6200\\t%s\\n" "$1"\n',
    'fw/memory.x': 'MEMORY { FLASH : ORIGIN = 0x08000000, LENGTH = 64K\n RAM : ORIGIN = 0x20000000, LENGTH = 16K }\n',
  }

  beforeEach(() => {
    root = tree(sources)
    inRepo(root)
    chmodSync(join(root, 'bin/arm-none-eabi-size'), 0o755)
    process.env.PATH = `${join(root, 'bin')}:${process.env.PATH ?? ''}`
    setValue('firmware.targets', [
      { name: 'fw', path: 'fw', preset: 'make', artifact: 'build/app.elf' },
      { name: 'broken', path: 'fw', preset: 'make', artifact: 'build/app.elf', build: 'make BREAK=1' },
      { name: 'rtt', path: 'fw', preset: 'cargo', chip: 'RP235x', artifact: 'build/app.elf' },
      { name: 'console', path: 'fw', preset: 'make', artifact: 'build/app.elf', serial: 'nope' },
    ])
  })

  it('builds, counts warnings, finds the artifact and its size, records the log', async () => {
    const r = await call('firmware.build', { target: 'fw' })
    expect(r).toMatchObject({ ok: true, errors: 0, warnings: 1, artifact: 'fw/build/app.elf' })
    expect(r.size).toMatchObject({ text: 20480, data: 512, bss: 4096, flash_bytes: 20992, ram_bytes: 4608, flash_pct: 32, ram_pct: 28.1, tool: 'arm-none-eabi-size' })
    const w = new Work()
    const run1 = w.run(String(r.run_id))!
    const log = new TextDecoder().decode(w.getArtifact(run1.id, 'build.log')!)
    w.close()
    expect(run1).toMatchObject({ kind: 'firmware.build', subject: 'fw', status: 'pass' })
    expect(run1.measurements.find((m) => m.name === 'flash_bytes')?.value).toBe(20992)
    expect(log).toContain('unused variable')
  })

  it('reports a failed build with its first error', async () => {
    const r = await call('firmware.build', { target: 'broken' })
    expect(r).toMatchObject({ ok: false, exit_code: 2, errors: 1, artifact: null })
    expect((r.first_errors as Obj[])[0]).toMatchObject({ file: 'main.c', line: 7, message: "expected ';' before '}' token" })
    expect(String(r.tail)).toContain('error')
    const w = new Work()
    expect(w.run(String(r.run_id))?.status).toBe('fail')
    w.close()
  })

  it('sizes an image on its own', async () => {
    await call('firmware.build', { target: 'fw' })
    const r = await call('firmware.size', { target: 'fw' })
    expect(r).toMatchObject({ flash_bytes: 20992, ram_bytes: 4608, flash_total: 65536 })
  })

  it('refuses to flash a missing or stale image, then flashes a fresh one', async () => {
    await expect(call('firmware.flash', { target: 'fw' })).rejects.toThrow(/no image to flash.*run firmware.build target=fw/)
    await call('firmware.build', { target: 'fw' })
    // a source edited after the build
    const later = new Date(Date.now() + 5000)
    utimesSync(join(root, 'fw/main.c'), later, later)
    await expect(call('firmware.flash', { target: 'fw' })).rejects.toThrow(/older than fw\/main.c/)
    await call('firmware.build', { target: 'fw' })
    utimesSync(join(root, 'fw/build/app.elf'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    const r = await call('firmware.flash', { target: 'fw' })
    expect(r).toMatchObject({ ok: true, verified: true, command: 'make flash' })
    expect(r.probe_output).toContain('Verified OK')
  })

  it('names the install command for a missing program', async () => {
    await call('firmware.build', { target: 'fw' })
    utimesSync(join(root, 'fw/build/app.elf'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    process.env.PATH = `${join(root, 'bin')}:/usr/bin:/bin` // no probe-rs here
    await expect(call('firmware.flash', { target: 'rtt' })).rejects.toThrow(/needs probe-rs, which is not on PATH — probe-rs: cargo install probe-rs-tools/)
    await expect(call('firmware.logs', { target: 'rtt', seconds: 1 })).rejects.toThrow(/needs probe-rs/)
  })

  it('refuses logs without a source, and names a missing serial port', async () => {
    await expect(call('firmware.logs', { target: 'fw', seconds: 1 })).rejects.toThrow(/no logs command for preset make and no serial port/)
    await expect(call('firmware.logs', { target: 'console', seconds: 1 })).rejects.toThrow(/no serial port "nope" in hil.serial/)
  })

  it('captures logs from a command until a regex, flagging a panic', async () => {
    const r = await call('firmware.logs', {
      target: 'fw', seconds: 5, until: 'HardFault',
      command: 'echo "INFO boot"; echo "ERROR panicked at src/main.rs:9:5"; echo "HardFault: PC=0x10000abc"; sleep 10',
    })
    expect(r.stopped_on_match).toBe(true)
    expect(r.faults).toEqual(['ERROR panicked at src/main.rs:9:5', 'HardFault: PC=0x10000abc'])
    expect(r.seconds as number).toBeLessThan(4)
    const early = await call('firmware.logs', { target: 'fw', seconds: 5, command: 'echo "Error: no probe was found"; exit 1' })
    expect(early).toMatchObject({ exited: 1 })
    const w = new Work()
    expect(w.run(String(early.run_id))?.status).toBe('error')
    w.close()
  })

  it('lists targets with their resolved commands and freshness', async () => {
    const r = await call('firmware.targets', {})
    const t = Object.fromEntries((r.targets as Obj[]).map((x) => [x.name, x]))
    expect(t.fw).toMatchObject({ build: 'make', flash: 'make flash', artifact: { exists: false } })
    expect(String((t.rtt as Obj).flash)).toMatch(/^probe-rs download --verify --chip RP235x .*app\.elf && probe-rs reset --chip RP235x$/)
    expect(String((t.rtt as Obj).logs)).toMatch(/^probe-rs attach --chip RP235x /)
  })

  it('validates firmware settings', () => {
    const e = resolveCfg({ 'firmware.targets': [{ name: 'a', preset: 'custom' }, { name: 'a', preset: 'make' }, { name: 'b', preset: 'nope' }] }).errors.join('\n')
    expect(e).toMatch(/firmware.targets.2.preset/)
    const e2 = resolveCfg({ 'firmware.targets': [{ name: 'a', preset: 'custom' }, { name: 'a', preset: 'make' }] }).errors.join('\n')
    expect(e2).toMatch(/firmware.targets.0.build: a custom target needs a build command/)
    expect(e2).toMatch(/firmware.targets.1.name: a is listed twice/)
  })

  it('needs hardware allowed to flash', async () => {
    await expect(reg.call('firmware.flash', { target: 'fw' }, { hardware: false, via: 'test' })).rejects.toThrow(/drives real hardware/)
    expect(reg.list().filter((t) => t.hardware).map((t) => t.name)).toEqual(['firmware.flash', 'firmware.logs'])
  })
})
