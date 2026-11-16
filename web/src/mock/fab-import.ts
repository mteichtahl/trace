/**
 * Mock mode for starting a project from fabrication files (docs/fab-import.md): projects.import_upload keeps which files
 * each upload has, and projects.import_check answers what the API answers for the Potroller carrier's real files
 * (test/fixtures/fab-import: a 10-layer KiCad board, 133 BOM lines, 774 placements), with the overview's topics found
 * by a rough look at its words. VITE_MOCK_FAB=blocked answers the placement file as not sharing the Gerbers' origin.
 */
import type { FabCheck, FabFile } from '@/components/new-project/fab-import'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const later = (r: Response, ms = 500) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

const SIZES: Record<FabFile, number> = { gerbers: 3_258_613, bom: 15_355, cpl: 29_735 }
const given = new Map<string, Set<FabFile>>()

const TOPICS = [
  { id: 'purpose', title: 'What it does', ask: 'What does the board do, in a sentence or two?', words: /\b(does|controls?|monitors?|hosts?|drives?|measures?|is a|designed to)\b/i },
  { id: 'use', title: 'Where it is used', ask: 'Where will it be used: the setting, enclosure and environment (indoors, a vehicle, a rack, temperature)?', words: /\b(enclosure|case|rack|indoors?|outdoors?|cockpit|simulator|desk|lab|temperature)\b/i },
  { id: 'power', title: 'Power', ask: 'What powers it: the input voltage and current, and the rails it makes?', words: /\b(\d+\s?v\b|volts?|power|supply|battery|rail)/i },
  { id: 'interfaces', title: 'Interfaces', ask: 'What does it connect to: connectors, buses and the devices on them?', words: /\b(usb|i2c|spi|uart|can|ethernet|hdmi|gpio|connector|header)\b/i },
  { id: 'size', title: 'Size and mounting', ask: 'How big is it, and how is it mounted (holes, standoffs, a case)?', words: /(\d+\s?[x×]\s?\d+|\bmm\b|standoffs?|mounting|holes?)/i },
  { id: 'quantity', title: 'Quantity and cost', ask: 'How many will be built, and is there a target cost or budget?', words: /\b(\d+\s?boards?|quantity|budget|cost|usd|aud|\$)/i },
]

const LAYERS: FabCheck['layers'] = [
  ['B_Cu.gbl', 'copper', 'bottom', 10], ['B_Mask.gbs', 'mask', 'bottom', null], ['B_Paste.gbp', 'paste', 'bottom', null], ['B_Silkscreen.gbo', 'silkscreen', 'bottom', null],
  ['Edge_Cuts.gm1', 'outline', null, null], ['F_Cu.gtl', 'copper', 'top', 1], ['F_Mask.gts', 'mask', 'top', null], ['F_Paste.gtp', 'paste', 'top', null], ['F_Silkscreen.gto', 'silkscreen', 'top', null],
  ...Array.from({ length: 8 }, (_, i) => [`In${i + 1}_Cu.g${i + 1}`, 'copper', 'inner', i + 2] as const),
  ['NPTH-drl_map.gbr', 'drill-map', null, null], ['NPTH.drl', 'drill', null, null], ['PTH-drl_map.gbr', 'drill-map', null, null], ['PTH.drl', 'drill', null, null], ['job.gbrjob', 'job', null, null],
].map(([n, kind, side, layer]) => ({ name: `potroller-supervisor-${n}`, kind: kind as string, side: side as string | null, layer: layer as number | null, bytes: 100_000 }))

const OPTIONS: FabCheck['order_options'] = [
  { group: 'pcb', option: 'Base material', value: 'FR-4', source: 'JLCPCB\'s default: not decided in the files', decided: false },
  { group: 'pcb', option: 'Layers', value: '10', source: 'the Gerbers', decided: true },
  { group: 'pcb', option: 'Dimensions', value: '200 x 160 mm', source: 'the outline layer', decided: true },
  { group: 'pcb', option: 'PCB thickness', value: '1.6 mm', source: 'the Gerber job file', decided: true },
  { group: 'pcb', option: 'Min hole size', value: '0.15 mm', source: 'the drill files', decided: true },
  { group: 'pcb', option: 'Solder mask colour', value: 'Green', source: 'JLCPCB\'s default: not decided in the files', decided: false },
  { group: 'pcb', option: 'Silkscreen colour', value: 'White', source: 'JLCPCB\'s default: not decided in the files', decided: false },
  { group: 'pcb', option: 'Surface finish', value: 'ENIG', source: 'the Gerber job file', decided: true },
  { group: 'pcb', option: 'Impedance control', value: 'Yes', source: 'the Gerber job file', decided: true },
  { group: 'pcba', option: 'PCBA', value: 'Yes', source: 'the placement file', decided: true },
  { group: 'pcba', option: 'Assembly side', value: 'Both sides (774 placed parts: 675 top, 99 bottom)', source: 'the placement file', decided: true },
  { group: 'pcba', option: 'BOM', value: '133 lines, 774 parts', source: 'the parts list', decided: true },
]

/** What projects.import_check answers for these files and this overview. */
export function mockFabCheck(upload: string, files: ReadonlySet<FabFile>, overview: string, o: { quantity?: number; built?: boolean } = {}): FabCheck {
  const t = overview.trim()
  const topics = TOPICS.map(({ words, ...x }) => ({ ...x, found: words.test(t) }))
  const found = topics.filter((x) => x.found).length
  const overviewOk = t.length >= 300 && found >= 4
  const has = (f: FabFile) => files.has(f)
  const all = has('gerbers') && has('bom') && has('cpl')
  const blockedOrigin = import.meta.env.VITE_MOCK_FAB === 'blocked'
  const findings: FabCheck['findings'] = [
    ...(!has('gerbers') ? [{ id: 'gerbers.missing', severity: 'blocking' as const, file: 'gerbers' as const, text: 'No Gerber zip was given.', fix: 'Give the Gerber and drill files, zipped together.' }] : []),
    ...(!has('bom') ? [{ id: 'bom.missing', severity: 'blocking' as const, file: 'bom' as const, text: 'No bill of materials was given.', fix: 'Give the BOM as a CSV, in JLCPCB\'s columns if you have them.' }] : []),
    ...(!has('cpl') ? [{ id: 'cpl.missing', severity: 'blocking' as const, file: 'cpl' as const, text: 'No pick and place file was given.', fix: 'Give the placement (CPL) file as a CSV.' }] : []),
    ...(all && blockedOrigin ? [{ id: 'cpl.origin', severity: 'blocking' as const, file: 'cpl' as const, text: '774 of 774 placements are outside the board outline: the placement file and the Gerbers do not share an origin.', fix: 'Export both from the same origin (KiCad: "Use drill/place file origin" the same in both), then give them again.' }] : []),
    ...(!overviewOk ? [{
      id: 'overview.thin', severity: 'blocking' as const, file: 'overview' as const,
      text: t.length < 300 ? `The overview is ${t.length} characters; trace needs at least 300 to start the intent from it.` : `The overview covers ${found} of 6 topics; it needs at least 4.`,
      fix: `Add: ${topics.filter((x) => !x.found).map((x) => x.ask).join(' ')}`,
    }] : []),
    ...(has('bom') ? [
      { id: 'bom.out_of_stock', severity: 'warning' as const, file: 'bom' as const, text: '2 parts had no stock at JLCPCB when the BOM was made: 30A mini-blade (F1), 48406-0001 (J701).', fix: 'trace checks stock again at Fabricate and suggests in-stock alternatives; you can also choose one now and give the BOM again.', refs: ['F1', 'J701'] },
      { id: 'bom.short', severity: 'warning' as const, file: 'bom' as const, text: `1 part had less stock than ${o.quantity ?? 10} boards need: TPS25940L (32 for ${8 * (o.quantity ?? 10)}).`, fix: 'trace checks stock again at Fabricate; lower the quantity or choose alternatives if it is still short.' },
    ] : []),
    ...(overviewOk && found < 6 ? [{ id: 'overview.topics', severity: 'note' as const, file: 'overview' as const, text: `The overview does not say: ${topics.filter((x) => !x.found).map((x) => x.title.toLowerCase()).join(', ')}.`, fix: topics.filter((x) => !x.found).map((x) => x.ask).join(' ') }] : []),
  ]
  return {
    upload, sizes: { gerbers: has('gerbers') ? SIZES.gerbers : null, bom: has('bom') ? SIZES.bom : null, cpl: has('cpl') ? SIZES.cpl : null },
    ok: !findings.some((f) => f.severity === 'blocking'),
    summary: {
      board: has('gerbers') ? { layers: 10, width_mm: 200, height_mm: 160, thickness_mm: 1.6, finish: 'ENIG', impedance: true, smallest_hole_mm: 0.15, holes: 5155 } : { layers: 0, width_mm: null, height_mm: null, thickness_mm: null, finish: null, impedance: null, smallest_hole_mm: null, holes: 0 },
      tool: has('gerbers') ? 'KiCad Pcbnew 10.0.8' : null, project: has('gerbers') ? { name: 'potroller-supervisor', revision: 'M.20' } : { name: null, revision: null }, files: has('gerbers') ? 22 : 0,
      bom: has('bom') ? { lines: 133, parts: 774, with_lcsc: 133, basic: 5, extended: 128, out_of_stock: 2 } : { lines: 0, parts: 0, with_lcsc: 0, basic: 0, extended: 0, out_of_stock: 0 },
      placements: has('cpl') ? { total: 774, top: 675, bottom: 99, hand_placed: 0 } : { total: 0, top: 0, bottom: 0, hand_placed: 0 },
      overview: { chars: t.length, topics: found, of: 6 },
    },
    overview: { chars: t.length, topics, found, ok: overviewOk },
    findings, hand_placed: [], order_options: all ? OPTIONS : [],
    recommended: o.built ? { entry: 'bringup', why: 'You said the boards are built: their bench results become revision A\'s first evidence.' } : { entry: 'fabricate', why: 'The boards are not made yet: trace prepares the JLCPCB order from these files, checks stock again today, and you sign the order.' },
    layers: has('gerbers') ? LAYERS : [],
  }
}

export function fabImportAction(name: string, a: Record<string, unknown>): Response | undefined {
  if (name === 'projects.import_upload') {
    const id = String(a.upload)
    const set = given.get(id) ?? new Set<FabFile>()
    if (Number(a.part) === Number(a.parts) - 1) set.add(a.file as FabFile)
    given.set(id, set)
    return later(ok({ upload: id, file: a.file, part: a.part, parts: a.parts, received: Math.floor(String(a.base64).length * 0.75) }), 250)
  }
  if (name === 'projects.import_check') {
    const id = String(a.upload)
    // a draft kept from before a reload has its files uploaded already: VITE_MOCK_FAB=given answers them as given
    const files = import.meta.env.VITE_MOCK_FAB === 'given' || import.meta.env.VITE_MOCK_FAB === 'blocked' ? new Set<FabFile>(['gerbers', 'bom', 'cpl']) : given.get(id) ?? new Set<FabFile>()
    return later(ok(mockFabCheck(id, files, String(a.overview ?? ''), { quantity: Number(a.quantity) || 10, built: a.built === true })), 600)
  }
  return undefined
}
