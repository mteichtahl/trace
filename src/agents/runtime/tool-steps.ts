/**
 * A job's tool steps in its live log, as they happen (#45, #117, #125).
 *
 * The Agent SDK streams each model turn as it comes, but the runner logged only its own steps (cloning, "running the
 * verify specialist", its end): a job that ran tools for an hour showed four lines and then nothing, so a person could
 * not tell a long routing or SPICE run from a hang. Each tool call Claude makes is now one line in the job's log
 * ("tool: Bash (kicad-cli pcb drc board.kicad_pcb)"), a tool that failed says so, and a tool that is still running
 * says so every STILL_EVERY_MS, so silence in the log means the runtime itself stopped.
 *
 * The log lines go where every job log line goes: the job's step and last lines in the project's job index, and its
 * stream in the runs log group. What a tool was given is cut short and redacted like every other line.
 */
import { z } from 'zod'

/** How often a tool that is still running says so. */
export const STILL_EVERY_MS = 5 * 60_000
/** The longest summary of what a tool was given. */
export const STEP_CHARS = 120

const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string().optional(), name: z.string(), input: z.unknown().optional() }).loose()
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean().nullish() }).loose()
const Assistant = z.object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.unknown()).optional() }).loose() }).loose()
const User = z.object({ type: z.literal('user'), message: z.object({ content: z.union([z.string(), z.array(z.unknown())]).optional() }).loose() }).loose()

/** A tool's name as people read it: trace's own tools by their names (mcp__trace__kicad_erc → kicad.erc). */
export function toolName(name: string): string {
  const m = /^mcp__trace__([a-z0-9]+)_(.+)$/i.exec(name)
  if (m) return `${m[1]}.${m[2]}`
  return name.replace(/^mcp__([^_]+)__/, '$1 ')
}

/** The inputs that say most about a tool call, in order: the first one present is its summary. */
const TELLING = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'brief', 'question', 'request', 'part', 'net', 'name']

/** What a tool was given, in a few words (null when it was given nothing worth saying). Pure. */
export function inputSummary(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const key = TELLING.find((k) => typeof o[k] === 'string' && (o[k] as string).trim()) ?? Object.keys(o).find((k) => typeof o[k] === 'string' && (o[k] as string).trim())
  if (!key) return null
  const v = (o[key] as string).replace(/\s+/g, ' ').trim()
  return v.length > STEP_CHARS ? `${v.slice(0, STEP_CHARS - 1)}…` : v
}

export interface ToolSteps {
  /** feed every SDK message; never throws */
  observe(m: unknown): void
  /** say which tools are still running, where it is time to (the timer calls it; tests too) */
  tick(): void
  /** stop the "still running" timer */
  stop(): void
}

/** Log each tool call as it is made, each failed tool, and every STILL_EVERY_MS each tool still running. */
export function toolSteps(log: (line: string) => void, redact: (s: string) => string, o: { now?: () => number; stillEveryMs?: number; timer?: boolean } = {}): ToolSteps {
  const now = o.now ?? Date.now
  const open = new Map<string, { name: string; at: number; said: number }>()
  const every = o.stillEveryMs ?? STILL_EVERY_MS
  const still = (): void => {
    const t = now()
    for (const s of open.values()) {
      if (t - s.said < every) continue
      s.said = t
      log(`still running: ${s.name} (${Math.round((t - s.at) / 60_000)} min so far)`)
    }
  }
  const timer = o.timer === false ? null : setInterval(still, Math.min(every, 60_000))
  timer?.unref()
  return {
    observe(m) {
      try {
        const a = Assistant.safeParse(m)
        if (a.success) {
          for (const b of a.data.message.content ?? []) {
            const u = ToolUse.safeParse(b)
            if (!u.success) continue
            const name = toolName(u.data.name)
            const what = inputSummary(u.data.input)
            log(`tool: ${name}${what ? ` (${redact(what)})` : ''}`)
            if (u.data.id) open.set(u.data.id, { name, at: now(), said: now() })
          }
          return
        }
        const u = User.safeParse(m)
        if (!u.success || !Array.isArray(u.data.message.content)) return
        for (const b of u.data.message.content) {
          const r = ToolResult.safeParse(b)
          if (!r.success) continue
          const s = open.get(r.data.tool_use_id)
          open.delete(r.data.tool_use_id)
          if (r.data.is_error) log(`tool ${s?.name ?? 'call'} returned an error`)
        }
      } catch { /* a log line never stops the job */ }
    },
    tick: still,
    stop() { if (timer) clearInterval(timer) },
  }
}

