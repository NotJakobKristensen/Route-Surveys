"""Trees from the surface model over the whole survey-point area (route_hotspots.py searched 320 m either side of the
route only): python hd_trees_all.py [ids…], then route_hd_pack.py rebuilds the packs."""
import routecfg
import os, sys, pickle, time
import numpy as np
import hd_hot
C = routecfg.C + 'hot/'
ids = sys.argv[1:] or [f[:-4] for f in sorted(os.listdir(C)) if f.endswith('.pkl') and not f.endswith('_src.pkl')]
for hid in ids:
    fn = C + hid + '.pkl'; d = pickle.load(open(fn, 'rb'))
    hd = d.get('hd')
    if not hd or hd_hot.region(hid) not in hd_hot.HD_SET: print(hid, 'no HD data'); continue
    t0 = time.time()
    lod = hd.get('lod2') or []
    polys = [b['poly'] for b in lod] if lod else [b['poly'] for b in d['bld']]
    P = np.asarray(d['P'])[:, :2]
    old = 0 if hd.get('trees') is None else len(hd['trees'])
    T = hd_hot.ndom_trees(hid, d['proj'], d['ext'], P, within=5000.0, buildings=polys)
    if T is None: print(hid, 'no surface model'); continue
    hd['trees'] = T; d['hd'] = hd
    pickle.dump(d, open(fn, 'wb'))
    print(hid, old, '->', len(T), f'{time.time() - t0:.0f} s', flush=True)
