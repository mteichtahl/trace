/** The installer's HTML shell and styles. The page's behaviour is ui/app.ts, served as /ui.js. */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function page(key: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="trace-key" content="${esc(key)}">
<title>Install trace</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd; --accent: #2f5bd3; --accent-ink: #ffffff;
  --ok: #1d7a46; --warn: #a15c00; --bad: #b42318; --soft: #eef2fd; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe6; --muted: #a3a29b; --line: #34332f; --accent: #8aa6ff; --accent-ink: #10121a;
    --ok: #5cc98a; --warn: #f0b056; --bad: #ff8a80; --soft: #222838; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 28px 16px 8px; max-width: 920px; margin: 0 auto; }
header h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
header p { margin: 4px 0 0; color: var(--muted); }
main { max-width: 920px; margin: 0 auto; padding: 8px 16px 64px; display: grid; gap: 14px; }
nav.steps { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 4px; }
nav.steps button { border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer; }
nav.steps button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
nav.steps button.ok::before { content: "✓ "; }
section.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
section.card h2 { margin: 0 0 4px; font-size: 17px; }
section.card > p.lead { margin: 0 0 14px; color: var(--muted); }
label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
label small { font-weight: 400; color: var(--muted); }
input[type=text], input[type=password], input[type=email], input[type=number], select, textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 14px; }
.check { display: flex; align-items: center; gap: 8px; font-weight: 400; margin: 8px 0; }
.check input { width: auto; }
button.primary, button.secondary { font: inherit; border-radius: 8px; padding: 8px 16px; cursor: pointer; border: 1px solid var(--accent); }
button.primary { background: var(--accent); color: var(--accent-ink); }
button.secondary { background: transparent; color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--muted, #888); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
ul.progress { margin: 6px 0 0; padding-left: 18px; font-size: 13px; } ul.progress li { margin: 2px 0; }
.note { border-radius: 8px; padding: 10px 12px; margin: 10px 0; font-size: 14px; background: var(--soft); }
.note.ok { border-left: 3px solid var(--ok); } .note.warn { border-left: 3px solid var(--warn); } .note.bad { border-left: 3px solid var(--bad); }
.repos { max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; margin-top: 8px; }
.repos .item { display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 14px; }
.repos .item:last-child { border-bottom: 0; }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
table.grid { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
table.grid th, table.grid td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: middle; }
table.grid th { font-size: 12px; color: var(--muted); font-weight: 600; }
table.grid td select { padding: 4px 6px; }
.plan li, .progress li { margin: 6px 0; }
.progress { list-style: none; padding: 0; margin: 0; }
.progress li { display: grid; grid-template-columns: 22px 1fr; gap: 8px; }
.progress .icon { font-family: var(--mono); }
.progress .detail { color: var(--muted); font-size: 13px; }
.status-done .icon { color: var(--ok); } .status-failed .icon { color: var(--bad); } .status-running .icon { color: var(--accent); }
pre.log { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; max-height: 320px; overflow: auto; font: 12px/1.45 var(--mono); white-space: pre-wrap; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.actions.left { justify-content: flex-start; margin-top: 8px; }
.sub { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
.sub h3, details.advanced h3 { font-size: 14px; margin: 14px 0 4px; }
details.advanced { margin-top: 16px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
details.advanced > summary { cursor: pointer; font-weight: 600; }
button.link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
textarea { min-height: 4em; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 13px; }
@media (max-width: 600px) { .repos .item { grid-template-columns: auto 1fr; } .repos .item .opt { grid-column: 2; } }
</style>
</head>
<body>
<header>
  <h1>Install trace</h1>
  <p>Needs two things: AWS credentials and one GitHub token. Everything else is worked out or has a default. Tokens and keys you enter stay on this machine until they are written to AWS Secrets Manager and GitHub.</p>
</header>
<main id="app"><p class="muted">Loading…</p></main>
<script src="/ui.js"></script>
</body>
</html>`
}
