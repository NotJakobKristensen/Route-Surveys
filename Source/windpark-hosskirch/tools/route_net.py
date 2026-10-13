"""Road networks for routing from Overture transportation segments (OSM-derived) → <route cache>/net_<tag>.parquet.

Usage: python route_net.py W,S,E,N tag [classes]
  e.g. python route_net.py 9.2,47.6,15.1,53.8 major motorway,trunk,primary,secondary      (the long legs)
       python route_net.py 14.40,53.30,14.80,53.55 factory                                  (every road at the start)
The columns are the ones route_graph.py reads (class, connectors, access restrictions, routes, names, flags, widths)."""
import sys
import pyarrow.compute as pc, pyarrow.parquet as pq
import routecfg
import overture as ov

COLS = ['id', 'class', 'subclass', 'names', 'routes', 'road_flags', 'access_restrictions', 'connectors', 'geometry',
        'width_rules', 'speed_limits', 'level_rules', 'subclass_rules']

if __name__ == '__main__':
    bb = tuple(float(v) for v in sys.argv[1].split(','))
    tag = sys.argv[2]
    extra = pc.field('subtype') == 'road'
    if len(sys.argv) > 3: extra = extra & pc.field('class').isin(sys.argv[3].split(','))
    t = ov.query('transportation', 'segment', bb, columns=COLS, extra=extra)
    pq.write_table(t, routecfg.C + f'net_{tag}.parquet')
    print(t.num_rows, 'segments →', routecfg.C + f'net_{tag}.parquet')
