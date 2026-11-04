/** The frame every screen sits in: sign-in, Home, Next, the working indicator, themes. */
import { live } from './env'
import { expect, test } from './fixtures'

test.describe('sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the custom sign-in page asks for an email and moves on @phone', async ({ app, page }) => {
    if (!live) await page.addInitScript(() => sessionStorage.setItem('trace.mock.signedOut', '1'))
    await app.open('/sign-in')
    const email = page.locator('#email')
    await expect(email).toBeVisible()
    await expect(page).not.toHaveURL(/amazoncognito\.com/)
    test.skip(live, 'live: the smoke user signs in once in global setup')
    await email.fill('marc@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Welcome back')).toBeVisible()
  })
})

test('Home shows what needs you and the projects @phone', async ({ app, page }) => {
  await app.open('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Projects' }).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText(/your projects/i).first()).toBeVisible()
})

test('Next lists the next thing to do', async ({ app, page }) => {
  await app.open('/next')
  await expect(page.getByRole('heading', { name: 'Next', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Up next/ })).toBeVisible()
})

test('the trace-is-working indicator opens the activity list @phone', async ({ app, page }) => {
  await app.open('/')
  const working = page.getByRole('button', { name: /^trace is (working|idle)/ })
  await expect(working).toBeVisible()
  await working.click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('the theme switches between light, dark and system', async ({ app, page }) => {
  await app.open('/me')
  await page.getByRole('button', { name: 'Display' }).click()
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await theme.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await theme.getByRole('radio', { name: 'System' }).click()
})

test('search opens the command menu', async ({ app, page }) => {
  await app.open('/')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible()
})
