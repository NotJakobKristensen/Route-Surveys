"""Reconstruct the blade route Goleniów → Hoßkirch on the Overture road graph.

Fixed points (see the route-survey sources): the LM Wind Power / Vestas blade yard in Goleniów; A7 → B28 → B30 at
Neu-Ulm (Verkehrspolizei Günzburg escort); the B30 past Bad Waldsee; the B30 → B32 ramp at Weingarten-Niederbiegen
(incident 20 May 2025); the B32 past Hirschegg (incident 11 Jun 2025); the B32 Haid junction → K 8274 via
Wilfertsweiler and Heratskirch (Bad Saulgau notice); the crane pads. Between them: the cheapest heavy-transport path,
motorways strongly preferred, cities avoided (no primary/secondary roads on the long legs).
Run after fetching the networks (net_major / net_factory / net_site parquet) → .cache/route/route.pkl, graph.pkl
"""
import routecfg
import os, pickle, numpy as np
from route_graph import Graph, hav
C = routecfg.C
if os.path.exists(C + 'graph.pkl'):
    import types, route_graph
    G = pickle.load(open(C + 'graph.pkl', 'rb'))
    for name in ('ref_nodes', 'nearest', 'matrix', 'route', 'policy_matrix'): setattr(G, name, types.MethodType(getattr(route_graph.Graph, name), G))
else:
    G = Graph([C + 'net_major.parquet', C + 'net_factory.parquet', C + 'net_site.parquet'])
    pickle.dump(G, open(C + 'graph.pkl', 'wb'))
MW, MAJ = {'motorway', 'trunk'}, {'motorway', 'trunk', 'primary'}
LOCAL = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'}
W = [(14.7928, 53.5511),                     # blade yard, Goleniów (Prosta)
     (10.075, 48.335, 'B 28'),               # A7 → B28, Neu-Ulm
     (9.9959, 48.3708, 'B 30'),              # B28 → B30
     (9.70, 47.89, 'B 30'),                  # B30 past Bad Waldsee
     (9.60, 47.83, 'B 32'),                  # B30 → B32, Niederbiegen
     (9.51573, 47.99031, 'K 8274'),          # Haid junction
     (9.4628562, 47.9600875)]                # WEA 5 crane pad (first pad from the east)
LEGS = [{'motorway', 'trunk', 'tertiary', 'unclassified'}, MAJ, MAJ, MAJ, MAJ | {'secondary'}, None]
if routecfg.get('waypoints'):                # another route: its config (waypoints [lon, lat(, ref)], allowed classes per leg)
    W = [tuple(w) for w in routecfg.get('waypoints')]
    LEGS = [None if l is None else set(l) for l in (routecfg.get('legs') or [None] * (len(W) - 1))]
    if routecfg.get('policy'):                # no fixed points from reports: the heavy-transport policy on every leg
        P_ = routecfg.get('policy'); M_ = G.policy_matrix([w[:2] for w in (W[0], W[-1])], P_.get('near_m', 30000), P_.get('urban_x', 8.0))
        LEGS = [M_] * (len(W) - 1)
        for k_, cl_ in (routecfg.get('legs_fixed') or {}).items(): LEGS[int(k_)] = set(cl_)    # e.g. the yard exit, as researched
    assert len(LEGS) == len(W) - 1
R = G.route(W, LEGS)
tot = 0
for info, pc in R:
    a = np.array(pc); tot += float(hav(a[:-1, 0], a[:-1, 1], a[1:, 0], a[1:, 1]).sum())
print(f'route: {len(R)} edges, {tot / 1000:.1f} km')
pickle.dump(R, open(C + 'route.pkl', 'wb'))
