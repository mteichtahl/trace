/**
 * Part heights above the board face, for the case's fit check (docs/enclosure-build.md, "Board facts"). The images
 * carry no KiCad 3D model library, so a height comes, first match, from:
 *
 *   field    the footprint's `Height` field (mm: "3.3" or "3.3mm"), which a person sets in KiCad
 *   table    HEIGHTS below, by footprint name, for the KiCad library's common packages: the nominal seated height
 *            from the package drawings the library footprints are made from (JEDEC / EIA outlines and the usual
 *            manufacturers' drawings), rounded up to 0.1 mm
 *   default  DEFAULT_HEIGHT_MM, reported with a warning so the person can set a Height field
 *
 * The table is deliberately on the tall side where a package family varies (an SOIC is 1.75 mm at most, so 1.75):
 * the fit check would rather report a gap that is not needed than miss a clash.
 */

export const DEFAULT_HEIGHT_MM = 5.0

export interface HeightRule {
  /** matched against the footprint name without its library (`SOT-23-5`), case-insensitive */
  pattern: RegExp
  /** mm above the face, or a function of the regex match (a diameter or pitch in the name) */
  height: number | ((m: RegExpExecArray) => number)
  /** what the figure is, in a few words */
  note: string
}

const num = (s: string | undefined): number => Number((s ?? '').replace(',', '.'))

/** First match wins: specific names before families. */
export const HEIGHTS: readonly HeightRule[] = [
  // passives by EIA size code (chip resistors are thinner than capacitors; capacitors at their thickest common part)
  { pattern: /^R_0201/i, height: 0.3, note: '0201 chip resistor' },
  { pattern: /^R_0402/i, height: 0.4, note: '0402 chip resistor' },
  { pattern: /^R_0603/i, height: 0.55, note: '0603 chip resistor' },
  { pattern: /^R_0805/i, height: 0.6, note: '0805 chip resistor' },
  { pattern: /^R_1206/i, height: 0.7, note: '1206 chip resistor' },
  { pattern: /^(C|L)_0201/i, height: 0.35, note: '0201 chip capacitor or inductor' },
  { pattern: /^(C|L)_0402/i, height: 0.6, note: '0402 chip capacitor or inductor' },
  { pattern: /^(C|L)_0603/i, height: 0.9, note: '0603 chip capacitor or inductor' },
  { pattern: /^(C|L)_0805/i, height: 1.35, note: '0805 chip capacitor or inductor (thickest common)' },
  { pattern: /^(C|L)_1206/i, height: 1.8, note: '1206 chip capacitor or inductor (thickest common)' },
  { pattern: /^(C|L)_1210/i, height: 2.5, note: '1210 chip capacitor or inductor (thickest common)' },
  { pattern: /^(LED|D)_0402/i, height: 0.5, note: '0402 chip LED or diode' },
  { pattern: /^(LED|D)_0603/i, height: 0.8, note: '0603 chip LED or diode' },
  { pattern: /^(LED|D)_0805/i, height: 1.1, note: '0805 chip LED or diode' },
  { pattern: /^(LED|D)_1206/i, height: 1.3, note: '1206 chip LED or diode' },
  // SMD electrolytics: CP_Elec_<D>x<H> names both
  { pattern: /^CP_Elec_(\d+(?:[.,]\d+)?)x(\d+(?:[.,]\d+)?)/i, height: (m) => num(m[2]) + 0.3, note: 'SMD electrolytic, height from its name' },
  // radial electrolytics: CP_Radial_D<d>mm (height is not in the name: the usual can is about 2 × D, at least 5 mm)
  { pattern: /^CP_Radial_D(\d+(?:[.,]\d+)?)mm/i, height: (m) => Math.max(5, Math.min(2 * num(m[1]) + 1, 30)), note: 'radial electrolytic, about twice its diameter' },
  // transistors and regulators
  { pattern: /^SOT-23/i, height: 1.25, note: 'SOT-23 family' },
  { pattern: /^SOT-223/i, height: 1.8, note: 'SOT-223' },
  { pattern: /^SOT-89/i, height: 1.6, note: 'SOT-89' },
  { pattern: /^SOT-(323|353|363)|^SC-70/i, height: 1.1, note: 'SC-70 / SOT-323 family' },
  { pattern: /^TO-252|^DPAK/i, height: 2.4, note: 'TO-252 (DPAK)' },
  { pattern: /^TO-263|^D2PAK/i, height: 4.8, note: 'TO-263 (D2PAK)' },
  { pattern: /^TO-220.*Vertical/i, height: 20.0, note: 'TO-220 standing, tab included' },
  { pattern: /^TO-220.*Horizontal/i, height: 4.8, note: 'TO-220 lying flat' },
  { pattern: /^TO-92/i, height: 5.3, note: 'TO-92' },
  // ICs
  { pattern: /^SOIC/i, height: 1.75, note: 'SOIC, at most 1.75 mm' },
  { pattern: /^SSOP|^MSOP|^VSSOP/i, height: 1.75, note: 'SSOP / MSOP family' },
  { pattern: /^TSSOP/i, height: 1.2, note: 'TSSOP, at most 1.2 mm' },
  { pattern: /^(V|W|U)?QFN|^DFN|^(V|W)?SON/i, height: 1.0, note: 'QFN / DFN, at most 1.0 mm' },
  { pattern: /^LQFP/i, height: 1.6, note: 'LQFP, at most 1.6 mm' },
  { pattern: /^TQFP/i, height: 1.2, note: 'TQFP, at most 1.2 mm' },
  { pattern: /^BGA|^LFBGA|^TFBGA/i, height: 1.7, note: 'BGA family' },
  { pattern: /^DIP|^PDIP/i, height: 5.1, note: 'DIP body above the board' },
  // pin headers and sockets: vertical pins stand 8.5 mm above the plastic body at 2.54 mm pitch
  { pattern: /^Pin(Header|Socket)_\d+x\d+_P2\.54mm_Vertical/i, height: (m) => (/Socket/i.test(m[0]) ? 8.5 : 11.0), note: '2.54 mm header (pins and body) or socket' },
  { pattern: /^Pin(Header|Socket)_\d+x\d+_P2\.54mm_Horizontal/i, height: 2.5, note: '2.54 mm right-angle header, body height' },
  { pattern: /^Pin(Header|Socket)_\d+x\d+_P2\.00mm_Vertical/i, height: 8.0, note: '2.00 mm header' },
  { pattern: /^Pin(Header|Socket)_\d+x\d+_P1\.27mm_Vertical/i, height: 5.0, note: '1.27 mm header' },
  { pattern: /^Pin(Header|Socket)_\d+x\d+_P(\d[.,]\d+)mm_Horizontal/i, height: 2.0, note: 'right-angle header, body height' },
  // connectors
  { pattern: /^USB_C_Receptacle/i, height: 3.3, note: 'USB-C receptacle (mid-mount and top-mount vary; top-mount)' },
  { pattern: /^USB_Micro-B/i, height: 2.8, note: 'USB Micro-B receptacle' },
  { pattern: /^USB_Mini-B/i, height: 4.0, note: 'USB Mini-B receptacle' },
  { pattern: /^USB_A/i, height: 7.0, note: 'USB-A receptacle' },
  { pattern: /^JST_PH_.*_Vertical/i, height: 6.0, note: 'JST PH vertical' },
  { pattern: /^JST_PH_.*_Horizontal/i, height: 4.8, note: 'JST PH right-angle' },
  { pattern: /^JST_XH_.*_Vertical/i, height: 7.0, note: 'JST XH vertical' },
  { pattern: /^JST_XH_.*_Horizontal/i, height: 5.8, note: 'JST XH right-angle' },
  { pattern: /^JST_SH_/i, height: 3.0, note: 'JST SH' },
  { pattern: /^BarrelJack/i, height: 11.0, note: 'barrel jack' },
  // switches
  { pattern: /^SW_PUSH_6mm/i, height: 5.0, note: '6 mm tactile switch (5 mm plunger)' },
  { pattern: /^SW_SPST_TL3342|^SW_Push_1P1T_NO_CK_KMR2/i, height: 2.0, note: 'low-profile tactile switch' },
  { pattern: /^SW_.*(PTS645|6x6)/i, height: 5.0, note: '6 × 6 mm tactile switch' },
  { pattern: /^SW_.*(4x4|3x4|3x6)/i, height: 2.5, note: 'small SMD tactile switch' },
  // crystals
  { pattern: /^Crystal_HC49-4H|^Crystal_HC49-SD/i, height: 4.2, note: 'HC-49 low-profile (HC-49/S SMD)' },
  { pattern: /^Crystal_HC49/i, height: 13.5, note: 'HC-49/U, standing' },
  { pattern: /^Crystal_SMD_(2012|2016|2520)/i, height: 0.8, note: 'small SMD crystal' },
  { pattern: /^Crystal_SMD_(3225|5032|7050)/i, height: 1.2, note: 'SMD crystal' },
  { pattern: /^Crystal_SMD_HC49/i, height: 4.2, note: 'HC-49 SMD' },
  // test points and mounting holes have no body worth checking
  { pattern: /^TestPoint/i, height: 0.5, note: 'test point' },
  { pattern: /^MountingHole/i, height: 0.0, note: 'mounting hole' },
  { pattern: /^Fiducial/i, height: 0.0, note: 'fiducial' },
]

export interface Height { height_mm: number; source: 'field' | 'table' | 'default'; note: string }

/** A Height field's value in mm, or null when it is not a plain number with an optional "mm". */
export function heightField(v: string | undefined): number | null {
  if (v === undefined) return null
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(mm)?\s*$/i.exec(v)
  return m ? num(m[1]) : null
}

/** The part's height: its Height field, else the table, else the default. `fields` are the footprint's fields. */
export function partHeight(footprint: string, fields: Record<string, string>): Height {
  const key = Object.keys(fields).find((k) => k.toLowerCase() === 'height')
  const f = key ? heightField(fields[key]) : null
  if (f !== null) return { height_mm: f, source: 'field', note: `Height field ${JSON.stringify(fields[key as string])}` }
  const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint
  for (const r of HEIGHTS) {
    const m = r.pattern.exec(name)
    if (m) return { height_mm: Math.round((typeof r.height === 'number' ? r.height : r.height(m)) * 100) / 100, source: 'table', note: r.note }
  }
  return { height_mm: DEFAULT_HEIGHT_MM, source: 'default', note: 'no Height field and no table entry' }
}
