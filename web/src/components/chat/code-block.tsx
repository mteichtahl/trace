/**
 * A code block with a language label, Copy, and Shiki highlighting in a light and a dark theme. Shiki loads only
 * when the first code block appears (its own chunk), and only the languages trace uses.
 */
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

// only the languages trace uses, each its own small chunk (never Shiki's full bundle of every grammar)
const LANG_LOADERS = {
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  verilog: () => import('shiki/langs/verilog.mjs'),
  'system-verilog': () => import('shiki/langs/system-verilog.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  lisp: () => import('shiki/langs/lisp.mjs'),
} as const
type Lang = keyof typeof LANG_LOADERS
const ALIAS: Record<string, Lang> = {
  sh: 'shellscript', bash: 'shellscript', shell: 'shellscript', zsh: 'shellscript', ts: 'typescript', js: 'typescript', javascript: 'typescript',
  py: 'python', rs: 'rust', 'c++': 'cpp', h: 'c', hpp: 'cpp', v: 'verilog', sv: 'system-verilog', systemverilog: 'system-verilog',
  kicad: 'lisp', sexpr: 'lisp', 'kicad_sch': 'lisp', 'kicad_pcb': 'lisp', yml: 'yaml', md: 'markdown',
}
export const langOf = (l?: string): Lang | null => {
  const k = (l ?? '').toLowerCase()
  return k in LANG_LOADERS ? (k as Lang) : (ALIAS[k] ?? null)
}

type Highlighter = { loadLanguage: (...l: unknown[]) => Promise<void>; getLoadedLanguages: () => string[]; codeToHtml: (code: string, o: { lang: string; themes: { light: string; dark: string }; defaultColor: false }) => string }
let highlighter: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')]).then(
    ([core, engine, light, dark]) =>
      core.createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: engine.createJavaScriptRegexEngine() }) as unknown as Promise<Highlighter>,
  )
  return highlighter
}

export async function highlight(code: string, lang: Lang): Promise<string> {
  const h = await getHighlighter()
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage((await LANG_LOADERS[lang]()).default)
  return h.codeToHtml(code, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const l = langOf(lang)
  useEffect(() => {
    let live = true
    if (!l) return
    void highlight(code, l)
      .then((out) => live && setHtml(out))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [code, l])
  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-muted/30 text-[13px]">
      <div className="flex items-center justify-between border-b px-3 py-1">
        <span className="font-mono text-xs text-muted-foreground">{lang || 'text'}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {html ? (
        // Shiki's output: our own highlighter's HTML of the code text (escaped by Shiki), never the message's HTML
        <div className="overflow-x-auto p-3 font-mono [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
