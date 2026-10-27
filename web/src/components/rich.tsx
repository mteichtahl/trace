import { Fragment } from 'react'
import { Explained } from './term'

/**
 * A one- or two-sentence summary from the API, where **bold** marks the recommendation and `code` marks part
 * numbers, nets and run ids. Glossary terms are explained. Never renders HTML.
 */
export function Rich({ text, terms = true }: { text: string; terms?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="font-semibold">{terms ? <Explained text={p.slice(2, -2)} /> : p.slice(2, -2)}</strong>
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="font-mono text-[0.92em]">{p.slice(1, -1)}</code>
        return <Fragment key={i}>{terms ? <Explained text={p} /> : p}</Fragment>
      })}
    </>
  )
}
