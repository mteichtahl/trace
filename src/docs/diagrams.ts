/**
 * The figures Scribe's documents carry (docs/scribe.md): each kind, how it is made, and — for the Mermaid ones —
 * which Mermaid diagram types it may be written as. Nothing is drawn freehand: every kind names the records or the
 * tool it is generated from, so a document and the app's views never disagree.
 */
export type FigureMaker =
  | 'mermaid'     // written in the markdown as a ```mermaid block, rendered to SVG for the PDF
  | 'ontology'    // drawn from the ontology records the app's React Flow views use, emitted as Mermaid
  | 'blender'     // render.* (python/blender): Eevee drafts, Cycles for releases
  | 'build123d'   // mech.*: dimensioned drawings from the enclosure model
  | 'kicad'       // kicad-cli exports: schematic sheets
  | 'protocol'    // protocol.diagram / protocol.capture: timing diagrams and decoded traces

export interface FigureDef {
  maker: FigureMaker
  /** In words, for the caption check and for Scribe's prompt. */
  what: string
  /** Mermaid diagram types allowed (makers mermaid and ontology only). */
  mermaid?: readonly string[]
}

const FLOW = ['flowchart', 'graph'] as const

export const FIGURES = {
  'system-context': { maker: 'ontology', what: 'the product and what it connects to', mermaid: FLOW },
  'block-diagram': { maker: 'ontology', what: 'the blocks and their connections', mermaid: FLOW },
  'data-flow': { maker: 'ontology', what: 'how data moves through the blocks', mermaid: FLOW },
  'journey-flow': { maker: 'ontology', what: 'the project\'s stages and gates', mermaid: FLOW },
  'module-diagram': { maker: 'ontology', what: 'one block\'s circuit in outline', mermaid: FLOW },
  'pin-plan': { maker: 'ontology', what: 'pins to nets and functions', mermaid: FLOW },
  'power-tree': { maker: 'ontology', what: 'rails from source to load', mermaid: FLOW },
  'firmware-flow': { maker: 'mermaid', what: 'firmware start-up and main loop', mermaid: [...FLOW, 'stateDiagram-v2'] },
  'setup-flow': { maker: 'mermaid', what: 'setting the product up, step by step', mermaid: FLOW },
  'troubleshooting-flow': { maker: 'mermaid', what: 'symptom to fix', mermaid: FLOW },
  sequence: { maker: 'mermaid', what: 'messages exchanged over time', mermaid: ['sequenceDiagram'] },
  'state-machine': { maker: 'mermaid', what: 'an interface\'s states and transitions', mermaid: ['stateDiagram-v2', 'stateDiagram'] },
  'message-layout': { maker: 'mermaid', what: 'a message or register\'s fields and bits', mermaid: ['packet-beta', 'packet'] },
  'schematic-sheet': { maker: 'kicad', what: 'a schematic sheet' },
  'render-top': { maker: 'blender', what: 'the top of the board' },
  'render-bottom': { maker: 'blender', what: 'the underside of the board' },
  'render-iso': { maker: 'blender', what: 'the board at three-quarter view' },
  'render-in-case': { maker: 'blender', what: 'the board in its case' },
  'render-exploded': { maker: 'blender', what: 'the case and board taken apart' },
  'mech-drawing': { maker: 'build123d', what: 'a line drawing of the case: its dimensioned views, or its parts drawn apart' },
  'timing-diagram': { maker: 'protocol', what: 'signal timing against its limits' },
  'decoded-trace': { maker: 'protocol', what: 'a captured or simulated bus exchange, decoded' },
} as const satisfies Record<string, FigureDef>

export type FigureKind = keyof typeof FIGURES
export const FIGURE_KINDS = Object.keys(FIGURES) as FigureKind[]

export function isFigureKind(s: string): s is FigureKind {
  return Object.hasOwn(FIGURES, s)
}

/** A Mermaid block's diagram type: its first word, after any front matter, directives and comments. */
export function mermaidType(code: string): string | null {
  let text = code.replace(/^\s*---[\s\S]*?\n---\s*\n/, '')
  text = text.replace(/%%\{[\s\S]*?\}%%/g, '')
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/)[0] ?? null
  }
  return null
}

/** Why a Mermaid block cannot stand for `kind`, or null when it can. */
export function mermaidProblem(kind: FigureKind, code: string): string | null {
  const def: FigureDef = FIGURES[kind]
  if (!def.mermaid) return `a ${kind} is made by ${def.maker}, not written as Mermaid`
  const t = mermaidType(code)
  if (!t) return 'the Mermaid block is empty'
  if (!def.mermaid.includes(t)) return `a ${kind} is written as ${def.mermaid.join(' or ')}, not ${t}`
  return null
}
