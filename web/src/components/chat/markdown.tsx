import { lazy, Suspense } from 'react'

const Impl = lazy(() => import('./markdown-impl'))

/** Markdown for messages (lazy). While the renderer loads, the text shows as it is. */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap text-sm">{text}</p>}>
      <Impl text={text} streaming={streaming} />
    </Suspense>
  )
}
