/**
 * Which table and column becomes which class and property of the ontology (docs/ontology.md "Storage, runtime and
 * access": "One file says which table and column becomes which class and property"). trace's SQLite tables stay the
 * record; this mapping is how the ontology reads them (src/ontology/graph.ts builds a project's graph through it).
 *
 * Every column of every table in a mapped database is here, either with the property it becomes or, as `ignore`, with
 * why it is left out. test/ontology/mapping.test.ts holds that against the live schema (applyJourneySchema,
 * applyAgentFactsSchema, applyJobIndexSchema): a new column without a rule, or a rule for a column that is gone, fails
 * CI. Every class and property named here must be defined in ontology/*.ttl, with a matching kind.
 *
 * A column's rule:
 *
 *   { prop, as? }            a literal: text (default), time (seconds since 1970 → xsd:dateTime), int, decimal, bool
 *                            (0/1), date (YYYY-MM-DD), json (kept whole, rdf:JSON)
 *   { prop, ref, type? }     a link to the node of kind `ref` with the column's value as its id (stage, gate, job, …);
 *                            `type`: the linked node's class is also stated (for kinds no table stores: a revision, a
 *                            specialist, a template). `ref` may be a function of the value: [kind, id] or null
 *   { prop, refList, type? } a JSON list of ids, each linked like `ref`
 *   { prop, textList }       a JSON list of strings, each a literal
 *   { prop, objects }        a JSON list of objects, each its own node (<row>/<prop>/<n>) of `objects.class`, its fields
 *                            mapped like columns; `typeIf` adds a class when a field is true (a recommended option)
 *   { prop, pick }           a link to one of this row's `objects` nodes: the one in `pick.column` whose `pick.field`
 *                            equals the value (the option a person chose)
 *   { ignore }               left out, with the reason
 *
 * Rows become nodes urn:trace:<installation>:<project>:<kind>:<key>; a table's `link` adds a constant link from one
 * node to every row (the journey has each stage).
 */

export type DbName = 'journey' | 'facts' | 'jobs'
export type LiteralAs = 'text' | 'time' | 'int' | 'decimal' | 'bool' | 'date' | 'json'

export type RefTarget = string | ((value: string) => readonly [kind: string, id: string] | null)

export interface FieldMap { class: string; fields: Readonly<Record<string, ColumnRule>>; typeIf?: { field: string; class: string } }

export type ColumnRule =
  | { prop: string; as?: LiteralAs }
  | { prop: string; ref: RefTarget; type?: string }
  | { prop: string; refList: string; type?: string }
  | { prop: string; textList: true }
  | { prop: string; objects: FieldMap }
  | { prop: string; pick: { column: string; field: string } }
  | { ignore: string }

export interface TableMap {
  db: DbName
  table: string
  class: string
  /** the IRI kind of a row's node */
  kind: string
  /** the column (or columns, joined by "/") that identifies a row */
  key: string | readonly string[]
  columns: Readonly<Record<string, ColumnRule>>
  /** a link from a fixed node to every row: [kind, id, property] */
  link?: readonly [kind: string, id: string, prop: string]
}

export const ID = (why = 'the identifier: it names the node') => ({ ignore: why }) as const

const evidence: FieldMap = {
  class: 'Evidence',
  fields: { kind: { prop: 'evidenceKind' }, ref: { prop: 'evidenceRef' }, label: { prop: 'label' } },
}
const options: FieldMap = {
  class: 'Option',
  typeIf: { field: 'recommended', class: 'Recommendation' },
  fields: {
    id: { ignore: 'the option\'s id within its question' }, label: { prop: 'label' }, recommended: { prop: 'isRecommended', as: 'bool' },
    why: { prop: 'justification' }, gives_up: { prop: 'givesUp' },
  },
}
const revision = { ref: 'revision', type: 'Revision' } as const
const specialist = { ref: 'specialist', type: 'Specialist' } as const
/** criterion_opens.item: a criterion id, or waiver:<id> */
const opened: RefTarget = (v) => (v.startsWith('waiver:') ? ['waiver', v.slice('waiver:'.length)] : ['criterion', v])

export const TABLES: readonly TableMap[] = [
  // ------------------------------------------------------------------ journey.db
  {
    db: 'journey', table: 'journey', class: 'Journey', kind: 'journey', key: 'id',
    columns: {
      id: ID('always "current": one journey per project'),
      template: { prop: 'fromTemplate', ref: 'template', type: 'JourneyTemplate' },
      revision: { prop: 'currentRevision', ...revision },
      current_stage: { prop: 'currentStage', ref: 'stage' },
      later: { prop: 'laterStage', textList: true },
      start: { prop: 'startedFrom' },
      name: { prop: 'name' }, description: { prop: 'description' }, icon: { prop: 'icon', as: 'json' },
      build: { prop: 'buildPlan', as: 'json' },
      created: { prop: 'createdAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' }, by: { prop: 'updatedBy' },
    },
  },
  {
    db: 'journey', table: 'stages', class: 'Stage', kind: 'stage', key: 'id', link: ['journey', 'current', 'hasStage'],
    columns: {
      id: { prop: 'stageKind' }, ord: { prop: 'order', as: 'decimal' }, revision: { prop: 'inRevision', ...revision },
      started: { prop: 'startedAt', as: 'time' }, finished: { prop: 'endedAt', as: 'time' },
      reopened_at: { prop: 'reopenedAt', as: 'time' }, reopened_reason: { prop: 'reopenReason' }, reopened_by: { prop: 'reopenedBy' },
      updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'gates', class: 'Gate', kind: 'gate', key: 'id',
    columns: {
      id: ID(), stage: { prop: 'ofStage', ref: 'stage' }, ord: { prop: 'order', as: 'decimal' }, name: { prop: 'name' },
      returned_at: { prop: 'returnedAt', as: 'time' }, returned_by: { prop: 'returnedBy' }, return_reason: { prop: 'returnReason' },
      updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'gate_criteria', class: 'Criterion', kind: 'criterion', key: 'id',
    columns: {
      id: ID(), gate: { prop: 'ofGate', ref: 'gate' }, ord: { prop: 'order', as: 'decimal' }, text: { prop: 'text' },
      owner: { prop: 'ownedBy' }, evidence_label: { prop: 'evidenceLabel' }, status: { prop: 'status' },
      evidence: { prop: 'hasEvidence', objects: evidence },
      checked_at: { prop: 'checkedAt', as: 'time' }, checked_by: { prop: 'checkedBy' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'criterion_opens', class: 'EvidenceOpening', kind: 'opening', key: ['item', 'who'],
    columns: { item: { prop: 'opened', ref: opened }, who: { prop: 'recordedByHash' }, at: { prop: 'recordedAt', as: 'time' } },
  },
  {
    db: 'journey', table: 'gate_signatures', class: 'Signature', kind: 'signature', key: 'id',
    columns: {
      id: ID(), gate: { prop: 'signs', ref: 'gate' }, revision: { prop: 'inRevision', ...revision },
      by: { prop: 'recordedBy' }, by_hash: { prop: 'recordedByHash' }, at: { prop: 'recordedAt', as: 'time' },
      criteria: { prop: 'criteriaAsSigned', as: 'json' }, waivers: { prop: 'acknowledgesWaiver', refList: 'waiver' },
      notes: { prop: 'note' }, superseded_at: { prop: 'supersededAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'questions', class: 'Question', kind: 'question', key: 'id',
    columns: {
      id: ID(), kind: { prop: 'questionKind' }, asked_by: { prop: 'askedBy' }, asked_of: { prop: 'askedOf' },
      stage: { prop: 'atStage', ref: 'stage' }, text: { prop: 'text' }, blocks: { prop: 'blocks' },
      options: { prop: 'hasOption', objects: options }, sources: { prop: 'consulted', objects: evidence },
      job_id: { prop: 'fromJob', ref: 'job' }, asked_at: { prop: 'askedAt', as: 'time' },
      answer: { prop: 'answer' },
      option_id: { prop: 'chose', pick: { column: 'options', field: 'id' } },
      answer_reason: { prop: 'reason' }, answered_by: { prop: 'answeredBy' }, answered_by_hash: { prop: 'recordedByHash' },
      answered_at: { prop: 'answeredAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'waivers', class: 'Waiver', kind: 'waiver', key: 'id',
    columns: {
      id: ID(), stage: { prop: 'atStage', ref: 'stage' }, gate: { prop: 'atGate', ref: 'gate' },
      target_kind: { prop: 'targetKind' }, target: { prop: 'waivesTarget' }, reason: { prop: 'reason' }, risk: { prop: 'risk' },
      severity: { prop: 'severity' }, caught_where: { prop: 'caughtWhere' }, scope: { prop: 'scope' },
      by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' },
      acknowledged_by: { prop: 'acknowledgedBy' }, acknowledged_at: { prop: 'acknowledgedAt', as: 'time' },
      closed_at: { prop: 'closedAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'decisions', class: 'DecisionEntry', kind: 'decision', key: 'id',
    columns: {
      id: ID(), at: { prop: 'recordedAt', as: 'time' }, kind: { prop: 'entryKind' }, stage: { prop: 'atStage', ref: 'stage' },
      ref: { prop: 'about' }, summary: { prop: 'summary' }, by: { prop: 'recordedBy' }, detail: { prop: 'detail', as: 'json' },
    },
  },
  {
    db: 'journey', table: 'orders', class: 'PlacedOrder', kind: 'order', key: 'id',
    columns: {
      id: ID(), revision: { prop: 'ofRevision', ...revision }, fab: { prop: 'fabHouse' }, number: { prop: 'fabOrderNumber' },
      boards: { prop: 'boardCount', as: 'int' }, paid: { prop: 'amountPaid', as: 'decimal' }, currency: { prop: 'currency' },
      ship_date: { prop: 'expectedShipDate', as: 'date' }, state: { prop: 'status' },
      placed_by: { prop: 'placedBy' }, placed_at: { prop: 'placedAt', as: 'time' },
      shipped_at: { prop: 'shippedAt', as: 'time' }, delivered_at: { prop: 'deliveredAt', as: 'time' },
      note: { prop: 'note' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'order_tracking', class: 'Shipment', kind: 'shipment', key: 'order_id',
    columns: {
      order_id: { prop: 'ofOrder', ref: 'order' }, carrier: { prop: 'carrier' }, tracking: { prop: 'trackingNumber' },
      by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'boards', class: 'BoardUnit', kind: 'board', key: 'serial',
    columns: {
      serial: { prop: 'serial' }, order_id: { prop: 'cameIn', ref: 'order' }, revision: { prop: 'ofRevision', ...revision },
      received_at: { prop: 'receivedAt', as: 'time' }, status: { prop: 'status' }, notes: { prop: 'note' },
      photos: { prop: 'photo', textList: true }, by: { prop: 'recordedBy' },
      created: { prop: 'createdAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'board_checks', class: 'InspectionCheck', kind: 'inspection', key: 'id',
    columns: {
      id: ID(), serial: { prop: 'ofBoardUnit', ref: 'board' }, check_id: { prop: 'checkName' }, kind: { prop: 'checkKind' },
      result: { prop: 'result' }, ref: { prop: 'atReference' }, note: { prop: 'note' }, photo: { prop: 'photo' },
      by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'stuck_dismissals', class: 'StuckDismissal', kind: 'stuck-dismissal', key: 'stuck_id',
    columns: {
      stuck_id: { prop: 'dismisses' }, job_id: { prop: 'fromJob', ref: 'job' }, reason: { prop: 'reason' },
      by: { prop: 'recordedBy' }, by_hash: { prop: 'recordedByHash' }, at: { prop: 'recordedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'handoff_declines', class: 'HandOffDecline', kind: 'handoff-decline', key: 'handoff_id',
    columns: {
      handoff_id: { prop: 'declines', ref: 'handoff' }, reason: { prop: 'reason' },
      by: { prop: 'recordedBy' }, by_hash: { prop: 'recordedByHash' }, at: { prop: 'recordedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'design_decisions', class: 'DesignDecision', kind: 'design-decision', key: 'id',
    columns: {
      id: ID(), kind: { prop: 'decisionKind' }, target: { prop: 'about' }, choice: { prop: 'choice' }, detail: { prop: 'detail', as: 'json' },
      by: { prop: 'recordedBy' }, by_hash: { prop: 'recordedByHash' }, at: { prop: 'recordedAt', as: 'time' },
      superseded_at: { prop: 'supersededAt', as: 'time' }, updated: { prop: 'updatedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'job_controls', class: 'JobControl', kind: 'job-control', key: 'job',
    columns: {
      job: { prop: 'controlsJob', ref: 'job' }, held: { prop: 'held', as: 'bool' }, ord: { prop: 'order', as: 'decimal' },
      discarded: { prop: 'discarded', as: 'bool' }, by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' },
    },
  },
  {
    db: 'journey', table: 'criterion_history', class: 'CriterionChange', kind: 'criterion-change', key: 'id',
    columns: {
      id: ID(), criterion: { prop: 'forCriterion', ref: 'criterion' }, gate: { prop: 'ofGate', ref: 'gate' },
      revision: { prop: 'inRevision', ...revision }, status: { prop: 'status' }, evidence: { prop: 'hasEvidence', objects: evidence },
      source: { prop: 'changeSource' }, by: { prop: 'recordedBy' }, by_hash: { prop: 'recordedByHash' },
      at: { prop: 'recordedAt', as: 'time' }, reconstructed: { prop: 'reconstructed', as: 'bool' },
    },
  },
  {
    db: 'journey', table: 'stage_history', class: 'StageEvent', kind: 'stage-event', key: 'id',
    columns: {
      id: ID(), stage: { prop: 'forStage', ref: 'stage' }, revision: { prop: 'inRevision', ...revision }, event: { prop: 'event' },
      reason: { prop: 'reason' }, by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' },
      reconstructed: { prop: 'reconstructed', as: 'bool' },
    },
  },
  {
    db: 'journey', table: 'journey_history', class: 'JourneyFieldChange', kind: 'journey-change', key: 'id',
    columns: {
      id: ID(), field: { prop: 'field' }, old: { prop: 'oldValue' }, new: { prop: 'newValue' },
      by: { prop: 'recordedBy' }, at: { prop: 'recordedAt', as: 'time' }, reconstructed: { prop: 'reconstructed', as: 'bool' },
    },
  },

  // ------------------------------------------------------------------ facts.db (the agents' facts)
  {
    db: 'facts', table: 'agent_questions', class: 'Question', kind: 'agent-question', key: 'id',
    columns: {
      id: ID(), asked_by: { prop: 'askedBy' }, agent: { prop: 'performedBy', ...specialist },
      asked_of_sub: { ignore: 'a person\'s sign-in identifier: who is asked is kept in words through asked_part, and the API resolves the person' },
      asked_part: { prop: 'askedOfPart' }, stage: { prop: 'atStage', ref: 'stage' }, text: { prop: 'text' }, blocks: { prop: 'blocks' },
      options: { prop: 'hasOption', objects: options }, sources: { prop: 'consulted', objects: evidence },
      job_id: { prop: 'fromJob', ref: 'job' }, asked_at: { prop: 'askedAt', as: 'time' },
    },
  },
  {
    db: 'facts', table: 'criterion_checks', class: 'CriterionCheck', kind: 'criterion-check', key: 'id',
    columns: {
      id: ID(), criterion: { prop: 'checks', ref: 'criterion' }, status: { prop: 'status' }, evidence: { prop: 'hasEvidence', objects: evidence },
      note: { prop: 'note' }, checked_at: { prop: 'checkedAt', as: 'time' }, by: { prop: 'performedBy', ...specialist },
      job_id: { prop: 'fromJob', ref: 'job' }, revision: { prop: 'inRevision', ...revision },
    },
  },
  {
    db: 'facts', table: 'stuck', class: 'Stuck', kind: 'stuck', key: 'id',
    columns: {
      id: ID(), job_id: { prop: 'fromJob', ref: 'job' }, agent: { prop: 'performedBy', ...specialist },
      agent_label: { ignore: 'the specialist\'s name in words: the label of the specialist it links to' },
      why: { prop: 'reason' }, recommendation: { prop: 'recommendation' }, options: { prop: 'hasOption', objects: options },
      sources: { prop: 'consulted', objects: evidence }, stage: { prop: 'atStage', ref: 'stage' }, at: { prop: 'recordedAt', as: 'time' },
      resolved_at: { prop: 'resolvedAt', as: 'time' }, resolution: { prop: 'resolution' },
    },
  },
  {
    db: 'facts', table: 'handoffs', class: 'HandOff', kind: 'handoff', key: 'id',
    columns: {
      id: ID(), from_agent: { prop: 'fromSpecialist', ...specialist },
      from_label: { ignore: 'the asking specialist\'s name in words: the label of the specialist it links to' },
      from_job: { prop: 'fromJob', ref: 'job' }, to_kind: { prop: 'toSpecialist', ...specialist }, question: { prop: 'request' },
      evidence: { prop: 'hasEvidence', objects: evidence }, blocks: { prop: 'blocks' }, recommendation: { prop: 'recommendation' },
      acceptance: { prop: 'acceptance', textList: true }, depth: { prop: 'depth', as: 'int' }, state: { prop: 'status' },
      created_at: { prop: 'createdAt', as: 'time' }, job_id: { prop: 'startsJob', ref: 'job' }, started_at: { prop: 'startedAt', as: 'time' },
      answer: { prop: 'answer' }, answer_evidence: { prop: 'answerEvidence', objects: evidence }, confidence: { prop: 'confidence', as: 'decimal' },
      acceptance_met: { prop: 'acceptanceMet', as: 'bool' }, answered_at: { prop: 'answeredAt', as: 'time' },
      why: { prop: 'failureReason' }, ended_at: { prop: 'endedAt', as: 'time' },
    },
  },

  // ------------------------------------------------------------------ jobs.db (the job index)
  {
    db: 'jobs', table: 'jobs', class: 'Job', kind: 'job', key: 'id',
    columns: {
      id: ID(),
      handle: { ignore: 'the API\'s handle for the job (its runtime session and id): how to reach it, not what it is' },
      session: { ignore: 'the runtime session it runs in: operational' },
      kind: { prop: 'jobKind' }, agent: { prop: 'performedBy', ...specialist }, title: { prop: 'title' },
      number: { prop: 'githubNumber', as: 'int' },
      requested_by_sub: { ignore: 'a person\'s sign-in identifier; requested_by names them' },
      requested_by: { prop: 'requestedBy' }, state: { prop: 'status' },
      step: { ignore: 'the latest line of its log: live progress, kept in the run logs' },
      queued_at: { prop: 'queuedAt', as: 'time' }, started_at: { prop: 'startedAt', as: 'time' }, ended_at: { prop: 'endedAt', as: 'time' },
      beat_at: { ignore: 'the runtime\'s heartbeat: operational' }, where_: { ignore: 'where it runs now, in words: operational' },
      branch: { prop: 'branch' }, parent_job: { prop: 'parentJob', ref: 'job' }, handoff: { prop: 'answersHandOff', ref: 'handoff' },
      resume_of: { prop: 'resumes', ref: 'job' }, resumed_by: { ignore: 'the inverse of resumes, which the later job states' },
      summary: { prop: 'summary' }, error: { prop: 'error' },
      payload: { ignore: 'the task\'s request as the runtime takes it, to start it again: its words are the title' },
      claude_session: { ignore: 'the agent session kept for a paused job: operational' },
      paused_by: { prop: 'pausedBy' }, paused_at: { prop: 'pausedAt', as: 'time' },
      tail: { ignore: 'its last log lines: kept in the run logs' }, vitals: { ignore: 'the machine\'s memory at its last word: operational' },
      lost_at: { prop: 'lostAt', as: 'time' }, updated_at: { prop: 'updatedAt', as: 'time' },
    },
  },
]

/** Tables of a mapped database the ontology leaves out, with why. */
export const IGNORED_TABLES: Readonly<Record<string, string>> = {
  'journey.skill_drafts': 'one person\'s unsubmitted draft of a guided skill: never part of the record (it is not copied with a release)',
  'jobs.batch': 'the remote machines a job\'s heavy tools ran on (AWS Batch bookkeeping): operational',
}

/**
 * Tables trace's project database registers that a later phase maps (docs/ontology-plan.md): the design record and
 * the run record with the board module, the bench readings with it, and the rest as their shapes need them. Listed so
 * a new table still fails the drift test until someone decides where it goes.
 */
export const LATER_TABLES: Readonly<Record<string, string>> = {
  intent_statements: 'board module', requirement_intent: 'board module', arch_options: 'board module', arch_criteria: 'board module',
  arch_scores: 'board module', arch_blocks: 'board module', arch_connections: 'board module', pin_plan: 'board module',
  sheet_requirements: 'board module', requirements: 'board module', test_items: 'board module', test_results: 'board module',
  coverage_points: 'board module', coverage_hits: 'board module', verify_merge_notes: 'board module', bringup_readings: 'board module',
  ams_specs: 'when a shape needs them', protocol_specs: 'when a shape needs them', thermal_envelopes: 'when a shape needs them',
  thermal_part_limits: 'when a shape needs them', thermal_budget: 'when a shape needs them', thermal_derating: 'when a shape needs them',
  thermal_corrections: 'when a shape needs them', kb_objects: 'when a shape needs them', prompts: 'when a shape needs them',
  prompt_history: 'when a shape needs them',
}

export const tableMap = (db: DbName, table: string): TableMap | undefined => TABLES.find((t) => t.db === db && t.table === table)
export const keyColumns = (t: TableMap): readonly string[] => (typeof t.key === 'string' ? [t.key] : t.key)
