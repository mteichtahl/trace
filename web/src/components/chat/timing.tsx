/**
 * A timing diagram written as WaveJSON (```wavedrom, also ```wavejson or ```timing), drawn by WaveDrom in the
 * diagram frame. WaveDrom loads only with the first timing diagram. Its SVG is cleaned like any drawing and shown as
 * an image, so the skin's stylesheet stays inside the diagram. The `head.text` of the WaveJSON names it.
 */
import { useEffect, useState } from 'react'
import { sanitizeSvg } from '@/components/files/sanitize'
import { DiagramFrame, DrawingFailed, DrawingPlaceholder, slug } from './diagram-frame'

/** WaveJSON (JSON5: comments, unquoted keys and trailing commas allowed) → a cleaned SVG string. */
export async function drawWaveDrom(source: string): Promise<{ svg: string; title?: string }> {
  const [{ default: wd }, { default: json5 }] = await Promise.all([import('wavedrom'), import('json5')])
  const src = json5.parse(source) as { head?: { text?: unknown } }
  if (!src || typeof src !== 'object') throw new Error('it is not WaveJSON')
  const tree = wd.renderAny(0, src, wd.waveSkin)
  const svg = sanitizeSvg(wd.onml.stringify(tree), { keepStyle: true })
  const title = typeof src.head?.text === 'string' ? src.head.text : undefined
  return { svg, title }
}

export function TimingDiagram({ source, streaming }: { source: string; streaming?: boolean }) {
  const [out, setOut] = useState<{ svg: string; title?: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (streaming) return
    let live = true
    setFailed(null)
    drawWaveDrom(source)
      .then((o) => live && setOut(o))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [source, streaming])
  if (failed) return <DrawingFailed kind="Timing diagram" reason={failed} source={source} lang="json" />
  const img = (big: boolean) =>
    out && <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.svg)}`} alt={out.title ?? 'Timing diagram'} draggable={false} className={big ? 'h-auto w-[min(88vw,1600px)] max-w-none' : 'h-auto max-w-full'} />
  return (
    <DiagramFrame
      kind="Timing diagram"
      title={out?.title}
      paper
      source={source}
      sourceLang="json"
      full={img(true)}
      download={out ? { name: slug(out.title ?? 'timing-diagram'), svg: out.svg } : undefined}
    >
      {out ? <div className="overflow-x-auto">{img(false)}</div> : <DrawingPlaceholder label="Drawing the timing diagram" />}
    </DiagramFrame>
  )
}
