#!/usr/bin/env python3
# Summary of two bench runs (rp.cjs): python3 -I table.py res/base_hk.json res/new_hk.json
import json, sys
def load(p):
    try: return json.load(open(p))
    except Exception as e: return None
A, B = load(sys.argv[1]), load(sys.argv[2])
def lt_after(d):
    out = {}
    if not d: return out
    if d.get('load'): out['load (after 1st frame)'] = [t[1] for t in d['load']['ltAfterFirst']]
    if d.get('map'): out['map pan/zoom/fly'] = d['map']['lt']
    for r in d.get('road', []):
        out[f"road open km {r['km']}"] = r['open']['lt']; out[f"drive 40 km/h km {r['km']}"] = r['drive']['lt']; out[f"fast + pack crossings km {r['km']}"] = r['fast']['lt']
    for h in d.get('hot', []):
        out[f"passage {h['id']} open"] = h['open']['lt']; out[f"passage {h['id']} drive"] = h['drive']['lt']; out[f"passage {h['id']} close"] = h['close']['lt']
    for k, u in (d.get('ui') or {}).items(): out['ui ' + k] = u['lt']
    return out
la, lb = lt_after(A), lt_after(B)
print('## Long tasks (> 50 ms) per phase: count / longest (ms)   base | new')
allA = allB = 0; mA = mB = 0
for k in list(la.keys()) + [k for k in lb if k not in la]:
    a, b = la.get(k), lb.get(k)
    fa = f"{len(a)} / {max(a) if a else 0}" if a is not None else '-'; fb = f"{len(b)} / {max(b) if b else 0}" if b is not None else '-'
    if a: allA += len(a); mA = max(mA, max(a))
    if b: allB += len(b); mB = max(mB, max(b))
    print(f"{k:42s} {fa:>12s} | {fb:>12s}")
print(f"{'TOTAL':42s} {allA:>5d} / {mA:<5d} | {allB:>5d} / {mB:<5d}")
def frames(d, key):
    out = []
    if not d: return out
    for r in d.get('road', []):
        for ph in ['open', 'drive', 'fast']: x = r[ph]; out.append((f"road km {r['km']} {ph}", x))
    for h in d.get('hot', []):
        for ph in ['open', 'drive', 'close']: x = h[ph]; out.append((f"{h['id']} {ph}", x))
    if d.get('map'): out.insert(0, ('map', d['map']))
    return out
print('\n## Frames: programs linked in frames, blocking GL queries in frames (ms), per-frame JS without render p95/max, all callbacks p95/max, draw calls max, triangles max')
fa, fb = dict(frames(A, 0)), dict(frames(B, 0))
for k in list(fa.keys()) + [k for k in fb if k not in fa]:
    def f(x):
        if not x: return '-'
        return f"links {x['links']:2d} blk {x['blockMs']:6.1f} js {x['js']['p95']}/{x['js']['max']} all {x['jsAll']['p95']}/{x['jsAll']['max']} calls {x['calls']['max']} tris {x['tris']['max']}"
    print(f"{k:32s} {f(fa.get(k)):80s} | {f(fb.get(k))}")
print('\n## Loading')
for nm, d in (('base', A), ('new', B)):
    if not d: continue
    print(nm, 'first map draw', d['load']['firstDraw'], 'ms; road open (first road frame)', [r['openMs'] for r in d.get('road', [])], 'passage open', [(h['id'], h['openMs']) for h in d.get('hot', [])][:30])
