/**
 * The installer page's entry (bundled to /ui.js and /ui.css by scripts/bundle-ui.mjs). The page itself is app.tsx;
 * its state and checks are model.ts; what it asks the local installer is actions.ts.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { boot } from './actions.js'
import { App } from './app.js'

const root = document.getElementById('app')
if (root) {
  createRoot(root).render(<StrictMode><App /></StrictMode>)
  void boot()
}
