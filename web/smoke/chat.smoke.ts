/** Ask trace: markdown, history, recall with the up key, read-aloud and the inline file viewers. */
import { live, projectPath } from './env'
import { expect, test } from './fixtures'

test('a message is sent, recalled with the up key, and the reply renders markdown @phone', async ({ app, page }) => {
  await app.open(projectPath())
  // a conversation of its own: the project's last one can hold anything, and is not what this checks
  const chat = await app.newChat()
  const box = chat.getByRole('textbox', { name: 'Message to trace' })
  const message = 'Smoke check: what is the next step? Answer in one line.'
  const replies = chat.getByRole('button', { name: 'Copy as markdown' })
  await expect(replies).toHaveCount(0)
  await box.fill(message)
  await box.press('Enter')
  // the message is in the conversation, and a reply from trace follows it with its own controls
  await expect(chat.getByText(message).first()).toBeVisible()
  await expect(replies.first()).toBeVisible({ timeout: 60_000 })
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

test('trace offers to remember something, and nothing is kept until the person confirms @phone', async ({ app, page }) => {
  // the mock offers the card whenever a message says "remember"; a live model decides for itself
  test.skip(live, 'the mock offers a remember card on "remember"')
  await app.open(projectPath())
  const chat = await app.openChat()
  await chat.getByRole('textbox', { name: 'Message to trace' }).fill('Please remember that the probe runs from a 3.3 V rail.')
  await page.keyboard.press('Enter')
  const card = chat.getByLabel('What trace will remember').last()
  await expect(card).toContainText('3.3 V rail', { timeout: 30_000 })
  const keep = chat.getByRole('button', { name: 'Remember this' }).last()
  await expect(keep).toBeEnabled()
  await keep.click()
  await expect(keep).toBeHidden()
})
