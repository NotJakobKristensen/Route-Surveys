import os, time, urllib.parse, pyarrow.dataset as ds, pyarrow.fs as pfs, pyarrow.compute as pc
_px = urllib.parse.urlparse(os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or '')
s3 = pfs.S3FileSystem(anonymous=True, region='us-west-2',
                      **({'proxy_options': {'scheme': _px.scheme or 'http', 'host': _px.hostname, 'port': _px.port}} if _px.hostname else {}))
REL = 'overturemaps-us-west-2/release/2026-09-23.1'
_cache = {}
def dataset(theme, typ):
    k = (theme, typ)
    if k not in _cache:
        _cache[k] = ds.dataset(f'{REL}/theme={theme}/type={typ}/', filesystem=s3, format='parquet')
    return _cache[k]
def query(theme, typ, bbox, columns=None, extra=None):
    w, s, e, n = bbox
    f = ((pc.field('bbox', 'xmin') <= e) & (pc.field('bbox', 'xmax') >= w) &
         (pc.field('bbox', 'ymin') <= n) & (pc.field('bbox', 'ymax') >= s))
    if extra is not None:
        f = f & extra
    t0 = time.time()
    t = dataset(theme, typ).to_table(filter=f, columns=columns)
    print(f'[{theme}/{typ}] {t.num_rows} rows in {time.time()-t0:.1f}s')
    return t
