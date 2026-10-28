// Screenshots of Admin › Connected systems in mock mode: the list, the connect sheet, the keys panel and a system's
// page, in light and dark and at phone width. Run `npm run dev:mock` first (or set BASE), then
// `node scripts/shots-systems.mjs`. Output: screenshots/ (gitignored).
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const OUT = new URL('../screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const connect = async (p) => {
  await p.getByRole('button', { name: 'Connect a system' }).first().click()
  await p.waitForSelector('#svc-name')
  await p.fill('#svc-name', 'ci-pipeline')
  await p.fill('#svc-desc', 'Our build pipeline: reads each project\'s runs after every push.')
  await p.getByLabel(/Soil sensor/).first().click()
  await p.getByLabel(/Motor driver/).first().click()
  await p.waitForTimeout(300)
}
const keys = async (p) => {
  await connect(p)
  await p.getByRole('button', { name: 'Connect ci-pipeline' }).click()
  await p.waitForSelector('text=This secret is shown once')
  await p.waitForTimeout(500)
}

const views = [
  { tag: 'light', theme: 'light' },
  { tag: 'dark', theme: 'dark' },
  { tag: 'phone', theme: 'light', width: 390, height: 844, scale: 2 },
]
const shots = [
  { name: 'systems-list', path: '/admin/systems' },
  { name: 'systems-create', path: '/admin/systems', act: connect },
  { name: 'systems-keys', path: '/admin/systems', act: keys },
  { name: 'systems-detail', path: '/admin/systems/release-bot', full: true },
  { name: 'systems-off', path: '/admin/systems', off: true, only: ['light'] },
]

const browser = await chromium.launch()
for (const v of views) {
  for (const s of shots) {
    if (s.only && !s.only.includes(v.tag)) continue
    const ctx = await browser.newContext({ viewport: { width: v.width ?? 1440, height: v.height ?? 1000 }, deviceScaleFactor: v.scale ?? 1, colorScheme: v.theme })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.error(`[${s.name}-${v.tag}] page error:`, e.message))
    await page.addInitScript((t) => localStorage.setItem('trace.display', JSON.stringify({ theme: t })), v.theme)
    if (s.off) await page.addInitScript(() => sessionStorage.setItem('trace.mock.external', 'off'))
    await page.goto(BASE + s.path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    if (s.act) await s.act(page)
    await page.screenshot({ path: `${OUT}${s.name}-${v.tag}.png`, fullPage: !!s.full })
    console.log('saved', `${s.name}-${v.tag}`)
    await ctx.close()
  }
}
await browser.close()
