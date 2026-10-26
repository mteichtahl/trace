"""S-parameter helpers shared by trace's openEMS runner and emc.si (numpy only).

  write_touchstone   a Touchstone 1.1 file, RI format, Hz, one reference impedance
  tdr                the step-response impedance profile of a reflection S(f), on a uniform grid df, 2df, ... N df:
                     the DC value is extrapolated linearly from the two lowest points (real part; imaginary 0), the
                     spectrum is windowed by the falling half of a Hann window (a low-pass that sets the rise time,
                     about 1/fmax), transformed with an inverse real FFT to the impulse response, and integrated to
                     the step response rho(t); Z(t) = Z0 (1 + rho) / (1 - rho). This is the usual frequency-domain
                     TDR (as in scikit-rf's Network.step_response and VNA time-domain options); the time resolution
                     is limited by fmax and the window.
"""
import math

import numpy as np


def write_touchstone(path, f, s, z0, comment=''):
    """f: (N,), s: (N, P, P) complex."""
    f = np.asarray(f, dtype=float)
    s = np.asarray(s, dtype=complex)
    n, p, _ = s.shape
    lines = []
    for c in comment.splitlines():
        lines.append('! ' + c)
    lines.append('# Hz S RI R %g' % z0)
    for k in range(n):
        vals = []
        if p == 2:
            # 2-port files list S11 S21 S12 S22 (column order)
            order = [(0, 0), (1, 0), (0, 1), (1, 1)]
        else:
            order = [(i, j) for i in range(p) for j in range(p)]
        for (i, j) in order:
            vals.append('%.9e %.9e' % (s[k, i, j].real, s[k, i, j].imag))
        if p <= 2:
            lines.append('%.9e %s' % (f[k], ' '.join(vals)))
        else:
            # more than 2 ports: one row of the matrix per line (at most 4 pairs per line)
            row_vals = [vals[i * p:(i + 1) * p] for i in range(p)]
            first = True
            for row in row_vals:
                for c in range(0, p, 4):
                    chunk = ' '.join(row[c:c + 4])
                    lines.append(('%.9e ' % f[k] if first else '') + chunk)
                    first = False
    with open(path, 'w') as fh:
        fh.write('\n'.join(lines) + '\n')


def uniform(f):
    f = np.asarray(f, dtype=float)
    if len(f) < 4:
        return False
    df = f[1] - f[0]
    return abs(f[0] - df) < 1e-6 * df and np.allclose(np.diff(f), df, rtol=1e-6, atol=0)


def tdr(f, s11, z0, er_eff=None):
    """Step-response impedance profile. Returns dict with t (s), z (ohm), and d (m, when er_eff is given)."""
    f = np.asarray(f, dtype=float)
    s = np.asarray(s11, dtype=complex)
    if not uniform(f):
        raise ValueError('TDR needs a uniform frequency grid df, 2df, ..., N df')
    n = len(f)
    dc = s[0].real - (s[1].real - s[0].real)  # linear extrapolation of the real part to f = 0
    spec = np.concatenate([[dc + 0j], s])
    w = np.cos(0.5 * math.pi * np.arange(n + 1) / n) ** 2  # falling half of a Hann window
    imp = np.fft.irfft(spec * w, n=2 * n)
    step = np.cumsum(imp)
    dt = 1.0 / (2 * n * (f[1] - f[0]))
    t = np.arange(2 * n) * dt
    rho = np.clip(step, -0.999999, 0.999999)
    z = z0 * (1 + rho) / (1 - rho)
    keep = n  # the second half is the periodic image
    out = {'t': t[:keep].tolist(), 'z': z[:keep].tolist(), 'rise_s': 1.0 / f[-1]}
    if er_eff:
        out['d'] = (t[:keep] * 299792458.0 / (2 * math.sqrt(er_eff))).tolist()
    return out
