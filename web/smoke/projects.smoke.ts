/** The projects list and making a project. */
import { projectPath, writes } from './env'
import { expect, test } from './fixtures'

test('the projects table lists, searches and offers its columns', async ({ app, page }) => {
  await app.open('/projects')
  const row = await app.tableHasRows()
  const name = (await row.locator('td').first().innerText()).split('\n')[0]!.trim()
  await app.searchTable(name.slice(0, 6))
  await page.getByRole('button', { name: 'Columns' }).click()
  await expect(page.getByRole('menuitemcheckbox').first()).toBeVisible()
})

test('a project opens on its overview with the stage strip', async ({ app, page }) => {
  await app.open(projectPath())
  await expect(page.getByRole('navigation', { name: 'Project' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Define: / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Fabricate: / })).toBeVisible()
})

test('a new project asks for a name, description and icon', async ({ app, page }) => {
  test.skip(!writes, 'creates a project: mock, or live with TRACE_SMOKE_WRITES=1')
  await app.open('/projects/new')
  await expect(page.getByRole('heading', { name: 'Name and describe the project' })).toBeVisible()
  await page.locator('#np-name').fill(`smoke-${Date.now().toString(36)}`)
  await page.locator('#np-desc').fill('A throwaway board made by the smoke test to check that new projects can be named.')
  await page.getByLabel('Sensor', { exact: true }).first().click()
  await expect(page.getByRole('button', { name: /^Met: Description/ })).toBeVisible()
  await expect(page.getByText('No other project uses this name')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).filter({ visible: true }).last().click()
  await expect(page.getByText(/Step 2 of \d+/).first()).toBeVisible()
})
