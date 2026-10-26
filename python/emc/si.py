"""trace emc.si: signal-integrity checks on a Touchstone file with scikit-rf.

  python3 si.py job.json      prints `TRACE_RESULT {json}` as its last line

job.json (written by src/tools/emc/si.ts):
  touchstone   path to the .sNp file
  z_target     the impedance discontinuities are judged against (ohm); tol is a fraction of it
  er_eff       for converting TDR time to distance (optional)
  tdr_ports    ports (1-based) whose reflection is turned into an impedance profile
  il           [{from, to, budget_db, f_max?}]: insertion loss -20 log10 |S(to, from)| against a budget
  xtalk        [{name, aggressor: {near, far}, victim: {near, far}, limit_db?}]: NEXT |S(v_near, a_near)|,
               FEXT |S(v_far, a_near)| (dB, worst over the band)
  max_points   cap on returned curve points

The network is read and resampled by scikit-rf (any Touchstone format and unit; renormalised to z_ref when given).
The TDR is rf.tdr: the reflection resampled to a uniform grid df..fmax, DC extrapolated, Hann-windowed, inverse-FFT
and integrated (see rf.py); its time resolution is about 1/fmax.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RESULT = 'TRACE_RESULT '


def emit(o):
    print(RESULT + json.dumps(o), flush=True)


def db(x):
    return 20 * math.log10(x) if x > 0 else -400.0


def decimate(xs, ys, n):
    if len(xs) <= n:
        return xs, ys
    step = len(xs) / n
    idx = sorted(set(int(k * step) for k in range(n)) | {len(xs) - 1})
    return [xs[i] for i in idx], [ys[i] for i in idx]


def main(job):
    import numpy as np
    import skrf
    from rf import tdr

    ntw = skrf.Network(job['touchstone'])
    if job.get('z_ref'):
        ntw.renormalize(float(job['z_ref']))
    f = ntw.f
    s = ntw.s
    nports = ntw.nports
    out = {'ok': True, 'ports': nports, 'points': len(f), 'f_min': float(f[0]), 'f_max': float(f[-1]), 'z0': float(np.real(ntw.z0[0, 0])), 'skrf': skrf.__version__}
    npts = int(job.get('max_points', 200))

    def port(p):
        if not (1 <= p <= nports):
            raise ValueError('port %d: the network has %d ports' % (p, nports))
        return p - 1

    # TDR on a uniform grid
    tdr_out = []
    if job.get('tdr_ports'):
        n = len(f)
        df = f[-1] / n
        fu = np.arange(1, n + 1) * df
        z_t = float(job['z_target'])
        tol = float(job.get('tol', 0.1))
        for p in job['tdr_ports']:
            i = port(p)
            re = np.interp(fu, f, s[:, i, i].real)
            im = np.interp(fu, f, s[:, i, i].imag)
            r = tdr(fu, re + 1j * im, float(np.real(ntw.z0[0, i])), job.get('er_eff'))
            t = r['t']
            z = r['z']
            # ignore the first rise time (the window's step) and report runs outside tolerance
            t_skip = 2 * r['rise_s']
            runs = []
            cur = None
            for k in range(len(t)):
                if t[k] < t_skip:
                    continue
                bad = abs(z[k] - z_t) > tol * z_t
                if bad and cur is None:
                    cur = {'t0': t[k], 'z_ext': z[k], 'k0': k}
                elif bad:
                    if abs(z[k] - z_t) > abs(cur['z_ext'] - z_t):
                        cur['z_ext'] = z[k]
                elif cur is not None:
                    cur['t1'] = t[k]
                    runs.append(cur)
                    cur = None
            if cur is not None:
                cur['t1'] = t[-1]
                runs.append(cur)
            disc = []
            for rr in runs[:20]:
                d = {'t0_s': rr['t0'], 't1_s': rr['t1'], 'z_ohm': rr['z_ext'], 'deviation': (rr['z_ext'] - z_t) / z_t}
                if 'd' in r:
                    d['d0_m'] = r['d'][rr['k0']]
                disc.append(d)
            tx, tz = decimate(t, z, npts)
            body = [z[k] for k in range(len(t)) if t[k] >= t_skip]
            tdr_out.append({'port': p, 'z_min': min(body) if body else None, 'z_max': max(body) if body else None, 'rise_s': r['rise_s'],
                            'discontinuities': disc, 'profile': {'t_s': tx, 'z_ohm': tz}})
    out['tdr'] = tdr_out

    il_out = []
    for c in job.get('il', []):
        a = port(c['from'])
        b = port(c['to'])
        fmax = c.get('f_max', f[-1])
        sel = f <= fmax
        il = [-db(abs(v)) for v in s[sel, b, a]]
        k = int(np.argmax(il))
        worst = {'f_hz': float(f[sel][k]), 'il_db': il[k]}
        row = {'from': c['from'], 'to': c['to'], 'worst': worst, 'f_max': float(fmax)}
        if c.get('budget_db') is not None:
            row['budget_db'] = c['budget_db']
            row['pass'] = worst['il_db'] <= c['budget_db']
            row['margin_db'] = c['budget_db'] - worst['il_db']
        fx, ix = decimate(list(map(float, f[sel])), il, npts)
        row['curve'] = {'f_hz': fx, 'il_db': ix}
        il_out.append(row)
    out['insertion_loss'] = il_out

    xt_out = []
    for c in job.get('xtalk', []):
        an = port(c['aggressor']['near'])
        vn = port(c['victim']['near'])
        row = {'name': c.get('name', '%s->%s' % (c['aggressor'], c['victim']))}
        nx = [db(abs(v)) for v in s[:, vn, an]]
        k = int(np.argmax(nx))
        row['next'] = {'worst_db': nx[k], 'f_hz': float(f[k])}
        if c['aggressor'].get('far') and c['victim'].get('far'):
            vf = port(c['victim']['far'])
            fx = [db(abs(v)) for v in s[:, vf, an]]
            k2 = int(np.argmax(fx))
            row['fext'] = {'worst_db': fx[k2], 'f_hz': float(f[k2])}
        if c.get('limit_db') is not None:
            worst = max(row['next']['worst_db'], row.get('fext', {}).get('worst_db', -400))
            row['limit_db'] = c['limit_db']
            row['pass'] = worst <= c['limit_db']
            row['margin_db'] = c['limit_db'] - worst
        xt_out.append(row)
    out['crosstalk'] = xt_out
    return out


if __name__ == '__main__':
    try:
        with open(sys.argv[1]) as fh:
            job = json.load(fh)
        emit(main(job))
    except ImportError as e:
        emit({'ok': False, 'error': 'scikit-rf/numpy not importable: %s' % e})
        sys.exit(3)
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        sys.exit(1)
