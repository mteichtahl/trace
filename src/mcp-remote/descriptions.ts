/**
 * What each tool of the MCP endpoint does, in plain words for a model choosing one (src/mcp-remote/server.ts). One per
 * action a connected system may call (src/api/service-policy.ts SERVICE_ACTIONS); test/mcp-remote keeps the two equal.
 * The arguments themselves are described by each tool's input schema, made from the action's own zod arguments.
 */
export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  whoami: 'Who this connected system is to trace: its id, name, scopes and class.',
  projects: 'The projects this system is on, with its part on each (contributor: may change it; reviewer: reads only). Start here to find a repo.',
  'installation.layout': 'How this trace installation keeps each project\'s cloud resources (flat or nested) and how many projects it holds.',
  status: 'A project\'s state on GitHub: open pull requests, open agent-fix issues, recent trace workflow runs and the last deploy. Needs repo (OWNER/REPO).',
  'settings.get': 'A project\'s trace settings as set in its database on the default branch, and the resolved configuration with any errors.',
  runs: 'A project\'s recorded runs (tool calls, simulations, checks), newest first. Narrow with kind, agent and limit.',
  run: 'One recorded run of a project by id: its arguments, result, measurements and artifact list.',
  artifact: 'One artifact of a run (by run id and artifact name) as base64, at most 8 MB.',
  'jobs.list': 'A project\'s jobs: running, queued, paused and the last day\'s finished ones, each agent\'s status and queue, and the hand-offs between specialists.',
  job: 'One job by id: its state and log. With afterVersion and waitS (up to 240 s) the answer waits until the job changes, so there is no need to poll.',
  'journey.get': 'Where a project is on its journey: stages, gates, the next step, open questions, waivers, decisions and its jobs.',
  'requirements.trace': 'A project\'s requirements, each with its evidence status (verified, failing, untested, waived), its tests, and the intent statements it comes from.',
  'design.get': 'A project\'s design: schematic sheets with their electrical rule check findings, the board with its design rule check findings, the architecture and the pin plan.',
  'build.get': 'A project\'s build record: releases, orders and their shipping, boards by serial with their inspection, and bench readings.',
  'cost.get': 'A project\'s stage timeline: when each stage started and finished. Money is shown to admins only.',
  'files.list': 'A project\'s files at a ref (the default branch unless named), grouped by kind: design, fabrication, firmware, documents, models, evidence.',
  'files.url': 'One file of a project by path (optionally at an earlier commit): its bytes as base64 up to 8 MB, else a short-lived download link.',
  'graph.neighbourhood': 'What trace knows around one item of a project (a requirement id such as REQ-001, a run, a part): linked requirements, runs, decisions, blocks and parts, as nodes and links.',
  'kb.search': 'Search a project\'s knowledge base (its documents and datasheets) with a query; returns the best passages with their sources.',
  'tools.list': 'The electronics tools a project can run through trace (never the hardware ones), with their input schemas and whether each needs write.',
  'tools.waits': 'What a project\'s tool calls are waiting on (a knowledge-base sync, a graphics card job). With afterVersion and waitS the answer waits for a change.',
  tool: 'Run one of a project\'s tools (name from tools list, args as its schema) on the project\'s own worker, on a clone of its default branch. Tools that write the shared library need the write scope and the contributor part.',
  task: 'Start a task: a free-form request that trace\'s agents work on in the project, on a claude/ branch. Optional agent picks a specialist. Returns the job id; follow it with job.',
  'job.control': 'Pause, resume, cancel or move up a job this system started (op). Jobs started by people cannot be controlled by a system.',
  'settings.set': 'Change or unset one project setting (key, value or unset: true). trace commits it on a new branch; a person merges the pull request.',
  'kb.sync': 'Sync a project\'s default branch into its knowledge base, and wait up to wait_minutes for the ingestion to finish.',
}
