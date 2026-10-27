// No flash: the theme class (and the display preferences) before anything paints. Loaded as a file, not inline,
// so the content security policy needs no 'unsafe-inline' for scripts.
(function () {
  try {
    var d = document.documentElement
    var p = JSON.parse(localStorage.getItem('trace.display') || '{}')
    var t = p.theme || 'system'
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) d.classList.add('dark')
    d.style.colorScheme = dark ? 'dark' : 'light'
    if (p.density) d.dataset.density = p.density
    if (p.motion) d.dataset.motion = p.motion
    if (p.contrast) d.dataset.contrast = p.contrast
    if (p.textSize) d.style.setProperty('--text-scale', String(p.textSize))
  } catch (e) {}
})()
