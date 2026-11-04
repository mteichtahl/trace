/**
 * The screens that draw a board in 3D (WebGL). On a machine without a GPU each one takes a CPU core or more, and two at
 * once starved each other until a click timed out (docs/smoke-test.md "Findings"). The `3d` project in
 * playwright.config.ts runs these one at a time, phone included, while every other check runs in parallel.
 */
import { type Page, devices } from '@playwright/test'
import { projectPath } from './env'
import { type App, expect, test } from './fixtures'

/** Open the Board tab in 3D and turn the board over (building it takes a while with software rendering). */
async function turnOver(app: App, page: Page) {
  // building the board in 3D takes a while with software rendering on a busy test machine
  await app.open(projectPath('/design'))
  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(page.locator('canvas[aria-label^="The board in 3D"]')).toBeVisible({ timeout: 90_000 })
  const camera = page.getByRole('group', { name: 'Camera' })
  await camera.getByRole('button', { name: 'Turn over' }).click()
  await expect(page.getByText('Underside', { exact: true })).toBeVisible()
  await page.getByRole('group', { name: 'How to show the board' }).getByRole('button').last().click()
}

test('design: the board opens in 3D and turns over to the underside @3d', async ({ app, page }) => {
  test.slow()
  await turnOver(app, page)
})

test.describe('on a phone', () => {
  const { defaultBrowserType: _, ...phone } = devices['Pixel 7']
  test.use(phone)

  test('design: the board opens in 3D and turns over to the underside @3d', async ({ app, page }) => {
    test.slow()
    await turnOver(app, page)
  })
})

test('design: the case shows whether the board fits, with each problem on the board and listed @3d', async ({ app, page }) => {
  test.slow()
  await app.open(projectPath('/design'))
  await page.getByRole('tab', { name: 'Case' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Case' })
  // a project with no case yet says so; one with a build says whether it fits, from which build, on the board
  const empty = panel.getByText(/^No case yet/)
  await expect(empty.or(panel.getByRole('link', { name: /^build / })).first()).toBeVisible()
  if (await empty.isVisible()) return
  await expect(panel.getByText(/^(Fits|Out of date|\d+ problems? to fix or waive)/).first()).toBeVisible()
  await expect(panel.getByRole('region', { name: 'Case problems on the board' })).toBeVisible({ timeout: 90_000 })
})
