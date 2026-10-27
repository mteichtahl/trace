/**
 * The markdown renderer for every message (lazy: it brings react-markdown, KaTeX and their plugins in its own chunk).
 *
 * - GitHub-flavoured markdown: tables scroll sideways in their own frame; task lists; images.
 * - Formulas with KaTeX ($…$ and $$…$$).
 * - Code blocks with Shiki, a language label and Copy; ```mermaid as a picture with Show source.
 * - Links into the record (/p/…, or trace:<kind>/<id>) become chips that open in place; links out of trace show
 *   their domain.
 * - Raw HTML is never rendered: it is shown as the text it is.
 * - While streaming, unfinished fences, tables and formatting are closed first (streaming.ts).
 */
import 'katex/dist/katex.min.css'
import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from './code-block'
import { Mermaid } from './mermaid'
import { closeStreaming } from './streaming'

type Node = { type: string; value?: string; children?: Node[] }

/** remark plugin: raw HTML becomes plain text (shown, never rendered). */
function remarkHtmlAsText() {
  const walk = (n: Node) => {
    if (n.type === 'html') n.type = 'text'
    n.children?.forEach(walk)
  }
  return (tree: Node) => walk(tree)
}

/** A record link: "/p/soil-sensor/requirements/R-014" or "trace:requirement/R-014". */
export function recordLink(href: string): { to: string; label?: string } | null {
  if (href.startsWith('trace:')) {
    const [kind, ...rest] = href.slice(6).split('/')
    const id = rest.join('/')
    return { to: `/r/${kind}/${encodeURIComponent(id)}`, label: id }
  }
  if (href.startsWith('/') && !href.startsWith('//')) return { to: href }
  return null
}

export const domainOf = (href: string): string | null => {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

const textOf = (n: ReactNode): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : '')

function components(streaming: boolean): Components {
  return {
    a({ href = '', children }) {
      const rec = recordLink(href)
      if (rec) {
        return (
          <Link to={rec.to} className="mx-0.5 inline-flex items-center rounded-md border bg-background px-1.5 py-px align-baseline font-mono text-[12px] text-foreground no-underline hover:bg-accent">
            {children}
          </Link>
        )
      }
      const domain = domainOf(href)
      if (!domain) return <span>{children}</span>
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
          {children}
          <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground no-underline">
            ({domain}
            <ExternalLink className="size-3" aria-hidden />)
          </span>
        </a>
      )
    },
    pre({ children }) {
      return <>{children}</>
    },
    code({ className, children }) {
      const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
      const code = textOf(children).replace(/\n$/, '')
      const block = !!lang || code.includes('\n')
      if (!block) return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
      if (lang === 'mermaid') return <Mermaid source={code} streaming={streaming} />
      return <CodeBlock code={code} lang={lang} />
    },
    table({ children }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm [&_td]:border-t [&_td]:px-3 [&_td]:py-1.5 [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium">{children}</table>
        </div>
      )
    },
    img({ src, alt }) {
      return <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" className="my-2 max-h-80 rounded-md border" />
    },
    blockquote({ children }) {
      return <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
    },
  }
}

export default function MarkdownImpl({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const source = streaming ? closeStreaming(text) : text
  return (
    <div className="prose-trace text-sm leading-relaxed [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 [&_.katex-display]:overflow-x-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkHtmlAsText]} rehypePlugins={[rehypeKatex]} components={components(streaming)} skipHtml={false}>
        {source}
      </ReactMarkdown>
    </div>
  )
}
