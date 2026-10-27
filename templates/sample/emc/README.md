# EMC inputs

| File | What it is |
|---|---|
| `adc_in-line.s2p` | The ADC_IN trace (U2 pin 1 to J2 pin 7) as a 2-port, 10 MHz to 3 GHz, 50 ohm ports. Computed with scikit-rf's microstrip model on the board's stackup by `make_s2p.py`, not measured. Run `emc.si` on it. |
| `make_s2p.py` | Regenerates the file: `python3 emc/make_s2p.py` (needs scikit-rf). |

## Ports and nets for emc.setup

The net worth a field solve is `/ADC_IN`: the longest signal, 38.9 mm, with two vias through the B.Cu ground pour.

- Port 1: `U2.1`, the buffer output pad, on F.Cu (an SMD pad, so a lumped port works there).
- Port 2: the track beside J2 pin 7, at board point [153, 119.24] mm on F.Cu. J2 is a through-hole header, and a
  lumped port on its pad would short to its own B.Cu copper. That is why the port goes on the track instead.
- Reference: the GND pour on B.Cu (found automatically).
- fstop 1 GHz is enough for CISPR 32 class B (30 MHz to 1 GHz).

The fast edges on the board are the I2C lines (400 kHz, about 200 ns rise with 4k7 and 50 pF) and the UART
(115200 baud, a few ns edges from the MCU). Give `emc.precheck` and `emc.spectrum` those as `edges` / `signal`.
