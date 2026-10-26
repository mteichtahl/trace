"""Route a KiCad board with Freerouting: export Specctra DSN (pcbnew), route (java -jar freerouting.jar), import the SES
and save. Run with KiCad's Python (it needs `import pcbnew`). Driven by trace's pcb.autoroute (src/pcb/autoroute.ts),
which runs it through runJob; a JSON report goes to --report.

Locked tracks and vias (OrthoRoute's stage-1 copper, or anything a designer locked) must reach Freerouting as fixed
wiring. KiCad 10 writes them as `(type fix)`; this checks that in the DSN it wrote, and marks any locked item it finds
written otherwise as fixed before routing. After the import it checks that every locked item is still on the board,
unmoved, and fails if one is not.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

# A quoted token never spans lines: the DSN header's `(string_quote ")` is a lone quote.
TOKEN = re.compile(r'\s+|\(|\)|"[^"\n]*"|[^\s()"]+')


def tokens(text):
    return [(m.group(0), m.start(), m.end()) for m in TOKEN.finditer(text) if not m.group(0).isspace()]


def unq(s):
    return s[1:-1] if len(s) >= 2 and s[0] == '"' and s[-1] == '"' else s


def isolate_nets(text, nets):
    """Move `nets` out of their DSN net classes into one class, trace_ignore, so `-inc trace_ignore` skips them.
    Returns (text, isolated, unknown)."""
    toks = tokens(text)
    want = set(nets)
    cut, found, template, insert_at, stack = [], [], None, None, []
    for i, (t, s, e) in enumerate(toks):
        if t == '(':
            name = toks[i + 1][0] if i + 1 < len(toks) else ''
            stack.append(name)
            if name == 'class' and len(stack) >= 2 and stack[-2] == 'network':
                j = i + 3  # (class NAME net net ... (circuit ...) (rule ...))
                while j < len(toks) and toks[j][0] not in ('(', ')'):
                    if unq(toks[j][0]) in want:
                        cut.append((toks[j][1], toks[j][2]))
                        found.append(unq(toks[j][0]))
                    j += 1
                k, d = j, 0
                while k < len(toks):
                    if toks[k][0] == '(':
                        d += 1
                    elif toks[k][0] == ')':
                        if d == 0:
                            break
                        d -= 1
                    k += 1
                if template is None and j < len(toks):
                    template = text[toks[j][1]:toks[k][1]]
        elif t == ')':
            name = stack.pop() if stack else ''
            if name == 'network':
                insert_at = s
    missing = sorted(want - set(found))
    if not found or insert_at is None:
        return text, [], missing
    out = text
    for s, e in sorted(cut, reverse=True):
        out = out[:s] + out[e:]
    pos = insert_at - sum(e - s for s, e in cut if s < insert_at)
    names = ' '.join('"%s"' % n for n in sorted(set(found)))
    cls = '  (class trace_ignore %s\n      %s)\n  ' % (names, (template or '').strip())
    return out[:pos] + cls + out[pos:], sorted(set(found)), missing


WIRE = re.compile(r'\(wire\s+\(path\s+(\S+)\s+([\d.]+)((?:\s+-?[\d.]+)+)\s*\)(.*?)\(type\s+(\w+)\)\)')
VIA = re.compile(r'\(via\s+("[^"\n]*"|\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(.*?)\(type\s+(\w+)\)\)')


def dsn_scale(text):
    """DSN units per mm (KiCad writes `(resolution um 10)` with `(unit um)`: coordinates in um)."""
    m = re.search(r'\(unit\s+(\w+)\)', text) or re.search(r'\(resolution\s+(\w+)', text)
    unit = m.group(1) if m else 'um'
    return {'um': 1000.0, 'mm': 1.0, 'mil': 1 / 0.0254, 'inch': 1 / 25.4, 'cm': 0.1}.get(unit, 1000.0)


def fix_dsn(text, locked):
    """Make sure every locked item is fixed wiring in the DSN. `locked` = {'tracks': [[layer, x1, y1, x2, y2]],
    'vias': [[x, y]]} in mm (KiCad's Y-down coordinates). Returns (text, report)."""
    k = dsn_scale(text)
    tol = 0.002 * k  # 2 um
    segs = [(t[0], t[1] * k, -t[2] * k, t[3] * k, -t[4] * k) for t in locked.get('tracks', [])]
    vias = [(v[0] * k, -v[1] * k) for v in locked.get('vias', [])]

    def seg_match(layer, pts):
        for (ly, x1, y1, x2, y2) in segs:
            if ly != layer:
                continue
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                if (abs(a[0] - x1) < tol and abs(a[1] - y1) < tol and abs(b[0] - x2) < tol and abs(b[1] - y2) < tol) or \
                   (abs(a[0] - x2) < tol and abs(a[1] - y2) < tol and abs(b[0] - x1) < tol and abs(b[1] - y1) < tol):
                    return True
        return False

    rep = {'fixed_wires': 0, 'fixed_vias': 0, 'marked_wires': 0, 'marked_vias': 0}

    def on_wire(m):
        layer, nums, kind = unq(m.group(1)), [float(x) for x in m.group(3).split()], m.group(5)
        pts = list(zip(nums[0::2], nums[1::2]))
        if seg_match(layer, pts):
            if kind in ('fix', 'protect'):
                rep['fixed_wires'] += 1
                return m.group(0)
            rep['marked_wires'] += 1
            return m.group(0)[:m.start(5) - m.start(0)] + 'fix' + m.group(0)[m.end(5) - m.start(0):]
        return m.group(0)

    def on_via(m):
        x, y, kind = float(m.group(2)), float(m.group(3)), m.group(5)
        if any(abs(x - vx) < tol and abs(y - vy) < tol for vx, vy in vias):
            if kind in ('fix', 'protect'):
                rep['fixed_vias'] += 1
                return m.group(0)
            rep['marked_vias'] += 1
            return m.group(0)[:m.start(5) - m.start(0)] + 'fix' + m.group(0)[m.end(5) - m.start(0):]
        return m.group(0)

    text = WIRE.sub(on_wire, text)
    text = VIA.sub(on_via, text)
    return text, rep


# ------------------------------------------------------------------ pcbnew side

def r4(v):
    return round(v, 4)


def locked_items(pcbnew, board):
    """Locked tracks and vias as plain lists, in mm: what must survive the round trip unchanged."""
    tracks, vias = [], []
    for t in board.GetTracks():
        if not t.IsLocked():
            continue
        if t.GetClass() == 'PCB_VIA':
            p = t.GetPosition()
            vias.append([r4(pcbnew.ToMM(p.x)), r4(pcbnew.ToMM(p.y)), board.GetLayerName(t.TopLayer()),
                         board.GetLayerName(t.BottomLayer()), t.GetNetname()])
        else:
            s, e = t.GetStart(), t.GetEnd()
            tracks.append([board.GetLayerName(t.GetLayer()), r4(pcbnew.ToMM(s.x)), r4(pcbnew.ToMM(s.y)),
                           r4(pcbnew.ToMM(e.x)), r4(pcbnew.ToMM(e.y)), t.GetNetname()])
    return {'tracks': tracks, 'vias': vias}


def missing_locked(before, after):
    key_t = lambda t: (t[0], t[5], tuple(sorted([(t[1], t[2]), (t[3], t[4])])))  # noqa: E731
    key_v = lambda v: (v[0], v[1], v[4])  # noqa: E731
    have_t = {key_t(t) for t in after['tracks']}
    have_v = {key_v(v) for v in after['vias']}
    return {'tracks': [t for t in before['tracks'] if key_t(t) not in have_t],
            'vias': [v for v in before['vias'] if key_v(v) not in have_v]}


def counts(board):
    tracks = vias = locked = 0
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            vias += 1
        else:
            tracks += 1
        locked += 1 if t.IsLocked() else 0
    board.BuildConnectivity()
    try:
        unrouted = board.GetConnectivity().GetUnconnectedCount(False)
    except TypeError:
        unrouted = board.GetConnectivity().GetUnconnectedCount()
    return {'tracks': tracks, 'vias': vias, 'locked': locked, 'unrouted': unrouted}


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--board', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--dsn', required=True)
    p.add_argument('--ses', required=True)
    p.add_argument('--report', required=True)
    p.add_argument('--jar', default=os.environ.get('TRACE_FREEROUTING_JAR', '/opt/freerouting/freerouting.jar'))
    p.add_argument('--java', default=os.environ.get('TRACE_JAVA', 'java'))
    p.add_argument('--passes', type=int, default=100)
    p.add_argument('--threads', type=int, default=0)
    p.add_argument('--max-seconds', type=int, default=3000)
    p.add_argument('--ignore-nets', default='')
    p.add_argument('--ignore-classes', default='')
    p.add_argument('--work', default='.')
    p.add_argument('--no-fill', action='store_true')
    a = p.parse_args(argv)
    report = {'ok': False, 'stage': 'start'}

    def done(ok, **kw):
        report.update(kw, ok=ok)
        with open(a.report, 'w') as f:
            json.dump(report, f)
        return 0 if ok else 3

    import pcbnew

    t0 = time.time()
    board = pcbnew.LoadBoard(a.board)
    report['kicad'] = pcbnew.Version()
    report['before'] = counts(board)
    locked_before = locked_items(pcbnew, board)
    report['stage'] = 'export'
    if not pcbnew.ExportSpecctraDSN(board, a.dsn) or not os.path.exists(a.dsn):
        return done(False, error='pcbnew could not export the Specctra DSN (is the board outline closed?)')
    with open(a.dsn) as f:
        text = f.read()
    text, fixed = fix_dsn(text, {'tracks': [t[:5] for t in locked_before['tracks']], 'vias': [v[:2] for v in locked_before['vias']]})
    fixed['locked_tracks'] = len(locked_before['tracks'])
    fixed['locked_vias'] = len(locked_before['vias'])
    report['dsn_fixed'] = fixed
    classes = [c for c in a.ignore_classes.split(',') if c]
    if a.ignore_nets:
        text, isolated, missing = isolate_nets(text, [n for n in a.ignore_nets.split(',') if n])
        report['ignored_nets'] = isolated
        report['unknown_nets'] = missing
        if isolated:
            classes.append('trace_ignore')
    with open(a.dsn, 'w') as f:
        f.write(text)
    report['export_seconds'] = round(time.time() - t0, 2)

    report['stage'] = 'route'
    if not os.path.exists(a.jar):
        return done(False, error='the Freerouting jar is not at %s (set TRACE_FREEROUTING_JAR)' % a.jar)
    user = os.path.join(a.work, 'freerouting-home')
    os.makedirs(user, exist_ok=True)
    cmd = [a.java, '-Djava.awt.headless=true', '-jar', a.jar, '-de', a.dsn, '-do', a.ses, '-mp', str(a.passes),
           '--gui.enabled=false', '-da', '--user_data_path=' + user, '--logging.file.enabled=false']
    if a.threads > 0:
        cmd += ['-mt', str(a.threads)]
    if classes:
        cmd += ['-inc', ','.join(classes)]
    report['command'] = cmd
    t1 = time.time()
    try:
        code = subprocess.run(cmd, timeout=a.max_seconds).returncode
    except subprocess.TimeoutExpired:
        return done(False, error='Freerouting did not finish within %d s (lower passes or raise max_seconds)' % a.max_seconds,
                    route_seconds=round(time.time() - t1, 2))
    except FileNotFoundError:
        return done(False, error='%s is not installed (Freerouting needs Java 25; set TRACE_JAVA)' % a.java)
    report['route_seconds'] = round(time.time() - t1, 2)
    report['freerouting_exit'] = code
    if not os.path.exists(a.ses):
        return done(False, error='Freerouting wrote no session file (exit %d)' % code)

    report['stage'] = 'import'
    if not pcbnew.ImportSpecctraSES(board, a.ses):
        return done(False, error='pcbnew could not import the Specctra session')
    lost = missing_locked(locked_before, locked_items(pcbnew, board))
    if lost['tracks'] or lost['vias']:
        return done(False, error='%d locked tracks and %d locked vias moved or vanished in the Freerouting round trip'
                    % (len(lost['tracks']), len(lost['vias'])), lost={k: v[:20] for k, v in lost.items()})
    if not a.no_fill:
        try:
            pcbnew.ZONE_FILLER(board).Fill(board.Zones())
            report['zones_filled'] = True
        except Exception as e:  # an unfilled board is still a routed board
            report['zones_filled'] = 'failed: %s' % e
    report['after'] = counts(board)
    if not pcbnew.SaveBoard(a.out, board):
        return done(False, error='pcbnew could not save the routed board')
    report['seconds'] = round(time.time() - t0, 2)
    return done(True, stage='done')


if __name__ == '__main__':
    sys.exit(main())
