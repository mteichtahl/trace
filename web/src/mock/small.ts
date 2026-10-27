/**
 * Mock answers for the small gaps (web gaps "small"): installation.layout (a flat installation, so New project and
 * Admin › Installation show what applies to it; VITE_MOCK_LAYOUT=nested shows the other), prompts.chat, and
 * voice.vocabulary. Registered in handlers.ts with one line; answers undefined for anything else.
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
const NESTED = { layout: 'nested', projects: { max: 60, updateMax: 60 }, has: { knowledgeBase: true, cpuQueue: true, answerEvents: true }, note: 'Each project has its own nested stack: up to 60 projects, each with its knowledge base.' }

export function smallAction(name: string, a: Record<string, unknown>): Response | undefined {
  switch (name) {
    case 'installation.layout': return ok(import.meta.env.VITE_MOCK_LAYOUT === 'nested' ? NESTED : FLAT)
    case 'prompts.chat': return ok({ entries: [{ id: 'chat.role', text: null, version: null, sha: '0123456789ab' }] })
    case 'voice.vocabulary': return ok({ repo: a.repo, language: a.language, name: 'trace-0123abcd-en-AU', state: 'READY', usable: true, note: 'Dictation uses this project\'s words (reference designators, part numbers, net names, requirement ids).' })
    default: return undefined
  }
}
