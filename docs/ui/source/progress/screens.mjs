// Design renders for "See what trace is doing" (docs/progress-and-logs.md). Writes one HTML file per screen next to
// this script; render.mjs turns them into docs/ui/screens/*.png. Designs only: nothing here ships.
import { writeFileSync } from 'node:fs'

const svg = (d, s = 16, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`
const I = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  book: '<path d="M4 4h10a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M4 16a4 4 0 0 1 4-4h10"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  dashed: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  down: '<path d="M12 4v12M6 12l6 6 6-6M4 20h16"/>',
  searchI: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 18h5"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v4M12 17h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  wrench: '<path d="M14 7a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3l8-8a4 4 0 0 1 5-5l-3 3 1 2 2 1z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  send: '<path d="m4 12 16-8-6 16-2-6z"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
}

const page = (title, body, extraCss = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>trace · ${title}</title><link rel="stylesheet" href="common.css"><style>${extraCss}</style></head><body>${body}</body></html>`

const side = `<nav class="side">
  <div class="brand"><div class="logo">t</div>trace</div>
  <a class="nav">${svg(I.home)}Home</a>
  <a class="nav on">${svg(I.folder)}Projects</a>
  <a class="nav">${svg(I.book)}Knowledge</a>
  <a class="nav">${svg(I.bot)}Agents</a>
  <a class="nav">${svg(I.pulse)}Operations</a>
  <a class="nav">${svg(I.shield)}Admin</a>
  <div class="pinned">Pinned</div>
  <a class="nav">Soil sensor<span class="badge-n">1</span></a>
  <a class="nav">Motor driver</a>
  <a class="nav">Panel controller</a>
  <div class="me"><div class="avatar">MT</div><div><div style="font-weight:500">Marc Teichtahl</div><div class="xs muted">Admin</div></div></div>
</nav>`

const top = (crumbs, { open = false } = {}) => `<header class="top">
  <div class="crumbs">${crumbs}</div>
  <div class="search">${svg(I.searchI, 14)} Search or run a command <span class="kbd">⌘K</span></div>
  <button class="working" style="${open ? 'box-shadow:0 0 0 3px #dbeafe' : ''}"><span class="spin"></span>trace is working <span class="n">4</span></button>
  <span class="live"><span class="dot"></span>Live</span>
  <button class="btn" style="padding:6px 8px">${svg(I.bell)}</button>
  <button class="btn">${svg(I.spark)}Ask trace <span class="kbd">⌘J</span></button>
</header>`

// ------------------------------------------------------------------ 1. a change's checks, live

const checksCard = `<section class="card" style="padding:20px 24px 8px">
  <div style="display:flex;align-items:baseline;gap:10px"><div class="label">Checks</div><div class="small muted">2 running · 1 waiting for a build machine · 1 passed</div></div>
  <div style="margin-top:6px">
    <div class="check row">
      <span class="spin big" style="margin-top:2px"></span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center"><b style="font-weight:600">Board checks</b><span class="pill blue">Step 4 of 9</span></div>
        <div style="margin-top:2px">Checking the routed board against JLCPCB's design rules</div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:8px"><div class="bar" style="width:320px"><i style="width:48%"></i></div><span class="small muted">3 min so far, usually 6</span></div>
        <div class="xs muted" style="margin-top:6px"><span class="beat"><span class="p"></span>Newest line 2 s ago</span> · <span class="mono">drc: 1,204 of 2,480 items checked</span></div>
      </div>
      <button class="btn sm">${svg(I.term, 14)}Watch</button>
    </div>
    <div class="check row">
      <span class="spin big" style="margin-top:2px"></span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center"><b style="font-weight:600">Firmware build</b><span class="pill blue">Step 2 of 5</span></div>
        <div style="margin-top:2px">Compiling the firmware: 412 of 980 files</div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:8px"><div class="bar" style="width:320px"><i style="width:42%"></i></div><span class="small muted">1 min so far, about 2 left</span></div>
        <div class="xs muted" style="margin-top:6px"><span class="beat"><span class="p"></span>Newest line just now</span> · <span class="mono">Compiling embassy-stm32 v0.2.0</span></div>
      </div>
      <button class="btn sm">${svg(I.term, 14)}Watch</button>
    </div>
    <div class="check row">
      ${svg(I.clock, 18, 'class="ico muted"')}
      <div style="flex:1;min-width:0">
        <div><b style="font-weight:600">Simulation</b> <span class="muted">· waiting for a build machine</span></div>
        <div class="small muted">Starts when one is free. Usually under a minute; waiting 40 s.</div>
      </div>
    </div>
    <div class="check row">
      ${svg(I.check, 18, 'class="ico ok"')}
      <div style="flex:1;min-width:0">
        <div><b style="font-weight:600">Schematic checks</b> <span class="muted">· passed in 48 s</span></div>
      </div>
      <button class="btn sm ghost">Log</button>
    </div>
  </div>
</section>`

const changePage = (dim = false) => `<div class="app">${side}<main>
  ${top('Soil sensor · Changes · <b>#212 Move U4 2 mm left</b>')}
  <div class="content" style="${dim ? '' : ''}">
    <div class="small muted">Change #212 · Layout specialist · opened 10:41</div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:6px"><h1>Move U4 2 mm left</h1><span class="pill blue"><span class="spin" style="width:10px;height:10px;border-width:1.5px;vertical-align:-1px;margin-right:4px"></span>Checking</span></div>
    <p style="margin:8px 0 0;max-width:720px">Gives the three nets that failed between U4's pins room to route. Nothing else on the board moves.</p>
    <div class="card" style="margin-top:20px;display:flex;gap:14px;align-items:center;background:#f8fafc">
      ${svg(I.clock, 20, 'class="blue"')}
      <div style="flex:1"><div style="font-weight:500">Nothing for you to do yet</div><div class="small muted">trace is checking this change. You can accept it once the checks pass, in about 3 minutes. We'll tell you.</div></div>
      <button class="btn" disabled style="opacity:.5">Accept</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 300px;gap:20px;margin-top:20px">
      ${checksCard}
      <section class="card"><div class="label">What changed</div>
        <div style="margin-top:10px" class="small">1 part moved · 3 nets re-routed</div>
        <div style="margin-top:12px;height:150px;border-radius:8px;background:repeating-linear-gradient(45deg,#fafafa 0 8px,#f4f4f5 8px 16px);display:flex;align-items:center;justify-content:center" class="xs muted">Board, before and after</div>
      </section>
    </div>
  </div>
</main>${dim ? '<div class="overlay"></div>' : ''}</div>`

writeFileSync(new URL('./ChangeChecksLive.html', import.meta.url), page('Checks running', changePage()))

// ------------------------------------------------------------------ 2. the log sheet

const logLines = [
  ['10:44:02', '<span class="s">▸ Step 1 · Get the design</span>'],
  ['10:44:03', 'Fetched soil-sensor @ 7c1e9a2 (change #212)'],
  ['10:44:09', '<span class="s">▸ Step 2 · Load the board</span>'],
  ['10:44:11', 'kicad-cli 9.0.2 · soil-sensor.kicad_pcb · 4 layers, 62 nets, 118 parts'],
  ['10:44:31', '<span class="s">▸ Step 3 · Check the schematic still matches the board</span>'],
  ['10:44:58', '<span class="k">✓ parity: 62 of 62 nets match</span>'],
  ['10:45:02', '<span class="s">▸ Step 4 · Design rule check (JLCPCB 4-layer rules, updated 1 Nov)</span>'],
  ['10:45:03', 'drc: clearance, track width, annular ring, silkscreen over mask, courtyards'],
  ['10:45:40', 'drc: 412 of 2,480 items checked'],
  ['10:46:21', '<span class="w">⚠ silkscreen: R14 label overlaps solder mask opening by 0.06 mm (moved automatically)</span>'],
  ['10:46:55', 'drc: 980 of 2,480 items checked'],
  ['10:47:31', 'drc: 1,204 of 2,480 items checked'],
  ['10:47:33', '<span class="cur">drc: courtyards, U4 to C7 0.31 mm (rule 0.25 mm) ok</span>'],
]

const logBox = (lines, h = 330) => `<div class="log mono" style="height:${h}px;position:relative">
  ${lines.map(([t, x]) => `<div class="l"><span class="t">${t}</span><span>${x}</span></div>`).join('')}
</div>`

const sheet = `<aside class="sheet">
  <div style="padding:20px 24px 14px;border-bottom:1px solid #f0f0f0">
    <div style="display:flex;align-items:center;gap:10px">
      <span class="spin big"></span><h2 style="flex:1">Board checks</h2>
      <button class="btn sm ghost">${svg(I.more, 16)}</button>
      <button class="btn sm ghost">${svg(I.close, 16)}</button>
    </div>
    <p style="margin:10px 0 0">Checking the routed board against JLCPCB's design rules. <b style="font-weight:500">1,204 of 2,480 items</b> checked, one small thing fixed on the way.</p>
    <div style="display:flex;align-items:center;gap:12px;margin-top:10px"><div class="bar" style="flex:1"><i style="width:48%"></i></div><span class="small muted">3 min so far, usually 6</span></div>
  </div>
  <div style="padding:14px 24px 6px">
    <div class="label" style="margin-bottom:4px">Steps</div>
    <div class="step"><span class="circ done"></span>Get the design<span class="d">0:06</span></div>
    <div class="step"><span class="circ done"></span>Load the board<span class="d">0:20</span></div>
    <div class="step"><span class="circ done"></span>Check the schematic still matches the board<span class="d">0:27</span></div>
    <div class="step" style="font-weight:500"><span class="circ now"></span>Design rule check<span class="d blue">Running · 2:31</span></div>
    <div class="step muted"><span class="circ"></span>Make the fabrication files, and 4 more<span class="d">about 3 min</span></div>
  </div>
  <div style="padding:10px 24px 0;display:flex;align-items:center;gap:8px">
    <div class="label" style="flex:1">What it's saying</div>
    <div class="search" style="width:190px;padding:3px 10px">${svg(I.searchI, 13)}<span class="small" style="flex:1;margin-left:6px">Find in log</span></div>
    <button class="btn sm" title="Wrap long lines">${svg(I.wrap, 14)}</button>
    <button class="btn sm">${svg(I.alert, 14)}1 note</button>
    <button class="btn sm">${svg(I.down, 14)}</button>
  </div>
  <div style="padding:10px 24px 0;flex:1">${logBox(logLines, 500)}</div>
  <div style="padding:12px 24px 18px;display:flex;align-items:center;gap:10px;border-top:1px solid #f0f0f0;margin-top:14px">
    <span class="beat small"><span class="p"></span>Live · newest line 2 s ago</span>
    <span class="small muted" style="flex:1">· following the newest line</span>
    <span class="small muted">Build machine: AWS CodeBuild, Sydney</span>
  </div>
</aside>`

writeFileSync(new URL('./LogSheet.html', import.meta.url), page('Board checks log', `<div style="position:relative">${changePage(true)}${sheet}</div>`, '.log .l{white-space:pre-wrap}'))

// ------------------------------------------------------------------ 3. what trace is doing, everywhere

const actRow = (o) => `<div style="padding:12px 16px;border-top:1px solid #f4f4f5;display:flex;gap:12px;align-items:flex-start">
  ${o.icon ?? '<span class="spin" style="margin-top:3px"></span>'}
  <div style="flex:1;min-width:0">
    <div><b style="font-weight:600">${o.project}:</b> ${o.title}</div>
    <div class="small" style="margin-top:1px">${o.step}</div>
    <div class="xs muted" style="margin-top:4px">${o.beat} <span>· ${o.time}</span></div>
  </div>
  <button class="btn sm">${o.btn ?? 'Watch'}</button>
</div>`

const groupHead = (t, n) => `<div style="padding:12px 16px 4px;display:flex;justify-content:space-between" class="xs muted"><span class="label" style="font-size:11px">${t}</span><span>${n}</span></div>`

const activityPanel = `<div style="position:absolute;top:52px;right:240px;width:470px;background:#fff;border:1px solid #e5e5e5;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.14);overflow:hidden">
  <div style="padding:16px 16px 12px;display:flex;align-items:center;gap:10px"><h2 style="flex:1;font-size:16px">What trace is doing</h2><span class="small muted">4 things · all healthy but one</span></div>
  ${groupHead('Checks on changes', '2')}
  ${actRow({ project: 'Soil sensor', title: 'Board checks on #212', step: 'Step 4 of 9: design rule check, 1,204 of 2,480 items', beat: '<span class="beat"><span class="p"></span>newest line 2 s ago</span>', time: '3 min, usually 6' })}
  ${actRow({ project: 'Motor driver', title: 'Firmware build on #88', step: 'Step 2 of 5: compiling, 412 of 980 files', beat: '<span class="beat"><span class="p"></span>newest line just now</span>', time: '1 min, about 2 left' })}
  ${groupHead('Specialists', '1')}
  ${actRow({ project: 'Soil sensor', title: 'Routing the board', step: 'Stage 1 of 2: OrthoRoute on the dense core near U4', beat: '<span class="beat"><span class="p grey"></span>quiet for 1 min · normal while the router thinks</span>', time: '12 min, usually 20' })}
  ${groupHead('Tools', '1')}
  ${actRow({ icon: `<span style="margin-top:2px" class="warn">${svg(I.alert, 16)}</span>`, project: 'Panel controller', title: 'Thermal simulation', step: 'Meshing the enclosure: no word for 4 min', beat: '<span class="beat warn"><span class="p amber"></span>later than usual · declared lost at 11:20 if still silent</span>', time: '9 min, usually 5', btn: 'Look' })}
  <div style="padding:12px 16px;border-top:1px solid #f0f0f0;background:#fafafa;display:flex;justify-content:space-between;align-items:center" class="small"><span class="muted">Also waiting: JLCPCB to confirm order · next check in 13 min</span><a class="blue">All work ›</a></div>
</div>`

writeFileSync(new URL('./Activity.html', import.meta.url), page('What trace is doing', `<div class="app">${side}<main>${top('Home', { open: true })}
  <div class="content" style="opacity:.55">
    <h1>Good morning, Marc</h1><p class="muted" style="margin-top:4px">Two things need you; trace is working on four.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px">
      <div class="card" style="height:150px"><div class="label">Next</div><p>Sign the schematic gate on Soil sensor</p></div>
      <div class="card" style="height:150px"><div class="label">Next</div><p>Answer the Layout specialist's question on Motor driver</p></div>
    </div>
    <div class="card" style="margin-top:16px;height:260px"><div class="label">Recently</div></div>
  </div>
</main>${activityPanel}</div>`))

// ------------------------------------------------------------------ 4. a tool running in chat, and the quiet states

const chatMsg = (who, html) => `<div style="margin-top:16px"><div class="xs muted">${who}</div><div style="margin-top:4px">${html}</div></div>`

const toolRunning = `<div class="tool" style="margin-top:10px">
  <div style="display:flex;align-items:center;gap:10px"><span class="spin"></span><b style="font-weight:600;flex:1">Running the transient simulation</b><span class="small muted mono">0:42</span></div>
  <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><div class="bar" style="flex:1"><i style="width:62%"></i></div><span class="xs muted">62% · about 25 s left</span></div>
  <div class="xs muted mono" style="margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ngspice: t = 6.2 ms of 10 ms, step 2.0 µs</div>
  <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm">${svg(I.term, 13)}Watch log</button><button class="btn sm ghost">What it was asked</button></div>
</div>`

const states = [
  ['p', 'Working', 'Newest line seconds ago. Spinner and the latest line.', ''],
  ['p grey', 'Quiet, as usual', 'No new lines, but this step usually goes quiet. Says for how long it normally does.', ''],
  ['p amber', 'Later than usual', 'Past its overdue time. Says when it will be called lost, and offers to stop it.', 'warn'],
  ['p red', 'Lost', 'Nothing heard past the limit. Shows the last thing it said and what was kept.', 'bad'],
]

writeFileSync(new URL('./ChatTool.html', import.meta.url), page('A tool running in chat', `<div class="app">${side}<main>${top('Soil sensor · <b>Ask trace</b>')}
  <div style="display:grid;grid-template-columns:1fr 420px;height:944px">
    <div class="content" style="opacity:.5"><h1>Soil sensor</h1><div class="card" style="margin-top:20px;height:500px"></div></div>
    <aside style="border-left:1px solid #e5e5e5;padding:20px 22px;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center"><h2 style="flex:1">Ask trace</h2><span class="small muted">Soil sensor</span></div>
      ${chatMsg('You · 10:52', '<div style="background:#f4f4f5;border-radius:12px;padding:10px 12px">Does the probe output settle within 5 ms at power-on?</div>')}
      ${chatMsg('trace · 10:52', `I'm running a transient simulation of the probe circuit from power-on to 10 ms.${toolRunning}`)}
      <div class="tool" style="margin-top:12px;background:#fff">
        <div style="display:flex;align-items:center;gap:10px"><span class="spin" style="border-color:#e5e5e5;border-top-color:#a3a3a3"></span><span style="flex:1">Reading the probe datasheet</span><span class="small muted mono">0:18</span></div>
        <div class="xs muted" style="margin-top:6px"><span class="beat"><span class="p grey"></span>Quiet for 15 s: normal, it reads the whole file before answering</span></div>
      </div>
      <div style="margin-top:auto">
        <div class="label" style="margin:0 0 8px">How quiet is too quiet</div>
        ${states.map(([p, t, d, c]) => `<div style="display:flex;gap:10px;padding:6px 0;align-items:flex-start"><span class="beat" style="margin-top:6px"><span class="${p}"></span></span><div><div class="small ${c}" style="font-weight:600">${t}</div><div class="xs muted">${d}</div></div></div>`).join('')}
        <div class="search" style="width:auto;margin-top:14px;padding:10px 12px">Ask anything about Soil sensor ${svg(I.send, 15)}</div>
      </div>
    </aside>
  </div>
</main></div>`))

// ------------------------------------------------------------------ 5. on a phone

const phoneTop = (t) => `<div class="status"><span>10:48</span><span>●●● ▮</span></div><div style="padding:6px 20px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0">${t}</div>`

const phoneHome = `<div class="phone">${phoneTop('<div class="logo">t</div><b style="flex:1">trace</b><button class="working" style="font-size:12px"><span class="spin"></span>4<span class="n" style="display:none"></span></button><span class="dot"></span>')}
  <div style="padding:16px 20px;opacity:.45"><div class="label">Next</div><div class="card" style="margin-top:8px;height:90px"></div></div>
  <div style="position:absolute;left:0;right:0;bottom:0;top:250px;background:#fff;border-radius:22px 22px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.15);overflow:hidden">
    <div style="width:40px;height:4px;background:#d4d4d4;border-radius:9px;margin:10px auto"></div>
    <div style="padding:4px 18px 8px;display:flex"><b style="flex:1;font-size:16px">What trace is doing</b><span class="small muted">4</span></div>
    ${[
      ['Soil sensor', 'Board checks on #212', 'Design rule check · 3 of 6 min', 'p', 'Watch'],
      ['Motor driver', 'Firmware build on #88', 'Compiling · about 2 min left', 'p', 'Watch'],
      ['Soil sensor', 'Routing the board', 'Quiet 1 min · normal here', 'p grey', 'Watch'],
      ['Panel controller', 'Thermal simulation', 'No word for 4 min · later than usual', 'p amber', 'Look'],
    ].map(([p, t, s, b, btn]) => `<div style="padding:12px 18px;border-top:1px solid #f4f4f5;display:flex;gap:10px;align-items:center"><span class="beat"><span class="${b}"></span></span><div style="flex:1;min-width:0"><div class="small"><b style="font-weight:600">${p}:</b> ${t}</div><div class="xs muted">${s}</div></div><button class="btn sm">${btn}</button></div>`).join('')}
    <div style="padding:12px 18px" class="small blue">All work ›</div>
  </div>
</div>`

const phoneLog = `<div class="phone">${phoneTop(`${svg(I.back, 20)}<b style="flex:1">Board checks</b>${svg(I.more, 20)}`)}
  <div style="padding:14px 20px 4px">
    <div style="display:flex;gap:8px;align-items:center"><span class="spin"></span><span class="small" style="font-weight:500">Step 4 of 9 · Design rule check</span></div>
    <p class="small" style="margin:8px 0 0">Checking the routed board against JLCPCB's rules. 1,204 of 2,480 items checked; one small thing fixed.</p>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px"><div class="bar" style="flex:1"><i style="width:48%"></i></div><span class="xs muted">3 of ~6 min</span></div>
  </div>
  <div style="display:flex;gap:6px;padding:12px 20px 8px"><span class="pill" style="padding:3px 10px">Steps</span><span class="pill" style="padding:3px 10px;background:#0a0a0a;color:#fff;border-color:#0a0a0a">Log</span><span style="flex:1"></span><span class="pill amber" style="padding:3px 10px">1 note</span></div>
  <div style="padding:0 12px">${logBox(logLines.slice(6).map(([t, x]) => [t.slice(3), x]), 470)}</div>
  <div style="position:absolute;bottom:22px;right:20px"><span class="btn sm" style="border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.12)">${svg(I.arrowDown, 13)}Following the newest line</span></div>
  <div style="position:absolute;bottom:30px;left:20px" class="xs"><span class="beat"><span class="p"></span>Live · 2 s ago</span></div>
</div>`

writeFileSync(new URL('./PhoneProgress.html', import.meta.url), page('On a phone', `<div style="display:flex;gap:48px;padding:40px;background:#f4f4f5;width:950px">${phoneHome}${phoneLog}</div>`, '.log .l{white-space:pre-wrap}'))

console.log('written')
