# The bench

There is no real bench for this sample: trace's bench emulator stands in for it. It models this board's analog side
behind three SCPI instruments, a CAN bus and the firmware's serial console. The `hil.*` tools reach it exactly as
they would reach real instruments, through the project settings.

| Name | Instrument | Address | Wired to |
|---|---|---|---|
| `bench-psu` | Rigol DP832 (dialect rigol-dp800) | `TCPIP::127.0.0.1::5555::SOCKET` | CH1 is VIN at J1. Limits: 13 V, 0.1 A |
| `bench-scope` | Rigol DS1104Z (rigol-ds1000z) | `TCPIP::127.0.0.1::5556::SOCKET` | CH1 is ADC_IN (the last VIN step through the RC filter, τ ≈ 160 µs; use 1 V/div). CH2 is a 1 kHz, 3.2 Vpp square |
| `bench-dmm` | Keysight 34465A (keysight-344xx) | `TCPIP::127.0.0.1::5557::SOCKET` | DC volts = ADC_IN = VIN × 13/52 (0 with the PSU off). DC current = the board's draw. Resistance = a Pt100 at 25 °C. Temperature 25 °C |
| `bench-can` | python-can `virtual` bus, channel `bench` | in-process | Nothing on the bench answers. A frame sent is seen only by a capture in the same trace process |
| `bench-uart` | the firmware console on a pseudo-terminal | `/tmp/trace-bench-uart-5555` | While VIN ≥ 4 V: `boot trace-sample fw 0.1.0`, then `adc raw=3722 mv=11998` each second at 12 V, `temp mcu_c=25.0` every 5 s. Answers `READ`, `ID`, `HELP` |

## Run it

```
trace hil emulate --write-settings --serial &      # keep it running; Ctrl-C stops it
export TRACE_HARDWARE=1                            # hardware tools are refused without it
trace tool hil.idn instrument=bench-psu
trace tool hil.psu instrument=bench-psu voltage=12 current=0.1 output=on
trace tool hil.dmm instrument=bench-dmm function=vdc          # about 3.0 V
trace tool hil.serial_expect serial=bench-uart --args '{"steps":[{"send":"READ","expect":"adc raw=\\d+ mv=\\d+"}]}'
```

`--write-settings` writes the `hil.*` settings above into `.trace/project.db`. The installer already put the same
entries there. `--serial` needs Linux or macOS with python3.

What the emulator cannot show: anything the board's MCU does beyond its console, real noise, real thermal drift.
`thermal.measure` reads the DMM's fixed 25 °C. Treat bench results as a rehearsal of the procedure, not as
measurements of a board.
