/** Ask trace: markdown, history, recall with the up key, read-aloud and the inline file viewers. */
import { projectPath } from './env'
import { expect, test } from './fixtures'

test('a message is sent, recalled with the up key, and the reply renders markdown @phone', async ({ app, page }) => {
  await app.open(projectPath())
  const chat = await app.openChat()
  const box = chat.getByRole('textbox', { name: 'Message to trace' })
  const message = 'Smoke check: what is the next step? Answer in one line.'
  const replies = chat.getByRole('button', { name: 'Copy as markdown' })
  const before = await replies.count()
  await box.fill(message)
  await box.press('Enter')
  // a new reply from trace arrives, rendered as markdown with its own controls
  await expect.poll(() => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(chat.locator('p, li, strong').filter({ visible: true }).last()).toBeVisible()
  await box.focus()
  await page.keyboard.press('ArrowUp')
  await expect(box).toHaveValue(message)
})

test('past conversations are kept', async ({ app }) => {
  await app.open(projectPath())
  const chat = await app.openChat()
  await chat.getByRole('button', { name: 'Conversations' }).click()
  await expect(chat.getByRole('listitem').first()).toBeVisible()
})

test('read-aloud and dictation controls are there', async ({ app }) => {
  await app.open(projectPath())
  const chat = await app.openChat()
  await expect(chat.getByRole('switch', { name: 'Read replies aloud' })).toBeVisible()
  await expect(chat.getByRole('button', { name: /^Dictate/ })).toBeVisible()
})
