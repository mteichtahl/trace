/**
 * Light, dark and system; density, text size, motion and status contrast. The person's choice is stored with them
 * (prefs.display); a copy goes to localStorage `trace.display` only so index.html's inline script paints the first
 * frame right. System always follows the device in hand.
 */
import { useEffect } from 'react'
import { usePrefs } from './prefs'
import type { Prefs } from './types'

export type Display = Prefs['display']
const STORE = 'trace.display'

export function applyDisplay(d: Partial<Display>): void {
  const root = document.documentElement
  const theme = d.theme ?? 'system'
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', !!dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (d.density) root.dataset.density = d.density
  if (d.motion) root.dataset.motion = d.motion
  if (d.contrast) root.dataset.contrast = d.contrast
  if (d.textSize) root.style.setProperty('--text-scale', String(d.textSize))
  try {
    localStorage.setItem(STORE, JSON.stringify(d))
  } catch {
    // private mode: the inline script falls back to system
  }
}

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

/** Keep the document in step with the person's display preferences, and with the device when on System. */
export function useDisplayPrefs(): void {
  const { display } = usePrefs()
  useEffect(() => {
    applyDisplay(display)
    if (display.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyDisplay(display)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [display])
}
