/**
 * The board as the ontology reads it (docs/ontology.md "Extracting board facts"): one reader of the .kicad_pcb for
 * cases and boards alike (src/tools/kicad/pcb.ts loadBoard, which mech.board's facts already come from), turned into
 * the board module's records when the graph is built. Nothing is stored: like every other freshness and state in
 * trace, the board's facts are worked out when read, from the board file at the commit being read, so they cannot
 * drift from it. loadBoard keeps parsed boards by their hash, so reading the same board twice parses it once.
 *
 *   addBoard(store, o, path, board)   the board (Board), its copper layers (Layer), every placed part (Component, with
 *                                     where it sits), every pad (Pad, with its net) and every net (Net)
 *   BOARD_CLASSES, BOARD_PROPERTIES   what it writes, so the ontology's tests can hold it to the vocabulary
 *
 * Components and nets are named by their reference and net name, project-wide, so the pin plan's "U1 pin 30 on
 * UART_TX" links to the same nodes. Tracks and vias are counted on the board, not made records each.
 */
import { DataFactory, type NamedNode, type Quad_Object, type Store } from 'n3'
import type { Board } from '../tools/kicad/pcb.js'
import { type GraphOptions, nodeIri } from './graph.js'
import { NS, RDF, XSD } from './vocab.js'

const { namedNode, literal, quad } = DataFactory
const T = (n: string) => namedNode(`${NS}${n}`)
const TYPE = namedNode(`${RDF}type`)
const dec = (n: number) => literal(String(Math.round(n * 1e4) / 1e4), namedNode(`${XSD}decimal`))
const int = (n: number) => literal(String(Math.trunc(n)), namedNode(`${XSD}integer`))

export const BOARD_CLASSES = ['Board', 'Layer', 'Component', 'Pad', 'Net'] as const
export const BOARD_PROPERTIES = [
  'path', 'sha256', 'copperLayers', 'thickness', 'width', 'height', 'viaCount', 'trackCount', 'onBoard', 'name', 'order', 'layerKind',
  'reference', 'componentValue', 'footprintName', 'side', 'positionX', 'positionY', 'rotation', 'ofComponent', 'pinNumber', 'padType', 'onNet',
] as const

/** Add `board`, read from the repository's `path`, to `store`. */
export function addBoard(store: Store, o: GraphOptions, path: string, board: Board): void {
  const id = (kind: string, key: string): NamedNode => namedNode(nodeIri(o, kind, key))
  const add = (s: NamedNode, p: string, v: Quad_Object) => store.addQuad(quad(s, T(p), v))
  const b = id('board-file', path)
  store.addQuad(quad(b, TYPE, T('Board')))
  add(b, 'path', literal(path))
  add(b, 'sha256', literal(board.sha256))
  add(b, 'copperLayers', int(board.layers.length))
  if (board.thickness_mm !== null) add(b, 'thickness', dec(board.thickness_mm))
  if (board.outline) { add(b, 'width', dec(board.outline.width_mm)); add(b, 'height', dec(board.outline.height_mm)) }
  add(b, 'viaCount', int(Object.values(board.vias).reduce((n, v) => n + v.length, 0)))
  add(b, 'trackCount', int(Object.values(board.segments).reduce((n, s) => n + s.length, 0)))
  for (const l of board.layers) {
    const n = id('layer', `${path}/${l.name}`)
    store.addQuad(quad(n, TYPE, T('Layer')))
    add(n, 'name', literal(l.name))
    add(n, 'order', dec(l.index))
    add(n, 'layerKind', literal(board.layer_table.find((r) => r.name === l.name)?.type ?? 'signal'))
    add(n, 'onBoard', b)
  }
  const nets = new Set<string>()
  for (const f of board.footprints) {
    if (!f.ref) continue
    const c = id('component', f.ref)
    store.addQuad(quad(c, TYPE, T('Component')))
    add(c, 'reference', literal(f.ref))
    if (f.value) add(c, 'componentValue', literal(f.value))
    if (f.footprint) add(c, 'footprintName', literal(f.footprint))
    add(c, 'side', literal(f.side))
    add(c, 'positionX', dec(f.x_mm))
    add(c, 'positionY', dec(f.y_mm))
    add(c, 'rotation', dec(f.rotation_deg))
    add(c, 'onBoard', b)
    for (const p of f.pads) {
      if (!p.num) continue
      const pad = id('pad', `${f.ref}.${p.num}`)
      store.addQuad(quad(pad, TYPE, T('Pad')))
      add(pad, 'ofComponent', c)
      add(pad, 'pinNumber', literal(p.num))
      if (p.type) add(pad, 'padType', literal(p.type))
      if (p.net) { add(pad, 'onNet', id('net', p.net)); nets.add(p.net) }
    }
  }
  for (const name of nets) {
    const n = id('net', name)
    store.addQuad(quad(n, TYPE, T('Net')))
    add(n, 'name', literal(name))
    add(n, 'onBoard', b)
  }
}
