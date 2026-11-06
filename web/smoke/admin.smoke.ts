/** The installation-wide screens: people, connected systems, instructions, installation, usage, operations, agents, knowledge. */
import { admin } from './env'
import { expect, test } from './fixtures'

test('admin: people and access', async ({ app, page }) => {
  test.skip(!admin, 'admin screens: the live smoke user is not an admin (TRACE_SMOKE_ADMIN=1 when it is)')
  await app.open('/admin/people')
  await expect(page.getByRole('heading', { name: 'People and access' })).toBeVisible()
  await app.tableHasRows()
  await expect(page.getByRole('button', { name: 'Invite people' })).toBeVisible()
})

test('admin: connected systems', async ({ app, page }) => {
  test.skip(!admin, 'admin screens: the live smoke user is not an admin (TRACE_SMOKE_ADMIN=1 when it is)')
  await app.open('/admin/systems')
  await expect(page.getByRole('heading', { name: 'Connected systems' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect a system' })).toBeVisible()
})

test('admin: agent instructions open in the editor', async ({ app, page }) => {
  test.skip(!admin, 'admin screens: the live smoke user is not an admin (TRACE_SMOKE_ADMIN=1 when it is)')
  await app.open('/admin/prompts')
  await expect(page.getByRole('heading', { name: 'Agent instructions' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Find an instruction' }).fill('role')
  await expect(page.getByRole('navigation', { name: 'Instructions' }).getByRole('button').first()).toBeVisible()
  await expect(page.getByRole('textbox', { name: /^Text of / }).first()).toBeVisible()
})

test('admin: installation health and usage', async ({ app, page }) => {
  test.skip(!admin, 'admin screens: the live smoke user is not an admin (TRACE_SMOKE_ADMIN=1 when it is)')
  await app.open('/admin/installation')
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()
  await app.open('/admin/usage')
  await expect(page.getByRole('heading', { name: 'Usage and cost' })).toBeVisible()
  await page.getByRole('button', { name: 'Previous month' }).click()
})

test('operations: dashboards load with a time range', async ({ app, page }) => {
  await app.open('/ops')
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Summary' }).getByRole('article').first()).toBeVisible()
  await page.getByRole('radiogroup', { name: 'Time range' }).getByRole('radio', { name: '7 d' }).click()
  await expect(page.getByRole('region', { name: 'Dashboards' })).toBeVisible()
})

test('agents and tools list with their status', async ({ app, page }) => {
  await app.open('/agents')
  await expect(page.getByRole('heading', { name: 'Agents and tools' })).toBeVisible()
  // the map: a box per agent, each saying its status
  await expect(page.getByRole('group', { name: /^Agents map/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Verification: (Working|Queued|Idle|Stuck|Waiting on a person)\./ })).toBeVisible()
  await page.getByRole('navigation', { name: 'Jump to' }).getByRole('link', { name: 'Tools' }).click()
  await expect(page.getByRole('heading', { name: /^Tools/ })).toBeInViewport()
})

test('knowledge: search and the graph @phone', async ({ app, page }) => {
  await app.open('/knowledge')
  await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search knowledge' }).fill('regulator')
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toContainText(/result|regulator/i)
  await app.open('/knowledge/graph')
  await expect(page.getByRole('textbox', { name: 'Start from' })).toBeVisible()
  // the empty graph suggests the project's own requirements (REQ-1a2b3c live, R-006 in the mock): start from the first
  await page.getByRole('group', { name: 'Places to start' }).getByRole('button').first().click()
  // a phone opens the graph as a list: switch it to the drawing
  const graph = page.getByRole('radio', { name: 'Graph' }).or(page.getByRole('button', { name: 'Graph', exact: true })).filter({ visible: true }).first()
  if (await graph.isVisible().catch(() => false)) await graph.click()
  await expect(page.locator('#main canvas').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 })
})

test('preferences: voice and dictation switches save', async ({ app, page }) => {
  await app.open('/me')
  await page.getByRole('button', { name: 'Voice' }).click()
  const spoken = page.getByRole('switch', { name: 'Spoken replies' })
  const before = await spoken.getAttribute('aria-checked')
  await spoken.click()
  await expect(spoken).not.toHaveAttribute('aria-checked', before!)
  await spoken.click()
  await expect(spoken).toHaveAttribute('aria-checked', before!)
  await expect(page.getByRole('switch', { name: 'Dictation' })).toBeVisible()
})

test('admin: project templates open, a stage edits, and the change can be discarded', async ({ app, page }) => {
  test.skip(!admin, 'admin screens: the live smoke user is not an admin (TRACE_SMOKE_ADMIN=1 when it is)')
  await app.open('/admin/templates')
  await expect(page.getByRole('heading', { name: 'Project templates' })).toBeVisible()
  await expect(page.getByRole('button', { name: /trace's own$/ }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Stages' })).toBeVisible()
  // a stage opens with its gate's criteria and its guide; editing words makes the template savable, and Discard undoes it
  await page.getByRole('button', { name: /^Edit / }).nth(2).click()
  const words = page.getByRole('textbox', { name: /^Words of / }).first()
  await expect(words).toBeVisible()
  await expect(page.getByRole('button', { name: /Add a criterion a person signs off/ })).toBeVisible()
  const save = page.getByRole('button', { name: /^Save version/ })
  await expect(save).toBeDisabled()
  await words.fill(`${await words.inputValue()} (smoke)`)
  // a new version needs a reason, kept in its history
  await page.getByPlaceholder('Kept with the version, for whoever reads the history').fill('Smoke test: checking the editor')
  await expect(save).toBeEnabled()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(save).toBeDisabled()
})

test('knowledge: a project\'s record replays in the graph', async ({ app, page }) => {
  await app.open('/knowledge/graph')
  await page.getByRole('button', { name: /^Replay .*'s record$/ }).click()
  const player = page.getByRole('region', { name: /^Replay of / })
  await expect(player).toBeVisible()
  await expect(player.getByRole('navigation', { name: 'Chapters' }).getByRole('button').first()).toBeVisible()
  await expect(player.getByRole('list', { name: 'The latest records' }).getByRole('listitem').first()).toBeVisible()
  // play moves the playhead along the record; a chapter jumps to it
  // Radix puts the slider role and its value on the handle, inside the labelled track
  const where = player.locator('[aria-label="Where in the record"]').getByRole('slider').or(player.getByRole('slider', { name: 'Where in the record' })).first()
  await player.getByRole('button', { name: 'To the start' }).click()
  const start = Number(await where.getAttribute('aria-valuenow'))
  await player.getByRole('button', { name: 'Play' }).click()
  await expect.poll(async () => Number(await where.getAttribute('aria-valuenow')), { timeout: 15_000 }).toBeGreaterThan(start)
  await player.getByRole('button', { name: 'Pause' }).click()
  await player.getByRole('navigation', { name: 'Chapters' }).getByRole('button').last().click()
  await expect(player.getByRole('button', { name: 'Export a video' })).toBeVisible()
  await player.getByRole('button', { name: 'Back to the graph' }).click()
  await expect(page.getByRole('textbox', { name: 'Start from' })).toBeVisible()
})
