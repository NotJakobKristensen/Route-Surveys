#!/usr/bin/env python3
# Per-target summary of two bench runs (rp.cjs) and load runs: python3 -I final.py res/base_hk.json res/f_hk.json 'res/load_base_hk_*.json' 'res/load_f_hk_*.json'
import json, sys, glob, statistics as st
A, B = (json.load(open(f)) for f in sys.argv[1:3])
LA = [json.load(open(f))['load'] for f in sorted(glob.glob(sys.argv[3]))] if len(sys.argv) > 3 else []
LB = [json.load(open(f))['load'] for f in sorted(glob.glob(sys.argv[4]))] if len(sys.argv) > 4 else []
def phases(d):
    out = []
    if d.get('map'): out.append(('map', d['map']))
    for r in d.get('road', []):
        for ph in ('open', 'drive', 'fast'): out.append((f"road {ph}", r[ph]))
    for h in d.get('hot', []):
        for ph in ('open', 'drive', 'close'): out.append((f"passage {ph}", h[ph]))
    for k, u in (d.get('ui') or {}).items(): out.append(('ui', u))
    return out
def agg(d):
    P = phases(d); g = {}
    for name, x in P:
        e = g.setdefault(name, {'lt': [], 'links': 0, 'js95': [], 'jsmax': [], 'calls': 0, 'tris': 0, 'block': 0})
        e['lt'] += x.get('lt', []); e['links'] += x.get('links', 0) or 0; e['block'] += x.get('blockMs', 0) or 0
        if x.get('js') and x['js'].get('p95') is not None: e['js95'].append(x['js']['p95']); e['jsmax'].append(x['js']['max'])
        if x.get('calls') and x['calls'].get('max'): e['calls'] = max(e['calls'], x['calls']['max'])
        if x.get('tris') and x['tris'].get('max'): e['tris'] = max(e['tris'], x['tris']['max'])
    if d.get('load'): g['load (after first frame)'] = {'lt': [t[1] for t in d['load']['ltAfterFirst']], 'links': 0, 'js95': [], 'jsmax': [], 'calls': 0, 'tris': 0, 'block': 0}
    return g
ga, gb = agg(A), agg(B)
order = ['load (after first frame)', 'map', 'road open', 'road drive', 'road fast', 'passage open', 'passage drive', 'passage close', 'ui']
f = lambda v: f"{len(v)} / {max(v) if v else 0:.0f}"
print('| phase | long tasks >50 ms: count / longest ms (base) | (new) | programs linked in frames (base / new) | per-frame JS p95 worst, ms (base / new) | per-frame JS max, ms (base / new) | draw calls max (new) | triangles max (new) |')
print('|---|---|---|---|---|---|---|---|')
for k in order:
    a, b = ga.get(k), gb.get(k)
    if not a or not b: continue
    j = lambda e, key: (f"{max(e[key]):.1f}" if e[key] else '-')
    print(f"| {k} | {f(a['lt'])} | {f(b['lt'])} | {a['links']} / {b['links']} | {j(a,'js95')} / {j(b,'js95')} | {j(a,'jsmax')} / {j(b,'jsmax')} | {b['calls']} | {b['tris']/1e6:.2f} M |")
ta = sum(len(e['lt']) for e in ga.values()); tb = sum(len(e['lt']) for e in gb.values())
print(f"\nall long tasks after the first frame: base {ta}, new {tb}")
med = lambda v: st.median(v) if v else None
print('first road frame ms (per point): base', [r['openMs'] for r in A['road']], 'new', [r['openMs'] for r in B['road']])
print('passage open ms median: base', med([h['openMs'] for h in A['hot']]), 'new', med([h['openMs'] for h in B['hot']]))
if LA and LB: print('first map frame ms: base', [x['firstDraw'] for x in LA], 'median', med([x['firstDraw'] for x in LA]), '| new', [x['firstDraw'] for x in LB], 'median', med([x['firstDraw'] for x in LB]))
print('errors: base', A.get('errs', [])[:3], 'new', B.get('errs', [])[:3])
