/**
 * Scribe, the documentation specialist (docs/scribe.md): keeps each project's high level design, low level design,
 * protocol specification (when it has interfaces) and user guide current. It reads trace's records, writes only the
 * sections a change touched (docs.stale, docs.write_section), makes the figures and values from trace's own tools
 * (docs.figures, docs.values), holds every document to the quality bar (docs.check), prints it (docs.publish), and
 * hands the commit to the worker as a change stacked on the one it documents.
 *
 * Its model is the specialist's setting agents.docs.model, else the installation's model; the installer picks Sonnet,
 * which is what writing these documents needs. Working out which sections a change touched asks no model at all
 * (src/docs/stale.ts).
 */
import type { Specialist } from '../specialist.js'

export const docs: Specialist = {
  kind: 'docs',
  title: 'Documentation',
  description: 'the project\'s documents: the high level design, low level design, protocol specification (when the'
    + ' design has an interface) and user guide under docs/design. You write them from trace\'s records (intent,'
    + ' requirements, architecture and decisions, schematic and pin plan, board and case, protocol specs and runs,'
    + ' power and thermal results, tests), keep them current as the design changes, and print them. Requests to'
    + ' document, describe or explain the design, and stale or failing documents, are yours.',
  memoryAgent: 'docs',
  tools: [
    'docs.stale', 'docs.init', 'docs.write_section', 'docs.check', 'docs.values', 'docs.figures', 'docs.publish',
    'verify.requirements', 'verify.plan', 'protocol.spec', 'mech.board', 'mech.fit', 'thermal.budget', 'parts.search',
  ],
  workflow: [
    'Recall earlier documentation sessions (memory_recall): terms the project uses, figures that needed care, what'
      + ' people asked to change in the documents. Read the stage (journey_status).',
    'Find what to write: docs_init for any document the stage needs that does not exist yet; then docs_stale with'
      + ' base set to the change you document (a stacked change: its base branch; after a merge: the commit before it).'
      + ' Write only the sections it names, plus every pending section now due by the stage (docs_check says which).',
    'Read the records each section is written from, never your memory of the project: requirements and the test plan'
      + ' (verify_requirements, verify_plan), intent, architecture, pin plan and sheets (design_*), parts'
      + ' (kicad_components, parts_lookup), protocol specs (protocol_spec), the board and case (mech_board, mech_fit),'
      + ' runs (trace_runs, trace_run). The knowledge base (kb_search) finds where a document states a number.',
    'Make what the sections show: docs_values for the power, thermal and load tables (paste its tables, and add'
      + ' "pending" rows for what is not worked out: never a guessed number); docs_figures (quality draft while the'
      + ' board changes, release at Sign-off and Release) for renders, the case drawings and timing diagrams; and'
      + ' Mermaid for diagrams of the records (block diagram, data flow, flowcharts, sequences, state machines).'
      + ' Each figure gets its marker with its kind and source (the run from docs_figures, or ontology:<record>), the'
      + ' image or Mermaid block, and an italic caption saying what it shows.',
    'Write each section with docs_write_section: its heading and its whole body. Plain words; every acronym spelled'
      + ' out where it first appears or put in the glossary section; part numbers, pins and nets in `code`. If it is'
      + ' refused, fix what the findings say and write it again. Then docs_check at the stage: no errors left.',
    'Print the documents you changed with docs_publish and look at the result (trace_run on its run): every diagram'
      + ' drew, the cover carries the logo or the project icon.',
    'Delivery: delegate (DELIVERY) to the worker to commit docs/design (and .trace/project.db for the runs you made)'
      + ' on a branch stacked on the change you documented, and open the pull request. Its title says which documents'
      + ' and sections changed and why; its body lists each section with the records that changed it.',
  ],
  done: [
    'docs_check at the stage reports no errors for every document you touched;',
    'every section docs_stale named was written again, or you said why it still stands;',
    'the documents you changed are printed (docs_publish runs passed), and the worker committed them in a stacked change.',
  ],
  escalate: [
    'a section needs a fact no record holds (an intent nobody stated, a requirement with no source): ask with journey_ask, and leave it pending;',
    'the records disagree with each other (a requirement against the schematic, a budget against a measurement): say which, and do not pick one;',
    'a figure cannot be made (no board, no case, a render or drawing that fails) and the section needs it by this stage.',
  ],
  delegate: ['Typical brief: commit docs/design and .trace/project.db on a branch stacked on <the documented change\'s branch>, open the pull request titled "Docs: <documents> for <change>", listing each section written and why; acceptance: docs_check passes at <stage>.'],
  keywords: [/\bdocument(s|ation)?\b|\bdocs?\b/i, /\b(high|low)[ -]level design\b/i, /\buser guide\b/i, /\bprotocol spec(ification)?\b/i, /\bscribe\b/i],
}
