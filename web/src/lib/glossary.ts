/**
 * The terms trace explains when a person hovers or taps them (docs/user-journey.md, Glossary). Each definition is
 * the one-line version shown in the app. Keys are matched case-sensitively for acronyms, case-insensitively for words.
 */
export const GLOSSARY: Record<string, string> = {
  ADC: 'Analogue-to-digital converter: the part of a chip that turns a voltage into a number',
  BOM: 'Bill of materials: the full parts list for a board, with quantities and part numbers',
  'CISPR 32': 'The international standard for the radio interference electronic equipment may give off',
  CPL: 'Component placement list: where each part sits on the board, for the assembly machine',
  DFM: 'Design for manufacture: checking a board can be built reliably in volume',
  DFT: 'Design for test: making sure each board can be tested in the factory',
  DRC: "Design rule check: KiCad's check that the board layout obeys its spacing and size rules",
  EMC: 'Electromagnetic compatibility: not causing, and not suffering from, radio interference',
  'End of life': 'A part the maker has stopped making, or soon will',
  ERC: "Electrical rule check: KiCad's check that the schematic's connections make sense",
  Gerbers: 'The files a board maker uses to make the bare board, one per layer',
  HIL: 'Hardware in the loop: tests that run against the real board on the bench',
  JLCPCB: 'The board maker and assembler trace prepares orders for first',
  KiCad: 'The open-source electronics design program trace reads and writes',
  LCSC: "JLCPCB's parts supplier; its part codes tell JLCPCB which part to fit",
  LDO: 'Low-dropout regulator: a simple part that lowers a supply voltage to a steady level',
  MCU: 'Microcontroller: the small computer chip that runs the firmware',
  'Monte Carlo': 'Running a simulation many times with parts varied within their tolerances, to see the spread of results',
  MPN: "Manufacturer part number: the maker's own code for a part",
  'Pin plan': 'Which job each pin of the microcontroller does, agreed between schematic and firmware',
  RF: 'Radio frequency: the radio side of a design, such as the antenna and its matching parts',
  SPICE: 'The standard way to simulate an electronic circuit before building it',
  STEP: 'A 3D file format used to share models of boards and enclosures',
  SWD: 'Serial wire debug: the connection used to load and debug firmware on an Arm chip',
  UART: 'A simple two-wire serial connection, often used for log messages',
  Gate: 'A checkpoint between stages: an admin signs it once every criterion is met or waived',
  Waiver: 'A recorded decision to accept a finding instead of fixing it, with its risk and where it is caught instead',
  Contributor: 'Can change the design, answer questions and run tools on this project',
  Reviewer: 'Reads everything and comments at gates; changes nothing',
}

export function define(term: string): string | undefined {
  if (GLOSSARY[term]) return GLOSSARY[term]
  const lower = term.toLowerCase()
  const k = Object.keys(GLOSSARY).find((x) => x.toLowerCase() === lower && x !== x.toUpperCase())
  return k ? GLOSSARY[k] : undefined
}

/** Split text into plain runs and glossary terms (whole words), for <Explained>. */
export function splitTerms(text: string): { text: string; term?: string }[] {
  const terms = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`\\b(${terms.join('|')})\\b`, 'g')
  const out: { text: string; term?: string }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i) })
    out.push({ text: m[0], term: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
