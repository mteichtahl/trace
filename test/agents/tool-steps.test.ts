/**
 * A job's tool steps in its live log as they happen (src/agents/runtime/tool-steps.ts, job.ts runClaude): the layout
 * worker of #125 showed four lines and then nothing for 50 minutes, the verify job of #117 nothing for 8, so a person
 * could not tell work from a hang.
 */
import { describe, expect, it } from 'vitest'
import { runClaude } from '../../src/agents/runtime/job.js'
import { STEP_CHARS, inputSummary, toolName, toolSteps } from '../../src/agents/runtime/tool-steps.js'
import { defaults } from '../../src/core/config.js'

const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'Routing the USB pair.' }, { type: 'tool_use', id, name, input }] } })
const result = (id: string, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } })

describe('tool steps', () => {
  it('names trace\'s tools as people read them, and says what each was given in a few words', () => {
    expect(toolName('mcp__trace__kicad_erc')).toBe('kicad.erc')
    expect(toolName('mcp__trace__agent_delegate')).toBe('agent.delegate')
    expect(toolName('Bash')).toBe('Bash')
    expect(toolName('mcp__other__thing')).toBe('other thing')
    expect(inputSummary({ command: 'kicad-cli pcb drc\n  board.kicad_pcb', description: 'run DRC' })).toBe('kicad-cli pcb drc board.kicad_pcb')
    expect(inputSummary({ file_path: 'hw/board.kicad_pcb' })).toBe('hw/board.kicad_pcb')
    expect(inputSummary({ n: 3 })).toBeNull()
    expect(inputSummary(null)).toBeNull()
    expect(inputSummary({ query: 'x'.repeat(500) })).toHaveLength(STEP_CHARS)
  })

  it('logs each tool call as it is made, a tool that failed, and a tool still running every few minutes', () => {
    const lines: string[] = []
    let t = 0
    const s = toolSteps((l) => { lines.push(l) }, (x) => x.replace('ghp_secret', '***'), { now: () => t, stillEveryMs: 300_000, timer: false })
    s.observe(use('a', 'mcp__trace__kicad_erc', { project: 'hw/board.kicad_pro' }))
    s.observe(result('a'))
    s.observe(use('b', 'Bash', { command: 'GH_TOKEN=ghp_secret gh pr view' }))
    s.observe(result('b', true))
    s.observe(use('c', 'mcp__trace__spice_run', { netlist: 'sim/ldo.cir' }))
    t = 299_000; s.tick()
    t = 301_000; s.tick()
    t = 400_000; s.tick()
    s.observe(result('c'))
    t = 1_000_000; s.tick()
    s.observe({ type: 'result', subtype: 'success' })
    s.observe('not a message')
    s.stop()
    expect(lines).toEqual([
      'tool: kicad.erc (hw/board.kicad_pro)',
      'tool: Bash (GH_TOKEN=*** gh pr view)',
      'tool Bash returned an error',
      'tool: spice.run (sim/ldo.cir)',
      'still running: spice.run (5 min so far)',
    ])
  })

  it('runClaude streams the tool steps into the job\'s log as the Agent SDK reports them, before the run ends', async () => {
    const lines: string[] = []
    let seenBeforeEnd: string[] = []
    await runClaude({
      claude: () => (async function* () {
        yield use('1', 'Read', { file_path: 'docs/intent.md' })
        yield result('1')
        yield use('2', 'mcp__trace__kicad_drc', { board: 'hw/board.kicad_pcb' })
        seenBeforeEnd = [...lines]
        yield result('2')
        yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 2, is_error: false }
      })(),
      cli: '/app/dist/cli.js', timeoutS: 60, model: '', env: {},
    }, { prompt: 'p', cwd: '/tmp', cfg: defaults(), token: 't', signal: new AbortController().signal, log: (l) => { lines.push(l) }, redact: (s) => s })
    expect(seenBeforeEnd).toEqual(['tool: Read (docs/intent.md)', 'tool: kicad.drc (hw/board.kicad_pcb)'])
  })
})
