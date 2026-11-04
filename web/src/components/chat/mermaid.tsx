/**
 * A Mermaid diagram (flowcharts, sequence, state, block, class, Gantt, timelines, pie and x-y charts) drawn as a
 * picture in the diagram frame. Mermaid loads only when the first diagram appears. Labels are drawn as SVG text, not
 * HTML, so nothing in a label can run and the picture downloads as a PNG too. A `%% title: …` first line names it.
 */
import { useEffect, useId, useState } from 'react'
import { isDark } from '@/lib/theme'
import { DiagramFrame, DrawingFailed, DrawingPlaceholder, slug } from './diagram-frame'

export const mermaidTitle = (source: string): string | undefined => /^\s*%%\s*title:\s*(.+)$/m.exec(source)?.[1]?.trim()

export function Mermaid({ source, streaming }: { source: string; streaming?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const title = mermaidTitle(source)
  useEffect(() => {
    if (streaming) return
    let live = true
    setFailed(null)
    void import('mermaid')
      .then(async ({ default: m }) => {
        m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark() ? 'dark' : 'neutral',
          fontFamily: 'Geist Variable, sans-serif',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        })
        const { svg } = await m.render(`m${id}`, source)
        if (live) setSvg(svg)
      })
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message.split('\n')[0] : 'the diagram has a mistake'))
    return () => {
      live = false
    }
  }, [source, id, streaming])
  if (failed) return <DrawingFailed kind="Diagram" reason={failed} source={source} lang="mermaid" />
  // Mermaid's own SVG, rendered with securityLevel strict and SVG labels (no scripts, no HTML)
  const picture = svg ? <div className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} /> : null
  return (
    <DiagramFrame kind="Diagram" title={title} source={source} sourceLang="mermaid" download={svg ? { name: slug(title ?? 'diagram'), svg } : undefined}>
      {picture ?? <DrawingPlaceholder />}
    </DiagramFrame>
  )
}
