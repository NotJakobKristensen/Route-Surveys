#!/usr/bin/env python3
"""Fetch Polish official open geodata (GUGiK / geoportal.gov.pl) for a small box.

    fetch_pl(product, lon, lat, half_x_m, half_y_m, outdir, **kw) -> dict

The box is axis-aligned in EPSG:2180 (PUWG 1992, the native CRS of all GUGiK
rasters), centred on the WGS84 point; every output is a GeoTIFF in EPSG:2180.

products
  "orto"      True-colour orthophoto at native best resolution (default 0.05 m).
              Source: WMS PZGIK/ORTO/WMS/HighResolution (layer "Raster", the finest
              sheets <=10 cm, newest on top within a resolution).  Pixels outside the
              high-res sheet footprints (from the WFS index) are filled from
              WMS PZGIK/ORTO/WMS/StandardResolutionTime (layer "Raster", newest
              25 cm sheet), upsampled.  JPEG-compressed tiled BigTIFF + overviews.
  "orto_std"  Newest standard orthophoto only (25 cm), from StandardResolutionTime.
  "nmt"       Terrain model 1 m, heights PL-EVRF2007-NH, float32.  Native grid from the
              opendata.geoportal.gov.pl ARC/INFO ASCII sheets (index: WMS
              PZGIK/NMT/WMS/SkorowidzeUkladEVRF2007), lidar preferred, newest first.
  "nmpt"      Surface model 0.5 m (same scheme, PZGIK/NMPT/WMS/SkorowidzeUkladEVRF2007).
  "nmt_wcs"   Terrain 1 m via WCS 2.0.1 PZGIK/NMT/GRID1/WCS/DigitalTerrainModel,
              coverage DTM_PL-EVRF2007-NH (ASCII grid, resampled to an integer grid
              by the server; quick fallback, no tile downloads).

Attribution: "Źródło: Geoportal.gov.pl / GUGiK (Główny Urząd Geodezji i Kartografii)".
Requires: numpy, rasterio, pyproj, Pillow, requests (honours HTTPS_PROXY / CA bundle).
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import json
import math
import os
import re
import sys
import time

import numpy as np
import rasterio
import requests
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.windows import Window
from rasterio.warp import reproject

Image.MAX_IMAGE_PIXELS = None
WSS = "https://mapy.geoportal.gov.pl/wss/service/PZGIK"
ORTO_HR = f"{WSS}/ORTO/WMS/HighResolution"
ORTO_SR = f"{WSS}/ORTO/WMS/StandardResolutionTime"
ORTO_WFS = f"{WSS}/ORTO/WFS/Skorowidze"
NMT_IDX = f"{WSS}/NMT/WMS/SkorowidzeUkladEVRF2007"
NMPT_IDX = f"{WSS}/NMPT/WMS/SkorowidzeUkladEVRF2007"
NMT_WCS = f"{WSS}/NMT/GRID1/WCS/DigitalTerrainModel"
ATTRIBUTION = "Źródło: Geoportal.gov.pl / GUGiK (Główny Urząd Geodezji i Kartografii)"
CRS = "EPSG:2180"
WMS_MAX = 4096

_S = requests.Session()
_S.headers["User-Agent"] = "pl_fetch/1.0 (research; contact via repo)"


def _get(url, params=None, timeout=180, tries=5, expect=None):
    last = None
    for i in range(tries):
        try:
            r = _S.get(url, params=params, timeout=timeout)
            if r.status_code == 200 and (expect is None or r.headers.get("content-type", "").startswith(expect)):
                return r
            last = f"HTTP {r.status_code} {r.headers.get('content-type')} {r.text[:200]!r}"
        except requests.RequestException as e:  # connection reset, timeout ...
            last = repr(e)
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url} {params} -> {last}")


def _box2180(lon, lat, hx, hy, res):
    cx, cy = Transformer.from_crs(4326, 2180, always_xy=True).transform(lon, lat)
    e = 1e-6  # guard against float noise, e.g. 220500/0.05 = 4409999.9999
    x0 = math.floor((cx - hx) / res + e) * res
    y1 = math.ceil((cy + hy) / res - e) * res
    x1 = math.ceil((cx + hx) / res - e) * res
    y0 = math.floor((cy - hy) / res + e) * res
    return tuple(round(v, 6) for v in (x0, y0, x1, y1))


def _wms_getmap(url, layer, x0, y0, x1, y1, w, h, fmt="image/jpeg", extra=None):
    # WMS 1.3.0 + EPSG:2180 -> axis order northing,easting
    p = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS=layer, STYLES="",
             CRS=CRS, BBOX=f"{y0},{x0},{y1},{x1}", WIDTH=w, HEIGHT=h, FORMAT=fmt)
    if extra:
        p.update(extra)
    r = _get(url, p, expect="image/")
    return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")), len(r.content)


# ----------------------------------------------------------------- ortho index (WFS)
def orto_sheets(x0, y0, x1, y1, years=range(2026, 2009, -1)):
    """Return list of index records (godlo, year, pixel, colour, date, url, polygon)."""
    out = []
    for y in years:
        p = dict(SERVICE="WFS", VERSION="2.0.0", REQUEST="GetFeature",
                 TYPENAMES=f"gugik:SkorowidzOrtofomapy{y}", SRSNAME=CRS,
                 BBOX=f"{y0},{x0},{y1},{x1},urn:ogc:def:crs:EPSG::2180")
        try:
            s = _get(ORTO_WFS, p, timeout=120).text
        except RuntimeError as e:
            print("  WFS index", y, "failed:", e, file=sys.stderr)
            continue
        for f in re.findall(r"<gugik:SkorowidzOrtofomapy\d+ .*?</gugik:SkorowidzOrtofomapy\d+>", s, re.S):
            g = lambda k: (re.search(rf"<gugik:{k}[^>]*>(?:<gml:timePosition>)?([^<]*)", f) or [None, ""])[1]
            pos = list(map(float, re.search(r"<gml:posList[^>]*>([^<]*)", f)[1].split()))
            ring = [(pos[i + 1], pos[i]) for i in range(0, len(pos), 2)]  # (N,E) -> (E,N)
            out.append(dict(godlo=g("godlo"), year=int(g("akt_rok") or y), pixel_m=float(g("piksel") or 0),
                            colour=g("kolor"), date=g("akt_data"), url=g("url_do_pobrania"),
                            size_mb=g("wlk_pliku_mb"), ring=ring))
    return out


# ----------------------------------------------------------------- orthophoto
def _fetch_orto(x0, y0, x1, y1, res, outdir, name, hr=True, workers=4, quality=90):
    W, H = round((x1 - x0) / res), round((y1 - y0) / res)
    tf = from_origin(x0, y1, res, res)
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{name}.tif")
    print(f"[orto] box E {x0:.2f}..{x1:.2f} N {y0:.2f}..{y1:.2f} -> {W}x{H} px @ {res} m")

    sheets = orto_sheets(x0, y0, x1, y1)
    rgb = [s for s in sheets if s["colour"] == "RGB"]
    hr_sheets = [s for s in rgb if 0 < s["pixel_m"] <= 0.10]
    sr_sheets = [s for s in rgb if s["pixel_m"] > 0.10]
    meta = dict(product=name, crs=CRS, pixel_m=res, width=W, height=H,
                bounds_2180=[x0, y0, x1, y1], attribution=ATTRIBUTION,
                services=dict(high=ORTO_HR + " layer=Raster", standard=ORTO_SR + " layer=Raster (TIME default=newest)"),
                sheets=[{k: v for k, v in s.items() if k != "ring"} for s in rgb])

    # standard-resolution (25 cm, newest) base for the whole box
    sr_res = 0.25
    sr_W, sr_H = math.ceil((x1 - x0) / sr_res), math.ceil((y1 - y0) / sr_res)
    sr = np.zeros((sr_H, sr_W, 3), np.uint8)
    nbytes = 0
    for r0 in range(0, sr_H, WMS_MAX):
        for c0 in range(0, sr_W, WMS_MAX):
            w, h = min(WMS_MAX, sr_W - c0), min(WMS_MAX, sr_H - r0)
            a, n = _wms_getmap(ORTO_SR, "Raster", x0 + c0 * sr_res, y1 - (r0 + h) * sr_res,
                               x0 + (c0 + w) * sr_res, y1 - r0 * sr_res, w, h)
            sr[r0:r0 + h, c0:c0 + w] = a
            nbytes += n
    print(f"[orto] standard-res base {sr_W}x{sr_H} px fetched ({nbytes/1e6:.1f} MB)")
    if not hr or res >= sr_res - 1e-9:
        if abs(res - sr_res) > 1e-9:
            raise ValueError("orto_std is served at 0.25 m")
        profile = dict(driver="GTiff", width=sr_W, height=sr_H, count=3, dtype="uint8", crs=CRS,
                       transform=from_origin(x0, y1, sr_res, sr_res), tiled=True, blockxsize=512,
                       blockysize=512, compress="JPEG", jpeg_quality=quality, photometric="YCBCR")
        with rasterio.open(path, "w", **profile) as ds:
            ds.write(sr.transpose(2, 0, 1))
            ds.build_overviews([2, 4, 8, 16], Resampling.average)
            ds.update_tags(ATTRIBUTION=ATTRIBUTION, SOURCE=ORTO_SR)
        meta.update(width=sr_W, height=sr_H, pixel_m=sr_res, download_mb=round(nbytes / 1e6, 1),
                    newest_standard_date=max((s["date"] for s in sr_sheets), default=None))
        meta.pop("sheets")
        meta["sheets"] = [{k: v for k, v in s.items() if k != "ring"} for s in sr_sheets]
        json.dump(meta, open(path[:-4] + ".json", "w"), indent=1, ensure_ascii=False)
        return dict(path=path, **{k: meta[k] for k in ("width", "height", "pixel_m", "crs")})

    profile = dict(driver="GTiff", width=W, height=H, count=3, dtype="uint8", crs=CRS, transform=tf,
                   tiled=True, blockxsize=512, blockysize=512, compress="JPEG", jpeg_quality=quality,
                   photometric="YCBCR", BIGTIFF="YES")
    tiles = [(r0, c0, min(WMS_MAX, H - r0), min(WMS_MAX, W - c0))
             for r0 in range(0, H, WMS_MAX) for c0 in range(0, W, WMS_MAX)]
    hr_bytes = [0]
    # Footprint of the high-res layer: the WMS answers blank (transparent / white) where it
    # has no data, and the WFS index lists old sheets the layer does not show, so ask the
    # WMS itself: a transparent PNG at 1 m gives the alpha footprint.
    cres = 1.0
    fW, fH = math.ceil((x1 - x0) / cres), math.ceil((y1 - y0) / cres)
    foot = np.zeros((fH, fW), np.uint8)
    for r0 in range(0, fH, WMS_MAX):
        for c0 in range(0, fW, WMS_MAX):
            w, h = min(WMS_MAX, fW - c0), min(WMS_MAX, fH - r0)
            p = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS="Raster", STYLES="", CRS=CRS,
                     BBOX=f"{y1 - (r0 + h) * cres},{x0 + c0 * cres},{y1 - r0 * cres},{x0 + (c0 + w) * cres}",
                     WIDTH=w, HEIGHT=h, FORMAT="image/png", TRANSPARENT="TRUE")
            im = Image.open(io.BytesIO(_get(ORTO_HR, p, expect="image/").content)).convert("RGBA")
            foot[r0:r0 + h, c0:c0 + w] = np.asarray(im)[..., 3] > 0
    from scipy.ndimage import binary_dilation, binary_erosion  # noqa: E402
    core = binary_erosion(foot, iterations=1, border_value=1)   # surely high-res
    halo = binary_dilation(foot, iterations=1)                  # maybe high-res (edge band)
    print(f"[orto] high-res footprint covers {foot.mean()*100:.1f}% of the box")

    def job(t):
        r0, c0, h, w = t
        f = cres / res
        rr = np.minimum(((r0 + np.arange(h)) / f).astype(int), fH - 1)
        cc = np.minimum(((c0 + np.arange(w)) / f).astype(int), fW - 1)
        m_core, m_halo = core[np.ix_(rr, cc)], halo[np.ix_(rr, cc)]
        if m_halo.any():
            a, n = _wms_getmap(ORTO_HR, "Raster", x0 + c0 * res, y1 - (r0 + h) * res,
                               x0 + (c0 + w) * res, y1 - r0 * res, w, h)
            hr_bytes[0] += n
            # in the 1 m edge band keep high-res pixels unless they are blank white
            mask = m_core | (m_halo & (a.min(axis=2) < 250))
        else:
            a, mask = None, None
        # matching slice of the 25 cm base, resampled to res
        g = sr_res / res
        sc0, sr0 = int(c0 / g), int(r0 / g)
        sc1, sr1 = min(sr_W, math.ceil((c0 + w) / g) + 1), min(sr_H, math.ceil((r0 + h) / g) + 1)
        sub = Image.fromarray(sr[sr0:sr1, sc0:sc1])
        # crop box in the sub-image's pixel units so pixel edges line up exactly
        bx0, by0 = c0 / g - sc0, r0 / g - sr0
        base = np.asarray(sub.resize((w, h), Image.BILINEAR, box=(bx0, by0, bx0 + w / g, by0 + h / g)))
        out = base.copy() if a is None else np.where(mask[..., None], a, base)
        return t, out, 0.0 if mask is None else float(mask.mean())

    t0 = time.time()
    with rasterio.open(path, "w", **profile) as ds, cf.ThreadPoolExecutor(workers) as ex:
        done = 0
        for (r0, c0, h, w), out, cov in ex.map(job, tiles):
            ds.write(out.transpose(2, 0, 1), window=Window(c0, r0, w, h))
            done += 1
            if done % 10 == 0 or done == len(tiles):
                print(f"[orto] {done}/{len(tiles)} tiles, {hr_bytes[0]/1e6:.0f} MB, {time.time()-t0:.0f}s", flush=True)
        ds.update_tags(ATTRIBUTION=ATTRIBUTION, SOURCE_HIGH=ORTO_HR, SOURCE_STANDARD=ORTO_SR)
    print("[orto] building overviews ...", flush=True)
    with rasterio.open(path, "r+") as ds:
        ds.build_overviews([2, 4, 8, 16, 32, 64], Resampling.average)
    # which high-res sheet is on top: finest pixel, then newest
    top = sorted(hr_sheets, key=lambda s: (s["pixel_m"], [-int(p) for p in s["date"].split("-")]))
    meta.update(download_mb=round((hr_bytes[0] + nbytes) / 1e6, 1), highres_coverage=round(float(foot.mean()), 3),
                # the layer draws finest pixel first, then newest: this sheet set is on top
                highres_top=dict(pixel_m=top[0]["pixel_m"], date=top[0]["date"],
                                 sheets=sorted({s["godlo"] for s in top if s["date"] == top[0]["date"]
                                                and s["pixel_m"] == top[0]["pixel_m"]})) if top else None,
                standard_fill_date=max((s["date"] for s in sr_sheets), default=None))
    json.dump(meta, open(path[:-4] + ".json", "w"), indent=1, ensure_ascii=False)
    _preview(path, os.path.join(outdir, f"{name}_preview.jpg"))
    return dict(path=path, width=W, height=H, pixel_m=res, crs=CRS, download_mb=meta["download_mb"],
                highres_coverage=meta["highres_coverage"], highres_top=meta["highres_top"],
                standard_fill_date=meta["standard_fill_date"])


def _preview(path, out, max_px=2000):
    with rasterio.open(path) as ds:
        f = max(ds.width, ds.height) / max_px
        w, h = round(ds.width / f), round(ds.height / f)
        a = ds.read(out_shape=(ds.count, h, w), resampling=Resampling.average)
    if a.shape[0] == 1:
        v = a[0].astype(float)
        lo, hi = np.nanpercentile(v[v > -1000], [1, 99])
        img = Image.fromarray(np.clip((v - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8))
    else:
        img = Image.fromarray(a.transpose(1, 2, 0))
    img.save(out, quality=88)


# ----------------------------------------------------------------- elevation (NMT/NMPT)
def _gfi_sheets(idx_url, layers, x, y):
    recs = []
    for L in layers:
        p = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetFeatureInfo", LAYERS=L, QUERY_LAYERS=L,
                 STYLES="", CRS=CRS, BBOX=f"{y-50},{x-50},{y+50},{x+50}", WIDTH=101, HEIGHT=101,
                 I=50, J=50, INFO_FORMAT="text/html", FEATURE_COUNT=50)
        html = _get(idx_url, p, timeout=60).text
        for m in re.finditer(r"\.push\(\{(.*?)\}\)", html, re.S):
            recs.append(dict(re.findall(r'(\w+):"([^"]*)"', m.group(1))))
    return recs


def elev_sheets(kind, x0, y0, x1, y1, step=1000.0):
    idx = NMT_IDX if kind == "nmt" else NMPT_IDX
    tag = "NMT" if kind == "nmt" else "NMPT"
    layers = [f"Skorowidze{tag}{y}" for y in (2026, 2025, 2024)] + [f"Skorowidze{tag}2023iStarsze"]
    xs = np.unique(np.r_[np.arange(x0, x1, step), x1])
    ys = np.unique(np.r_[np.arange(y0, y1, step), y1])
    allrec = {}
    pts = [(x, y) for x in xs for y in ys]  # 1:5000 sheets are ~2.2 x 2.4 km
    with cf.ThreadPoolExecutor(6) as ex:
        for recs in ex.map(lambda p: _gfi_sheets(idx, layers, *p), pts):
            for r in recs:
                allrec[r["url"]] = r
    by = {}
    for r in allrec.values():
        by.setdefault(r["godlo"], []).append(r)
    chosen = {}
    for g, rs in by.items():  # prefer lidar, then newest
        rs.sort(key=lambda r: (r.get("zrDanych", "Skaning laserowy") == "Skaning laserowy", r["aktualnosc"]), reverse=True)
        chosen[g] = rs[0]
    return chosen, list(allrec.values())


def _read_asc(text):
    head, pos = {}, 0
    while True:  # 5 or 6 header lines ("nodata_value" is optional, e.g. in WCS output)
        end = text.index("\n", pos)
        tok = text[pos:end].split()
        if not tok or not tok[0][0].isalpha():
            break
        head[tok[0].lower()] = float(tok[1])
        pos = end + 1
    lines = [None] * 6 + [text[pos:]]
    n = int(head["nrows"]) * int(head["ncols"])
    data = np.fromstring(lines[6], dtype=np.float32, sep=" ", count=n)  # text mode: memory-light
    data = data.reshape(int(head["nrows"]), int(head["ncols"]))
    cs = head["cellsize"]
    xl = head["xllcenter"] - cs / 2 if "xllcenter" in head else head["xllcorner"]
    yl = head["yllcenter"] - cs / 2 if "yllcenter" in head else head["yllcorner"]
    nd = head.get("nodata_value", -9999)
    data[data == nd] = np.nan
    return data, xl, yl, cs


def _fetch_elev(kind, lon, lat, hx, hy, outdir, name, cache=True):
    res = 1.0 if kind == "nmt" else 0.5
    cx, cy = Transformer.from_crs(4326, 2180, always_xy=True).transform(lon, lat)
    os.makedirs(outdir, exist_ok=True)
    cdir = os.path.join(outdir, f"_cache_{kind}")
    os.makedirs(cdir, exist_ok=True)
    # coarse box for the index query
    chosen, allrec = elev_sheets(kind, cx - hx, cy - hy, cx + hx, cy + hy)
    print(f"[{kind}] {len(chosen)} sheets:", ", ".join(f"{g} {r['aktualnosc']} {r.get('zrDanych','')}" for g, r in sorted(chosen.items())))
    grids, nbytes = [], 0
    for g, r in sorted(chosen.items(), key=lambda kv: kv[1]["aktualnosc"]):  # oldest first, newest overwrites
        fn = os.path.join(cdir, os.path.basename(r["url"]))
        if not os.path.exists(fn):
            resp = _get(r["url"], timeout=600)
            open(fn, "wb").write(resp.content)
            nbytes += len(resp.content)
        grids.append((g, r) + _read_asc(open(fn, encoding="latin1").read()))
    # output grid = native grid of the finest (then newest) sheet, e.g. NMT 1 m with
    # pixel edges at x.5, NMPT 0.5 m with edges at x.25/x.75. Sheets on the same grid
    # are copied 1:1; sheets on another grid/resolution are resampled bilinearly.
    ref = min(grids, key=lambda t: (t[5], [-int(p) for p in t[1]["aktualnosc"].split("-")]))
    _, _, _, xl, yl, cs = ref
    ox, oy = xl % cs, yl % cs
    x0 = math.floor((cx - hx - ox) / cs) * cs + ox
    x1 = math.ceil((cx + hx - ox) / cs) * cs + ox
    y0 = math.floor((cy - hy - oy) / cs) * cs + oy
    y1 = math.ceil((cy + hy - oy) / cs) * cs + oy
    W, H = round((x1 - x0) / cs), round((y1 - y0) / cs)
    dtf = from_origin(x0, y1, cs, cs)
    out = np.full((H, W), np.nan, np.float32)
    src = np.zeros((H, W), np.uint8)
    for k, (g, r, a, gxl, gyl, gcs) in enumerate(grids, 1):
        nr, nc = a.shape
        aligned = abs(gcs - cs) < 1e-9 and abs((gxl - x0) / cs - round((gxl - x0) / cs)) < 1e-6 \
            and abs((gyl - y0) / cs - round((gyl - y0) / cs)) < 1e-6
        if aligned:
            blk_full = np.full((H, W), np.nan, np.float32)
            gc0 = round((gxl - x0) / cs)             # column of sheet's west edge in output
            gr0 = round((y1 - (gyl + nr * gcs)) / cs)  # row of sheet's north edge in output
            r0, r1 = max(0, gr0), min(H, gr0 + nr)
            c0, c1 = max(0, gc0), min(W, gc0 + nc)
            if r0 >= r1 or c0 >= c1:
                continue
            blk_full[r0:r1, c0:c1] = a[r0 - gr0:r1 - gr0, c0 - gc0:c1 - gc0]
        else:
            blk_full = np.full((H, W), np.nan, np.float32)
            reproject(a, blk_full, src_transform=from_origin(gxl, gyl + nr * gcs, gcs, gcs), src_crs=CRS,
                      dst_transform=dtf, dst_crs=CRS, src_nodata=np.nan, dst_nodata=np.nan,
                      resampling=Resampling.bilinear)
        ok = ~np.isnan(blk_full)
        out[ok] = blk_full[ok]
        src[ok] = k
        del blk_full
    path = os.path.join(outdir, f"{name}.tif")
    prof = dict(driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=CRS,
                transform=from_origin(x0, y1, cs, cs), nodata=np.nan, tiled=True,
                blockxsize=256, blockysize=256, compress="DEFLATE", predictor=3)
    with rasterio.open(path, "w", **prof) as ds:
        ds.write(out, 1)
        ds.update_tags(ATTRIBUTION=ATTRIBUTION, VERTICAL_DATUM="PL-EVRF2007-NH",
                       SOURCES=json.dumps({g: r["url"] for g, r, *_ in grids}))
    meta = dict(product=name, crs=CRS, vertical="PL-EVRF2007-NH (normal heights, m)", pixel_m=cs,
                width=W, height=H, bounds_2180=[x0, y0, x1, y1], attribution=ATTRIBUTION,
                index_service=(NMT_IDX if kind == "nmt" else NMPT_IDX), download_mb=round(nbytes / 1e6, 1),
                nodata_fraction=round(float(np.isnan(out).mean()), 4),
                min=float(np.nanmin(out)), max=float(np.nanmax(out)),
                sheets_used=[dict(godlo=g, date=r["aktualnosc"], source=r.get("zrDanych"), url=r["url"],
                                  res=r.get("charakterystykaPrzestrzenna"), sigma_h=r.get("bladSredniWysokosci"), native_res=r.get("charakterystykaPrzestrzenna", "").startswith(f"{cs:.2f}"),
                                  px_in_box=int((src == k).sum()))
                             for k, (g, r, *_) in enumerate(grids, 1)],
                other_vintages=sorted({(r["godlo"], r["aktualnosc"]) for r in allrec} -
                                      {(g, r["aktualnosc"]) for g, r in chosen.items()}))
    json.dump(meta, open(path[:-4] + ".json", "w"), indent=1, ensure_ascii=False)
    _preview(path, os.path.join(outdir, f"{name}_preview.jpg"))
    if not cache:
        for f in os.listdir(cdir):
            os.remove(os.path.join(cdir, f))
        os.rmdir(cdir)
    return dict(path=path, width=W, height=H, pixel_m=cs, crs=CRS, min=meta["min"], max=meta["max"],
                nodata_fraction=meta["nodata_fraction"])


def _fetch_nmt_wcs(x0, y0, x1, y1, outdir, name, chunk=2000):
    W, H = round(x1 - x0), round(y1 - y0)
    out = np.full((H, W), np.nan, np.float32)
    for r0 in range(0, H, chunk):
        for c0 in range(0, W, chunk):
            w, h = min(chunk, W - c0), min(chunk, H - r0)
            p = [("SERVICE", "WCS"), ("VERSION", "2.0.1"), ("REQUEST", "GetCoverage"),
                 ("COVERAGEID", "DTM_PL-EVRF2007-NH"), ("FORMAT", "image/x-aaigrid"),
                 ("SUBSET", f"x({x0 + c0},{x0 + c0 + w})"), ("SUBSET", f"y({y1 - r0 - h},{y1 - r0})")]
            txt = _get(NMT_WCS, p, timeout=300).content.decode("latin1")
            body = txt[txt.index("ncols"):]
            body = body[:body.index("--wcs")] if "--wcs" in body else body
            a, xl, yl, cs = _read_asc(body)
            gc0, gr0 = round(xl - x0), round(y1 - (yl + a.shape[0] * cs))
            hh, ww = min(a.shape[0], H - gr0), min(a.shape[1], W - gc0)
            out[gr0:gr0 + hh, gc0:gc0 + ww] = a[:hh, :ww]
    path = os.path.join(outdir, f"{name}.tif")
    with rasterio.open(path, "w", driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=CRS,
                       transform=from_origin(x0, y1, 1, 1), nodata=np.nan, compress="DEFLATE",
                       predictor=3, tiled=True) as ds:
        ds.write(out, 1)
        ds.update_tags(ATTRIBUTION=ATTRIBUTION, VERTICAL_DATUM="PL-EVRF2007-NH", SOURCE=NMT_WCS)
    return dict(path=path, width=W, height=H, pixel_m=1.0, crs=CRS)


# ----------------------------------------------------------------- entry point
def fetch_pl(product, lon, lat, half_x_m, half_y_m, outdir, res=None, workers=4, name=None, **kw):
    os.makedirs(outdir, exist_ok=True)
    name = name or f"pl_{product}"
    if product == "orto":
        r = res or 0.05
        return _fetch_orto(*_box2180(lon, lat, half_x_m, half_y_m, r), r, outdir, name, True, workers, **kw)
    if product == "orto_std":
        return _fetch_orto(*_box2180(lon, lat, half_x_m, half_y_m, 0.25), 0.25, outdir, name, False, **kw)
    if product in ("nmt", "nmpt"):
        return _fetch_elev(product, lon, lat, half_x_m, half_y_m, outdir, name, **kw)
    if product == "nmt_wcs":
        return _fetch_nmt_wcs(*_box2180(lon, lat, half_x_m, half_y_m, 1.0), outdir, name)
    raise ValueError(f"unknown product {product!r}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("product", choices=["orto", "orto_std", "nmt", "nmpt", "nmt_wcs"])
    ap.add_argument("--lon", type=float, default=14.7928)
    ap.add_argument("--lat", type=float, default=53.5511)
    ap.add_argument("--half-x", type=float, default=1500)
    ap.add_argument("--half-y", type=float, default=1250)
    ap.add_argument("--res", type=float, default=None, help="orto only: output pixel (m), default 0.05")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    ap.add_argument("--name", default=None, help="output file name without .tif (default pl_<product>; another area: pl_<product>_<area>)")
    a = ap.parse_args()
    print(json.dumps(fetch_pl(a.product, a.lon, a.lat, a.half_x, a.half_y, a.out, res=a.res, name=a.name), indent=1))
