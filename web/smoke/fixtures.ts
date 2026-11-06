/**
 * The smoke test's `test`: every check fails if the page throws, and gets helpers for the shapes trace's screens share
 * (the TanStack tables, the project's section tabs, Ask trace).
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { live } from './env'

export { expect }

export const test = base.extend<{ app: App }>({
  app: async ({ page }, use, info) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await use(new App(page))
    if (errors.length) await info.attach('page errors', { body: errors.join('\n'), contentType: 'text/plain' })
    expect(errors, 'the page threw while the check ran').toEqual([])
  },
})

export class App {
  constructor(readonly page: Page) {}

  /** Go to a path and wait until the app has painted it (the main navigation or a focus screen is up). */
  async open(path: string) {
    await this.page.goto(path)
    await expect(this.page.locator('h1, h2').first()).toBeVisible()
  }

  /** The rows of the first trace table in scope: on a phone the tables become lists, so list items there. */
  rows(scope: Locator | Page = this.page.locator('#main').or(this.page.locator('body')).first()): Locator {
    // decided by the screen, not by whichever appears first: a desktop page can show a list while its table loads
    const phone = (this.page.viewportSize()?.width ?? 1440) < 768
    return scope.locator(phone ? 'ul > li' : 'table tbody tr').filter({ visible: true }).first()
  }

  /**
   * The first trace table in scope has at least one data row; returns that row. On a phone the tables become lists,
   * so a list item counts as a row there.
   */
  async tableHasRows(scope: Locator | Page = this.page.locator('#main').or(this.page.locator('body')).first()): Promise<Locator> {
    const row = this.rows(scope)
    await expect(row).toBeVisible()
    await expect(row).not.toHaveText(/^\s*(No results|Nothing)/i)
    return row
  }

  /**
   * Whether the screen shows its data (true) or says, in its own empty state, that the project has none yet (false).
   * The mock always has the data, so there it must show. A live project may truly have none (no open change, no run
   * before its baseline is signed, trace idle): then its empty state must show instead, and the check notes what it
   * could not exercise (`not exercised` in results.json) so that a green run never hides it. A screen that shows
   * neither still fails.
   */
  async hasData(data: Locator, empty: Locator, none: string): Promise<boolean> {
    await expect(data.first().or(empty.first()).first()).toBeVisible()
    if (!live) {
      await expect(data.first(), 'the mock has this data').toBeVisible()
      return true
    }
    if (await data.first().isVisible()) return true
    await expect(empty.first()).toBeVisible()
    base.info().annotations.push({ type: 'not exercised', description: `live: ${none}` })
    return false
  }

  /** Type into a table's search box and see the rows narrow to the text (TanStack Table's global filter). */
  async searchTable(text: string) {
    const box = this.page.getByRole('textbox', { name: 'Search the table' }).first()
    await box.fill(text)
    await expect(await this.tableHasRows()).toContainText(text, { ignoreCase: true })
    await box.fill('')
  }

  /** Open Ask trace (the chat) with its keyboard shortcut. */
  async openChat(): Promise<Locator> {
    await this.page.keyboard.press('Control+j')
    const chat = this.page.getByRole('region', { name: 'Ask trace' })
    await expect(chat).toBeVisible()
    // ready when it has decided which conversation to show and finished loading it: its conversation log is up and
    // not busy (it is busy while a stored conversation loads, and absent while the last one is looked up). Typing
    // before then would race the panel; network quiet says nothing about it
    await expect(chat.locator('[aria-live="polite"][aria-busy="false"]')).toBeVisible({ timeout: 30_000 })
    return chat
  }

  /** Open Ask trace on a new conversation of its own, so a check starts from nothing the project's history put there. */
  async newChat(): Promise<Locator> {
    const chat = await this.openChat()
    await chat.getByRole('button', { name: 'Conversations' }).click()
    await chat.getByRole('button', { name: 'New conversation' }).click()
    await expect(chat.locator('[aria-live="polite"][aria-busy="false"]')).toBeVisible()
    return chat
  }
}
