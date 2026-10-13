"""Which route the route-survey tools work on, and where its files live.

ROUTE_ROOT (environment) is the route's folder: its config (route_config.json), its work cache (.cache/route/), the
page data (data/route/) and the build output (dist/). Unset, it is this project folder (the Hoßkirch blade route).
Tile caches of the official geodata (elevation and survey-point rasters) are shared by every route (SHARED).
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, '..'))
ROOT = os.path.normpath(os.environ.get('ROUTE_ROOT') or PROJECT)
C = os.path.join(ROOT, '.cache', 'route') + '/'           # the route's work cache
DATA = os.path.join(ROOT, 'data', 'route') + '/'          # page data (route.json, route.bin, images)
DIST = os.path.join(ROOT, 'dist') + '/'                   # packs and the hosted page
SHARED = os.path.join(PROJECT, '.cache', 'route') + '/'   # tile caches, any route
os.makedirs(C, exist_ok=True)

_cfg = os.path.join(ROOT, 'route_config.json')
CFG = json.load(open(_cfg, encoding='utf-8')) if os.path.exists(_cfg) else {}


def get(key, default=None):
    return CFG.get(key, default)
