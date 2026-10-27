/**
 * The sample board, as the bench emulator sees it: a 0-12 V input divider (R1 39k over R2 13k), an RC filter (R3 6k2
 * into C1 10n) to the MCU's ADC pin ADC_IN, and a BAT54S clamping ADC_IN to the 3V3 rail.
 *
 *   VIN ──R1 39k──┬──R3 6k2──┬── ADC_IN (12-bit, Vref 3.3 V)
 *                 R2 13k     C1 10n ── BAT54S to 3V3 and GND
 *                 GND        GND
 *
 * Steady state ADC_IN = VIN · 13/52, at most about 3.3 V + 0.25 V (the clamp diode's forward drop at the current
 * the divider can push). The filter's time constant is (R1 ∥ R2 + R3) · C1 = 15.95 kΩ · 10 nF ≈ 160 µs, so a step on
 * VIN reaches ADC_IN with a 10-90 % rise time of about 350 µs. The board draws VIN / 52 kΩ from the supply (its MCU
 * and regulator are not modelled as a load), and the firmware runs while VIN is at least 4 V (the regulator's
 * dropout).
 */
export const R1 = 39_000
export const R2 = 13_000
export const R3 = 6_200
export const C1 = 10e-9
export const DIVIDER = R2 / (R1 + R2)
/** the filter's time constant, seconds */
export const TAU = ((R1 * R2) / (R1 + R2) + R3) * C1
/** ADC_IN cannot go above the 3V3 rail plus a Schottky drop */
export const CLAMP_V = 3.3 + 0.25
export const VREF = 3.3
export const ADC_BITS = 12
/** the firmware runs (and logs) at or above this VIN */
export const BOOT_V = 4
/** what the board looks like to the supply: the divider */
export const LOAD_OHMS = R1 + R2
/** the board's temperature as the bench instruments report it (no self-heating to speak of at 2.8 mW) */
export const AMBIENT_C = 25

/** ADC_IN in steady state for a VIN. */
export const adcIn = (vin: number): number => Math.min(Math.max(vin, 0) * DIVIDER, CLAMP_V)

/** ADC_IN `t` seconds after VIN stepped from `from` to `to` (t < 0: before the step). */
export function adcStep(from: number, to: number, t: number): number {
  const a = adcIn(from), b = adcIn(to)
  return t < 0 ? a : b + (a - b) * Math.exp(-t / TAU)
}

/** What the firmware reads and reports: the ADC code, and VIN in millivolts worked back from it. */
export function firmwareReading(vin: number): { raw: number; mv: number } {
  const full = 2 ** ADC_BITS - 1
  const raw = Math.min(full, Math.floor((adcIn(vin) / VREF) * full))
  return { raw, mv: Math.round((raw * VREF * 1000) / full / DIVIDER) }
}

/** A Pt100's resistance at a temperature (IEC 60751, T >= 0 °C), for a DMM reading resistance as an RTD. */
export const pt100 = (t: number): number => 100 * (1 + 3.9083e-3 * t - 5.775e-7 * t * t)
