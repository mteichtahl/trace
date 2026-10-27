// Screenshots of the Operations, Admin, Inbox and Preferences screens (mock mode). BASE defaults to :5183.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
const BASE = process.env.BASE ?? 'http://localhost:5183'
const OUT = new URL('../screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const only = process.argv[2]
const shots = [
  { name: 'ops', path: '/ops', full: true },
  { name: 'ops-moment', path: '/ops', act: async (p) => { await p.waitForSelector('.recharts-surface'); const b = await p.locator('.recharts-surface').first().boundingBox(); await p.mouse.click(b.x + b.width * 0.7, b.y + b.height * 0.6); await p.waitForTimeout(800) } },
  { name: 'ops-dark', path: '/ops', theme: 'dark' },
  { name: 'ops-phone', path: '/ops', width: 390, height: 844, full: true },
  { name: 'people', path: '/admin/people' },
  { name: 'people-invite', path: '/admin/people', act: async (p) => { await p.click('text=Invite people'); await p.fill('#invite-email', 'sam.okafor@example.com'); await p.waitForTimeout(500) } },
  { name: 'people-phone', path: '/admin/people', width: 390, height: 844, full: true },
  { name: 'prompts', path: '/admin/prompts', full: true },
  { name: 'prompts-project', path: '/admin/prompts', full: true, act: async (p) => { await p.click('text=Project: Soil sensor'); await p.waitForTimeout(600); await p.click('nav[aria-label="Instructions"] >> text=Role'); await p.waitForTimeout(800) } },
  { name: 'prompts-dark', path: '/admin/prompts', theme: 'dark' },
  { name: 'prompts-phone', path: '/admin/prompts', width: 390, height: 844, full: true },
  { name: 'project-prompts', path: '/p/acme~soil-sensor/settings/prompts' },
  { name: 'installation', path: '/admin/installation', full: true },
  { name: 'usage', path: '/admin/usage' },
  { name: 'inbox', path: '/inbox' },
  { name: 'inbox-other', path: '/inbox', act: async (p) => { await p.click('text=Other answer'); await p.waitForTimeout(500) } },
  { name: 'inbox-phone', path: '/inbox', width: 390, height: 844, full: true },
  { name: 'me', path: '/me?group=voice', full: true },
  { name: 'me-display-dark', path: '/me?group=display', theme: 'dark' },
  { name: 'me-security', path: '/me?group=security' },
  { name: 'me-notifications', path: '/me?group=notifications', full: true },
  { name: 'me-phone', path: '/me?group=display', width: 390, height: 844, full: true },
]
const browser = await chromium.launch()
for (const s of shots.filter((x) => !only || x.name.startsWith(only))) {
  const ctx = await browser.newContext({ viewport: { width: s.width ?? 1440, height: s.height ?? 1000 }, deviceScaleFactor: s.width ? 2 : 1, colorScheme: s.theme === 'dark' ? 'dark' : 'light' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`[${s.name}] page error:`, e.message))
  if (s.theme) await page.addInitScript((t) => localStorage.setItem('trace.display', JSON.stringify({ theme: t })), s.theme)
  await page.goto(BASE + s.path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  try { if (s.act) await s.act(page) } catch (e) { console.error(`[${s.name}] act failed:`, e.message) }
  await page.screenshot({ path: `${OUT}${s.name}.png`, fullPage: !!s.full })
  console.log('saved', s.name)
  await ctx.close()
}
await browser.close()
