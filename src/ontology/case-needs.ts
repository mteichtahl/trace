/**
 * What a requirement asks of the case beyond the board it is built around (issues #135, #136 of the test-esp32 run):
 * read from the requirement's words, for the layout gate's fit criterion (ontology/shapes/layout.fit.ttl), which must
 * not say "the board fits its enclosure" while the case holds only the bare board.
 *
 *   window     something is seen through the case: "the OLED visible through a window", "a window in the lid". The
 *              fit check measures openings for edge connectors only, so a window is not checked by it
 *   off-board  a part that sits in the case but not on the board: a display, sensor or other module on a header,
 *              connector, socket or cable, or a battery. The fit check models the board's own parts only, so
 *              such a part (the OLED module on J2) is not checked by it
 *
 * Read from words, so it errs towards asking: a requirement it names costs one waiver once a person has checked the
 * case by hand, while one it missed let the gate pass a case the display could not fit.
 */

/** A part that may sit off the board, as a requirement names it; the first word is what the finding calls it. */
const PARTS: readonly [RegExp, string][] = [
  [/\b(?:oled|lcd|tft|e-?paper|e-?ink|display|screen)s?\b/i, 'display'],
  [/\bbatter(?:y|ies)\b|\b(?:li-?po|li-?ion|lithium) (?:cell|pack)s?\b/i, 'battery'],
  // a module named by what it does; not a bare "module", which is as often one soldered on (an ESP32 module)
  [/\b(?:sensor|camera|keypad|keyboard|touch ?panel|rfid reader)\s+(?:module|board|breakout)s?\b|\bbreakout boards?\b|\bdaughter ?boards?\b/i, 'module'],
]

/** Words saying the part is not on the board: it plugs in, is wired in, or is a module of its own. */
const OFF_BOARD = /\b(?:headers?|connectors?|sockets?|cables?|wires?|wired|leads?|plugs?|plugged|ribbon|off[- ]board|off the board|separate board|breakout|(?:oled|lcd|display|screen|sensor|camera) modules?|packs?)\b/i

/** Words saying something is seen through the case: a window, or visible through the case itself. Not a time window
 *  ("over a 60 s window"): the window must be through, in or of the case. */
const WINDOW: readonly RegExp[] = [
  /\b(?:visible|seen|readable|viewable|viewed|read|shown|shows?)\s+through\s+(?:a|an|the|its)\s+(?:[a-z-]+\s+)?(?:window|opening|cut-?out|aperture|lid|case|enclosure|housing|front|top|cover)\b/i,
  // the part may carry its size: "a window for the 0.96 inch display"
  /\b(?:window|cut-?out|aperture)\s+(?:in|on|of|for|through)\s+(?:a|an|the|its)\s+(?:[\w.-]+\s+){0,3}?(?:case|lid|enclosure|housing|front|top|cover|display|screen|oled|lcd)\b/i,
  /\b(?:case|lid|enclosure|housing|cover)(?:'s)?\s+(?:display\s+)?(?:window|cut-?out|aperture)\b/i,
  /\b(?:display|screen|viewing)\s+window\b/i,
]

export interface CaseNeed {
  /** something is seen through the case */
  window: boolean
  /** the part off the board the case must hold ('display', 'module', 'battery'), or null */
  offBoard: string | null
}

/** Words of money: a sentence about what a budget covers ("case printing and the OLED module are outside this budget",
 *  run 2's REQ-1db18b) names a part without putting it in the case. */
const COST = /\b(?:budget|costs?|price[sd]?|USD|US\$|AUD|EUR|GBP)\b|\$\s?\d/i

/** The sentences of `text`, so a part and the word that puts it off the board are read together. */
const sentences = (text: string): string[] => text.split(/(?<=[.;!?])\s+|\n+/).filter(Boolean)

/** What a requirement's words ask of the case beyond the bare board. */
export function caseNeed(...texts: (string | null | undefined)[]): CaseNeed {
  const all = texts.filter((t): t is string => Boolean(t))
  const window = all.some((t) => WINDOW.some((w) => w.test(t)))
  let offBoard: string | null = null
  for (const s of all.flatMap(sentences)) {
    if (COST.test(s)) continue
    const part = PARTS.find(([p]) => p.test(s))
    if (!part) continue
    // a display seen through a window sits in the case even when nothing says how it is wired
    if (OFF_BOARD.test(s) || (window && part[1] === 'display' && WINDOW.some((w) => w.test(s)))) { offBoard = part[1]; break }
  }
  return { window, offBoard }
}

/** What the case must hold, in words for the fit finding ("a window in the case, with the display behind it"), or null. */
export function caseNeedWords(n: CaseNeed): string | null {
  if (n.window && n.offBoard === 'display') return 'a window in the case, with the display behind it'
  if (n.window && n.offBoard) return `a window in the case, and the ${n.offBoard} off the board`
  if (n.window) return 'a window in the case'
  if (n.offBoard) return `the ${n.offBoard} off the board, in the case`
  return null
}
