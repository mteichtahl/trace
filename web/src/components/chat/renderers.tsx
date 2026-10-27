/**
 * Registers how tool calls draw in the conversation, and the one human-in-the-loop tool, `ask_person`.
 *
 * Tool calls are drawn by the shape of their result, so any tool that returns one of these shapes gets its card
 * without a registration per tool:
 *   { series, x, y }      → Plot card        (simulation and measurement tools)
 *   { findings, check }   → Findings card    (ERC, DRC, datasheet limits)
 *   { mpn }               → Part card        (parts tools)
 *   { path, kind? , url? }→ File card        (any tool that writes or reads a file)
 *   { run }               → Run card
 *   anything else         → Tool row         (one quiet folded line)
 * Explicit `show_*` tools (the agent asking to show a card) are matched by name first.
 */
import { useHumanInTheLoop, useRenderTool } from '@copilotkit/react-core/v2'
import { z } from 'zod'
import { DecisionCard, type Decision } from '@/components/decision-card'
import { usePrefs } from '@/lib/prefs'
import { FileCard, FindingsCard, type FileData, type FindingsData, PartCard, type PartData, PlotCard, type PlotData, RunCard, type RunCardData, ToolRow, type ToolStatus, parseResult } from './cards'

type Shape = { kind: 'plot'; data: PlotData } | { kind: 'findings'; data: FindingsData } | { kind: 'part'; data: PartData } | { kind: 'file'; data: FileData } | { kind: 'run'; data: RunCardData } | null

export function shapeOf(name: string, args: unknown, result: unknown): Shape {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const pick = (o: Record<string, unknown>): Shape => {
    if (Array.isArray(o.series) && o.x && o.y) return { kind: 'plot', data: o as unknown as PlotData }
    if (Array.isArray(o.findings)) return { kind: 'findings', data: { check: String(o.check ?? name), findings: o.findings as FindingsData['findings'], thumbnail: o.thumbnail as string | undefined } }
    if (typeof o.mpn === 'string') return { kind: 'part', data: o as unknown as PartData }
    if (o.run && typeof o.run === 'object') return { kind: 'run', data: o as unknown as RunCardData }
    if (typeof o.path === 'string' && (o.url || o.kind || o.size !== undefined)) return { kind: 'file', data: o as unknown as FileData }
    return null
  }
  if (name.startsWith('show_')) return pick(a) ?? pick(r)
  return pick(r)
}

function Generic({ name, parameters, result, status }: { name: string; parameters: unknown; result?: string; status: ToolStatus }) {
  const folded = usePrefs().chat.toolRows === 'folded'
  const shape = shapeOf(name, parameters, status === 'complete' ? parseResult(result) : undefined)
  switch (shape?.kind) {
    case 'plot': return <PlotCard data={shape.data} />
    case 'findings': return <FindingsCard data={shape.data} />
    case 'part': return <PartCard data={shape.data} />
    case 'file': return <FileCard data={shape.data} />
    case 'run': return <RunCard data={shape.data} />
    default: return <ToolRow name={name} args={parameters} result={result} status={status} defaultOpen={!folded} />
  }
}

const AskPerson = z.object({
  question: z.string(),
  recommended: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })),
  why: z.string().optional(),
  givesUp: z.string().optional(),
  blocks: z.string().optional(),
  evidence: z.array(z.object({ kind: z.string(), label: z.string(), id: z.string().optional(), to: z.string().optional(), summary: z.string().optional() })).optional(),
})
type AskArgs = z.infer<typeof AskPerson>

/** Mount once per chat provider. */
export function ChatRenderers() {
  const detail = usePrefs().chat.recommendations
  useRenderTool({ name: '*', render: (p: { name: string; parameters: unknown; result?: string; status: ToolStatus }) => <Generic {...p} /> }, [])
  useHumanInTheLoop<AskArgs>(
    {
      name: 'ask_person',
      description: 'Ask the person to decide. Give your recommendation first, why (with evidence), what it gives up, and the alternatives. The answer comes back as { option, recommended, reason? }.',
      parameters: AskPerson,
      render: ({ args, status, respond, result }) => {
        if (!args.options?.length || !args.recommended) return <ToolRow name="ask_person" args={args} status="inProgress" />
        const decision = args as unknown as Decision
        if (status === 'complete') {
          const chosen = parseResult<{ option: string; recommended: boolean; reason?: string }>(result)
          return <DecisionCard decision={decision} onChoose={() => undefined} chosen={chosen && typeof chosen === 'object' ? chosen : { option: '?', recommended: false }} />
        }
        return <DecisionCard decision={decision} detail={detail} onChoose={(c) => (respond ? respond(c) : undefined)} />
      },
    },
    [detail],
  )
  return null
}
