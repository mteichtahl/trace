/**
 * test-esp32 #15: the project page was blank (all black) for about 3 s on first navigation. index.html draws the
 * page's outline before any script runs; while trace asks who is signed in, the signed-in routes show it at once.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageSkeleton, ShellSkeleton } from './shell-skeleton'

describe('the outline while a page is on its way', () => {
  it('is in index.html, inside the root the app replaces', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
    expect(html).toMatch(/<div id="root"><div class="boot" role="status" aria-label="Loading trace">/)
    // its styles only while it is there: the app's own background is never overridden
    expect(html).not.toMatch(/^\s*body\s*\{/m)
  })

  it('is said as loading, the shell with its page', () => {
    render(<ShellSkeleton />)
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    render(<PageSkeleton />)
    expect(screen.getAllByRole('status', { name: 'Loading' })).toHaveLength(2)
  })

  it('is shown at once by the signed-in routes, and within a second by any page', () => {
    const [app, focus, main] = ['../../routes/_app.tsx', '../../routes/_focus.tsx', '../../main.tsx'].map((f) => readFileSync(resolve(__dirname, f), 'utf8'))
    expect(app).toMatch(/pendingComponent: ShellSkeleton,\s*pendingMs: 0,/)
    expect(focus).toMatch(/pendingComponent: PageSkeleton,\s*pendingMs: 0,/)
    const ms = Number(/defaultPendingMs: (\d+)/.exec(main ?? '')?.[1])
    expect(ms).toBeLessThan(1000)
  })
})
