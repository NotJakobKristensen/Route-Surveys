"""Guide posts (Z 620) by the packed edge, in the road packs.

route_signs.py stands the guide posts 0.5 m beyond the traced edge of its day; route_pack.py copies them into the packs
unchanged but takes the edges from the later, corrected trace. Where an edge was traced again, a post's packed offset
(d) no longer lies 0.5 m beyond the packed edge, and on some motorway stretches it lies on the carriageway. This sets
every guide post's d to the packed edge + 0.5 m at its s (right of the direction of travel: d = -(R + 0.5), left:
L + 0.5), the edges read as the road view reads them (tools/rpacks.mjs line().at(s): the 2 m samples of the pack and
its neighbours, linearly between). Only posts more than TOL off move, nothing else in a pack changes (the packs are
rewritten byte for byte as route_pack.py writes them).

  python route_guideposts.py <road pack folder (r/)>        (DRY=1: report only; TOL=0.05 m)
Run it after route_pack.py (a full build or SIGNS_ONLY=1)."""
import base64, glob, json, os, sys, zlib
import numpy as np

DT = {'<f4': np.float32, '<f8': np.float64, '<i2': np.int16, '|u1': np.uint8, '<u2': np.uint16, '<u4': np.uint32, '<i4': np.int32}
TOL = float(os.environ.get('TOL', '0.05'))


def samples(fn):
    """the pack's 2 m samples: s, left and right edge (m)"""
    h = json.loads(open(fn, 'rb').read().decode('utf-8'))
    raw = zlib.decompress(base64.b64decode(h['blob']), -15)
    A = {m['n']: np.frombuffer(raw, DT[m['t']], m['l'], m['o']) for m in h['arrays'] if m['n'] in ('s2', 'edge')}
    e = A['edge'].astype(np.float64).reshape(-1, 2) / 100
    return A['s2'].astype(np.float64), e[:, 0], e[:, 1]


def main(rdir):
    idx = json.load(open(os.path.join(rdir, 'index.json')))
    packs = idx['packs']; fn = lambda p: os.path.join(rdir, f'{p:03d}.json')
    cache = {}
    def smp(p):
        if p not in cache: cache[p] = samples(fn(p)) if p in packs and os.path.exists(fn(p)) else None
        return cache[p]
    moved = 0; total = 0; on_cw = 0; changed = []; worst = 0.0
    for p in packs:
        parts = [x for x in (smp(p - 1), smp(p), smp(p + 1)) if x is not None]
        S = np.concatenate([x[0] for x in parts]); L = np.concatenate([x[1] for x in parts]); R = np.concatenate([x[2] for x in parts])
        raw = open(fn(p), 'rb').read().decode('utf-8'); h = json.loads(raw)
        n = 0
        for q in h.get('signs') or []:
            s, d, dr, code = q[0], q[1], q[2], q[3]
            if str(code).split('-')[0] != '620': continue
            total += 1
            i = min(int(np.searchsorted(S, s, 'left')), len(S) - 1); a = max(0, i - 1)
            t = 0.0 if S[i] <= S[a] else min(1.0, max(0.0, (s - S[a]) / (S[i] - S[a])))
            l = L[a] + (L[i] - L[a]) * t; r = R[a] + (R[i] - R[a]) * t
            dn = round(-(r + 0.5) if dr > 0 else l + 0.5, 2)
            if -r < d < l: on_cw += 1
            if abs(dn - d) > TOL:
                worst = max(worst, abs(dn - d)); q[1] = dn; n += 1
        if n:
            moved += n; changed.append((p, n))
            if os.environ.get('DRY') != '1':
                tmp = fn(p) + '.tmp'
                open(tmp, 'wb').write(json.dumps(h, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
                os.replace(tmp, fn(p))
    print(f'guide posts {total}, on the carriageway before {on_cw}, moved {moved} (largest move {worst:.2f} m) in {len(changed)} packs'
          + (' (dry run)' if os.environ.get('DRY') == '1' else ''))
    print(' '.join(f'{p}:{n}' for p, n in changed))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'dist', 'r'))
