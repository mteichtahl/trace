# sensor-node: one small design through the whole trace toolkit

A sensor input channel that takes 0–12 V and feeds a 3.3 V microcontroller's ADC. It's a real, finished design: the
schematic passes ERC, the routed board passes DRC with schematic parity, every part has a manufacturer part number
and an LCSC code, and every value comes from a trace calculator. The same circuit is also simulated, and the MCU side
has a Verilog filter with a testbench and a C conversion module with a unit test.

Every output shown below is from an actual run (KiCad 10.0.7, ngspice, Icarus Verilog, host `cc`). Run ids differ on
each run.

```
J1 VIN ──R1 39k──┬── DIV ──R3 6k2──┬──────────── ADC_IN ──► J2.3
                 R2 13k            C1 10n   D1 BAT54S clamp: ADC_IN to GND and to 3V3
                 │                 │        C2 100n on 3V3
                GND               GND
J2.4 LED ──R4 680── D2 red LED ── GND           J2: 1 3V3, 2 GND, 3 ADC_IN, 4 LED
```

| Folder | What it holds |
|---|---|
| `hardware/` | The KiCad 10 project: schematic, 2-layer 40×25 mm board, and project library tables pointing at KiCad's standard libraries. |
| `sim/` | `front-end.cir`, the analog path as an ngspice netlist with the schematic's values. `front-end-from-kicad.sh` simulates the schematic itself. `models/BAT54S.lib` is the vendor model for the clamp diode. |
| `logic/` | A 4-sample moving average for the ADC samples, and its self-checking testbench. |
| `firmware/` | `adc.c`, which converts ADC counts to input millivolts, plus a host unit test and a Makefile (`make`, `make test`). |
| `tools/` | `generate.ts` writes the KiCad files. `setup-db.ts` writes `.trace/project.db`. |
| `.trace/` | `project.db` holds the settings below and records every tool run. `rules.md` is left for the owner to write. |

Settings (`trace config show`):

- `electronics.projects` is `["hardware/sensor-node.kicad_pro"]`.
- `electronics.models` is `["sim/models"]`, so the BAT54S model is in every simulation.
- `firmware.targets` has one target: `adc-convert`, `make` preset, `path: firmware`, `build: make all test`, `artifact: build/libadc.a`.

Run everything below from this folder.

## 1. Choose the values

```
$ trace tool calc.divider vin=12 vout=3.0 series=E24
summary: "R1 39 kΩ / R2 13 kΩ (E24) gives 3 V (+0.00 %), worst case 2.96 V to 3.05 V"

$ trace tool calc.divider vin=12 r1=39k r2=13k
r_thevenin_ohm: 9750
summary: "Vout 3 V (worst case 2.96 V to 3.05 V at 1 %), divider current 231 µA"
```

The anti-alias filter's resistance is R3 plus the divider's Thevenin resistance (9.75 kΩ), because the divider is
what drives the filter.

```
$ trace tool calc.rc_filter fc=1k c=10n
summary: "R 16 kΩ, C 10 nF gives fc 995 Hz (-0.53 %)"
```

16 kΩ − 9.75 kΩ = 6.25 kΩ, and the nearest E24 value is 6.2 kΩ:

```
$ trace tool calc.rc_filter r=15950 c=10n
fc_hz: 997.84    rise_10_90_s: 0.000350    settle_time_s: 0.000735 (to 1 %)
```

The LED is a KT-0603R red LED. Its LCSC listing gives Vf = 1.8–2.4 V at 20 mA; 2.0 V is assumed at 2 mA.

```
$ trace tool calc.led_resistor vsupply=3.3 vf=2.0 current=2m
summary: "680 Ω (E24) gives 1.91 mA, resistor dissipates 2.49 mW"
```

The clamp's upper diode returns the input to 3V3, so a fault on J1 (for example 24 V) only pushes about 0.15 mA through
R3 into the rail. Full scale (12 V at J1) puts 3.0 V on the ADC pin, 0.3 V below the rail. Section 3 shows what that
margin costs.

## 2. Check the design

```
$ trace tool kicad.erc
errors: 0   warnings: 0   excluded: 0

$ trace tool kicad.drc            # with --schematic-parity
errors: 0   warnings: 0   unconnected: 0   parity_issues: 0

$ trace tool kicad.netlist
nets_total: 7   components_total: 10   single_pin_nets: 0
  /ADC_IN: C1.1 D1.3 J2.3 R3.2      /DIV: R1.2 R2.1 R3.1      GND: 7 pins ...

$ trace tool kicad.bom jlc=true
total_parts: 10   unique_lines: 10   missing_part_number: 0   lines_without_lcsc: 0

$ trace tool kicad.board trace_width_mm=0.25
outline 40 × 25 mm, 2 copper layers, 10 footprints, 7 nets, 23 tracks, 7 vias, 1 copper zone
F.Cu z0_ohm: 128.04 at 0.25 mm (microstrip over the 1.51 mm core)

$ trace tool kicad.net_length nets='["/ADC_IN"]' from=R3.2 to=J2.3
length_mm: 26.175 (the whole net)   path R3.2 → J2.3: 20.175 mm, 0 vias, 117 ps
```

ERC is clean because the design is complete, not because anything was waived. PWR_FLAGs mark 3V3 and GND as supplied
through J2 and J1, and every pin is connected, so no pin needs a no-connect flag. All 10 parts have an MPN and an LCSC
code, checked with `trace tool parts.lookup`, so the BOM has one line per part.

For a fab and assembly package, run `trace tool kicad.fab out_dir=build/fab`. It writes 17 files: Gerbers and drill zipped, the BOM, the JLCPCB BOM and CPL, and the placement file. All 10 parts get a placement, and there are no warnings.

## 3. Simulate it

The hand-written netlist, at the 12 V full-scale point:

```
$ trace tool sim.spice path=sim/front-end.cir --args '{"measurements":[
    {"name":"vadc_dc","kind":"value_at","vector":"v(adc_in)","analysis":"op"},
    {"name":"f3db","kind":"bandwidth","vector":"v(adc_in)"},
    {"name":"rise","kind":"rise_time","vector":"v(adc_in)","analysis":"tran"}]}'
vadc_dc: 2.99462 V     (calc.divider: 3.000 V, −0.18 %)
f3db:    1046 Hz       (calc.rc_filter: 998 Hz)
rise:    0.349 ms      (calc.rc_filter: 0.350 ms)
```

Mid-scale is the input range's middle, with no diode near conduction. Set `vin_dc` to 6:

```
$ trace tool sim.spice path=sim/front-end.cir --args '{"params":{"vin_dc":6},"analyses":[".op",".ac dec 50 1 1meg"], ...}'
vadc: 1.50002 V        f3db: 993.6 Hz   (calc.rc_filter 997.8 Hz: −0.4 %)
```

At mid-scale the filter matches the calculator. At the ends of the range the clamp loads the node: with `vin_dc=1`
the simulation gives 0.2588 V where the ideal is 0.25 V, and fc rises to 1095 Hz. The cause is the vendor model. Its
saturation current is IS = 34.9 µA, so it predicts tens of µA of reverse current. The BAT54S datasheet (Diodes Inc.
DS11005) gives at most 2.0 µA at 25 V reverse. The model is right about forward conduction, which is what the clamp
does, but it overstates leakage. An error budget should use the datasheet's 2 µA, which is about 32 mV through
15.95 kΩ in the worst case.

The schematic can be simulated directly, without the hand-written netlist (`sim/front-end-from-kicad.sh`):

```
$ trace tool sim.kicad_spice schematic=hardware/sensor-node.kicad_sch --args '{"analyses":[".op",".ac dec 50 1 1meg"],
    "replace":{"J1":"V1 /VIN 0 DC 6 AC 1","J2":"V2 +3V3 0 DC 3.3","D1":"XD1 GND +3V3 /ADC_IN BAT54S","D2":null,"R4":null}, ...}'
vadc: 1.50002 V        f3db: 993.566 Hz
netlist: components 10, replaced J1 D1 J2, removed R4 D2
```

This is the same answer as the hand-written netlist, so `front-end.cir` holds the schematic's values. KiCad's export
models the R and C parts itself. The connectors have no model, and neither do the Diode:BAT54S and Device:LED
symbols, so those are replaced or removed:

- D1 is replaced with the BAT54S subcircuit from `sim/models`.
- J1 and J2 are replaced with sources.
- The LED and R4 are removed.

## 4. The MCU side

```
$ trace tool sim.logic --args '{"files":["logic/moving_average.v","logic/moving_average_tb.v"],"top":"moving_average_tb","pass":"ALL TESTS PASSED"}'
passed: true
output: checked 254 samples / ALL TESTS PASSED
vcd: moving_average_tb.vcd (stored with the run, for sim.wave_read)

$ trace tool firmware.build target=adc-convert
ok: true   command: "make all test"   errors: 0   warnings: 0
size: flash_bytes 221 (llvm-size, host build)
```

The testbench computes its own expected average and stops with `$fatal` on any mismatch. Changing the module's `>> 2`
to `>> 3` makes it fail at the first step sample (`MISMATCH after sample 3723: avg 465, expected 930`).

`firmware/test_adc.c` checks several cases:

- Full scale: 4095 counts → 13 200 mV.
- 12 V in → 3723 counts.
- 3723 counts → 12 001 mV, within one count, which is 3.2 mV.
- A round trip over all 4096 codes.

## 5. Everything at once, and the record

```
$ trace check
ok     kicad.erc hardware/sensor-node.kicad_pro: 0 errors, 0 warnings
ok     kicad.drc hardware/sensor-node.kicad_pro: 0 errors, 0 warnings
ok     firmware.build adc-convert:

$ trace runs
eac8b0e1cd634b14  2026-10-26 07:40  pass    firmware.build    adc-convert  adc-convert: ok, 0 errors, 0 warnings, flash 221 B
2533a6604b4c4fcc  2026-10-26 07:39  pass    sim.logic         moving_average_tb  moving_average_tb: output matched the pass pattern: ALL TESTS PASSED
b27486a2e6804359  2026-10-26 07:39  pass    sim.kicad_spice   hardware/sensor-node.kicad_sch  hardware/sensor-node.kicad_sch: op+ac vadc=1.5 V, f3db=993.6 Hz
...
```

Each run keeps its full outputs in `.trace/project.db`: the ERC/DRC JSON reports, the BOM CSV, the netlists, the
ngspice logs and raw data, the VCD, and the build log. Look at one with `trace run ID` or `trace artifact ID NAME`.

## Regenerating

The KiCad files are generated, then finished by KiCad itself: `kicad-cli pcb drc --refill-zones --save-board` fills
the GND pour. The generator ends by running ERC and DRC and fails unless both report zero errors.

```
npx tsx examples/sensor-node/tools/generate.ts   # → ERC: 0 errors, 0 warnings; DRC: 0 errors, 0 warnings
npx tsx examples/sensor-node/tools/setup-db.ts   # rebuilds .trace/project.db (settings only, no run history)
```

`test/examples/sensor-node.test.ts` runs the steps above through the tool registry on a temporary copy.

## Parts

| Ref | Value | MPN | Manufacturer | LCSC |
|---|---|---|---|---|
| R1 | 39k 1 % 0603 | 0603WAF3902T5E | UNI-ROYAL | C23153 |
| R2 | 13k 1 % 0603 | 0603WAF1302T5E | UNI-ROYAL | C22797 |
| R3 | 6k2 1 % 0603 | 0603WAF6201T5E | UNI-ROYAL | C4260 |
| R4 | 680 1 % 0603 | 0603WAF6800T5E | UNI-ROYAL | C23228 |
| C1 | 10n X7R 50 V 0603 | CL10B103KB8NNNC | Samsung Electro-Mechanics | C1589 |
| C2 | 100n X7R 50 V 0603 | CC0603KRX7R9BB104 | YAGEO | C14663 |
| D1 | BAT54S SOT-23 | BAT54S-7-F | Diodes Incorporated | C83574 |
| D2 | red LED 0603 | KT-0603R | Hubei KENTO Elec | C2286 |
| J1 | 1×2 2.54 mm header | PZ254V-11-02P | XFCN | C492401 |
| J2 | 1×4 2.54 mm header | PZ254V-11-04P | XFCN | C2691448 |

The SPICE model in `sim/models/BAT54S.lib` is Diodes Incorporated's, from
https://www.diodes.com/spice/download/431/BAT54S.spice.txt, with its notice kept. The two-diode subcircuit that
matches the SOT-23 pinout was added for this example.
