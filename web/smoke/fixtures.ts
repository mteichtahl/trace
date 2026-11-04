/**
 * The smoke test's `test`: every check fails if the page throws, and gets helpers for the shapes trace's screens share
 * (the TanStack tables, the project's section tabs, Ask trace).
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test'

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

  /**
   * The first trace table in scope has at least one data row; returns that row. On a phone the tables become lists,
   * so a list item counts as a row there.
   */
  async tableHasRows(scope: Locator | Page = this.page.locator('#main').or(this.page.locator('body')).first()): Promise<Locator> {
    const tableRow = scope.locator('table tbody tr').filter({ visible: true }).first()
    const listRow = scope.locator('ul > li').filter({ visible: true }).first()
    await expect(tableRow.or(listRow).first()).toBeVisible()
    const row = (await tableRow.isVisible()) ? tableRow : listRow
    await expect(row).toBeVisible()
    await expect(row).not.toHaveText(/^\s*(No results|Nothing)/i)
    return row
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
    return chat
  }
}
