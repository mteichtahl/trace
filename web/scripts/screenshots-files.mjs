// Screenshots of the Files screen and the File viewer in mock mode (npm run dev:mock first, or set BASE).
// node scripts/screenshots-files.mjs [name-filter]; output in screenshots/ (gitignored).
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const OUT = new URL('../screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const P = '/p/acme~soil-sensor'
const only = process.argv[2]

const shots = [
  { name: 'files', path: `${P}/files`, full: true },
  { name: 'files-dark', path: `${P}/files`, theme: 'dark' },
  { name: 'files-phone', path: `${P}/files`, width: 390, height: 844, scale: 2, full: true },
  { name: 'files-sheet', path: `${P}/files`, act: async (p) => { await p.click('text=parts-list.csv'); await p.waitForTimeout(1500) } },
  { name: 'files-drawer-phone', path: `${P}/files`, width: 390, height: 844, scale: 2, act: async (p) => { await p.click('text=README.md'); await p.waitForTimeout(1500) } },
  { name: 'fv-board', path: `${P}/files/hardware/soil-sensor.kicad_pcb`, wait: 4000 },
  { name: 'fv-board-dark', path: `${P}/files/hardware/soil-sensor.kicad_pcb`, theme: 'dark', wait: 4000 },
  { name: 'fv-schematic', path: `${P}/files/hardware/soil-sensor.kicad_sch`, wait: 4000 },
  { name: 'fv-versions', path: `${P}/files/hardware/soil-sensor.kicad_pcb`, wait: 3000, act: async (p) => { await p.click('button:has-text("Versions")'); await p.waitForTimeout(400) } },
  { name: 'fv-parts', path: `${P}/files/hardware/parts-list.csv` },
  { name: 'fv-parts-compare', path: `${P}/files/hardware/parts-list.csv`, act: async (p) => { await p.click('button:has-text("Versions")'); await p.click('text=Compare with previous'); await p.waitForTimeout(1200) } },
  { name: 'fv-code', path: `${P}/files/firmware/src/main.c`, wait: 1500 },
  { name: 'fv-code-compare', path: `${P}/files/firmware/src/main.c`, act: async (p) => { await p.click('button:has-text("Versions")'); await p.click('text=Compare with previous'); await p.waitForTimeout(1200) } },
  { name: 'fv-log', path: `${P}/files/runs/run_77aa/build.log`, wait: 1500 },
  { name: 'fv-markdown', path: `${P}/files/README.md`, wait: 1500 },
  { name: 'fv-pdf', path: `${P}/files/docs/datasheets/TLV755P.pdf?page=3`, wait: 2500 },
  { name: 'fv-svg', path: `${P}/files/hardware/enclosure-outline.svg` },
  { name: 'fv-stl', path: `${P}/files/hardware/3d/soil-sensor.stl`, wait: 2500 },
  { name: 'fv-vcd', path: `${P}/files/runs/run_8f2c/i2c-capture.vcd`, act: async (p) => { const b = await p.locator('svg[role=img]').boundingBox(); await p.mouse.click(b.x + b.width * 0.3, b.y + 20); await p.keyboard.down('Shift'); await p.mouse.click(b.x + b.width * 0.45, b.y + 20); await p.keyboard.up('Shift'); await p.waitForTimeout(300) } },
  { name: 'fv-sim', path: `${P}/files/evidence/sim/3v3-burst.sim.json`, wait: 1500 },
  { name: 'fv-wavedrom', path: `${P}/files/evidence/i2c-write.wavedrom.json`, wait: 1500 },
  { name: 'fv-gerber-zip', path: `${P}/files/fab/soil-sensor-jlcpcb.zip`, wait: 2500 },
  { name: 'fv-firmware', path: `${P}/files/firmware/build/soil-sensor.bin`, wait: 1500 },
  { name: 'fv-unknown', path: `${P}/files/docs/notes/bring-up.unknownext` },
  { name: 'fv-popout', path: `/view${P}/files/hardware/soil-sensor.kicad_pcb`, wait: 4000 },
  { name: 'chat-file-card', path: `${P}/files`, act: async (p) => { await p.keyboard.press('Control+j'); await p.waitForTimeout(500); await p.click('[aria-label="Conversations"]'); await p.click('text=Where does the 2.2'); await p.waitForTimeout(3500) } },
  { name: 'fv-phone', path: `${P}/files/hardware/parts-list.csv`, width: 390, height: 844, scale: 2 },
  { name: 'fv-pdf-phone', path: `${P}/files/docs/datasheets/TLV755P.pdf`, width: 390, height: 844, scale: 2, wait: 2500 },
]

const browser = await chromium.launch()
for (const s of shots) {
  if (only && !s.name.includes(only)) continue
  const ctx = await browser.newContext({ viewport: { width: s.width ?? 1440, height: s.height ?? 1000 }, deviceScaleFactor: s.scale ?? 1, colorScheme: s.theme === 'dark' ? 'dark' : 'light' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`[${s.name}] page error:`, e.message))
  page.on('console', (m) => m.type() === 'error' && console.error(`[${s.name}] console:`, m.text().slice(0, 300)))
  if (s.theme) await page.addInitScript((t) => localStorage.setItem('trace.display', JSON.stringify({ theme: t })), s.theme)
  await page.goto(BASE + s.path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(s.wait ?? 900)
  if (s.act) await s.act(page)
  await page.screenshot({ path: `${OUT}${s.name}.png`, fullPage: !!s.full })
  console.log('saved', s.name)
  await ctx.close()
}
await browser.close()
