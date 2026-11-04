/** Reviewing trace's changes inside the app, and the gate staying locked while work is pending. */
import { live, projectPath, writes } from './env'
import { expect, test } from './fixtures'

test('the changes table lists changes and one opens for review @phone', async ({ app, page }) => {
  await app.open(projectPath('/changes'))
  const row = await app.tableHasRows()
  await row.click()
  await expect(page).toHaveURL(/\/changes\/\d+/)
  await expect(page.getByRole('heading', { name: 'What trace did' })).toBeVisible()
  // desktop shows a Checks section; a phone folds it into one line ("1 of 1 check passed")
  await expect(page.getByText(/\bchecks? (passed|failing|running)|^Checks/i).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept into the design' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask for changes' })).toBeVisible()
})

test('a changed file shows its before and after', async ({ app, page }) => {
  await app.open(projectPath('/changes'))
  await (await app.tableHasRows()).click()
  const files = page.getByRole('region', { name: 'Files' })
  await files.getByRole('button').first().click()
  await expect(files.locator('pre, table, svg, canvas, [data-diff]').filter({ visible: true }).first()).toBeVisible()
})

test('a change is accepted in the app', async ({ app, page }) => {
  test.skip(!writes || live, 'accepting merges: mock only (Tier 2 accepts for real)')
  await app.open(projectPath('/changes/12'))
  await page.getByRole('button', { name: 'Accept into the design' }).click()
  await expect(page.getByText(/accepted|merging|being checked/i).first()).toBeVisible()
})

test('a gate cannot be signed while its stage has pending work', async ({ app, page }) => {
  await app.open(projectPath())
  const gate = page.getByRole('link', { name: /Sign the .* gate/ }).first()
  test.skip(!(await gate.isVisible().catch(() => false)), 'no gate is waiting on this project right now')
  await gate.click()
  await expect(page.getByRole('heading', { name: /^Sign the .* gate/ })).toBeVisible()
  await app.tableHasRows()
  const pending = page.getByText(/pending|still open|not met|waiting/i).first()
  if (await pending.isVisible().catch(() => false)) await expect(page.getByRole('button', { name: /^Sign the .* gate/ }).last()).toBeDisabled()
})

test('a gate shows what each shape still needs under its criterion, each waivable on its own @phone', async ({ app, page }) => {
  // the mock's schematic gate has a stock criterion with two findings; a live project may have none right now
  test.skip(live, 'needs a gate with shape findings: the mock\'s schematic gate has them')
  await app.open(projectPath('/gates/schematic'))
  const needed = page.getByRole('list', { name: 'Still needed' }).first()
  await expect(needed.getByRole('listitem').first()).toBeVisible()
  await expect(needed.getByRole('link', { name: /^Waive this one/ }).first()).toBeVisible()
})

test('a criterion an admin added is signed off by saying what was checked', async ({ app, page }) => {
  test.skip(live, 'needs a gate with an added criterion: the mock\'s schematic gate has one')
  await app.open(projectPath('/gates/schematic'))
  await page.getByRole('button', { name: /^Sign off/ }).first().click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'What did you check?' })
  await expect(dialog).toBeVisible()
  const confirm = dialog.getByRole('button', { name: 'Sign off', exact: true })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill('Read the battery datasheet and the charger\'s protection limits.')
  await expect(confirm).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})
