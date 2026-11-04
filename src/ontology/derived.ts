/**
 * Facts the graph carries that no column stores (trace:derived): worked out when the graph is built, by the same code
 * the app and the guided skills use, so a shape over the graph and the screen a person reads agree.
 *
 *   isLive           on each Requirement: not struck by a person's standing decision, nor rejected or obsolete by the
 *                    agents' row (src/tools/design/record.ts requirementDecisions, as the requirements list reads it)
 *   isCurrentOption  on each ArchitectureOption: the option the design goes ahead with (architectureView's `current`:
 *                    the chosen one, else the recommended one, else the first)
 */
import type { DatabaseSync } from 'node:sqlite'
import { DataFactory, type Store } from 'n3'
import { loadDesignDecisions } from '../tools/design/decisions.js'
import { readDesignRows } from '../tools/design/db.js'
import { architectureView, requirementDecisions, requirementsNow } from '../tools/design/record.js'
import { NS } from './vocab.js'
import { nodeIri, type GraphOptions } from './graph.js'

const { namedNode, literal, quad } = DataFactory
const BOOL = namedNode('http://www.w3.org/2001/XMLSchema#boolean')
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** Add the derived facts of `project` (the design rows) and `decisions` (the database holding people's decisions). */
export function addDerived(store: Store, o: GraphOptions, project: DatabaseSync, decisions: DatabaseSync | null): void {
  const ds = decisions ? loadDesignDecisions(decisions) : []
  if (has(project, 'requirements')) {
    const all = project.prepare('SELECT * FROM requirements ORDER BY id').all() as Record<string, unknown>[]
    const decided = requirementDecisions(ds, requirementsNow(all))
    for (const q of all) {
      const d = decided.get(String(q.id))
      const live = d ? d.choice !== 'struck' : q.status !== 'rejected' && q.status !== 'obsolete'
      store.addQuad(quad(namedNode(nodeIri(o, 'requirement', String(q.id))), namedNode(`${NS}isLive`), literal(String(live), BOOL)))
    }
  }
  if (has(project, 'arch_options')) {
    const a = architectureView(readDesignRows(project), ds)
    for (const opt of a.options) store.addQuad(quad(namedNode(nodeIri(o, 'arch-option', opt.id)), namedNode(`${NS}isCurrentOption`), literal(String(opt.id === a.current), BOOL)))
  }
}
