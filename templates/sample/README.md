# trace-sample: a 12 V rail monitor

A small, finished board that exists to show what trace does. It measures a 12 V supply rail and the board's
temperature, and reports both to a microcontroller over a header. Every agent and every simulation in trace has
something real to work on here. The trace installer created this repository, and it opens a tour of issues, one per
step of the journey from intent to bring-up.

```
J1 VIN ─┬─ R1 39k ─┬─ R3 6k2 ─┬─ U2 buffer (MCP6001) ─ ADC_IN ─► J2.7
        │          R2 13k     C1 10n, D1 BAT54S clamp to GND and 3V3
        │          GND
        └─ C3 10u ─ U1 AMS1117-3.3 ─ 3V3 ─ C4 10u ─► J2.1, J3.1, U2, I2C pull-ups R5/R6 4k7
J2 (to the MCU board): 3V3 GND SDA SCL TX RX ADC_IN LED      J3 (expansion): 3V3 GND SDA SCL TX RX
```

The board is 60 × 40 mm with 2 layers and 17 parts, every one with an LCSC code. The schematic passes ERC and the
routed board passes DRC with schematic parity (KiCad 10.0.7). The heat comes from U1: 12 V in and about 43 mA out
make it dissipate about 0.44 W, which the thermal tools have to check.

## What is in each folder

| Folder | What it holds |
|---|---|
| `docs/` | `intent.md`, the product brief in trace's ten intent topics. `spec.md`, the numbered requirements (REQ-…) with acceptance criteria. `datasheets/`, two datasheets for **fictional** parts (TRC-OPA1, an op-amp; TRC-TMP1, an I2C temperature sensor), written for this sample by `make_datasheets.py`, not copied from any vendor |
| `hardware/` | The KiCad 10 project: schematic, routed board, and a `.kicad_dru` with length rules |
| `layout/` | The same board with every part placed and no copper. It is the autorouter's input |
| `tools/generate.ts` | Writes both KiCad projects from one parts list and checks ERC and DRC |
| `sim/` | `front-end.cir` (the analog path), `buffer.cir`, `noise.cir`, `front-end-corners.cir` with `corners/component.lib` (tt/ff/ss sections), and `models/`: Diodes Inc.'s BAT54S model and `TRC_OPA1.lib`, the sample's own behavioural op-amp model |
| `power/` | `ldo.cir`, the regulator's operating point, for the power budget |
| `logic/` | A 4-sample moving average with a testbench, cocotb tests and formal properties; an SPI ADC model; `sample_top.v`, the same job as the firmware on an FPGA, with its testbench |
| `fpga/` | `sample_top.pcf`, pin constraints for an iCE40 UP5K (SG48) |
| `protocol/` | Captures of an I2C read of TRC-TMP1, the console UART line and the CAN status frame. They were made with trace's `protocol.model`, so they are exact |
| `emc/` | `adc_in-line.s2p`, the ADC line as S-parameters from scikit-rf's microstrip model (`make_s2p.py`), and the port notes for the field solver |
| `thermal/` | `u1-bench-log.csv`, U1's temperature logged on the bench after power-on, to compare with the model |
| `mech/` | `enclosure.stl`, a simple tray the board sits in, for renders |
| `firmware/` | The ADC conversion in C with a unit test, and the console program, all built on the host with `make` |
| `bench/` | How to run the bench emulator that stands in for the instruments |
| `.trace/` | `project.db` (settings, requirements, test plan, specs, thermal data, and every run) and `rules.md` |

## How the tour works

Each tour issue is labelled `agent-fix` and `agent:<kind>`, so trace's worker picks it up and gives it to one
specialist: verify, impl, ams, emc, render or thermal. A specialist can only read and run tools. When a task needs
files changed, or a tool only the worker has (the fab package, the firmware build, the knowledge-base sync, the
bench), the specialist hands that part to the worker. Each issue says what to run, which files to use and what done
looks like. The agent comments its numbers with run ids and closes the issue.

The tour follows the journey:

1. **Define:** requirements, then datasheets.
2. **Architect:** values from the calculators, then the thermal envelope.
3. **Capture:** the project is indexed.
4. **Prove:** the analog, mixed-signal, logic, protocol and FPGA work.
5. **Layout:** autorouting, EMC, thermal and the enclosure.
6. **Sign-off:** solver cross-checks, renders and the test plan.
7. **Release:** the fab package.
8. **Bring-up:** on the emulated bench.

Tasks marked as GPU or CPU jobs run on AWS Batch, and the installer leaves them out when those jobs are off.

## Starting state

The installer put these in `.trace/project.db`, so the tour starts from a project that already has a plan:

- 19 requirements from `docs/spec.md`, accepted.
- A 27-item test plan using every method (sim, formal, spice, hil, inspection, drc), and 8 coverage points.
- Analog limits (spec sets `front-end` and `buffer`).
- Interface timing for TRC-TMP1, the console UART and the CAN status frame. All of it is marked unverified until a
  datasheet in the library backs it.
- The thermal envelope `enclosure` (0 to 50 °C, still air), part limits, the power budget `nominal` and U1's derating
  curve.

Run `tracectl tool verify.run all=true` here. 23 items pass; the 2 bench items wait for `TRACE_HARDWARE=1` and the
emulator, and the 2 inspection items wait for a person's verdict.

## Numbers from the local tools

Every number below is from an actual run through trace's tools, the same calls the tour asks for.

- **Front end:** ADC_IN is 2.995 V at 12 V in (calc.divider gives 3.000 V). The -3 dB point is 994 Hz at mid-scale
  (calc.rc_filter gives 998 Hz). The 10–90 % rise time is 0.349 ms. Corners (27: tt/ff/ss × 3V3 ±5 % × −20/25/70 °C)
  all pass. The worst is the f3db minimum, 903 Hz at ss −20 °C. Monte Carlo yield is 200/200.
- **Buffer (TRC_OPA1 model):** 100 dB open-loop gain, GBW 0.97 MHz, 76° phase margin, 0.59 V/µs slew. Noise is
  26 µV rms over 1 Hz–1 MHz, 0.03 LSB.
- **Mixed signal:** the front end into the moving average under Verilator co-simulation gives code 3717 at 12 V.
- **Logic:** the testbenches, 3 cocotb tests, and formal bmc and cover all pass. On the FPGA, yosys gives 435 cells
  and nextpnr reaches 46.9 MHz against the 12 MHz target. Seed 2 closes at 48 MHz.
- **Thermal:** the budget is 0.44 W, mostly U1. The 2.5D board model puts U1 at 84 °C on the board at 50 °C ambient,
  or 64 °C at 25 °C. CalculiX gives 58 °C at 25 °C. The bench log ends at 61 °C, between the two. The θJA junction
  estimate is 89 °C at 50 °C ambient, against a 105 °C derated limit.
- **EMC and SI:** the ADC line is about 128 Ω, so the 50 Ω TDR sees a mismatch, and insertion loss is 3.4 dB at
  1 GHz. That is a plain line between 50 Ω ports, not a fault; the signal is DC to 1 kHz.

## What this sample does not do honestly

- U1 is modelled at SPICE level as ideal regulation plus its ground current, which is enough for the power budget,
  but not a vendor model. U2 on the board is a real MCP6001; it is simulated with the sample's own TRC_OPA1 model,
  sized to its headline figures.
- The AMS1117's thermal figures (Tj max 125 °C, θJA 90 °C/W) are recalled, not read from a datasheet in the library.
  They are marked `verified: null`.
- The bench is an emulator, and the bench log in `thermal/` is a plausible example, not a measurement of a real
  board.
- The firmware is built for the host, so `firmware.size` reports host sizes.

## Regenerating

```
npx tsx tools/generate.ts                 # hardware/: ERC 0, DRC 0
UNROUTED=1 npx tsx tools/generate.ts      # layout/: the same board with no copper
python3 docs/datasheets/make_datasheets.py
python3 emc/make_s2p.py
```

`tools/generate.ts` imports nothing from trace, so it runs in this repository with KiCad 10 installed.
