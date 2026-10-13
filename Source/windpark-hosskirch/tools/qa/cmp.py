#!/usr/bin/env python3
# Compare two fidelity runs (fid.cjs): python3 -I cmp.py fid/base_hk fid/new_hk
# Fingerprints must match exactly; screenshots: pixels that differ between base and new, outside the pixels that differ
# between the two shots of the same run (time-animated: beacons, marker pulses), must be zero.
import json, sys, os, glob
import numpy as np
from PIL import Image
a, b = sys.argv[1], sys.argv[2]
A = json.load(open(os.path.join(a, 'fid.json'))); B = json.load(open(os.path.join(b, 'fid.json')))
bad = 0
def chk(name, x, y):
    global bad
    ok = x == y
    if not ok: bad += 1
    print(('OK  ' if ok else 'DIFF') + ' ' + name + ('' if ok else f'  {json.dumps(x)[:160]}  vs  {json.dumps(y)[:160]}'))
for ra, rb in zip(A['road'], B['road']):
    k = ra['km']; chk(f'road km {k}: km', ra['km'], rb['km'])
    chk(f'road km {k}: packs', sorted(ra['packs']), sorted(rb['packs']))
    for p in sorted(set(ra['packs']) & set(rb['packs']), key=int):
        for f in ['hdr', 'A', 'bmps', 'meshes']: chk(f'road km {k}: pack {p} {f}', ra['packs'][p][f], rb['packs'][p][f])
    for f in ['live', 'scene', 'samples', 'gates', 'objects', 'survey']: chk(f'road km {k}: {f}', ra.get(f), rb.get(f))
for ha, hb in zip(A['hot'], B['hot']):
    for f in ['scene', 'data', 'poses', 'swept', 'tags', 'ntags', 'trees', 'pathLength', 'markers', 'out']: chk(f"hot {ha['id']}: {f}", ha.get(f), hb.get(f))
print('errors base', A['errs'][:3], 'new', B['errs'][:3])
print('fingerprint mismatches:', bad)
for fa in sorted(glob.glob(os.path.join(a, '*_0.png'))):
    nm = os.path.basename(fa)[:-6]
    fb = os.path.join(b, nm + '_0.png')
    if not os.path.exists(fb): print('missing', fb); continue
    shots = lambda f: [np.asarray(Image.open(q).convert('RGB')).astype(np.int16) for q in sorted(glob.glob(f.replace('_0.png', '_[0-9].png')))]
    IA, IB = shots(fa), shots(fb)
    anim = np.zeros(IA[0].shape[:2], bool)
    for S in (IA, IB):
        for x in S[1:]: anim |= np.abs(S[0] - x).max(axis=2) > 0
    I = [IA[0], None, IB[0]]
    d = np.abs(I[0] - I[2]).max(axis=2)
    out = (d > 0) & ~anim
    print(f'{nm}: animated {int(anim.sum())} px; base vs new differ {int((d > 0).sum())} px, outside the animated ones {int(out.sum())} px (max {int(d[out].max()) if out.any() else 0})')
    if out.any():
        ys, xs = np.nonzero(out); print(f'   at x {xs.min()}..{xs.max()}, y {ys.min()}..{ys.max()}')
        Image.fromarray((out * 255).astype(np.uint8)).save(os.path.join(b, nm + '_diffmask.png'))
