# Intent: trace-sample, a 12 V rail monitor

The product brief, in the ten topics trace's intent builder asks about. Every number here becomes a requirement in
[spec.md](spec.md).

## 1. Purpose

A small board that measures a 12 V supply rail and reports the reading to a microcontroller. It is used by a lab
technician who wants to log a rail's voltage and the board's own temperature over a day.

## 2. Environment

- Indoors, on a bench or in a vented plastic enclosure, mounted vertically.
- Operating ambient 0 to 50 °C, still air. Storage −20 to 70 °C.
- No ingress protection needed. No vibration beyond normal handling.

## 3. Power

- Powered from the rail it measures: 4.5 V to 13 V at J1, nominally 12 V.
- The board makes its own 3.3 V with a linear regulator (U1) for the MCU board, the buffer and the I2C sensor.
- Power budget: at most 50 mA from 3.3 V (the MCU board takes up to 40 mA of it), so at most 0.6 W from the rail.
- Below 4.5 V the 3.3 V rail drops out and the MCU resets. That is acceptable: nothing needs to be stored.

## 4. Interfaces

| Interface | Type | Connector | Protocol and rate | Direction |
|---|---|---|---|---|
| Rail input | power and sense | J1, 2-pin 2.54 mm header | DC, 0 to 13 V | in |
| MCU board | power, analog, digital | J2, 8-pin 2.54 mm header | 3V3, GND, I2C, UART, ADC_IN, LED | both |
| Expansion | I2C and UART | J3, 6-pin 2.54 mm header | I2C fast mode 400 kHz; UART 115200 8N1 | both |
| Bench CAN (MCU board) | CAN | on the MCU board, not this one | 500 kbit/s, status frame 0x321 once a second | out |

## 5. Performance

- Measure the rail from 0 to 12 V with 12-bit resolution and better than ±1 % of full scale.
- Anti-alias filter corner near 1 kHz (850 to 1250 Hz). A step reaches 1 % within 1 ms.
- Report a reading once a second on the console and in the CAN status frame.
- Measure the board's temperature to ±1 °C with the I2C sensor on J3.

## 6. Physical

- Board at most 60 × 40 mm, 2 layers, 1.6 mm FR-4.
- J1 on the left edge, J2 and J3 on the right edge, all 2.54 mm headers.
- No component taller than 5 mm. No enclosure model: size limits only.

## 7. Compliance

- Radiated emissions: CISPR 32 class B (pre-compliance estimate only; no lab test for this sample).
- No safety approvals: the board runs below 15 V.

## 8. Build

- 10 boards per run, assembled by JLCPCB (every part has an LCSC code).
- Target cost: under USD 5 a board in parts at that quantity.

## 9. Constraints

- Reuse the sensor-node front end (divider, RC filter, BAT54S clamp) from trace's examples.
- Only parts in stock at LCSC. No BGA or QFN parts: everything hand-solderable.

## 10. References

- [docs/datasheets/TRC-OPA1.pdf](datasheets/TRC-OPA1.pdf) and [TRC-TMP1.pdf](datasheets/TRC-TMP1.pdf): datasheets
  for two **fictional** parts, written for this sample so the datasheet tools have something to read. The op-amp on
  the board is a real MCP6001; TRC-OPA1 is its stand-in model.
- trace's `examples/sensor-node`, which this board grows from.

## Open questions

- Does the MCU board's 40 mA budget hold with its radio on? Owner: the firmware lead, before the layout gate.
