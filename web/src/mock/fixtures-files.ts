/**
 * Files for the File viewer and the Files screen in mock mode: the Soil sensor's design, fabrication, evidence,
 * firmware and documents. Small, real files of each format (the PDF, STL and fab zip are generated here), with an
 * earlier version where Compare has something to show.
 */
import { zipSync, strToU8 } from 'fflate'
import type { FileFinding, ListedFile } from '@/components/files/data'
import type { ChatMessage, ChatThread } from '@/lib/types'
import pcb from './files/soil-sensor.kicad_pcb?raw'
import sch from './files/soil-sensor.kicad_sch?raw'

const HOUR = 3600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

// ------------------------------------------------------------------ text files

export const PARTS_CSV = `Ref,Value,Footprint,MPN,Qty,Unit price
"C1,C2",100n,C_0402_1005Metric,GRM155R71C104KA88D,2,0.004
C7,2.2u,C_0402_1005Metric,GRM155R61A225KE95D,1,0.012
J1,USB-C,USB_C_Receptacle_GCT_USB4105,USB4105-GF-A,1,0.62
R1,10k,R_0402_1005Metric,RC0402FR-0710KL,1,0.002
R2,10k,R_0402_1005Metric,RC0402FR-0710KL,1,0.002
R101,4k7,R_0402_1005Metric,RC0402FR-074K7L,1,0.002
U2,TLV75533PDBVR,SOT-23-5,TLV75533PDBVR,1,0.21
U4,STM32WL55JCI6,UFQFPN-48,STM32WL55JCI6,1,6.85
U5,SX1262IMLTRT,QFN-24,SX1262IMLTRT,1,4.10
`

export const PARTS_CSV_PREV = `Ref,Value,Footprint,MPN,Qty,Unit price
"C1,C2",100n,C_0402_1005Metric,GRM155R71C104KA88D,2,0.004
C7,1u,C_0402_1005Metric,GRM155R61A105KE15D,1,0.009
J1,USB-C,USB_C_Receptacle_GCT_USB4105,USB4105-GF-A,1,0.58
R1,10k,R_0402_1005Metric,RC0402FR-0710KL,1,0.002
R2,10k,R_0402_1005Metric,RC0402FR-0710KL,1,0.002
R3,0R,R_0402_1005Metric,RC0402JR-070RL,1,0.001
U2,TLV75533PDBVR,SOT-23-5,TLV75533PDBVR,1,0.21
U4,STM32WL55JCI6,UFQFPN-48,STM32WL55JCI6,1,6.85
U5,SX1262IMLTRT,QFN-24,SX1262IMLTRT,1,4.10
`

export const VCD = `$date Mon Oct 26 14:02:11 2026 $end
$version trace hil.logic_capture $end
$timescale 1us $end
$scope module i2c $end
$var wire 1 ! SCL $end
$var wire 1 " SDA $end
$var wire 8 # data [7:0] $end
$upscope $end
$enddefinitions $end
$dumpvars
1!
1"
b00000000 #
$end
#10
0"
#15
0!
${Array.from({ length: 9 }, (_, i) => {
  const t = 20 + i * 10
  const bit = [1, 0, 0, 1, 0, 0, 0, 0, 0][i]
  return `#${t}\n${bit}"\n#${t + 3}\n1!\n#${t + 8}\n0!`
}).join('\n')}
#105
b01001000 #
#110
1!
#115
1"
#130
`

export const README_MD = `# Soil sensor, Rev A

A battery-powered soil moisture and temperature sensor that reports over LoRa every 15 minutes.

## Power

The 3.3 V rail comes from a **TLV755** low-dropout regulator (U2). The datasheet asks for at least 2.2 µF on the
output, placed close to the pin; see finding 1 on the board.

| Rail | Source | Budget |
| --- | --- | --- |
| 3V3 | U2 TLV75533 | 120 mA peak |
| VBAT | 2×AA | — |

## Radio

The SX1262 (U5) sits in the antenna corner. Keep copper out of the antenna area on every layer.

## Firmware

See \`firmware/src/main.c\`. The image must stay under 80% of flash so updates fit.

<script>alert('raw HTML is shown as text, never run')</script>
`

export const README_MD_PREV = README_MD.replace('at least 2.2 µF', 'at least 1 µF').replace('\nSee `firmware/src/main.c`. The image must stay under 80% of flash so updates fit.\n', '\nSee `firmware/src/main.c`.\n')

export const MAIN_C = `/* Soil sensor firmware: sample, report over LoRa, sleep. */
#include <stdint.h>
#include "board.h"
#include "radio.h"
#include "sensor.h"

#define REPORT_INTERVAL_S (15u * 60u)

static uint16_t moisture_permille(uint16_t raw)
{
    /* calibrated dry and wet points from the bench run of 24 Oct */
    const uint16_t dry = 3120, wet = 1380;
    if (raw >= dry) return 0;
    if (raw <= wet) return 1000;
    return (uint16_t)(((uint32_t)(dry - raw) * 1000u) / (dry - wet));
}

int main(void)
{
    board_init();
    radio_init(RADIO_EU868);
    for (;;) {
        sensor_reading_t r = sensor_read();
        radio_send_report(moisture_permille(r.moisture_raw), r.temp_centi);
        board_sleep_s(REPORT_INTERVAL_S);
    }
}
`

export const MAIN_C_PREV = MAIN_C.replace('15u * 60u', '10u * 60u').replace('    /* calibrated dry and wet points from the bench run of 24 Oct */\n', '').replace('3120, wet = 1380', '3000, wet = 1400')

export const BUILD_LOG = Array.from({ length: 40 }, (_, i) => {
  const lines = ['[cmake] Configuring done', '[build] Compiling C object src/main.c.o', '[build] Compiling C object src/radio.c.o', '[build] Compiling C object src/sensor.c.o', '[build] Linking C executable soil-sensor.elf', 'warning: unused variable \'retry\' [-Wunused-variable]', '[size]    text    data     bss     dec', '[size]   86412    1204    9876   97492', '[build] Build finished with 1 warning']
  return `2026-10-27T03:${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}Z ${lines[i % lines.length]}`
}).join('\n')

export const WAVEDROM = `{ signal: [
  { name: 'SCL', wave: 'p.........' },
  { name: 'SDA', wave: '10.3.4.5.1', data: ['ADDR 0x48', 'W', 'ACK'] },
  { name: 'EN', wave: '01........' },
], head: { text: 'I²C write to the sensor (address 0x48)' } }
`

export const SIM_JSON = JSON.stringify({
  title: '3V3 rail during a radio burst',
  x: { label: 'Time', unit: 'ms' },
  y: { label: 'Voltage', unit: 'V' },
  series: [{ name: '3V3', points: Array.from({ length: 41 }, (_, i) => [i * 0.25, Number((3.3 - (i > 8 && i < 20 ? 0.09 * Math.exp(-(i - 8) / 4) : 0)).toFixed(4))]) }],
  limit: { value: 3.135, label: 'Minimum 3.135 V (−5%)', kind: 'min' },
  verdict: 'The rail stays above its 3.135 V minimum: lowest 3.21 V, a margin of 75 mV.',
  ok: true,
  runId: 'run_4a11',
})

export const DRAWING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" font-family="sans-serif">
  <script>alert('scripts in a drawing are removed')</script>
  <rect x="10" y="10" width="380" height="220" rx="12" fill="#f3f4f6" stroke="#111" stroke-width="2"/>
  <rect x="300" y="20" width="80" height="60" fill="none" stroke="#999" stroke-dasharray="4 3"/>
  <text x="340" y="96" font-size="10" text-anchor="middle" fill="#555">Antenna area</text>
  <circle cx="40" cy="40" r="5" fill="none" stroke="#111"/><circle cx="360" cy="200" r="5" fill="none" stroke="#111"/>
  <circle cx="40" cy="200" r="5" fill="none" stroke="#111"/><circle cx="360" cy="40" r="5" fill="none" stroke="#111" onclick="alert(1)"/>
  <line x1="10" y1="250" x2="390" y2="250" stroke="#111"/>
  <text x="200" y="130" font-size="16" text-anchor="middle">Soil sensor enclosure outline</text>
  <text x="200" y="152" font-size="11" text-anchor="middle" fill="#555">50 × 30 mm board, 4 × M2 holes, 1.6 mm</text>
  <a href="javascript:alert(1)"><text x="200" y="180" font-size="10" text-anchor="middle" fill="#2563eb">a link that is removed</text></a>
</svg>
`

// ------------------------------------------------------------------ a PDF, made here (three pages, an outline)

function pdfString(s: string) {
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
}

export function makePdf(pages: { title: string; lines: string[] }[]): string {
  const objs: string[] = []
  const add = (body: string) => objs.push(body) // object number = index + 1
  // 1 catalog, 2 pages, 3 font, 4 outlines; then per page: page, content; then outline items
  const nPages = pages.length
  const pageObj = (i: number) => 5 + i * 2
  const itemObj = (i: number) => 5 + nPages * 2 + i
  add(`<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>`)
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${nPages} >>`)
  add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`)
  add(`<< /Type /Outlines /First ${itemObj(0)} 0 R /Last ${itemObj(nPages - 1)} 0 R /Count ${nPages} >>`)
  pages.forEach((p, i) => {
    const text = [`BT /F1 20 Tf 56 760 Td ${pdfString(p.title)} Tj ET`, ...p.lines.map((l, j) => `BT /F1 11 Tf 56 ${720 - j * 18} Td ${pdfString(l)} Tj ET`), `BT /F1 9 Tf 56 40 Td ${pdfString(`TLV755P datasheet (mock) - page ${i + 1} of ${nPages}`)} Tj ET`].join('\n')
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`)
    add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  })
  pages.forEach((p, i) => {
    add(`<< /Title ${pdfString(p.title)} /Parent 4 0 R /Dest [${pageObj(i)} 0 R /XYZ 0 792 0]${i > 0 ? ` /Prev ${itemObj(i - 1)} 0 R` : ''}${i < nPages - 1 ? ` /Next ${itemObj(i + 1)} 0 R` : ''} >>`)
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

export const DATASHEET_PDF = makePdf([
  { title: 'TLV755P 500-mA low-dropout regulator', lines: ['Features', '- Input voltage range: 1.45 V to 5.5 V', '- Very low dropout: 238 mV at 500 mA (3.3 V out)', '- Stable with a 1 uF or larger ceramic output capacitor', '- Packages: SOT-23-5, WSON-6'] },
  { title: 'Electrical characteristics', lines: ['VIN = VOUT(nom) + 0.5 V, IOUT = 1 mA, TJ = -40 to 125 C', 'Output accuracy: +/-1.5% over load and temperature', 'Quiescent current: 25 uA typical', 'Power-supply rejection: 50 dB at 1 kHz', 'Current limit: 600 mA minimum'] },
  { title: 'Layout guidelines', lines: ['Place the input and output capacitors as close as possible', 'to the device pins: within 2 mm of the OUT pin.', 'The output capacitor must be at least 2.2 uF effective', 'for loads with fast transients such as radio bursts.', 'Use a solid ground plane under the device.'] },
])

// ------------------------------------------------------------------ an STL (the board and three parts, ASCII)

function box(x: number, y: number, z: number, w: number, d: number, h: number): string {
  const v = [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z], [x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]]
  const f: [number, number, number, [number, number, number]][] = [
    [0, 2, 1, [0, 0, -1]], [0, 3, 2, [0, 0, -1]], [4, 5, 6, [0, 0, 1]], [4, 6, 7, [0, 0, 1]],
    [0, 1, 5, [0, -1, 0]], [0, 5, 4, [0, -1, 0]], [2, 3, 7, [0, 1, 0]], [2, 7, 6, [0, 1, 0]],
    [1, 2, 6, [1, 0, 0]], [1, 6, 5, [1, 0, 0]], [3, 0, 4, [-1, 0, 0]], [3, 4, 7, [-1, 0, 0]],
  ]
  return f.map(([a, b, c, n]) => `facet normal ${n.join(' ')}\n outer loop\n${[a, b, c].map((i) => `  vertex ${v[i]!.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')
}

export const BOARD_STL = `solid soil-sensor\n${[box(0, 0, 0, 50, 30, 1.6), box(8, 8, 1.6, 4, 4, 1), box(22, 10, 1.6, 7, 7, 0.9), box(36, 18, 1.6, 5, 5, 0.9), box(0, 12, 1.6, 7, 9, 3.2)].join('\n')}\nendsolid soil-sensor\n`

// ------------------------------------------------------------------ Gerbers and the fab zip

const gerber = (body: string) => `%FSLAX46Y46*%\n%MOMM*%\n${body}\nM02*\n`
const EDGE = gerber('%ADD10C,0.100*%\nD10*\nX0Y0D02*\nX50000000Y0D01*\nX50000000Y30000000D01*\nX0Y30000000D01*\nX0Y0D01*')
const FCU = gerber('%ADD10C,0.250*%\n%ADD11R,0.600X0.500*%\n%ADD12C,0.600*%\nD11*\nX9500000Y10000000D03*\nX10500000Y10000000D03*\nX19500000Y20000000D03*\nX20500000Y20000000D03*\nX30000000Y9500000D03*\nX30000000Y10500000D03*\nD10*\nX10500000Y10000000D02*\nX20000000Y10000000D01*\nX25000000Y10000000D02*\nX30000000Y10000000D01*\nX15000000Y10000000D02*\nX15000000Y20000000D01*\nX19500000Y20000000D01*\nD12*\nX20000000Y10000000D03*\nX25000000Y10000000D03*')
const BCU = gerber('%ADD10C,0.250*%\n%ADD11R,0.600X0.500*%\n%ADD12C,0.600*%\nD11*\nX39500000Y20000000D03*\nX40500000Y20000000D03*\nD10*\nX20000000Y10000000D02*\nX22500000Y7500000D01*\nX25000000Y10000000D01*\nD12*\nX20000000Y10000000D03*\nX25000000Y10000000D03*')
const FMASK = gerber('%ADD11R,0.700X0.600*%\nD11*\nX9500000Y10000000D03*\nX10500000Y10000000D03*\nX19500000Y20000000D03*\nX20500000Y20000000D03*\nX30000000Y9500000D03*\nX30000000Y10500000D03*')
const FSILK = gerber('%ADD10C,0.150*%\nD10*\nX8500000Y11500000D02*\nX11500000Y11500000D01*\nX18500000Y21500000D02*\nX21500000Y21500000D01*')
const DRILL = 'M48\nMETRIC\nT1C0.300\n%\nG90\nG05\nT1\nX20.0Y10.0\nX25.0Y10.0\nM30\n'

export const FAB_ZIP = zipSync({
  'soil-sensor-Edge_Cuts.gm1': strToU8(EDGE),
  'soil-sensor-F_Cu.gtl': strToU8(FCU),
  'soil-sensor-B_Cu.gbl': strToU8(BCU),
  'soil-sensor-F_Mask.gts': strToU8(FMASK),
  'soil-sensor-F_Silkscreen.gto': strToU8(FSILK),
  'soil-sensor-PTH.drl': strToU8(DRILL),
  'README.txt': strToU8('Made by trace kicad.fab for JLCPCB: 2 layers, 1.6 mm, HASL, green.\n'),
})

export const RELEASE_TAR_NOTE = 'notes inside the release archive'

// ------------------------------------------------------------------ the file list

const FINDINGS_PCB: FileFinding[] = [
  { id: 'f1', severity: 'fix', text: 'Output capacitor C1 is 20 mm from U2’s pin. The datasheet asks for it within 2 mm.', x_mm: 30, y_mm: 10, ref: 'C1' },
  { id: 'f2', severity: 'blocks', text: 'Track on net MID runs 0.15 mm from the board edge; the fab needs 0.3 mm.', x_mm: 15, y_mm: 20 },
  { id: 'f3', severity: 'waived', text: 'Silkscreen label overlaps a via. Waived by Priya Shah, 20 Oct.', x_mm: 20, y_mm: 10 },
]
const FINDINGS_SCH: FileFinding[] = [
  { id: 's1', severity: 'fix', text: 'R2 has no tolerance in its value field.', x_mm: 120, y_mm: 100, ref: 'R2' },
  { id: 's2', severity: 'waived', text: 'Power flag missing on GND; waived, the regulator drives it.', x_mm: 140, y_mm: 104 },
]

const v = (commit: string, at: number, release?: string) => ({ commit, at: ago(at), ...(release ? { release } : {}) })

export const FILE_LIST: Record<string, ListedFile[]> = {
  'acme/soil-sensor': [
    { path: 'hardware/soil-sensor.kicad_pcb', kind: 'design', size: pcb.length, commit: '7f3e21a', at: ago(2 * HOUR), revision: 'Rev A', versions: [v('7f3e21a', 2 * HOUR), v('a91c04b', DAY), v('3b77e90', 5 * DAY)], findings: FINDINGS_PCB },
    { path: 'hardware/soil-sensor.kicad_sch', kind: 'design', size: sch.length, commit: '7f3e21a', at: ago(2 * HOUR), revision: 'Rev A', versions: [v('7f3e21a', 2 * HOUR), v('c0ffee1', 3 * DAY)], findings: FINDINGS_SCH },
    { path: 'hardware/parts-list.csv', kind: 'design', size: PARTS_CSV.length, commit: '7f3e21a', at: ago(3 * HOUR), revision: 'Rev A', versions: [v('7f3e21a', 3 * HOUR), v('a91c04b', DAY)] },
    { path: 'hardware/enclosure-outline.svg', kind: 'design', size: DRAWING_SVG.length, commit: '3b77e90', at: ago(5 * DAY), versions: [v('3b77e90', 5 * DAY)] },
    { path: 'hardware/3d/soil-sensor.stl', kind: 'design', size: BOARD_STL.length, commit: 'a91c04b', at: ago(DAY) },
    { path: 'fab/soil-sensor-jlcpcb.zip', kind: 'fabrication', size: FAB_ZIP.length, release: 'Rev A release 1', frozen: true, commit: 'e4d1c2f', at: ago(6 * DAY) },
    { path: 'fab/soil-sensor-F_Cu.gtl', kind: 'fabrication', size: FCU.length, release: 'Rev A release 1', frozen: true, commit: 'e4d1c2f', at: ago(6 * DAY) },
    { path: 'runs/run_8f2c/i2c-capture.vcd', kind: 'evidence', size: VCD.length, at: ago(20 * HOUR) },
    { path: 'evidence/sim/3v3-burst.sim.json', kind: 'evidence', size: SIM_JSON.length, at: ago(30 * HOUR), commit: 'a91c04b' },
    { path: 'evidence/i2c-write.wavedrom.json', kind: 'evidence', size: WAVEDROM.length, at: ago(2 * DAY), commit: '3b77e90' },
    { path: 'runs/run_77aa/build.log', kind: 'evidence', size: BUILD_LOG.length, at: ago(40 * 60_000) },
    { path: 'firmware/src/main.c', kind: 'firmware', size: MAIN_C.length, commit: '7f3e21a', at: ago(4 * HOUR), versions: [v('7f3e21a', 4 * HOUR), v('5aa9e03', 2 * DAY)] },
    { path: 'firmware/build/soil-sensor.bin', kind: 'firmware', size: 87616, commit: '7f3e21a', at: ago(40 * 60_000) },
    { path: 'docs/datasheets/TLV755P.pdf', kind: 'documents', size: DATASHEET_PDF.length, commit: '3b77e90', at: ago(9 * DAY) },
    { path: 'README.md', kind: 'documents', size: README_MD.length, commit: '7f3e21a', at: ago(4 * HOUR), versions: [v('7f3e21a', 4 * HOUR), v('3b77e90', 9 * DAY)] },
    { path: 'docs/notes/bring-up.unknownext', kind: 'documents', size: 2048, commit: '3b77e90', at: ago(9 * DAY) },
  ],
}

/** The bytes of a file at a version (an earlier commit gives the earlier text where there is one). */
export function fileContent(path: string, commit?: string): { bytes: Uint8Array | string; mime: string } | null {
  const prev = !!commit && !['7f3e21a', 'e4d1c2f'].includes(commit)
  switch (path) {
    case 'hardware/soil-sensor.kicad_pcb': return { bytes: pcb, mime: 'text/plain' }
    case 'hardware/soil-sensor.kicad_sch': return { bytes: sch, mime: 'text/plain' }
    case 'hardware/parts-list.csv': return { bytes: prev ? PARTS_CSV_PREV : PARTS_CSV, mime: 'text/csv' }
    case 'hardware/enclosure-outline.svg': return { bytes: DRAWING_SVG, mime: 'image/svg+xml' }
    case 'hardware/3d/soil-sensor.stl': return { bytes: BOARD_STL, mime: 'model/stl' }
    case 'fab/soil-sensor-jlcpcb.zip': return { bytes: FAB_ZIP, mime: 'application/zip' }
    case 'fab/soil-sensor-F_Cu.gtl': return { bytes: FCU, mime: 'text/plain' }
    case 'runs/run_8f2c/i2c-capture.vcd': return { bytes: VCD, mime: 'text/plain' }
    case 'evidence/sim/3v3-burst.sim.json': return { bytes: SIM_JSON, mime: 'application/json' }
    case 'evidence/i2c-write.wavedrom.json': return { bytes: WAVEDROM, mime: 'application/json' }
    case 'runs/run_77aa/build.log': return { bytes: BUILD_LOG, mime: 'text/plain' }
    case 'firmware/src/main.c': return { bytes: prev ? MAIN_C_PREV : MAIN_C, mime: 'text/x-c' }
    case 'firmware/build/soil-sensor.bin': return { bytes: new Uint8Array(87616).map((_, i) => (i * 31) & 0xff), mime: 'application/octet-stream' }
    case 'docs/datasheets/TLV755P.pdf': return { bytes: DATASHEET_PDF, mime: 'application/pdf' }
    case 'README.md': return { bytes: prev ? README_MD_PREV : README_MD, mime: 'text/markdown' }
    case 'docs/notes/bring-up.unknownext': return { bytes: new Uint8Array(2048), mime: 'application/octet-stream' }
    default: return null
  }
}

export const FIRMWARE_SIZE = { target: 'soil-sensor', artifact: 'firmware/build/soil-sensor.elf', text: 86412, data: 1204, bss: 9876, flash_bytes: 87616, ram_bytes: 11080, flash_pct: 33.4, flash_total: 262144, ram_pct: 17.3, ram_total: 65536, tool: 'arm-none-eabi-size' }

// ------------------------------------------------------------------ a conversation whose tool results are files (the chat's File card)


export const FILE_THREAD: ChatThread = { id: 'tf1', repo: 'acme/soil-sensor', title: 'Where does the 2.2 µF come from?', updatedAt: ago(30 * 60_000) }

export const FILE_THREAD_MESSAGES: ChatMessage[] = [
  { id: 'fm1', role: 'user', content: 'Where does the 2.2 µF on the regulator output come from?', at: ago(31 * 60_000) },
  {
    id: 'fm2', role: 'assistant', at: ago(30 * 60_000),
    content: '**From the TLV755P datasheet, page 3:** the output capacitor must be at least 2.2 µF for fast loads such as the radio’s bursts. The parts list has C7 at 2.2 µF; the board still places it too far from U2.',
    toolCalls: [
      { id: 'tc1', name: 'kb.read', args: JSON.stringify({ path: 'docs/datasheets/TLV755P.pdf', page: 3 }) },
      { id: 'tc2', name: 'files.read', args: JSON.stringify({ path: 'hardware/parts-list.csv' }) },
      { id: 'tc3', name: 'hil.logic_capture', args: JSON.stringify({ bus: 'i2c' }) },
    ],
  },
  { id: 'fm3', role: 'tool', toolCallId: 'tc1', at: ago(30 * 60_000), content: JSON.stringify({ path: 'docs/datasheets/TLV755P.pdf', kind: 'pdf', size: DATASHEET_PDF.length, page: 3 }) },
  { id: 'fm4', role: 'tool', toolCallId: 'tc2', at: ago(30 * 60_000), content: JSON.stringify({ path: 'hardware/parts-list.csv', kind: 'csv', size: PARTS_CSV.length }) },
  { id: 'fm5', role: 'tool', toolCallId: 'tc3', at: ago(30 * 60_000), content: JSON.stringify({ path: 'runs/run_8f2c/i2c-capture.vcd', kind: 'vcd', size: VCD.length }) },
]
