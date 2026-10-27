// Screenshots of the reference screens in mock mode, for a visual check against docs/ui/screens.
// Run `npm run dev:mock` first (or set BASE), then `npm run screenshots`. Output: screenshots/ (gitignored).
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const OUT = new URL('../screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const shots = [
  { name: 'sign-in', path: '/sign-in', signedOut: true },
  { name: 'sign-in-choices', path: '/sign-in', signedOut: true, act: async (p) => { await p.fill('#email', 'marc@example.com'); await p.click('button[type=submit]'); await p.waitForSelector('text=Welcome back') } },
  { name: 'home-light', path: '/' },
  { name: 'home-dark', path: '/', theme: 'dark' },
  { name: 'project', path: '/p/acme~soil-sensor', full: true },
  { name: 'projects', path: '/projects' },
  { name: 'ask-trace', path: '/p/acme~soil-sensor', act: async (p) => { await p.keyboard.press('Control+j'); await p.waitForTimeout(400); await p.click('[aria-label="Conversations"]'); await p.click('text=Why is R-006 failing?'); await p.waitForTimeout(1500) } },
  { name: 'focus', path: '/p/acme~soil-sensor/do/schematic-finish' },
  { name: 'home-phone', path: '/', width: 390, height: 844, scale: 2, full: true },
  { name: 'no-access', path: '/no-access' },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.width ?? 1440, height: s.height ?? 1000 }, deviceScaleFactor: s.scale ?? 1, colorScheme: s.theme === 'dark' ? 'dark' : 'light' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`[${s.name}] page error:`, e.message))
  if (s.signedOut) await page.addInitScript(() => sessionStorage.setItem('trace.mock.signedOut', '1'))
  if (s.theme) await page.addInitScript((t) => localStorage.setItem('trace.display', JSON.stringify({ theme: t })), s.theme)
  await page.goto(BASE + s.path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  if (s.act) await s.act(page)
  await page.screenshot({ path: `${OUT}${s.name}.png`, fullPage: !!s.full })
  console.log('saved', s.name)
  await ctx.close()
}
await browser.close()
