/**
 * The buses' own limits, used when a check has no device spec, and the default timing of the models.
 *
 * Every figure carries its citation. None of these documents is in the shared datasheet library as this was written,
 * so every citation here has `verified: null`: the figures are the published standards' as recalled, to be confirmed
 * against the PDF (add it with datasheets.add; a device spec from protocol.spec with mpn, sha256 and page is
 * verified). The I2C Table 10 figures are the same as sim/wave.ts I2C_LIMITS (a test keeps the two equal).
 *
 *   I2C        NXP UM10204 "I2C-bus specification and user manual", rev. 7.0, 1 October 2021: Table 10
 *              (Standard-mode, Fast-mode, Fast-mode Plus SDA/SCL timing), Table 12 (Hs-mode, Cb = 100 pF and
 *              400 pF), section 7.1 (pull-up sizing, equations 1 and 2), Table 9 (VIL, VIH, VOL, IOL).
 *   1-Wire     Maxim (Analog Devices) Application Note 126, "1-Wire Communication Through Software": Table 2,
 *              recommended standard and overdrive timings A..J.
 *   RS-232     TIA-232-F (1997), section 2: receiver thresholds ±3 V, driver output ±5 to ±15 V loaded, ±25 V max,
 *              slew rate at most 30 V/µs, load 3 to 7 kΩ, at most 2500 pF.
 *   CAN        ISO 11898-1:2015: frame format, bit stuffing after five equal bits, CRC-15 (polynomial 0x4599),
 *              bit time of sync (1 tq) + tseg1 + tseg2, SJW at most min(4, tseg2) for Classical CAN controllers.
 */

export interface Citation {
  source: string
  mpn?: string | undefined
  sha256?: string | undefined
  page?: number | undefined
  /** true: part, sha256 and page given (a datasheet in the library); null: not checked against a document. */
  verified: true | null
}

export interface Limit {
  min?: number
  typ?: number
  max?: number
  unit: string
  cite: Citation
  note?: string
}

const UM10204 = (table: string): Citation => ({ source: `NXP UM10204 rev. 7.0 (2021), ${table}; as recalled, not read from the PDF in the library`, verified: null })
const AN126: Citation = { source: 'Maxim/ADI Application Note 126, Table 2 (recommended 1-Wire timings); as recalled, not read from a PDF in the library', verified: null }
const TIA232: Citation = { source: 'TIA-232-F (1997) section 2, electrical characteristics; as recalled, not read from a document in the library', verified: null }

export type I2cSpeed = 'standard' | 'fast' | 'fast_plus' | 'high_speed' | 'high_speed_400pf'
export const I2C_SPEEDS = ['standard', 'fast', 'fast_plus', 'high_speed', 'high_speed_400pf'] as const

/** I2C parameter names, as protocol.spec and protocol.check use them (UM10204 symbols in the comments). */
export const I2C_PARAMS = {
  f_scl: 'fSCL, SCL clock frequency (max)',
  thd_sta: 'tHD;STA, hold time (repeated) START (min)',
  t_low: 'tLOW, SCL low period (min)',
  t_high: 'tHIGH, SCL high period (min)',
  tsu_sta: 'tSU;STA, set-up time for a repeated START (min)',
  thd_dat: 'tHD;DAT, data hold time (min)',
  tsu_dat: 'tSU;DAT, data set-up time (min)',
  tvd_dat: 'tVD;DAT, data valid time (max)',
  tvd_ack: 'tVD;ACK, data valid acknowledge time (max)',
  tsu_sto: 'tSU;STO, set-up time for STOP (min)',
  t_buf: 'tBUF, bus free time between STOP and START (min)',
  t_r: 'tr, rise time of SDA and SCL, 30 % to 70 % (max)',
  t_f: 'tf, fall time of SDA and SCL, 70 % to 30 % (max)',
  c_b: 'Cb, capacitive load for each bus line (max)',
  t_sp: 'tSP, pulse width of spikes the input filter suppresses (max)',
  vil: 'VIL, low-level input voltage (max, fraction of VDD when unit is "VDD")',
  vih: 'VIH, high-level input voltage (min)',
  vol: 'VOL, low-level output voltage at IOL (max)',
  iol: 'IOL, low-level output current (min)',
} as const
export type I2cParam = keyof typeof I2C_PARAMS

const t10 = UM10204('Table 10')
const t12 = UM10204('Table 12')
const t9 = UM10204('Table 9')

const s = (v: number): Limit => ({ min: v, unit: 's', cite: t10 })
const smax = (v: number): Limit => ({ max: v, unit: 's', cite: t10 })

/** UM10204 limits per speed mode. Hs-mode figures are SCLH/SDAH; tHD;DAT has a maximum there. */
export const I2C_STANDARD: Readonly<Record<I2cSpeed, Partial<Record<I2cParam, Limit>>>> = {
  standard: {
    f_scl: { max: 100e3, unit: 'Hz', cite: t10 }, thd_sta: s(4.0e-6), t_low: s(4.7e-6), t_high: s(4.0e-6), tsu_sta: s(4.7e-6),
    thd_dat: s(0), tsu_dat: s(250e-9), tvd_dat: smax(3.45e-6), tvd_ack: smax(3.45e-6), tsu_sto: s(4.0e-6), t_buf: s(4.7e-6),
    t_r: smax(1000e-9), t_f: smax(300e-9), c_b: { max: 400e-12, unit: 'F', cite: t10 },
    vil: { max: 0.3, unit: 'VDD', cite: t9 }, vih: { min: 0.7, unit: 'VDD', cite: t9 }, vol: { max: 0.4, unit: 'V', cite: t9, note: 'at 3 mA sink, VDD > 2 V' }, iol: { min: 3e-3, unit: 'A', cite: t9 },
  },
  fast: {
    f_scl: { max: 400e3, unit: 'Hz', cite: t10 }, thd_sta: s(0.6e-6), t_low: s(1.3e-6), t_high: s(0.6e-6), tsu_sta: s(0.6e-6),
    thd_dat: s(0), tsu_dat: s(100e-9), tvd_dat: smax(0.9e-6), tvd_ack: smax(0.9e-6), tsu_sto: s(0.6e-6), t_buf: s(1.3e-6),
    t_r: { min: 20e-9, max: 300e-9, unit: 's', cite: t10 }, t_f: { max: 300e-9, unit: 's', cite: t10, note: 'min 20 ns × (VDD / 5.5 V)' },
    c_b: { max: 400e-12, unit: 'F', cite: t10 }, t_sp: { max: 50e-9, unit: 's', cite: t10 },
    vil: { max: 0.3, unit: 'VDD', cite: t9 }, vih: { min: 0.7, unit: 'VDD', cite: t9 }, vol: { max: 0.4, unit: 'V', cite: t9, note: 'at 3 mA sink, VDD > 2 V' }, iol: { min: 3e-3, unit: 'A', cite: t9 },
  },
  fast_plus: {
    f_scl: { max: 1e6, unit: 'Hz', cite: t10 }, thd_sta: s(0.26e-6), t_low: s(0.5e-6), t_high: s(0.26e-6), tsu_sta: s(0.26e-6),
    thd_dat: s(0), tsu_dat: s(50e-9), tvd_dat: smax(0.45e-6), tvd_ack: smax(0.45e-6), tsu_sto: s(0.26e-6), t_buf: s(0.5e-6),
    t_r: smax(120e-9), t_f: { max: 120e-9, unit: 's', cite: t10, note: 'min 20 ns × (VDD / 5.5 V)' },
    c_b: { max: 550e-12, unit: 'F', cite: t10 }, t_sp: { max: 50e-9, unit: 's', cite: t10 },
    vil: { max: 0.3, unit: 'VDD', cite: t9 }, vih: { min: 0.7, unit: 'VDD', cite: t9 }, vol: { max: 0.4, unit: 'V', cite: t9, note: 'at 20 mA sink' }, iol: { min: 20e-3, unit: 'A', cite: t9 },
  },
  high_speed: {
    f_scl: { max: 3.4e6, unit: 'Hz', cite: t12 }, tsu_sta: { min: 160e-9, unit: 's', cite: t12 }, thd_sta: { min: 160e-9, unit: 's', cite: t12 },
    t_low: { min: 160e-9, unit: 's', cite: t12 }, t_high: { min: 60e-9, unit: 's', cite: t12 }, tsu_dat: { min: 10e-9, unit: 's', cite: t12 },
    thd_dat: { min: 0, max: 70e-9, unit: 's', cite: t12 }, tsu_sto: { min: 160e-9, unit: 's', cite: t12 },
    t_r: { min: 10e-9, max: 40e-9, unit: 's', cite: t12, note: 'SCLH; SDAH 10 to 80 ns' }, t_f: { min: 10e-9, max: 40e-9, unit: 's', cite: t12, note: 'SCLH; SDAH 10 to 80 ns' },
    c_b: { max: 100e-12, unit: 'F', cite: t12 }, t_sp: { max: 10e-9, unit: 's', cite: t12 },
    vil: { max: 0.3, unit: 'VDD', cite: t9 }, vih: { min: 0.7, unit: 'VDD', cite: t9 },
  },
  high_speed_400pf: {
    f_scl: { max: 1.7e6, unit: 'Hz', cite: t12 }, tsu_sta: { min: 160e-9, unit: 's', cite: t12 }, thd_sta: { min: 160e-9, unit: 's', cite: t12 },
    t_low: { min: 320e-9, unit: 's', cite: t12 }, t_high: { min: 120e-9, unit: 's', cite: t12 }, tsu_dat: { min: 10e-9, unit: 's', cite: t12 },
    thd_dat: { min: 0, max: 150e-9, unit: 's', cite: t12 }, tsu_sto: { min: 160e-9, unit: 's', cite: t12 },
    t_r: { min: 20e-9, max: 80e-9, unit: 's', cite: t12, note: 'SCLH; SDAH 20 to 160 ns' }, t_f: { min: 20e-9, max: 80e-9, unit: 's', cite: t12, note: 'SCLH; SDAH 20 to 160 ns' },
    c_b: { max: 400e-12, unit: 'F', cite: t12 }, t_sp: { max: 10e-9, unit: 's', cite: t12 },
    vil: { max: 0.3, unit: 'VDD', cite: t9 }, vih: { min: 0.7, unit: 'VDD', cite: t9 },
  },
}

/** The pull-up equations of UM10204 section 7.1: Rp(min) = (VDD - VOL(max)) / IOL (eq. 1), Rp(max) = tr / (0.8473 Cb)
 * (eq. 2; 0.8473 = ln(0.7/0.3), the RC time from 30 % to 70 %). */
export const UM10204_PULLUP: Citation = UM10204('section 7.1, equations 1 and 2')

/** ln(0.7/0.3): an RC rise from 30 % to 70 % of the step takes 0.8473 RC. ln(9): 10 % to 90 % takes 2.1972 RC. */
export const RC_30_70 = Math.log(0.7 / 0.3)
export const RC_10_90 = Math.log(9)

// ------------------------------------------------------------------ SPI (no standard: device datasheets only)

export const SPI_PARAMS = {
  f_sck: 'fSCK, clock frequency (max)',
  t_sck_high: 'tHIGH / tCH, SCK high time (min)',
  t_sck_low: 'tLOW / tCL, SCK low time (min)',
  tcss: 'tCSS / tLEAD, CS active to the first SCK edge (min)',
  tcsh: 'tCSH / tLAG, the last SCK edge to CS inactive (min)',
  tcsd: 'tCSD / tCSW, CS inactive time between transfers (min)',
  tsu: 'tSU / tDS, data-in (MOSI) set-up to the sampling edge (min)',
  th: 'tH / tDH, data-in hold after the sampling edge (min)',
  tv: 'tV / tDO / tCO, data-out (MISO) valid after the launching edge (max)',
  tho: 'tHO / tOH, data-out hold after the launching edge (min)',
  tdis: 'tDIS, CS inactive to output high impedance (max)',
  tsu_mi: "MISO set-up at the master's sampling edge (the master's input requirement, min)",
  th_mi: "MISO hold after the master's sampling edge (min)",
  modes: 'the SPI modes the device supports (a list, e.g. [0, 3])',
  word_bits: 'the word sizes it supports (a list)',
} as const
export type SpiParam = keyof typeof SPI_PARAMS

// ------------------------------------------------------------------ UART / RS-232

export const UART_PARAMS = {
  baud: 'nominal baud rate (typ)',
  baud_tol: 'baud rate tolerance the receiver accepts, percent (max, ±)',
  t_break: 'minimum break length the receiver detects (s)',
} as const

/**
 * The baud mismatch a receiver that samples each bit at its middle survives, in percent, for a frame of `bits`
 * (start + data + parity + stop, the first stop bit included): the stop bit's middle may move half a bit over
 * bits - 0.5 bit times, so ±0.5 / (bits - 0.5) total, split evenly between the two ends. 10 bits (8N1): ±2.63 %
 * per end, ±5.26 % total. A derivation, not a standard figure; real receivers with 16× oversampling lose 1/16 bit
 * more.
 */
export function uartTolerance(frameBits: number): { total_pct: number; per_end_pct: number } {
  const total = (0.5 / (frameBits - 0.5)) * 100
  return { total_pct: total, per_end_pct: total / 2 }
}

export const RS232: Readonly<Record<string, Limit>> = {
  receiver_threshold: { min: 3, unit: 'V', cite: TIA232, note: 'mark (logic 1) below -3 V, space (logic 0) above +3 V' },
  driver_loaded: { min: 5, max: 15, unit: 'V', cite: TIA232, note: '|V| into 3 to 7 kΩ' },
  driver_open: { max: 25, unit: 'V', cite: TIA232 },
  slew: { max: 30e6, unit: 'V/s', cite: TIA232 },
  load_r: { min: 3e3, max: 7e3, unit: 'Ω', cite: TIA232 },
  load_c: { max: 2500e-12, unit: 'F', cite: TIA232 },
}

// ------------------------------------------------------------------ 1-Wire

export interface OneWireTiming {
  /** write-1 low */ a: number
  /** write-1 release (rest of the slot) */ b: number
  /** write-0 low */ c: number
  /** write-0 recovery */ d: number
  /** read: release to sample */ e: number
  /** read: sample to end of slot */ f: number
  /** before reset */ g: number
  /** reset low */ h: number
  /** reset release to presence sample */ i: number
  /** presence sample to end of reset */ j: number
  /** responder: presence high time after release (tPDH) */ pdh: number
  /** responder: presence low (tPDL) */ pdl: number
  /** responder: how long a read-0 is held low from the slot start */ rd0: number
}

export const ONEWIRE: Readonly<Record<'standard' | 'overdrive', OneWireTiming & { cite: Citation; reset_min: number; slot_min: number; bit_threshold: number }>> = {
  standard: { a: 6e-6, b: 64e-6, c: 60e-6, d: 10e-6, e: 9e-6, f: 55e-6, g: 0, h: 480e-6, i: 70e-6, j: 410e-6, pdh: 30e-6, pdl: 120e-6, rd0: 30e-6, cite: AN126, reset_min: 480e-6, slot_min: 60e-6, bit_threshold: 15e-6 },
  overdrive: { a: 1.0e-6, b: 7.5e-6, c: 7.5e-6, d: 2.5e-6, e: 1.0e-6, f: 7e-6, g: 2.5e-6, h: 70e-6, i: 8.5e-6, j: 40e-6, pdh: 3e-6, pdl: 12e-6, rd0: 4e-6, cite: AN126, reset_min: 48e-6, slot_min: 6e-6, bit_threshold: 2e-6 },
}

/** 1-Wire slave timing limits as 1-Wire device datasheets give them (DS18B20 / DS2431 AC characteristics, and AN126):
 * what a check without a device spec judges a bus against. */
const OW_CITE: Citation = { source: 'Maxim 1-Wire device AC characteristics (DS18B20, DS2431) and AN126; as recalled, not read from a PDF in the library', verified: null }
export const ONEWIRE_LIMITS: Readonly<Record<'standard' | 'overdrive', Readonly<Record<string, Limit>>>> = {
  standard: {
    t_rstl: { min: 480e-6, unit: 's', cite: OW_CITE }, t_pdh: { min: 15e-6, max: 60e-6, unit: 's', cite: OW_CITE }, t_pdl: { min: 60e-6, max: 240e-6, unit: 's', cite: OW_CITE },
    t_slot: { min: 60e-6, max: 120e-6, unit: 's', cite: OW_CITE }, t_low1: { min: 1e-6, max: 15e-6, unit: 's', cite: OW_CITE }, t_low0: { min: 60e-6, max: 120e-6, unit: 's', cite: OW_CITE },
    t_rd0: { min: 15e-6, max: 60e-6, unit: 's', cite: OW_CITE, note: "a responder's read-0: past the master's 15 µs sample, released within the slot" },
    t_rec: { min: 1e-6, unit: 's', cite: OW_CITE },
  },
  overdrive: {
    t_rstl: { min: 48e-6, max: 80e-6, unit: 's', cite: OW_CITE }, t_pdh: { min: 2e-6, max: 6e-6, unit: 's', cite: OW_CITE }, t_pdl: { min: 8e-6, max: 24e-6, unit: 's', cite: OW_CITE },
    t_slot: { min: 6e-6, max: 16e-6, unit: 's', cite: OW_CITE }, t_low1: { min: 1e-6, max: 2e-6, unit: 's', cite: OW_CITE }, t_low0: { min: 6e-6, max: 16e-6, unit: 's', cite: OW_CITE },
    t_rd0: { min: 2e-6, max: 6e-6, unit: 's', cite: OW_CITE, note: "a responder's read-0: past the master's 2 µs sample, released within the slot" },
    t_rec: { min: 1e-6, unit: 's', cite: OW_CITE },
  },
}

// ------------------------------------------------------------------ CAN

export const CAN_CITE: Citation = { source: 'ISO 11898-1:2015 (frame format, bit stuffing, CRC-15, bit timing); as recalled, not read from the standard', verified: null }

/** Every parameter name protocol.spec accepts, per protocol (unknown names are refused, so a typo is caught). */
export const PARAMS: Readonly<Record<string, readonly string[]>> = {
  i2c: Object.keys(I2C_PARAMS),
  spi: Object.keys(SPI_PARAMS),
  uart: Object.keys(UART_PARAMS),
  can: ['bitrate', 'sample_point', 'sjw', 'tq'],
  onewire: ['speed', 't_rstl', 't_pdh', 't_pdl', 't_slot', 't_low1', 't_low0', 't_rd0', 't_rec'],
  i2s: ['f_bclk', 'tsu', 'th', 'word_bits'],
}
