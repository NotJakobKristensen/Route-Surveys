"""Street-level photos for each passage from the Panoramax sweep (route_panoramax.py): up to four pictures spread along
the passage, looking in our direction of travel where there are such, the newest first among neighbours; each one
referenced by id (the page loads the thumbnails from the Panoramax instance in the viewer's browser and links each one
to the Panoramax viewer); the passage's file is loaded only when the passage is shown.
→ dist/h/pix_<passage id>.json  {lic, by, hosts, pics: [{id, s, t, fwd, h (host index)}]}
→ dist/r/NNN.json  pix: [[s, id, date, fwd, host]], pixh: hosts — one picture per 100 m, for the road view (after route_pack.py)
→ .cache/route/corr/pix_index.json  {passage id: number of photos}  (read by route_bake.py)
Usage: python route_pix.py          python route_pix.py packs   (only the road packs' pictures: nothing fetched, run after
route_pack.py when the passages' and bridges' photo files stand)"""
import routecfg
import base64, io, json, os, pickle, time, urllib.request
from PIL import Image
from route_corridor import OUT
from route_hotspots import HOT

N_MAX = 4
W = 560                    # px, embedded photos (passages, bridges): shown in the card at 200–280 px, sharp on high-DPI


def fetch(url):
    for a in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'route-survey'}), timeout=90).read()
        except Exception: time.sleep(3 * (a + 1))
    return None


def embed(p):
    """the picture as a small JPEG data URI (a 360° panorama: the quarter ahead of the camera), or None"""
    raw = fetch(p.get('sd') or p.get('thumb'))
    if not raw: return None
    try: im = Image.open(io.BytesIO(raw)).convert('RGB')
    except Exception: return None
    if p.get('pano') or im.width >= 2 * im.height:
        cx, q = im.width // 2, im.width // 4; im = im.crop((cx - q // 2, int(im.height * 0.25), cx + q // 2, int(im.height * 0.75)))
    im.thumbnail((W, W), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=70, optimize=True, progressive=True)
    return dict(iw=im.width, ih=im.height, img='data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode())
HOSTS = ['panoramax.openstreetmap.fr', 'panoramax.ign.fr']
def host(p):
    h = (p.get('thumb') or '').split('/')[2] if p.get('thumb') else ''
    if h not in HOSTS: HOSTS.append(h)
    return HOSTS.index(h)


def main(packs_only=False):
    pics = json.load(open(OUT + 'panoramax.json'))['pics']
    if packs_only: return road_packs(pics)
    os.makedirs(routecfg.DIST + 'h', exist_ok=True)
    index = {}
    for h in HOT:
        hid = h[0]
        sm = pickle.load(open(routecfg.C + 'hot/' + hid + '.pkl', 'rb'))['summary']
        a, b = sm['km'][0] * 1000 - 100, sm['km'][1] * 1000 + 100
        cand = [p for p in pics if a <= p['s'] <= b and (p.get('sd') or p.get('thumb'))]
        fn = routecfg.DIST + 'h/pix_' + hid + '.json'
        if not cand:
            if os.path.exists(fn): os.remove(fn)
            continue
        # forward-looking first, then the newest; spread along the passage (at least a fifth of it apart)
        cand.sort(key=lambda p: (p.get('fwd') is not True, -(int(p['t'][:4] or 0) if p.get('t') else 0)))
        gap = max(40.0, (b - a) / 5); pick = []
        for p in cand:
            if all(abs(p['s'] - q['s']) >= gap for q in pick): pick.append(p)
            if len(pick) >= N_MAX: break
        out = []
        for p in sorted(pick, key=lambda p: p['s']):
            e = embed(p)
            out.append(dict(id=p['id'], s=p['s'], t=p['t'], fwd=p.get('fwd'), h=host(p), **(e or {})))
        if not out: continue
        lic = sorted({p.get('lic') for p in pick if p.get('lic')}); by = sorted({p.get('by') for p in pick if p.get('by')})
        json.dump(dict(lic=', '.join(lic) or None, by=', '.join(by) or None, hosts=HOSTS, pics=out), open(fn, 'w'), separators=(',', ':'))
        index[hid] = len(out)
        print(f'  {hid:34s} {len(out)} photos  {os.path.getsize(fn) // 1024} KB', flush=True)
    json.dump(index, open(OUT + 'pix_index.json', 'w'))
    # the critical structures over the route (route.json's clear list: a check, too low, or under 5.3 m): the picture
    # taken 25–250 m before each, looking at it → dist/h/pix_bridges.json {round(s): {id, s, t, h (host), iw, ih, img}}
    hdr = json.load(open(routecfg.DATA + 'route.json'))
    need = 4.8
    crit = [o for o in hdr.get('clear', []) if o.get('check') or (o.get('signed') if o.get('signed') is not None else o.get('est', 99)) < need + 0.5]
    fwd = sorted([p for p in pics if p.get('fwd')], key=lambda p: p['s'])
    import bisect
    ss = [p['s'] for p in fwd]; br = {}
    for o in crit:
        i0, i1 = bisect.bisect_left(ss, o['s'] - 250), bisect.bisect_left(ss, o['s'] - 25)
        cand = sorted(fwd[i0:i1], key=lambda p: (abs((o['s'] - p['s']) - 70), -(int(p['t'][:4]) if p.get('t') else 0)))
        if not cand or str(round(o['s'])) in br: continue
        p = cand[0]; e = embed(p)
        if e: br[str(round(o['s']))] = dict(id=p['id'], s=p['s'], t=p['t'], h=host(p), **e)
    json.dump(dict(hosts=HOSTS, pics=br), open(routecfg.DIST + 'h/pix_bridges.json', 'w'), separators=(',', ':'))
    print(len(br), 'of', len(crit), 'critical structures with a photo looking at them →', os.path.getsize(routecfg.DIST + 'h/pix_bridges.json') // 1024, 'KB')
    road_packs(pics)


def road_packs(pics):
    """the whole route for the road view: one picture per 100 m (looking our way where possible), into each road pack
    (dist/r/NNN.json, key pix: [[s, id, date, fwd, host]], pixh: hosts), loaded with the pack: run after route_pack.py"""
    import glob
    best = {}
    rank = lambda x: (x.get('fwd') is True, x.get('t') or '')
    for p in pics:
        k = int(p['s'] // 100); q = best.get(k)
        if q is None or rank(p) > rank(q): best[k] = p
    rows = [[round(p['s']), p['id'], p['t'], 1 if p.get('fwd') else 0 if p.get('fwd') is False else None, host(p)] for _, p in sorted(best.items())]
    n = 0
    for fn in sorted(glob.glob(routecfg.DIST + 'r/[0-9]*.json')):
        P = json.load(open(fn))
        P['pix'] = [r_ for r_ in rows if P['s0'] <= r_[0] < P['s1']]; P['pixh'] = HOSTS
        json.dump(P, open(fn, 'w'), separators=(',', ':'), ensure_ascii=False); n += len(P['pix'])
    print(n, 'route pictures (one per 100 m) written into the road packs')

if __name__ == '__main__':
    import sys
    main(packs_only=sys.argv[1:2] == ['packs'])
