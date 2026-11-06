/** A project's sections: requirements, design, decisions, evidence, files, settings, cost and memory. */
import { admin, projectPath } from './env'
import { expect, test } from './fixtures'

test('requirements: the traceability diagram lights a chain when a box is picked', async ({ app, page }) => {
  await app.open(projectPath('/requirements'))
  const canvas = page.locator('.react-flow')
  await expect(canvas.locator('.react-flow__edge').first()).toBeAttached()
  // a requirement's box, by its node id (req:<id>): real requirement ids are REQ-1a2b3c, the mock's R-001
  await canvas.locator('.react-flow__node[data-id^="req:"]').first().click()
  await expect(canvas.locator('.react-flow__node.selected')).toHaveCount(1)
  // off-chain links fade, so at least one link is now drawn below full opacity
  await expect
    .poll(() => canvas.locator('.react-flow__edge path').evaluateAll((ps) => ps.some((p) => Number(getComputedStyle(p).opacity) < 1)))
    .toBe(true)
  await app.tableHasRows()
})

test('design: block diagram, schematic sheets and pin plan render', async ({ app, page }) => {
  await app.open(projectPath('/design'))
  // each picture comes in its own stage, so a live project early in its journey says it has none yet, tab by tab
  const panel = (name: string) => page.getByRole('tabpanel', { name })
  await page.getByRole('tab', { name: 'Block diagram' }).click()
  await app.hasData(panel('Block diagram').locator('.react-flow__node'), panel('Block diagram').getByText(/^No architecture record yet/), 'no architecture record yet, so no block diagram')
  await page.getByRole('tab', { name: 'Sheets' }).click()
  if (await app.hasData(page.getByRole('navigation', { name: 'Sheets' }), panel('Sheets').getByText(/^No schematic yet/), 'no schematic yet, so no sheets')) {
    await expect(page.locator('#main section svg').filter({ visible: true }).first()).toBeVisible()
  }
  await page.getByRole('tab', { name: 'Pin plan' }).click()
  await app.hasData(panel('Pin plan').locator('.react-flow__node, table tbody tr'), panel('Pin plan').getByText(/^No pin plan yet/), 'no pin plan yet')
})

test('decisions: the timeline shows dated entries and filters', async ({ app, page }) => {
  await app.open(projectPath('/decisions'))
  await expect(page.getByRole('group', { name: 'How to show the decisions' })).toBeVisible()
  await expect(page.locator('#main section[aria-label]').first()).toBeVisible()
  // narrow the line to one kind: whichever the record has (a project before its first gate has no gate records)
  const only = page.getByRole('group', { name: 'Show only' })
  await only.getByRole('button').nth(1).click()
  await expect(only.getByRole('button', { pressed: true })).toHaveCount(1)
  await expect(page.locator('#main section[aria-label]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Table' }).click()
  await app.tableHasRows()
})

test('evidence: coverage and runs list, and a run opens with its steps @phone', async ({ app, page }) => {
  await app.open(projectPath('/evidence'))
  await expect(page.getByRole('heading', { name: /^Coverage/ })).toBeVisible()
  const runs = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Runs \(/ }) }).last()
  if (!(await app.hasData(app.rows(runs), runs.getByText(/^No runs yet/), 'no run yet on the smoke project, so none was opened'))) return
  const run = await app.tableHasRows(runs)
  await run.click()
  await expect(page).toHaveURL(/\/runs\//)
  const failed = page.getByText('Could not load this run')
  await expect(page.locator('#main')).toContainText(/step|log|result|Could not load this run/i)
  if (await failed.isVisible()) {
    // seen once under parallel load and not reproduced since: keep what the page said, so the report explains it
    await page.getByText('Technical detail').click()
    const detail = await page.getByRole('alert').innerText()
    await test.info().attach('run load error', { body: detail, contentType: 'text/plain' })
    expect(detail, 'the run page could not load the run').toBe('')
  }
  await expect(page.locator('#main')).toContainText(/step|log|result/i)
})

test('files: the list groups files and a file opens in its viewer', async ({ app, page }) => {
  await app.open(projectPath('/files'))
  await expect(page.getByRole('tablist', { name: 'File groups' })).toBeVisible()
  const row = await app.tableHasRows()
  await row.click()
  const viewer = page.getByRole('dialog')
  await expect(viewer.getByRole('heading').first()).toBeVisible()
  await expect(viewer.locator('canvas, svg, pre, table, img').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 })
})

test('settings, cost and memory open with their data', async ({ app, page }) => {
  await app.open(projectPath('/settings'))
  await expect(page.getByRole('heading', { name: /^People and their parts/ })).toBeVisible()
  await app.open(projectPath('/cost'))
  // cost is an admin's: anyone else (the live smoke user) is told it is not shared with them
  if (admin) await expect(page.getByRole('heading', { name: 'Stage timeline' })).toBeVisible()
  else await expect(page.getByRole('heading', { name: /isn't shared with you/ })).toBeVisible()
  await app.open(projectPath('/memory'))
  await app.hasData(app.rows(), page.getByText(/^(Nothing is remembered here yet|Memory is not turned on)/), 'nothing remembered on the smoke project yet')
})

test('settings: the project logo for its documents, with a sample cover', async ({ app, page }) => {
  await app.open(projectPath('/settings'))
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible()
  await expect(page.getByLabel('Sample cover page')).toBeVisible()
})
