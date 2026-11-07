/**
 * An agent's reason as a person reads it (test-esp32 #39): the agents cite their sources the way their tools name
 * them, "ESP32-WROOM-32E sha256 0ac83c83 p27", "bom_check 1b4a0c446d474f70", "calc_ldo_thermal". Here a datasheet
 * citation reads "ESP32-WROOM-32E datasheet, page 27" and opens that page; a run reads "stock check", linked to the
 * run; a calculator named alone reads as what it calculates. Everything else is the agent's text as it is.
 *
 *   citations  the text cut into plain pieces and citations (pure, tested on its own)
 *   Cited      draws them: a datasheet opens beside the page (the shared library's viewer), a run opens its page
 */
import { Link } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import { DatasheetSheet, type SheetTarget } from '@/components/knowledge/viewers'
import { projectId, repoOf } from '@/lib/api'

export type Citation =
  | { kind: 'text'; text: string }
  | { kind: 'datasheet'; mpn: string | null; page: number | null; text: string }
  | { kind: 'run'; label: string; run: string; text: string }
  | { kind: 'tool'; label: string; text: string }

/** What a tool's run is, in words, for the tools agents cite most; others are said from their name. */
const RUN_WORDS: Readonly<Record<string, string>> = {
  'parts.bom_check': 'stock check', 'parts.search': 'parts search', 'parts.lookup': 'part lookup',
  'kicad.erc': 'electrical rule check', 'kicad.drc': 'design rule check', 'kicad.board': 'board read', 'kicad.netlist': 'netlist',
  'kicad.export': 'drawing export', 'mech.fit': 'case fit check', 'mech.build': 'case build', 'verify.report': 'verification report',
  'docs.check': 'documents check', 'docs.figures': 'figures run', 'protocol.model': 'protocol model', 'design.pins': 'pin plan check',
  'calc.ldo_thermal': 'LDO heat calculation', 'calc.regulator_feedback': 'feedback divider calculation', 'calc.divider': 'divider calculation',
  'calc.trace_width': 'trace width calculation', 'calc.led_resistor': 'LED resistor calculation', 'calc.rc_filter': 'RC filter calculation',
}
const FAMILIES = ['parts', 'kicad', 'calc', 'mech', 'verify', 'docs', 'protocol', 'design', 'sim', 'ams', 'thermal', 'emc', 'render', 'datasheets', 'fpga', 'firmware', 'pcb']

/** A tool's name as an agent wrote it ("bom_check", "calc_ldo_thermal", "parts.bom_check"), as trace names it; or null. */
function toolOf(token: string): string | null {
  if (token.includes('.')) return FAMILIES.includes(token.split('.')[0]!) ? token : null
  const family = FAMILIES.find((f) => token.startsWith(`${f}_`))
  if (family) return `${family}.${token.slice(family.length + 1)}`
  return Object.keys(RUN_WORDS).find((k) => k.split('.')[1] === token) ?? null
}

/** "stock check", "LDO heat calculation", or the tool's own words ("kicad.board" → "board read"). */
function toolWords(tool: string): string {
  if (RUN_WORDS[tool]) return RUN_WORDS[tool]!
  const [family, name = ''] = tool.split('.')
  const words = name.replace(/_/g, ' ')
  return family === 'calc' ? `${words} calculation` : `${words} run`
}

// a part number: starts with a capital, holds a digit ("ESP32-WROOM-32E", "AMS1117-3.3", "TLV62569")
const MPN = String.raw`[A-Z][A-Za-z0-9]*[0-9][A-Za-z0-9.\-/]*[A-Za-z0-9]|[A-Z][A-Za-z0-9]*[0-9]`
const DATASHEET = String.raw`(?:\b(${MPN})\s+)?\bsha256\s+[0-9a-f]{6,64}\b(?:,?\s*(?:p\.?\s?|pages?\s+)(\d+))?`
const RUN = String.raw`\b([a-z][a-z0-9]*(?:[._][a-z0-9]+)+)\s+(?:run\s+)?\`?([0-9a-f]{16})\`?(?![0-9a-z])`
const TOOL = String.raw`\b((?:calc|parts|kicad|mech)_[a-z0-9_]+|bom_check)\b`
const ANY = new RegExp(`${DATASHEET}|${RUN}|${TOOL}`, 'g')

/** The text cut into plain pieces and the citations in it. Pure. */
export function citations(text: string): Citation[] {
  const out: Citation[] = []
  let at = 0
  const plain = (s: string) => { if (s) out.push({ kind: 'text', text: s }) }
  for (const m of text.matchAll(ANY)) {
    const [whole, mpn, page, runTool, run, bare] = m
    let c: Citation | null = null
    if (whole.includes('sha256')) c = { kind: 'datasheet', mpn: mpn ?? null, page: page ? Number(page) : null, text: whole }
    else if (runTool && run) {
      const tool = toolOf(runTool)
      if (tool) c = { kind: 'run', label: toolWords(tool), run, text: whole }
    } else if (bare) {
      const tool = toolOf(bare)
      if (tool) c = { kind: 'tool', label: toolWords(tool), text: whole }
    }
    if (!c) continue
    plain(text.slice(at, m.index))
    out.push(c)
    at = m.index + whole.length
  }
  plain(text.slice(at))
  return out
}

/** "ESP32-WROOM-32E datasheet, page 27", "datasheet page 2". */
export const datasheetWords = (c: Extract<Citation, { kind: 'datasheet' }>): string =>
  c.mpn ? `${c.mpn} datasheet${c.page ? `, page ${c.page}` : ''}` : `datasheet${c.page ? ` page ${c.page}` : ''}`

/** An agent's reason with its citations as links (on a project's page; elsewhere they are words only). */
export function Cited({ text }: { text: string }) {
  // the project in view, from the address (as file cards find it): no router needed where there is no project
  const id = typeof location !== 'undefined' ? /^\/(?:view\/)?p\/([^/]+)/.exec(location.pathname)?.[1] : undefined
  const repo = id ? repoOf(decodeURIComponent(id)) : null
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const parts = citations(text)
  if (parts.length === 1 && parts[0]!.kind === 'text') return <>{text}</>
  const link = 'text-primary underline-offset-2 hover:underline'
  return (
    <>
      {parts.map((c, i) => {
        if (c.kind === 'text') return <Fragment key={i}>{c.text}</Fragment>
        if (c.kind === 'tool') return <Fragment key={i}>{c.label}</Fragment>
        if (c.kind === 'run') {
          return repo
            ? <Link key={i} to="/p/$id/runs/$run" params={{ id: projectId(repo), run: c.run }} className={link} title="Open the run">{c.label}</Link>
            : <Fragment key={i}>{c.label}</Fragment>
        }
        const words = datasheetWords(c)
        return repo && c.mpn
          ? <button key={i} type="button" className={link} onClick={() => setSheet({ repo, mpn: c.mpn!, page: c.page ?? 1 })}>{words}</button>
          : <Fragment key={i}>{words}</Fragment>
      })}
      <DatasheetSheet target={sheet} onOpenChange={(o) => { if (!o) setSheet(null) }} />
    </>
  )
}
