"""Reviewed corrections of single clear-height records, in the page data, the road packs and the passage packs.

A record the review proved wrong (a height limit mapped on the wrong road, a surface-model height under a deck too narrow
for it) is corrected in the route's clear_fixes.json (route_config "clear_fixes"; in git, each with its reason):
  [{"s": 42813.6, "kind": "limit", "action": "drop", "why": "…"},
   {"s": 118794.7, "kind": "bridge", "action": "set", "set": {"est": 5.8, "unc": 0.4, "top": 6.8, "src": "…", "note": "…"}, "why": "…"}]
"drop": the record goes (a structure or sign that is not there; a limit also from the map's summary of limits); "set": the given fields replace the record's ("unset": fields to remove; a bridge left without an estimate keeps no
height in the passage pack either). It is
applied wherever the record is: the page data's clear list (data/route/route.json), the road pack holding it
(r/NNN.json "over"), the passage packs' bridges that carry its height (h/<id>.json bridges[].clr, matched by the
record's heights), and the passages' "check the clear height" measure, rebuilt from the clear list as route_bake.py
builds it. Run it after route_bake.py, route_pack.py and route_hd_pack.py:
  python route_clear_fix.py <route folder> <road pack folder (r/)> <passage pack folder (h/)>"""
import json, os, sys

CLR = ('est', 'unc', 'top')


def nm(r): return r.get('name') or ('railway' if r.get('sub') == 'rail' else (r.get('cls') or 'bridge'))


def rd(fn): return json.loads(open(fn, 'rb').read().decode('utf-8'))


def main(root, rdir, hdir):
    cfg = json.load(open(os.path.join(root, 'route_config.json')))
    F = json.load(open(os.path.join(root, cfg.get('clear_fixes') or 'clear_fixes.json')))
    H = float(cfg.get('transport_height', 4.7))
    fn = os.path.join(root, 'data', 'route', 'route.json')
    J = rd(fn); PK = json.load(open(os.path.join(rdir, 'index.json')))['pack_km'] * 1000
    match = lambda r, f: r.get('kind') == f['kind'] and abs(r['s'] - f['s']) < 0.6
    packs, hpacks, log = {}, {}, []
    for f in F:
        hits = [r for r in J['clear'] if match(r, f)]
        if len(hits) != 1: raise SystemExit(f'{f["s"]} {f["kind"]}: {len(hits)} records in the clear list')
        old = dict(hits[0])
        p = int(f['s'] // PK)
        if p not in packs: packs[p] = rd(os.path.join(rdir, f'{p:03d}.json'))
        ph = [r for r in packs[p]['over'] if match(r, f)]
        if len(ph) != 1: raise SystemExit(f'{f["s"]} {f["kind"]}: {len(ph)} records in pack {p}')
        if f['action'] == 'drop':
            J['clear'].remove(hits[0]); packs[p]['over'].remove(ph[0])
            if f['kind'] == 'limit' and (J.get('osm') or {}).get('lim'):     # (the same limit in the map's summary of limits)
                lim = [q for q in J['osm']['lim'] if abs(q['a'] - f['s']) <= 1 and q.get('h') == old.get('signed')]
                for q in lim: J['osm']['lim'].remove(q)
                log += [f'map limits: {q}' for q in lim]
        elif f['action'] == 'set':
            for r in (hits[0], ph[0]):
                r.update(f['set'])
                for k in f.get('unset', []): r.pop(k, None)
        else: raise SystemExit('unknown action ' + f['action'])
        # the passages' bridges that carry this record's height (route_hd_pack.hd_bridges copies est / unc / top)
        if f['kind'] == 'bridge' and old.get('est') is not None:
            for h in J['hot']:
                if not h['km'][0] * 1000 - 400 <= f['s'] <= h['km'][1] * 1000 + 400: continue
                hf = os.path.join(hdir, h['id'] + '.json')
                if not os.path.exists(hf): continue
                if h['id'] not in hpacks: hpacks[h['id']] = rd(hf)
                for b in hpacks[h['id']].get('bridges') or []:
                    c = b.get('clr') or {}
                    if all(c.get(k) == old.get(k) for k in CLR):
                        nc = {k: f['set'].get(k, c.get(k)) for k in CLR if k not in f.get('unset', [])}
                        b['clr'] = None if f['action'] == 'drop' or nc.get('est') is None else nc
                        log.append(f'{h["id"]} {b.get("cls")}')
    changed = []
    for h in J['hot']:
        nb_ = sum(1 for cf in h['conflicts'] if cf['kind'] == 'overpass')
        idx = [i for i, m in enumerate(h['measures']) if m.startswith('Check the clear height under')]
        if not nb_ or not idx: continue
        idx = idx[-1:]          # (the computed one: route_bake.py puts the evidence's measures before it)
        rs = [r for r in J['clear'] if h['km'][0] * 1000 - 50 <= r['s'] <= h['km'][1] * 1000 + 50 and r.get('kind') in ('bridge', 'limit')
              and (r.get('signed') is not None or r.get('est') is not None)]
        n = max(nb_, len(rs))
        hs_ = '; '.join((f"{nm(r)} {r['signed']:.2f} m signed" if r.get('signed') is not None else f"{nm(r)} ≈ {r['est']:.1f} m ±{r.get('unc', 0.5):.1f}") for r in rs)
        m = f"Check the clear height under {n} bridge{'s' if n > 1 else ''} over the route on site" + (f" (estimated: {hs_})" if hs_ else " (not measured)") + f"; transport height about {H:.1f} m."
        if h['measures'][idx[0]] != m: h['measures'][idx[0]] = m; changed.append(h['id'])
    out = [(fn, json.dumps(J, ensure_ascii=False, separators=(',', ':')))] + \
          [(os.path.join(rdir, f'{p:03d}.json'), json.dumps(P, separators=(',', ':'), ensure_ascii=False)) for p, P in packs.items()] + \
          [(os.path.join(hdir, k + '.json'), json.dumps(P, separators=(',', ':'))) for k, P in hpacks.items()]
    for f_, txt in out:
        open(f_ + '.tmp', 'wb').write(txt.encode('utf-8')); os.replace(f_ + '.tmp', f_)
    print(f'{len(F)} records corrected; road packs {sorted(packs)}; passage bridges and map limits: {", ".join(log) or "none"}; '
          f'passage measures rebuilt: {" ".join(changed) or "none"}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
