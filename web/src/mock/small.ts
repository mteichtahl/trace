/**
 * Mock answers for the small gaps (web gaps "small"): installation.layout (a flat installation, so New project and
 * Admin › Installation show what applies to it; VITE_MOCK_LAYOUT=nested shows the other), prompts.chat,
 * voice.vocabulary, and project.agent (every project's agent is set up; VITE_MOCK_AGENT=setting_up shows the notice a
 * new project has while its agent is being set up). Registered in handlers.ts with one line; answers undefined for anything else.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })

const FLAT = {
  layout: 'flat', projects: { max: 20, updateMax: 15 }, has: { knowledgeBase: false, cpuQueue: false, answerEvents: false },
  note: 'This installation keeps every project in one stack (the flat layout, from before nested stacks). About 20 projects fit; a project created here is added by the self-update only while there are fewer than 15, and otherwise by the next installer run. Projects have no knowledge base or CPU queue, and an agent waiting for a person\'s answer checks on a timer rather than being told at once.',
  recommendation: 'Move to one nested stack per project when losing the agents\' memory records is acceptable: it is the only way to more projects and the features above, and it is a one-off.',
  move: {
    how: 'Run the installer (`tracectl install` or `tracectl upgrade`) and choose "Move to one nested stack per project" under Advanced.',
    steps: [
      'With "keep data" on, a first deploy marks each project\'s memory and its log delivery for deletion; nothing else changes.',
      'The next deploy removes every project from the stack: their agents, roles, token secrets and memories go, every memory record with them. The projects are offline from here.',
      'The last deploy creates every project again, each in its own nested stack, with an empty memory; then the installer sets each repository\'s variables again.',
    ],
    costs: 'Every project\'s memory records are deleted (AgentCore cannot copy them), and the projects are offline for the two deploys (about 30 to 60 minutes); workflows that run in between fail and need running again. Journeys, chats, settings, runs and the knowledge in the repositories are kept.',
    gives: 'Room for 60 projects, projects created in the web app added by every update, a knowledge base per project, the CPU queue, and agents told at once when a person answers their question.',
  },
}
// the project's rules (src/api/rule-answers.ts): one rule in the file, one waiting in change 41, and one answered
// before trace wrote them, which Settings adds (project.rule_from_answer). VITE_MOCK_RULES=empty: no rules at all
const RULES_TEXT = `# Rules

Never change the USB-C footprint without asking.

## Rules from answers

Rules people made in trace when they answered an agent's question with "A rule for the project". Each says who decided it and which question it answers. Follow them as every other rule here.

<!-- trace: rule from question aq-pins -->
- J2 is GND, VCC, SCL, SDA, as the OLED module's pins are.
  - Decided by Priya S. on 2026-11-04, answering the Implementation specialist's question aq-pins: "Which pin order does the OLED header J2 need?"
`
const at = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
const ruleAnswers = [
  { question: 'aq-thermal', asked: 'Can the modem transmit continuously, or should the design assume modem sleep?', asked_by: 'the Thermal specialist', rule: 'Design to modem sleep: no continuous transmit', reason: 'The case has no airflow.', by: 'priya@acme.example', at: at(0.2), state: 'waiting', change: 41 },
  { question: 'aq-pins', asked: 'Which pin order does the OLED header J2 need?', asked_by: 'the Implementation specialist', rule: 'J2 is GND, VCC, SCL, SDA', reason: null, by: 'priya@acme.example', at: at(20), state: 'in_rules', change: null },
  { question: 'aq-log', asked: 'May the firmware log over the USB serial port in production builds?', asked_by: 'the Firmware specialist', rule: 'No logging in production builds', reason: null, by: 'alex@acme.example', at: at(50), state: 'missing', change: null },
]

const NESTED = { layout: 'nested', projects: { max: 60, updateMax: 60 }, has: { knowledgeBase: true, cpuQueue: true, answerEvents: true }, note: 'Each project has its own nested stack: up to 60 projects, each with its knowledge base.' }

/** VITE_MOCK_AGENT=setting_up: how the agent's setting up stands. localStorage `mock.agent` picks the moment to show
 * (queued, running (the default), finishing, unread: GitHub would not say, look-fails: the app's own looks fail after
 * its first few seconds). */
const mockLoaded = Date.now()
function agentSetting(repo: unknown): Response {
  let which = 'running'
  try { which = localStorage.getItem('mock.agent') ?? which } catch { /* no storage: the default */ }
  const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString()
  const steps = (...states: string[]) => ['Build trace', 'Sign in to AWS', 'Update the installation', 'Mark the projects added'].map((name, i) => ({ name, state: states[i] ?? 'waiting' }))
  const base = { repo, ready: false, state: 'setting_up', requested_at: at(-4), expected_by: at(11), next_check_s: 60 }
  if (which === 'look-fails' && Date.now() - mockLoaded > 3000) return json({ ok: false, error: 'trace is busy; try again in a minute.' }, 503)
  switch (which) {
    case 'queued': return ok({ ...base, text: 'The installation update is waiting for its turn to start; once it starts it usually takes about 15 minutes.', update: { status: 'queued', started_at: at(-1), url: 'https://github.com/', steps: steps(), failed_log: null } })
    case 'finishing': return ok({ ...base, state: 'finishing', text: 'The installation update has added this project\'s agent. trace\'s service starts using it within a few minutes.', update: { status: 'finished', started_at: at(-16), url: 'https://github.com/', steps: steps('done', 'done', 'done', 'done'), failed_log: null }, expected_by: at(8), next_check_s: 20 })
    case 'unread': return ok({ ...base, text: 'trace can\'t read how the installation update stands on GitHub just now, so it can\'t say how far it has got. It keeps looking; the notice clears by itself once the agent is set up.', update: null })
    default: return ok({ ...base, text: 'The installation update is running: it is adding this project\'s agent to the installation.', update: { status: 'running', started_at: at(-4), url: 'https://github.com/', steps: steps('done', 'done', 'running'), failed_log: null } })
  }
}

export function smallAction(name: string, a: Record<string, unknown>): Response | undefined {
  switch (name) {
    case 'installation.layout': return ok(import.meta.env.VITE_MOCK_LAYOUT === 'nested' ? NESTED : FLAT)
    case 'project.agent': return import.meta.env.VITE_MOCK_AGENT === 'setting_up' ? agentSetting(a.repo)
      : ok({ repo: a.repo, ready: true, state: 'ready', text: 'This project\'s agent is set up.', requested_at: null, update: null, expected_by: null, next_check_s: null })
    // a person's edit committed on a branch of trace's own (docs/stay-in-trace.md): the change it opened
    case 'design.handin': {
      const files = (a.files as { path: string }[] | undefined) ?? []
      return ok({ repo: a.repo, change: 12, changed: files.map((f) => f.path), same: [], branch: `trace/handin-mock-${Date.now().toString(36)}`, commit: 'c0ffee1' })
    }
    // the project logo (src/api/actions-logo.ts): none yet; a chosen file is checked by its first bytes and size
    case 'project.logo': return ok({ repo: a.repo, light: null, dark: null })
    case 'project.logo_check': {
      const head = atob(String(a.base64 ?? '').slice(0, 64))
      const png = head.startsWith('\x89PNG')
      const svg = /<svg[\s>]|<\?xml/i.test(head)
      return ok({ repo: a.repo, ok: png || svg, format: png ? 'png' : svg ? 'svg' : null, width: png ? 1024 : 200, height: png ? 512 : 80, problems: png || svg ? [] : ['It is not an SVG or PNG image. Save the logo as SVG (best, sharp at any size) or PNG.'] })
    }
    case 'project.logo_set': return ok({ repo: a.repo, change: 12, branch: `trace/logo-${Date.now().toString(36)}`, commit: 'c0ffee1', written: ['docs/design/logo.svg'], removed: [] })
    case 'project.rules': return ok(import.meta.env.VITE_MOCK_RULES === 'empty'
      ? { repo: a.repo, branch: 'main', path: '.trace/rules.md', text: null, answers: [] }
      : { repo: a.repo, branch: 'main', path: '.trace/rules.md', text: RULES_TEXT, answers: ruleAnswers })
    case 'project.rule_from_answer': {
      const r = ruleAnswers.find((x) => x.question === a.question)
      if (r) Object.assign(r, { state: 'waiting', change: 44 })
      return ok({ repo: a.repo, question: a.question, state: 'proposed', change: 44, branch: `trace/rule-${String(a.question)}-m2`, applies: 'review', words: 'The rule goes into the project\'s rules (.trace/rules.md) in change #44: it applies once an admin accepts it, and every agent follows it from then on.', summary: 'The rule goes into the project\'s rules (.trace/rules.md) in change #44: it applies once an admin accepts it, and every agent follows it from then on.' })
    }
    case 'files.edit': return ok({ repo: a.repo, path: a.path, change: 12, branch: `trace/edit-claude-md-${Date.now().toString(36)}`, commit: 'c0ffee1' })
    case 'prompts.chat': return ok({ entries: [{ id: 'chat.role', text: null, version: null, sha: '0123456789ab' }] })
    case 'voice.vocabulary': return ok({ repo: a.repo, language: a.language, name: 'trace-0123abcd-en-AU', state: 'READY', usable: true, note: 'Dictation uses this project\'s words (reference designators, part numbers, net names, requirement ids).' })
    default: return undefined
  }
}
