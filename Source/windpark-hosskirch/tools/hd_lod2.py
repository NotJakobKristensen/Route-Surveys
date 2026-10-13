"""Official LoD2 buildings (CityGML 1.0, AdV profile; BW LGL zips, BY LDBV .gml) → roof / wall polygons in UTM32,
heights in DHHN2016 (as the DGM1)."""
import io, os, zipfile, functools
import numpy as np
from lxml import etree

NS = {'gml': 'http://www.opengis.net/gml', 'bldg': 'http://www.opengis.net/citygml/building/1.0',
      'core': 'http://www.opengis.net/citygml/1.0'}


def _rings(el):
    out = []
    for pl in el.iterfind('.//gml:posList', NS):
        v = np.array(pl.text.split(), float)
        if v.size >= 9: out.append(v.reshape(-1, 3))
    return out


def parse_gml(data, bbox=None):
    """bytes → list of buildings {id, roof: [N×3...], wall: [...], ground: [...]}; bbox (UTM32 x0,y0,x1,y1) filters"""
    root = etree.fromstring(data)
    res = []
    for b in root.iterfind('.//bldg:Building', NS):
        parts = [b] + list(b.iterfind('.//bldg:BuildingPart', NS))
        fn_ = b.find('bldg:function', NS)
        func = fn_.text if fn_ is not None else ''
        # traffic structures (AdV 53001_*: bridges, underpasses …) are in the model as buildings: not buildings here
        if func.startswith('53001'): continue
        rec = dict(id=b.get('{http://www.opengis.net/gml}id'), func=func, roof=[], wall=[], ground=[])
        for p in parts:
            for tag, key in (('RoofSurface', 'roof'), ('WallSurface', 'wall'), ('GroundSurface', 'ground'), ('ClosureSurface', 'wall')):
                for s in p.iterfind(f'bldg:boundedBy/bldg:{tag}', NS):
                    rec[key] += _rings(s)
        if not rec['roof'] and not rec['wall']: continue
        if bbox is not None:
            allp = np.concatenate(rec['roof'] + rec['wall'])
            if allp[:, 0].max() < bbox[0] or allp[:, 0].min() > bbox[2] or allp[:, 1].max() < bbox[1] or allp[:, 1].min() > bbox[3]: continue
        res.append(rec)
    return res


def bw_lod2(bbox, tdir):
    """all BW LoD2 buildings intersecting bbox (UTM32) from the downloaded 2 km zips in tdir"""
    out = []
    for e in range(int(bbox[0] // 1000) - 1, int(bbox[2] // 1000) + 1):
        for n in range(int(bbox[1] // 1000), int(bbox[3] // 1000) + 1):
            e2 = e - ((e - 1) % 2); n2 = n - (n % 2)
            fn = os.path.join(tdir, f'LoD2_32_{e2}_{n2}_2_bw.zip')
            if not os.path.exists(fn): continue
            z = zipfile.ZipFile(fn)
            for nm in z.namelist():
                if nm.endswith(f'_32_{e}_{n}_1_BW.gml'):
                    out += parse_gml(z.read(nm), bbox)
    return out
