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
  // agents map (docs/ui-design.md, "Agents and tools")
  { name: 'agents', path: '/agents', full: true },
  { name: 'agents-dark', path: '/agents', theme: 'dark', full: true },
  { name: 'agents-one-project', path: '/agents?project=acme%2Fsoil-sensor', full: true },
  { name: 'agents-selected', path: '/agents', act: async (p) => { await p.click('[data-id=impl]'); await p.waitForTimeout(800) } },
  { name: 'agents-phone', path: '/agents', width: 390, height: 844, scale: 2, full: true },
  // progress and logs (docs/progress-and-logs.md)
  { name: 'progress-activity', path: '/', act: async (p) => { await p.click('button[aria-label^="trace is working"]'); await p.waitForTimeout(600) } },
  { name: 'progress-activity-dark', path: '/', theme: 'dark', act: async (p) => { await p.click('button[aria-label^="trace is working"]'); await p.waitForTimeout(600) } },
  { name: 'progress-change-checks', path: '/p/acme~soil-sensor/changes/13', full: true },
  { name: 'progress-log-sheet', path: '/p/acme~soil-sensor/changes/13', act: async (p) => { await p.click('button[aria-label="Watch Board checks"]'); await p.waitForTimeout(1500) } },
  { name: 'progress-log-sheet-dark', path: '/p/acme~soil-sensor/changes/13', theme: 'dark', act: async (p) => { await p.click('button[aria-label="Watch Board checks"]'); await p.waitForTimeout(1500) } },
  { name: 'progress-phone-activity', path: '/', width: 390, height: 844, scale: 2, act: async (p) => { await p.click('button[aria-label^="trace is working"]'); await p.waitForTimeout(800) } },
  { name: 'progress-phone-log', path: '/p/acme~soil-sensor/changes/13', width: 390, height: 844, scale: 2, act: async (p) => { await p.click('button[aria-label="Watch Board checks"]'); await p.waitForTimeout(1500) } },
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
