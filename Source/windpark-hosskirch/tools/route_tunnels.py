"""Tunnels and covered sections of the route (road-view ceilings, lids, clear-height records):
  intervals  every piece of the route's own segments that Overture flags is_tunnel / is_covered, placed by geometry (the
             flagged part of the whole segment matched to the route samples of that segment, never to the other
             carriageway), merged when under 5 m apart, with the OSM tunnel ways on it (route_osm.py's cache: names,
             maxheight, layer) and a kind: 'tunnel' (≥ 80 m or OSM layer < 0), 'underbridge' (a mapped bridge over the
             route stands in it: the bridge pipeline draws it) or 'overpass' (a short cover with nothing mapped on it:
             wildlife overpasses)
  records    the road through it (vprof.npz z1 every 2 m: route_vprof.py fits it straight / Hermite between the portals),
             tube walls from the edges measured outside the portals, the lid every 4 m across (terrain model, or the
             surface model where the lid is a roof the terrain model leaves out), the lid top above the road at both
             portals and a clear-height estimate (lid top − assumed slab and cover; none for mined tunnels)
Run after route_vprof.py:  python route_tunnels.py   (python route_tunnels.py list: the intervals only)
→ .cache/route/corr/tunnels.json   {date, items: [{s0, s1, kind, name, osm, len, zA, zB, prof, dl, dr, lidtop, est, unc, std,
                                    signed, phys, H, src, note, lid: {s0, step, D, rel}}]}"""
import routecfg
import glob, json, os, pickle, sys, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from route_corridor import route, OUT
from route_bridges import tf
from scipy.ndimage import median_filter
from shapely import wkb

FL = {'is_tunnel', 'is_covered'}
STD = 4.50            # clearance profile of German road tunnels (RABT; RAA: 4.50 m for existing structures) when nothing is signed
DEPTH = {'tunnel': (1.5, 0.6), 'overpass': (3.0, 0.8)}      # slab + cover of a cut-and-cover lid / deck + soil of an overpass (m, ±)
MINED = 15.0          # lid top this far above the road: a mined tunnel (no lid estimate of the clear height)
D = [-300, -200, -130, -80, -45, -35, -27, -20, -14, -9, -5, 0, 5, 9, 14, 20, 27, 35, 45, 80, 130, 200, 300]     # lid offsets (m, left +)
STEP = 4.0            # lid rows along the road
FN = OUT + 'tunnels.json'


def _flags(info):
    return [f for f in (info.get('flags') or []) if FL & set(f.get('values') or [])]


def osm_ways():
    """OSM ways tagged tunnel / covered in route_osm.py's cache (the Overpass answers along the route), in UTM33"""
    from pyproj import Transformer
    t = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
    out = {}
    for fn in sorted(glob.glob(routecfg.C + 'osm/*.json')):
        try: els = json.load(open(fn))
        except Exception: continue
        if not isinstance(els, list): continue
        for e in els:
            tg = e.get('tags') or {} if isinstance(e, dict) else {}
            if e.get('type') != 'way' or e['id'] in out or not tg.get('highway'): continue
            if tg.get('tunnel', 'no') == 'no' and tg.get('covered', 'no') == 'no': continue
            g = e.get('geometry') or []
            if len(g) < 2: continue
            x, y = t.transform([p['lon'] for p in g], [p['lat'] for p in g])
            out[e['id']] = dict(id=e['id'], tags=tg, xy=np.c_[x, y])
    return list(out.values())


def intervals(verbose=False):
    """the covered pieces of the route: [{s0, s1, len, kind, flags, seg, ref, cls, name, osm: [ids], tags: {...}}] by s0"""
    import pyarrow.parquet as pq
    import shapely
    from shapely.ops import substring
    from scipy.spatial import cKDTree
    C = routecfg.C
    Ru = pickle.load(open(C + 'route.pkl', 'rb'))
    r = route(); P = r['P']; s = r['s']; SEG = r['SEG']
    want = {info['id'] for info, _ in Ru if _flags(info)}
    full = {}
    for fn in ('net_major.parquet', 'net_factory.parquet', 'net_site.parquet'):
        if not os.path.exists(C + fn) or len(full) == len(want): continue
        t = pq.read_table(C + fn, columns=['id', 'geometry'])
        for i, g in zip(t.column('id').to_pylist(), t.column('geometry').to_pylist()):
            if i in want and i not in full: full[i] = tf(wkb.loads(g))
    pieces = {}
    for k, (info, _) in enumerate(Ru):
        if info['id'] in want: pieces.setdefault(info['id'], []).append(k)
    raw = []
    for sid, ks in pieces.items():
        info = Ru[ks[0]][0]; g = full.get(sid)
        if g is None:                                       # not in the network extracts: the route's own vertices of it
            from shapely.geometry import LineString
            from pyproj import Transformer
            tt = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
            ks_ = sorted(ks, key=lambda k: Ru[k][0]['a']); a0, b1 = Ru[ks_[0]][0]['a'], Ru[ks_[-1]][0]['b']
            co = []
            for k in ks_:
                x, y = tt.transform(*np.asarray(Ru[k][1])[:, :2].T); co += list(zip(x, y))[1 if co else 0:]
            g0 = LineString(co); Lf = g0.length / max(1e-9, b1 - a0)
            g = (g0, a0, Lf)
        # route samples of this segment's pieces and their neighbours: the flagged line is matched to these only
        cand = np.nonzero(np.isin(SEG, sorted({k + o for k in ks for o in (-1, 0, 1)})))[0]
        if not len(cand): continue
        kd = cKDTree(P[cand])
        for f in _flags(info):
            a, b = f.get('between') or [0.0, 1.0]
            if isinstance(g, tuple):                         # (line from the route's vertices, its start fraction, full length)
                g0, a0, Lf = g; p = substring(g0, max(0.0, (a - a0) * Lf), max(0.0, (b - a0) * Lf))
            else: p = substring(g, a * g.length, b * g.length)
            if p.length < 1.0: continue
            q = shapely.get_coordinates(shapely.line_interpolate_point(p, np.arange(0.0, p.length + 0.01, 1.0)))
            dd, j = kd.query(q)
            ok = dd < 6.0                                   # on the route (the route samples are a 4 m smoothed copy)
            if ok.sum() < max(2, 0.5 * len(q)): continue
            sv = s[cand[j[ok]]]
            raw.append(dict(s0=float(sv.min()), s1=float(sv.max()), flags=sorted(FL & set(f['values'])), seg=sid, ref=info.get('ref'),
                            cls=info['cls'], name=info.get('name'), glen=round(p.length, 1)))
    raw.sort(key=lambda o: o['s0'])
    out = []
    for o in raw:                                           # pieces under 5 m apart are one covered section
        if out and o['s0'] - out[-1]['s1'] < 5.0:
            q = out[-1]; q['s1'] = max(q['s1'], o['s1']); q['flags'] = sorted(set(q['flags']) | set(o['flags'])); q['glen'] += o['glen']
        else: out.append(dict(o))
    # OSM ways on each interval (within 4 m of the route line over most of their length inside it)
    W = osm_ways()
    BRG = pickle.load(open(OUT + 'bridges.pkl', 'rb')) if os.path.exists(OUT + 'bridges.pkl') else {'over': {}}
    over_s = np.array(sorted(v['s0'] for v in BRG['over'].values())) if BRG['over'] else np.zeros(0)
    from route_osm import num
    for o in out:
        i0, i1 = np.searchsorted(s, [o['s0'] - 30, o['s1'] + 30])
        kd = cKDTree(P[i0:i1]); hits = []
        for w in W:
            seg = np.diff(w['xy'], axis=0); L = np.hypot(*seg.T); n_ = np.maximum(1, np.ceil(L).astype(int))
            q = np.concatenate([w['xy'][k] + seg[k] * (np.arange(n_[k])[:, None] / n_[k]) for k in range(len(seg))] + [w['xy'][-1:]])
            dd, j = kd.query(q)
            m = dd < 4.0
            if m.mean() < 0.6: continue
            sv = s[i0 + j[m]]
            ov = min(sv.max(), o['s1']) - max(sv.min(), o['s0'])
            if ov < 0.5 * min(o['s1'] - o['s0'], sv.max() - sv.min()) or ov <= 0: continue
            hits.append((w, sv.min(), sv.max()))
        o['osm'] = [h[0]['id'] for h in hits]
        tg = {}
        for w, _, _ in sorted(hits, key=lambda h: -(h[2] - h[1])):          # the longest way first
            for k in ('tunnel:name', 'name', 'description', 'maxheight', 'maxheight:physical', 'layer', 'tunnel', 'covered', 'lanes'):
                if k in w['tags'] and k not in tg: tg[k] = w['tags'][k]
        o['tags'] = tg
        o['signed'] = num(tg.get('maxheight')); o['phys'] = num(tg.get('maxheight:physical'))
        try: layer = int(str(tg.get('layer', '0')).split(';')[0])
        except ValueError: layer = 0
        o['len'] = round(o['s1'] - o['s0'], 1)
        nover = int(((over_s >= o['s0'] - 5) & (over_s <= o['s1'] + 5)).sum())
        o['nover'] = nover
        o['kind'] = 'tunnel' if (o['len'] >= 80 or layer < 0) else 'underbridge' if nover else 'overpass'
        # (the route's own road name is not the structure's: a green bridge over the motorway is not called after it)
        o['name'] = tg.get('tunnel:name') or tg.get('description') or (tg.get('name') if o['kind'] == 'tunnel' and tg.get('name') != o.get('name') else None)
    if verbose:
        for o in out:
            print(f"{o['s0'] / 1000:9.3f}–{o['s1'] / 1000:.3f} km {o['len']:6.1f} m (flagged line {o['glen']:6.1f}) {o['kind']:11s} "
                  f"{','.join(o['flags']):21s} {str(o['ref'] or ''):18s} {str(o['name'] or ''):22s} osm {o['osm']} over {o['nover']}")
    return out


HSRC = {'PL': 'NMT / NMPT (GUGiK)', 'MV': 'DGM1 / DOM1 (LAiV M-V)', 'BB': 'DGM1 / bDOM1 (LGB)', 'ST': 'DGM1 / DOM1 (LVermGeo LSA)',
        'SN': 'DGM (GeoSN)', 'BY': 'DGM1 / DOM20 (LDBV)', 'BW': 'DGM1 (LGL)', 'TH': 'no state height model reachable'}


def _fill(a):
    """NaN cells of a lid grid from the nearest known offset in the row, then from the nearest known row"""
    a = a.copy(); D_ = np.asarray(D, float)
    for k in range(len(a)):
        ok = np.isfinite(a[k])
        if ok.any() and not ok.all(): a[k, ~ok] = np.interp(D_[~ok], D_[ok], a[k, ok])
    rows = np.isfinite(a).all(1)
    if rows.any() and not rows.all():
        idx = np.nonzero(rows)[0]
        for k in np.nonzero(~rows)[0]: a[k] = a[idx[np.argmin(np.abs(idx - k))]]
    return a


def main():
    import route_vprof as vp
    t0 = time.time()
    r = route(); P = r['P']; s = r['s']; N = r['N']
    if not os.path.exists(OUT + 'vprof.npz'): sys.exit('route_tunnels: run route_vprof.py first (the road through the tunnels)')
    V = np.load(OUT + 'vprof.npz'); z1 = V['z1'].astype(float)
    S1 = np.load(OUT + 'survey_1m.npz')
    LL = np.load(OUT + 'lanelines.npz') if os.path.exists(OUT + 'lanelines.npz') else None      # (the painted edge lines)
    REG = pickle.load(open(OUT + 'regions.pkl', 'rb'))['lab']
    code_at = lambda sv: vp.CODE.get(REG[min(len(REG) - 1, int(sv // 500))], '')
    zat = lambda sv: np.interp(sv, s, z1)
    D_ = np.asarray(D, float); bw = None; items = []
    for o in intervals():
        s0, s1, kind = o['s0'], o['s1'], o['kind']; code = code_at((s0 + s1) / 2)
        sp = np.arange(s0, s1, 2.0); sp = np.r_[sp, s1]
        # tube walls: the edges measured outside both portals (inside, the photo shows the lid) + 1 m walkway
        a0, a1, b0, b1 = np.searchsorted(s, [s0 - 45, s0 - 5, s1 + 5, s1 + 45])
        ii = np.r_[np.arange(a0, a1), np.arange(b0, b1)]; iout = ii
        Lm = np.nanmedian(S1['L'][ii].astype(float)) if len(ii) else np.nan; Rm = np.nanmedian(S1['R'][ii].astype(float)) if len(ii) else np.nan
        wmax = 9.5 if o['cls'] in ('motorway', 'trunk') else 7.0           # the photo's edge often runs out to the verge / band
        dl = float(np.clip(np.nan_to_num(Lm, nan=r['HW'][a1]) + 1.0, 4.0, wmax)); dr = -float(np.clip(np.nan_to_num(Rm, nan=r['HW'][a1]) + 1.0, 4.0, wmax))
        dr_meas = dr
        if kind == 'tunnel' and LL is not None and len(ii):
            # a tunnel's tube: 1.25 m beyond the painted edge lines outside the portals (the traced edges there often take in
            # the verge or the other carriageway); the left wall short of the median axis (the centre wall of twin tubes). The
            # right wall of a covered section whose lid reaches farther (a hard shoulder under the roof) is set below
            eLo = np.nanmedian(LL['eL'][ii].astype(float)); eRo = np.nanmedian(LL['eR'][ii].astype(float)); axo = np.nanmedian(LL['ax'][ii].astype(float)) if np.isfinite(LL['ax'][ii].astype(float)).any() else np.nan
            if np.isfinite(eLo) and eLo > 0: dl = float(np.clip(min(eLo + 1.25, axo - 0.3 if np.isfinite(axo) else 99), 3.0, dl))
            if np.isfinite(eRo) and eRo < 0: dr = -float(np.clip(-eRo + 1.25, 3.0, -dr))
        rec = dict(s0=round(s0, 1), s1=round(s1, 1), kind=kind, name=o['name'], osm=o['osm'], len=o['len'], zA=round(float(zat(s0)), 2),
                   zB=round(float(zat(s1)), 2), prof=[[round(float(a), 1), round(float(zat(a)), 2)] for a in sp], dl=round(dl, 2), dr=round(dr, 2),
                   lidtop=None, est=None, unc=None, std=STD, signed=o['signed'], phys=o['phys'], H=None, src=None, note=None, lid=None)
        if kind == 'underbridge':
            rec.update(src='bridge records (route_bridges.py)', note='under a mapped bridge over the route: drawn and measured by the bridge pipeline')
        else:
            # the lid every 4 m across: the terrain model (a soil lid is ground in it), or the surface model over the tube where
            # the terrain model leaves the roof out (it stays at road level there: a PV roof, a hall)
            sv = np.arange(s0 - 12, s1 + 12.01, STEP); ii = np.clip(np.searchsorted(s, sv), 0, len(s) - 1)
            X = P[ii, 0][:, None] + N[ii, 0][:, None] * D_[None]; Y = P[ii, 1][:, None] + N[ii, 1][:, None] * D_[None]
            road = zat(sv)[:, None]
            Tg = np.full(X.shape, np.nan); Sf = np.full(X.shape, np.nan)
            if code in vp.GRID:                              # fetched within 45 m, the wide band from cached tiles
                nr = np.abs(D_) <= 45
                Tg[:, nr] = vp.heights(code, 'dgm', X[:, nr], Y[:, nr]); Tg[:, ~nr] = vp.heights(code, 'dgm', X[:, ~nr], Y[:, ~nr], fetch=False)
                tube = np.abs(D_) <= 20
                try: Sf[:, tube] = vp.heights(code, 'dom', X[:, tube], Y[:, tube])
                except Exception as ex: print('  surface model', code, repr(ex)[:100])
            elif code == 'BW':
                bw = bw or vp.BWCells(); Tg = bw.get(X, Y)[0].astype(float)
            # (the roof rule over the whole ±20 m band: a roof spans both carriageways, the terrain model beside a tube inside a
            # tunnel interval is the cutting or the other tube, not open ground with trees)
            inside = ((sv >= s0) & (sv <= s1))[:, None]; over = (np.abs(D_) <= 20)[None]
            rt = Tg - road; rs = median_filter(np.nan_to_num(Sf - road, nan=-99.0), size=(3, 1), mode='nearest')     # no lone tree / pole
            rs[rs < -90] = np.nan
            lid = np.where(inside & over & ~(rt > 3) & (rs > 3), rs, rt)
            known = np.isfinite(lid).mean()
            if known == 0:                                   # no height model: a flat lid at the standard height + slab
                lid = np.where(inside & over, STD + DEPTH.get(kind, DEPTH['tunnel'])[0], 0.0)
            lid = _fill(lid)
            # a cover over both carriageways (a wildlife overpass, a covered section over a motorway): its left wall beyond
            # the opposite carriageway — its outer edge (lanelines oout outside the portals) + 1.5 m, or as far as the cover
            # stands 3 m over the road — where the cover reaches over it (no height model: assumed); not for a mined tunnel's
            # bores (each has its own tube)
            ins = ((sv >= s0 + 2) & (sv <= s1 - 2)) if s1 - s0 > 8 else inside[:, 0]
            cwp = (D_ >= dr) & (D_ <= dl)
            mined_pre = kind == 'tunnel' and known > 0 and ins.any() and float(np.median(lid[ins][:, cwp])) > MINED
            dl_own = dl                                      # (the lid top and the clear height: over our carriageway only)
            if not mined_pre and ins.any():
                med = np.median(lid[ins], 0); ext = dl
                for jj in np.flatnonzero(D_ > dl):
                    if med[jj] >= 3.0: ext = float(D_[jj])
                    else: break
                oo = float(np.nanmedian(LL['oout'][iout].astype(float))) if LL is not None and len(iout) and np.isfinite(LL['oout'][iout].astype(float)).mean() > 0.3 else np.nan
                if np.isfinite(oo) and oo > dl:
                    jo = int(np.argmin(np.abs(D_ - oo)))
                    if known == 0 or med[jo] >= 3.0 or ext >= oo - 3: dl = float(min(45.0, oo + 1.5))
                elif kind == 'overpass' and known > 0 and ext > dl + 1.5: dl = float(min(45.0, ext))
                rec['dl'] = round(dl, 2)
            # the rows within 6 m inside a portal were sampled at its face or on the road before it: over the tube (walls ± 0.5
            # m) not lower than the first row fully inside (the drawn lid; the lid top and the estimate stay on the rows as
            # sampled)
            lid0 = lid.copy(); tub = (D_ >= dr - 0.5) & (D_ <= dl + 0.5)
            for side in (0, 1):
                near = np.flatnonzero((sv >= s0) & (sv <= s0 + 6)) if side == 0 else np.flatnonzero((sv >= s1 - 6) & (sv <= s1))
                ins = np.flatnonzero((sv > s0 + 6) & (sv < s1 - 6))
                if len(near) and len(ins):
                    ref = lid[ins[0] if side == 0 else ins[-1]]
                    lid[np.ix_(near, np.flatnonzero(tub))] = np.maximum(lid[np.ix_(near, np.flatnonzero(tub))], ref[tub][None])
            # lid top above the road at each portal: over the carriageway, 4–16 m inside (the very edge is smeared in the grid)
            cw = (D_ >= dr) & (D_ <= dl_own)
            top = []
            for lo_, hi_ in ((s0 + 4, s0 + 16), (s1 - 16, s1 - 4)):
                m = (sv >= min(lo_, (s0 + s1) / 2)) & (sv <= max(hi_, (s0 + s1) / 2)) if s1 - s0 < 24 else (sv >= lo_) & (sv <= hi_)
                top.append(round(float(np.median(lid0[m][:, cw])), 2) if m.any() and known > 0 else None)
            mid = lid0[(sv >= s0 + 4) & (sv <= s1 - 4)][:, cw] if s1 - s0 > 8 else lid0[inside[:, 0]][:, cw]
            mined = kind == 'tunnel' and known > 0 and len(mid) and float(np.median(mid)) > MINED
            if kind == 'tunnel' and not mined and dr > dr_meas + 0.5:
                # a covered section whose roof reaches beyond the painted lines' wall (a hard shoulder under it): its wall
                # where the edges outside the portals put it
                cs = np.flatnonzero((D_ < dr) & (D_ >= dr_meas - 0.5)); rin = (sv > s0 + 8) & (sv < s1 - 8)
                if len(cs) and rin.any() and (np.median(lid0[rin][:, cs], 0) >= STD).all(): dr = dr_meas; rec['dr'] = round(dr, 2)
            dep, unc = DEPTH['overpass' if kind == 'overpass' else 'tunnel']
            if known > 0 and not mined and all(t is not None for t in top):
                rec['est'] = round(min(top) - dep, 2); rec['unc'] = unc
            rec['lidtop'] = top
            rec['lid'] = dict(s0=round(float(sv[0]), 1), step=STEP, D=D, rel=np.round(lid * 100).astype(int).tolist())
            hs = HSRC.get(code, '?')
            pz = np.array(rec['prof'])[:, 1]; ch = pz[0] + (pz[-1] - pz[0]) * (sp - s0) / max(1.0, s1 - s0)
            model = hs.split(' / ')[0].split(' (')[0] + (' ' + hs[hs.rfind('('):] if '(' in hs else '')
            rec['src'] = (f'road: route_vprof.py fit of {model} across the carriageway, '
                          + ('straight between the portals' if np.abs(pz - ch).max() < 0.15 else 'Hermite between the portal grades')
                          + f'; lid: {hs}')
            if known == 0:
                rec['note'] = 'no height model here: lid drawn at the standard clear height, clear height not measured'
            elif mined:
                rec['note'] = (f'mined tunnel under up to {np.max(mid):.0f} m of ground: the lid gives no clear height; standard clearance '
                               f'profile {STD:.2f} m (RABT) until the registered clear height (Autobahn GmbH, SIB-Bauwerke) is checked')
            elif kind == 'tunnel':
                rec['note'] = (f'covered section (cut and cover): clear height = lid top above the road − {dep} m slab and cover '
                               f'(±{unc} m); registered clear height (Autobahn GmbH, SIB-Bauwerke) needed')
            else:
                rec['note'] = (f'wildlife overpass / cover: clear height = top of the cover above the road − {dep} m deck and soil '
                               f'(±{unc} m); no structure mapped over the road')
        rec['H'] = next(v for v in (rec['signed'], rec['phys'], rec['est'], STD) if v is not None)
        items.append(rec)
        print(f"{kind:11s} {s0 / 1000:8.3f}–{s1 / 1000:.3f} km {o['len']:6.1f} m {str(o['name'] or ''):22s} {code:3s} road {rec['zA']:7.2f} → {rec['zB']:7.2f} "
              f"(inside max {max(p[1] for p in rec['prof']):7.2f}) walls {rec['dr']:+.1f}/{rec['dl']:+.1f} lid top {rec['lidtop']} est {rec['est']} ±{rec['unc']} "
              f"H {rec['H']} osm {o['osm']}", flush=True)
    json.dump(dict(date=time.strftime('%Y-%m-%d'), items=items), open(FN + '.part', 'w'), ensure_ascii=False, separators=(',', ':'))
    os.replace(FN + '.part', FN)                                # (readers never see half a file)
    print(f'→ {FN} ({len(items)} items, {os.path.getsize(FN) / 1000:.0f} kB) in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    if sys.argv[1:2] == ['list']: intervals(verbose=True)
    else: main()
