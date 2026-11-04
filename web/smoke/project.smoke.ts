/** A project's sections: requirements, design, decisions, evidence, files, settings, cost and memory. */
import { projectPath } from './env'
import { expect, test } from './fixtures'

test('requirements: the traceability diagram lights a chain when a box is picked', async ({ app, page }) => {
  await app.open(projectPath('/requirements'))
  const canvas = page.locator('.react-flow')
  await expect(canvas.locator('.react-flow__edge').first()).toBeAttached()
  await canvas.locator('.react-flow__node[aria-label^="R-"]').first().click()
  await expect(canvas.locator('.react-flow__node.selected')).toHaveCount(1)
  // off-chain links fade, so at least one link is now drawn below full opacity
  await expect
    .poll(() => canvas.locator('.react-flow__edge path').evaluateAll((ps) => ps.some((p) => Number(getComputedStyle(p).opacity) < 1)))
    .toBe(true)
  await app.tableHasRows()
})

test('design: block diagram, schematic sheets and pin plan render', async ({ app, page }) => {
  await app.open(projectPath('/design'))
  await page.getByRole('tab', { name: 'Block diagram' }).click()
  await expect(page.locator('#main .react-flow__node').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Sheets' }).click()
  await expect(page.getByRole('navigation', { name: 'Sheets' })).toBeVisible()
  await expect(page.locator('#main section svg').filter({ visible: true }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Pin plan' }).click()
  await expect(page.locator('#main .react-flow__node, #main table tbody tr').first()).toBeVisible()
})

test('design: the board opens in 3D and turns over to the underside @phone', async ({ app, page }) => {
  // building the board in 3D takes a while with software rendering on a busy test machine
  test.slow()
  await app.open(projectPath('/design'))
  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(page.locator('canvas[aria-label^="The board in 3D"]')).toBeVisible({ timeout: 90_000 })
  const camera = page.getByRole('group', { name: 'Camera' })
  await camera.getByRole('button', { name: 'Turn over' }).click()
  await expect(page.getByText('Underside', { exact: true })).toBeVisible()
  await page.getByRole('group', { name: 'How to show the board' }).getByRole('button').last().click()
})

test('decisions: the timeline shows dated entries and filters', async ({ app, page }) => {
  await app.open(projectPath('/decisions'))
  await expect(page.getByRole('group', { name: 'How to show the decisions' })).toBeVisible()
  await expect(page.locator('#main section[aria-label]').first()).toBeVisible()
  await page.getByRole('button', { name: /^Gates \d/ }).click()
  await page.getByRole('button', { name: 'Table' }).click()
  await app.tableHasRows()
})

test('evidence: coverage and runs list, and a run opens with its steps @phone', async ({ app, page }) => {
  await app.open(projectPath('/evidence'))
  await expect(page.getByRole('heading', { name: /^Coverage/ })).toBeVisible()
  const runs = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Runs \(/ }) }).last()
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
  await expect(page.getByRole('heading', { name: 'Stage timeline' })).toBeVisible()
  await app.open(projectPath('/memory'))
  await app.tableHasRows()
})
