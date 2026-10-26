/**
 * Firmware presets: the build, flash and log commands for each embedded toolchain, used when a target in
 * firmware.targets does not give its own.
 *
 * Commands are templates. Placeholders: {chip} {probe} {artifact} {port} {path} {pio_env} {probe_arg}. A command whose
 * placeholder has no value is an error that names the missing setting, never a half-filled command line.
 *
 * Notes carried over from the Potroller supervisor (embassy-rp on an RP2350, flashed over SWD):
 *  - cargo: `.cargo/config.toml` holds both `[build] target` (the triple, so the ELF is target/<triple>/release/<bin>)
 *    and the `runner` (`probe-rs run --chip RP235x`). detect.ts reads both. `probe-rs download` writes and verifies
 *    (`--verify`); `probe-rs run` flashes then streams defmt/RTT; `probe-rs attach` only streams.
 *  - When cargo's home (~/.cargo) is not writable, cargo fails before compiling anything; the runner reports that as
 *    the environment (CARGO_HOME), not as a compile error. Give it its own home under the scratch directory.
 *  - openocd: one `program <elf> verify reset exit` command programs, verifies (exit non-zero on a mismatch) and runs.
 *    A verify-only pass is `init; reset halt; verify_image <elf>; reset run; shutdown`. Always with a timeout; a
 *    probe that hangs never comes back on its own.
 *  - picotool (RP2040/RP2350 in BOOTSEL over USB): `picotool load -u -v -x -t elf <elf>` (update, verify, execute).
 */
import type { FirmwareTarget } from '../core/config.js'
import { ToolError } from '../core/registry.js'

export type Preset = FirmwareTarget['preset']
export type Step = 'build' | 'flash' | 'logs'

export interface PresetDef {
  /** what the commands need on PATH, with how to install each */
  programs: Record<Step, { name: string; install: string }[]>
  build: string
  flash: string | null
  /** null: logs come from the target's serial port */
  logs: string | null
  /** where the image is, relative to the target path, when `artifact` is not set; glob-like: * matches one name */
  artifact: string[]
  /** a flash command that also verifies the image */
  verifies: boolean
}

const PROBE_RS = { name: 'probe-rs', install: 'cargo install probe-rs-tools --locked (or: curl --proto =https -LsSf https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.sh | sh)' }
const CARGO = { name: 'cargo', install: 'install Rust with rustup: https://rustup.rs (the target installs from rust-toolchain.toml or: rustup target add <triple>)' }
const PIO = { name: 'pio', install: 'pip install platformio' }
const WEST = { name: 'west', install: 'pip install west (and the Zephyr SDK: https://docs.zephyrproject.org/latest/develop/getting_started/)' }
const IDF = { name: 'idf.py', install: 'install ESP-IDF and source export.sh: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/' }
const ARDUINO = { name: 'arduino-cli', install: 'curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh' }
const CMAKE = { name: 'cmake', install: 'apt install cmake ninja-build gcc-arm-none-eabi (or brew install cmake ninja arm-none-eabi-gcc)' }
const PICOTOOL = { name: 'picotool', install: 'build from https://github.com/raspberrypi/picotool or install the Pico SDK VS Code extension' }
const OPENOCD = { name: 'openocd', install: "apt install openocd (for RP2040/RP2350 use Raspberry Pi's fork: https://github.com/raspberrypi/openocd)" }
const MAKE = { name: 'make', install: 'apt install make (or xcode-select --install)' }

export const PRESETS: Record<Preset, PresetDef> = {
  cargo: {
    programs: { build: [CARGO], flash: [PROBE_RS], logs: [PROBE_RS] },
    build: 'cargo build --release',
    flash: 'probe-rs download --verify --chip {chip}{probe_arg} {artifact} && probe-rs reset --chip {chip}{probe_arg}',
    logs: 'probe-rs attach --chip {chip}{probe_arg} {artifact}',
    artifact: ['target/{triple}/release/{bin}', 'target/release/{bin}'],
    verifies: true,
  },
  'pico-sdk': {
    programs: { build: [CMAKE], flash: [PICOTOOL], logs: [] },
    build: 'cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build',
    // picotool: BOOTSEL over USB. A probe: set flash to the openocd form in the notes above.
    flash: 'picotool load -u -v -x -t elf {artifact}',
    logs: null,
    artifact: ['build/*.elf'],
    verifies: true,
  },
  platformio: {
    programs: { build: [PIO], flash: [PIO], logs: [PIO] },
    build: 'pio run{pio_env_arg}',
    flash: 'pio run{pio_env_arg} -t upload{upload_port_arg}',
    logs: 'pio device monitor{pio_env_arg}{monitor_port_arg} --quiet',
    artifact: ['.pio/build/{pio_env}/firmware.elf', '.pio/build/*/firmware.elf'],
    verifies: false,
  },
  zephyr: {
    programs: { build: [WEST], flash: [WEST], logs: [] },
    build: 'west build -b {chip} -d build .',
    flash: 'west flash -d build',
    logs: null,
    artifact: ['build/zephyr/zephyr.elf'],
    verifies: false,
  },
  'esp-idf': {
    programs: { build: [IDF], flash: [IDF], logs: [IDF] },
    build: 'idf.py build',
    flash: 'idf.py{idf_port_arg} flash',
    logs: 'idf.py{idf_port_arg} monitor --no-reset',
    artifact: ['build/*.elf'],
    verifies: true, // esptool verifies the hash of what it wrote
  },
  arduino: {
    programs: { build: [ARDUINO], flash: [ARDUINO], logs: [ARDUINO] },
    build: 'arduino-cli compile --fqbn {chip} --output-dir build .',
    flash: 'arduino-cli upload --fqbn {chip} -p {port} --input-dir build --verify .',
    logs: 'arduino-cli monitor -p {port}',
    artifact: ['build/*.ino.elf', 'build/*.elf'],
    verifies: true,
  },
  make: {
    programs: { build: [MAKE], flash: [MAKE], logs: [] },
    build: 'make',
    flash: 'make flash',
    logs: null,
    artifact: ['build/*.elf', '*.elf', 'build/*.hex', '*.hex', 'build/*.bin', '*.bin'],
    verifies: false,
  },
  custom: {
    programs: { build: [], flash: [], logs: [] },
    build: '',
    flash: null,
    logs: null,
    artifact: [],
    verifies: false,
  },
}

/** The openocd forms, for a target whose flash says `preset: openocd` style. */
export const OPENOCD_FLASH = 'openocd -f interface/{probe}.cfg -f target/{chip}.cfg -c "adapter speed 5000" -c "program {artifact} verify reset exit"'
export const OPENOCD_VERIFY = 'openocd -f interface/{probe}.cfg -f target/{chip}.cfg -c "init; reset halt; verify_image {artifact}; reset run; shutdown"'
export { OPENOCD }

/** Fill a command template; a placeholder without a value is a ToolError naming the setting. */
export function fill(template: string, values: Record<string, string | undefined>, target: string): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const v = values[k]
    // an empty string is a deliberate blank (an optional `--probe` argument); only a missing value is an error
    if (v === undefined) {
      const hint: Record<string, string> = {
        chip: 'set chip (probe-rs chip like RP235x or STM32G071RBTx, a Zephyr board, an Arduino FQBN)',
        port: 'set serial (a hil.serial name) for the upload/monitor port',
        artifact: 'build first, or set artifact',
        probe: 'set probe (an openocd interface like cmsis-dap, or a probe-rs VID:PID[:serial])',
        triple: 'set artifact, or a [build] target in .cargo/config.toml',
        bin: 'set artifact (the package has no binary name)',
        pio_env: 'set pio_env',
      }
      throw new ToolError(`${target}: the command needs {${k}}: ${hint[k] ?? `set ${k}`}`)
    }
    return v
  })
}
