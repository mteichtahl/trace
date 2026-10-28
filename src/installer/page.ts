/**
 * The installer's HTML shell. The page is React with the web app's shadcn components and Tailwind
 * (src/installer/ui, bundled by scripts/bundle-ui.mjs): its script is /ui.js, its styles /ui.css, and /theme.js sets
 * light or dark before anything paints (a file, so the content security policy allows no inline script).
 */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Light, dark or the system's, before the first paint (the page's theme switch keeps the choice in localStorage). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('trace.installer.theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;if(d)e.classList.add('dark');e.style.colorScheme=d?'dark':'light'}catch(x){}})()`

export function page(key: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="trace-key" content="${esc(key)}">
<meta name="color-scheme" content="light dark">
<title>Install trace</title>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/ui.css">
</head>
<body>
<div id="app"><noscript>The installer needs JavaScript: turn it on for localhost and reload.</noscript></div>
<script src="/ui.js" defer></script>
</body>
</html>`
}
