// Screenshots of the graph view's replay player in mock mode: partway through (the design gate's waiver), at the end,
// filtered to one specialist, in light and dark and at phone width. Run `npm run dev:mock` first (or set BASE), then
// `node scripts/shots-replay.mjs`. Output: screenshots/ (gitignored).
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const OUT = new URL('../screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const to = (n) => async (p) => {
  await p.getByRole('button', { name: 'To the start' }).click()
  for (let i = 0; i < n; i++) await p.keyboard.press('ArrowRight')
  await p.waitForTimeout(1200)
}
const filter = async (p) => {
  await p.getByRole('combobox', { name: 'Whose records' }).click()
  await p.getByRole('option', { name: 'verification specialist' }).click()
  await p.waitForTimeout(1200)
}
const views = [
  { tag: 'light', theme: 'light' },
  { tag: 'dark', theme: 'dark' },
  { tag: 'phone', theme: 'light', width: 390, height: 844, scale: 2 },
]
const shots = [
  { name: 'replay-design', act: to(24) },
  { name: 'replay-end' },
  { name: 'replay-filter', act: filter, only: ['light'] },
]
const browser = await chromium.launch()
for (const v of views) {
  for (const s of shots) {
    if (s.only && !s.only.includes(v.tag)) continue
    const ctx = await browser.newContext({ viewport: { width: v.width ?? 1440, height: v.height ?? 1100 }, deviceScaleFactor: v.scale ?? 1, colorScheme: v.theme })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.error(`[${s.name}-${v.tag}] page error:`, e.message))
    await page.addInitScript((t) => localStorage.setItem('trace.display', JSON.stringify({ theme: t })), v.theme)
    await page.goto(`${BASE}/knowledge/graph?replay=1`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    if (s.act) await s.act(page)
    await page.screenshot({ path: `${OUT}${s.name}-${v.tag}.png`, fullPage: true })
    console.log('saved', `${s.name}-${v.tag}`)
    await ctx.close()
  }
}
await browser.close()
