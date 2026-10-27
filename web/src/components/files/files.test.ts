import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { unpack, untar } from './archive'
import { cellNumber, detectDelimiter, parseDelimited, partsColumns } from './csv'
import { fileHref, runOf } from './data'
import { hexBytes, readElf } from './elf'
import { codeLang, compareMode, extOf, groupOf, isLog, kindLabel, refineJson, viewerKind } from './kinds'
import { describeDiff, diffParts } from './parts-diff'
import { sanitizeSvg } from './sanitize'
import { lineDiff } from './text-diff'
import { busLabel, parseVcd, timeLabel, valueAt } from './vcd'
import { firstSection, headingsOf } from './viewers/markdown'

describe('kind detection', () => {
  it.each([
    ['hardware/board.kicad_sch', 'schematic'],
    ['hardware/board.kicad_pcb', 'board'],
    ['fab/board-F_Cu.gtl', 'gerber'],
    ['fab/board-Edge_Cuts.gm1', 'gerber'],
    ['fab/board.GBR', 'gerber'],
    ['fab/board-PTH.drl', 'gerber'],
    ['fab/soil-sensor-jlcpcb.zip', 'gerber-zip'],
    ['release/everything.zip', 'archive'],
    ['release/everything.tar.gz', 'archive'],
    ['3d/case.STEP', 'step'],
    ['3d/board.stl', 'model'],
    ['3d/board.glb', 'model'],
    ['renders/top.PNG', 'image'],
    ['renders/turntable.mp4', 'video'],
    ['outline.svg', 'svg'],
    ['TLV755.pdf', 'pdf'],
    ['bom.csv', 'table'],
    ['pos.tsv', 'table'],
    ['capture.vcd', 'vcd'],
    ['sim/rail.sim.json', 'plot'],
    ['timing.wavedrom.json', 'wavedrom'],
    ['src/main.c', 'code'],
    ['src/lib.rs', 'code'],
    ['rtl/top.sv', 'code'],
    ['spice/filter.cir', 'code'],
    ['run.log', 'code'],
    ['Makefile', 'code'],
    ['notes.md', 'markdown'],
    ['build/fw.elf', 'firmware'],
    ['build/fw.hex', 'firmware'],
    ['build/fw.map', 'firmware'],
    ['mystery.xyz', 'unknown'],
    ['noextension', 'unknown'],
  ])('%s is %s', (path, kind) => expect(viewerKind(path)).toBe(kind))

  it('reads compound extensions whole', () => {
    expect(extOf('a/b.tar.gz')).toBe('tar.gz')
    expect(extOf('a/rail.sim.json')).toBe('sim.json')
    expect(extOf('.hidden')).toBe('')
  })

  it('tells a WaveDrom or plot JSON from plain JSON by its content', () => {
    expect(viewerKind('x.json', '{ "signal": [] }')).toBe('wavedrom')
    expect(viewerKind('x.json', '{"title":"t","x":{"label":"t"},"y":{"label":"v"},"series":[]}')).toBe('plot')
    expect(viewerKind('x.json', '{"name":"pkg"}')).toBe('code')
    expect(refineJson('[1,2]')).toBe('code')
  })

  it('groups files for the Files screen, preferring the API’s kind', () => {
    expect(groupOf('x/whatever.bin', 'design')).toBe('design')
    expect(groupOf('fab/board-F_Cu.gtl')).toBe('fabrication')
    expect(groupOf('outputs/board-cpl.csv')).toBe('fabrication')
    expect(groupOf('firmware/src/main.c')).toBe('firmware')
    expect(groupOf('build/fw.elf')).toBe('firmware')
    expect(groupOf('runs/run_1/capture.vcd')).toBe('evidence')
    expect(groupOf('hardware/board.kicad_pcb')).toBe('design')
    expect(groupOf('hardware/bom.csv')).toBe('design')
    expect(groupOf('docs/TLV755.pdf')).toBe('documents')
  })

  it('names kinds, languages and compare modes', () => {
    expect(kindLabel('a.vcd')).toBe('Waveform')
    expect(kindLabel('a.kicad_pcb')).toBe('Board')
    expect(codeLang('a.rs')).toBe('rust')
    expect(codeLang('a.kicad_sch')).toBe('lisp')
    expect(codeLang('a.log')).toBeNull()
    expect(isLog('runs/x/build.log')).toBe(true)
    expect(compareMode('code')).toBe('text')
    expect(compareMode('table')).toBe('table')
    expect(compareMode('image')).toBe('image')
    expect(compareMode('pdf')).toBeNull()
  })
})

describe('the CSV parser', () => {
  it('reads quoted fields, doubled quotes, line breaks inside quotes, CRLF and a BOM', () => {
    const t = parseDelimited('﻿Ref,Note\r\n"C1,C2","say ""hi"""\r\nR1,"two\nlines"\r\n')
    expect(t.header).toEqual(['Ref', 'Note'])
    expect(t.rows).toEqual([['C1,C2', 'say "hi"'], ['R1', 'two\nlines']])
  })

  it('pads ragged rows, names missing headers and skips blank lines', () => {
    const t = parseDelimited('a,b\n1\n\n1,2,3\n')
    expect(t.header).toEqual(['a', 'b', 'Column 3'])
    expect(t.rows).toEqual([['1', '', ''], ['1', '2', '3']])
  })

  it('detects tabs and semicolons', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a;b;c')).toBe(';')
    expect(detectDelimiter('"a;b",c')).toBe(',')
    expect(parseDelimited('Ref\tQty\nR1\t2').rows).toEqual([['R1', '2']])
  })

  it('handles a file without a final newline and an empty file', () => {
    expect(parseDelimited('x,y\n1,2').rows).toEqual([['1', '2']])
    expect(parseDelimited('')).toEqual({ header: [], rows: [] })
  })

  it('finds a parts list’s columns', () => {
    expect(partsColumns(['Ref', 'Value', 'Footprint', 'MPN', 'Qty', 'Unit price'])).toEqual({ ref: 0, value: 1, footprint: 2, part: 3, qty: 4, price: 5 })
    expect(partsColumns(['Designator', 'Comment', 'Footprint', 'LCSC Part #'])).toMatchObject({ ref: 0, value: 1, part: 3 })
    expect(partsColumns(['time', 'voltage'])).toBeNull()
  })

  it('reads numbers from cells', () => {
    expect(cellNumber('US$1,204.50')).toBe(1204.5)
    expect(cellNumber('2 pcs')).toBe(2)
    expect(cellNumber('n/a')).toBeNull()
  })
})

describe('the VCD parser', () => {
  const vcd = `$date today $end
$timescale 10 ns $end
$scope module top $end
$scope module i2c $end
$var wire 1 ! scl $end
$var wire 8 " data [7:0] $end
$upscope $end
$var real 64 # vbat $end
$var wire 1 ! scl_alias $end
$upscope $end
$enddefinitions $end
$comment ignored $end
#0
$dumpvars
0!
bxxxxxxxx "
r3.3 #
$end
#5
1!
b1001000 "
#12
0!
r3.25 #
#20
`
  const d = parseVcd(vcd)

  it('reads the timescale and scopes', () => {
    expect(d.timescale).toEqual({ value: 10, unit: 'ns', seconds: 1e-8 })
    expect(d.date).toBe('today')
    expect(d.end).toBe(20)
    expect(d.signals.map((s) => `${s.scope}.${s.name}:${s.width}`)).toEqual(['top.i2c.scl:1', 'top.i2c.data[7:0]:8', 'top.vbat:64', 'top.scl_alias:1'])
  })

  it('records changes in time order, sharing them between aliases', () => {
    const [scl, data, vbat, alias] = d.signals
    expect(scl!.changes).toEqual([[0, '0'], [5, '1'], [12, '0']])
    expect(alias!.changes).toBe(scl!.changes)
    expect(data!.changes).toEqual([[0, 'xxxxxxxx'], [5, '1001000']])
    expect(vbat!.changes).toEqual([[0, '3.3'], [12, '3.25']])
  })

  it('gives the value at a time and reads buses and times as words', () => {
    const [scl, data] = d.signals
    expect(valueAt(scl!, 4)).toBe('0')
    expect(valueAt(scl!, 5)).toBe('1')
    expect(valueAt(scl!, 100)).toBe('0')
    expect(busLabel(valueAt(data!, 6), 8)).toBe('0x48')
    expect(busLabel('xxxxxxxx', 8)).toBe('x')
    expect(timeLabel(5, d.timescale)).toBe('50 ns')
    expect(timeLabel(150, { value: 1, unit: 'us', seconds: 1e-6 })).toBe('150 µs')
  })
})

describe('the parts list diff', () => {
  const before = parseDelimited('Ref,Value,MPN,Qty,Price\n"C1,C2",100n,GRM155,2,0.004\nC7,1u,GRM1u,1,0.009\nR3,0R,RC0R,1,0.001\nU2,TLV,TLV755,1,0.21\n')
  const after = parseDelimited('Ref,Value,MPN,Qty,Price\n"C2, C1",100n,GRM155,2,0.0040\nC7,2.2u,GRM2u2,1,0.012\nR101,4k7,RC4k7,1,0.002\nU2,TLV,TLV755,2,0.21\n')
  const d = diffParts(before, after)

  it('keys lines by their references, in any order', () => {
    expect(d.rows.find((r) => r.key === 'C1,C2')!.change).toBe('same')
  })

  it('finds added, removed and changed lines, removed first', () => {
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 2, same: 1 })
    expect(d.rows[0]).toMatchObject({ key: 'R3', change: 'removed' })
    expect(d.rows[1]).toMatchObject({ key: 'R101', change: 'added' })
  })

  it('says what changed: part, value, quantity and price (numbers compared as numbers)', () => {
    const c7 = d.rows.find((r) => r.key === 'C7')!
    expect(c7.fields.map((f) => f.field)).toEqual(['Part', 'Value', 'Price'])
    const u2 = d.rows.find((r) => r.key === 'U2')!
    expect(u2.fields).toEqual([{ field: 'Quantity', before: '1', after: '2' }])
    expect(describeDiff(d.counts)).toBe('1 added, 1 removed, 2 changed')
    expect(describeDiff({ added: 0, removed: 0, changed: 0, same: 4 })).toBe('No changes')
  })

  it('refuses a table that is not a parts list', () => {
    expect(() => diffParts(parseDelimited('t,v\n1,2'), parseDelimited('t,v\n1,3'))).toThrow(/not a parts list/)
  })
})

describe('SVG sanitising', () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
    <script>alert(2)</script>
    <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
    <circle r="4" onclick="alert(3)" fill="red"/>
    <a href="javascript:alert(4)"><text>link</text></a>
    <image href="https://tracker.example/pixel.png"/>
    <use href="#local"/>
    <set attributeName="onmouseover" to="alert(5)"/>
    <text x="1" y="2">Board outline</text>
  </svg>`
  const clean = sanitizeSvg(dirty)

  it('removes scripts, event handlers, foreign objects and outside links', () => {
    expect(clean).not.toMatch(/script|alert|onload|onclick|foreignObject|iframe|javascript:|tracker\.example|<set/i)
  })

  it('keeps the drawing and its words', () => {
    expect(clean).toContain('<circle')
    expect(clean).toContain('fill="red"')
    expect(clean).toContain('Board outline')
    expect(clean).toContain('link')
    expect(clean).toContain('href="#local"')
  })

  it('removes style blocks (they can fetch from outside with url())', () => {
    expect(sanitizeSvg('<svg><style>@import url(https://x.example/a.css)</style><rect width="2"/></svg>')).not.toMatch(/style|x\.example/)
  })
})

describe('the text diff', () => {
  it('numbers lines on both sides and folds long unchanged runs', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const b = a.replace('line 10', 'line ten')
    const d = lineDiff(a, b)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.lines.filter((l) => l.kind === 'fold').map((l) => l.hidden)).toEqual([7, 6])
    expect(d.lines.find((l) => l.kind === 'del')).toMatchObject({ text: 'line 10', a: 11 })
    expect(d.lines.find((l) => l.kind === 'add')).toMatchObject({ text: 'line ten', b: 11 })
  })
})

describe('archives', () => {
  it('unzips, leaving out folders and macOS clutter', async () => {
    const z = zipSync({ 'a.txt': strToU8('hi'), 'dir/b.gbr': strToU8('G04*'), '__MACOSX/._a.txt': strToU8('x') })
    const es = await unpack(z.buffer as ArrayBuffer, 'zip')
    expect(es.map((e) => e.path).sort()).toEqual(['a.txt', 'dir/b.gbr'])
  })

  it('reads a tar', () => {
    const header = (name: string, size: number) => {
      const h = new Uint8Array(512)
      h.set(strToU8(name), 0)
      h.set(strToU8(size.toString(8).padStart(11, '0')), 124)
      h[156] = 48
      h.set(strToU8('ustar'), 257)
      return h
    }
    const body = strToU8('hello')
    const tar = new Uint8Array(512 * 4)
    tar.set(header('notes/a.txt', 5), 0)
    tar.set(body, 512)
    const es = untar(tar)
    expect(es).toHaveLength(1)
    expect(es[0]).toMatchObject({ path: 'notes/a.txt', size: 5 })
    expect(new TextDecoder().decode(es[0]!.bytes)).toBe('hello')
  })
})

describe('firmware sizes from the file', () => {
  it('counts an Intel HEX file’s programmed bytes', () => {
    expect(hexBytes(':10010000214601360121470136007EFE09D2190140\n:00000001FF\n')).toBe(16)
  })
  it('does not mistake other bytes for an ELF', () => {
    expect(readElf(new Uint8Array(64).buffer)).toBeNull()
  })
})

describe('addresses', () => {
  it('builds the app’s own link for a file and a run’s output', () => {
    expect(fileHref({ repo: 'acme/soil-sensor', path: 'hardware/a b.csv' })).toBe('/p/acme~soil-sensor/files/hardware/a%20b.csv')
    expect(fileHref({ repo: 'acme/soil-sensor', path: 'x.log', run: { id: 'run_1', name: 'build.log' } }, { bare: true })).toBe('/view/p/acme~soil-sensor/files/runs/run_1/build.log')
    expect(runOf('runs/run_1/build.log')).toEqual({ id: 'run_1', name: 'build.log' })
    expect(runOf('hardware/x')).toBeUndefined()
  })
})

describe('markdown contents', () => {
  const md = '# Title\n\nintro\n\n```\n# not a heading\n```\n\n## Power\n\ntext\n\n### Rails ##\n'
  it('lists headings outside code', () => {
    expect(headingsOf(md)).toEqual([{ depth: 1, text: 'Title' }, { depth: 2, text: 'Power' }, { depth: 3, text: 'Rails' }])
  })
  it('cuts the first section for the card', () => {
    expect(firstSection(md)).toContain('intro')
    expect(firstSection(md)).not.toContain('Power')
  })
})
