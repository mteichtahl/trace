/** A Mermaid diagram drawn as a picture, with Show source. Mermaid loads only when the first diagram appears. */
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { isDark } from '@/lib/theme'
import { CodeBlock } from './code-block'

export function Mermaid({ source, streaming }: { source: string; streaming?: boolean }) {
  const id = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showSource, setShowSource] = useState(false)
  useEffect(() => {
    if (streaming) return
    let live = true
    void import('mermaid')
      .then(async ({ default: m }) => {
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'neutral', fontFamily: 'Geist Variable, sans-serif' })
        const { svg } = await m.render(`m${id}`, source)
        if (live) setSvg(svg)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [source, id, streaming])
  if (failed || streaming) return <CodeBlock code={source} lang="mermaid" />
  return (
    <figure className="my-3 rounded-lg border p-3">
      {svg ? (
        // Mermaid's own SVG, rendered with securityLevel strict (no scripts, no HTML labels)
        <div className="flex justify-center overflow-x-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="h-24 animate-pulse rounded bg-muted" />
      )}
      <figcaption className="mt-2 flex justify-end">
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowSource((v) => !v)}>
          {showSource ? 'Hide source' : 'Show source'}
        </Button>
      </figcaption>
      {showSource && <CodeBlock code={source} lang="mermaid" />}
    </figure>
  )
}
