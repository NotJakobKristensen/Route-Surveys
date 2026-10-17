# Windpark Hoßkirch — a 1:1 web recreation

`windpark-hosskirch.html` (in this folder) is a single, self-contained page that rebuilds **Windpark Hoßkirch**
in 3D at true scale and position: six **Vestas V172-7.2 MW** turbines in the Wagenhart forest north of Hoßkirch
(Landkreis Ravensburg, Baden-Württemberg), with the terrain, forest, fields, villages, roads, lakes and 110 kV lines
around them. Open the file in a current browser (WebGL 2); three.js r159 is loaded from jsDelivr, everything else
(code, geodata, imagery) is inlined — about 0.8 MB (≈ 0.66 MB compressed including three.js).

## Why this park

| | |
|---|---|
| Turbines | 6 × Vestas V172-7.2 MW (Vestas' first V172 order worldwide, Oct 2023), 43.2 MW |
| Tower | Max Bögl hybrid tower: precast concrete 0–103.09 m (Ø 9.43 → 4.53 m), steel above; hub 175 m |
| Rotor | Ø 172 m nominal (86 m along each blade, 84.35 m blade), tip height 261 m; 6° tilt and 6° cone with 4.2 m pre-bend, so the swept circle at rest is Ø 170 m and the upper blade stands vertical; clockwise seen from the front |
| Site | Wagenhart forest (moraine ridge up to 698 m), owned by the House of Königsegg-Aulendorf |
| Developer / operator | Uhl Windkraft · Wagenhart Wind GmbH & Co. KG |
| In operation | Sep–Oct 2025; opening ceremony 20 June 2026 |

| WEA | Latitude | Longitude | Ground (m a.s.l.) | Commissioned | MaStR |
|---|---|---|---|---|---|
| 1 | 47.9608403 | 9.4264449 | 648 | 2025-10-28 | SEE900783549690 |
| 2 | 47.9582348 | 9.4338187 | 645 | 2025-10-09 | SEE937744919643 |
| 3 | 47.9563677 | 9.4413519 | 645 | 2025-09-18 | SEE914656798139 |
| 4 | 47.9580903 | 9.4506170 | 663 | 2025-09-18 | SEE982721870653 |
| 5 | 47.9600875 | 9.4628562 | 671 | 2025-10-28 | SEE901865111347 |
| 6 | 47.9631767 | 9.4560887 | 663 | 2025-10-16 | SEE985393714256 |

Positions and commissioning dates: OpenStreetMap (Overture Maps release 2026-09-23.1). Ground elevations: German
Wikipedia "Windpark Hoßkirch". The positions agree with the crane pads and tower glint in Sentinel-2 imagery (≤ 1 pixel,
10 m).

## Plan

1. **Find the park** — web search for German V172 projects, confirmed in OpenStreetMap (all six turbines tagged
   `model=V172`, `height:hub=175 m`, MaStR IDs). A research sub-agent collected tower type, markings, lights and
   rotor data with sources.
2. **Collect open data** reachable from the build sandbox (AWS open data):
   - Overture Maps (OSM-derived): roads, tracks, buildings (+ Microsoft ML heights), land use, forest, water, orchards,
     hedges, tree rows, power lines, place names.
   - Copernicus GLO-30 surface model → bare-earth terrain: forest canopy removed with a local edge-step model, then
     levelled to the published tower-foot elevations.
   - Sentinel-2 L2A surface reflectance, 19 June 2026 (the day before the opening ceremony): ground colour; multi-date
     NDVI to trace the six crane pads; canopy openness (clearings, young growth).
   - AWS Terrain Tiles: terrain out to ±64 km (Lake Constance, Swabian Jura) and the Alpine skyline to 260 km (Earth
     curvature and refraction included); ESA WorldCover 2021 for forests and towns in that far ring.
3. **Encode compactly** (`tools/build_data.py`): everything in one local transverse Mercator frame centred on the
   park (k0 = 1, mm-level distortion); vectors quantised to 0.2 m, delta + varint coded, one deflate stream (≈ 340 KB);
   two WebP images (≈ 136 KB).
4. **Render** (`src/*.js`, three.js): terrain rings (21 m detail zone — 32 m on phones —, 128 m outer ring, 500 m far ring), ground
   shader (satellite colour + land-use detail, tramlines), fine 3–8 m terrain over the levelled crane pads and the lakes,
   canopy shell from the OSM forest with pads, roads and power corridors carved out (forest tracks drawn as lanes,
   Sentinel-2 clear-cuts left open), individual 3D trees along forest edges and — around the camera — throughout the forest, buildings
   with fitted gable / hip roofs, draped roads with German markings, lakes, 110 kV Donau pylons with sagging conductors,
   the V172s with AVV day marking and synchronised night lights, real sun position for the date and time, sky, clouds,
   aerial perspective, shadows.
   Kept light on purpose: trees are instanced in three levels of detail re-binned by camera distance (one draw call per
   species and level), the canopy shell sinks where individual trees take over, the shadow map is redrawn on a clock
   (30 / 15 / 8 Hz by distance to the nearest rotor, never at night), canopy crown detail is only computed where it can
   be resolved, shaders are compiled before the first frame, and a frame-interval governor lowers the resolution on
   slow GPUs (telling a GPU at its limit from a 30 fps battery-saver cap with a one-off 2 s test). Phones get a lighter preset (coarser terrain and canopy, 2048² shadows).
5. **Check quality with independent sub-agents** (run in parallel on a frozen build, each with its own rubric):
   geo-alignment, visual/design, performance/weight, turbine spec and text fact check. Fix, rebuild, re-check until the
   acceptance criteria hold.

## Views

| Button | What you see |
|---|---|
| Overview | the whole park from the south-west, 2 km out, 700 m up |
| Map | straight down over the park (compare with any aerial map) |
| From the south | eye level in the open fields between Königseggwald and Hoßkirch (47.9294° N, 9.4305° E, ground 667 m), 3.5 km from the park — the one stretch of those fields where terrain, forest, tree rows and orchards leave every nacelle and every lower blade tip in sight |
| On WEA 3 | on the rear of WEA 3's nacelle roof, 181 m up, looking downwind along the row (WEA 4, 6 and 5 with the default south-westerly), the rotor behind you |
| Tower foot | eye level at the far end of WEA 5's crane pad, looking at the tower base and door |
| 1 – 6 | each turbine from 520 m upwind, with its data card (position, elevation, commissioning date, MaStR number) |

Drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom; W A S D / Q E / R F / + − on the keyboard;
H hides the panels. Time of day, wind direction and speed are live: the rotors yaw into the wind and turn at the
V172's speed for that wind, the sun and shadows follow the real sun position over the park on 19 June 2026.

## Acceptance criteria

| Check | Target |
|---|---|
| Turbine positions (scene vs OSM, independent projection) | < 0.5 m |
| Hub height / rotor Ø / tip height in the scene | 175 m / 172 m / 261 m |
| Tower-foot elevations | published values ± 0.5 m |
| Buildings, roads, forest edges vs OSM | median < 0.5 m, p95 < 1 m |
| Imagery registration | < 1 Sentinel-2 pixel (10 m) |
| Rotation / yaw | clockwise from the front, rotor facing the wind |
| Page weight | < 1 MB incl. three.js; single HTML file |

## Quality checks

Four rounds of independent sub-agent reviews (geo-alignment, visual/design, performance + turbine spec), each on a
frozen build, each measuring in the running page (headless Chromium, SwiftShader WebGL 2) rather than reading constants.
Every finding was fixed or answered before the next round.

| Check | Target | Measured (round 4 build) |
|---|---|---|
| Turbine positions, scene vs OSM (pyproj, independent) | < 0.5 m | ≤ 0.006 m |
| Tower-foot elevations | published ± 0.5 m | exact (0.000 m) |
| Buildings / roads / forest / water outlines vs Overture | median < 0.5 m, p95 < 1 m | medians 0.04–0.05 m, p95 0.10–0.50 m |
| Imagery vs OSM roads | < 10 m | 0.1 m |
| Open-field terrain vs Copernicus GLO-30 (≤ 1.5 km) | small | p95 0.33 m |
| Hub height / upper blade tip | 175 m / 261 m | 175.000 m / 261.00 m |
| Rotation, yaw, rpm, markings, lights, blink pattern | V172 / AVV 2020 | all as specified |
| Crane pads / ramps / seams (terrain vs pads) | no burial, ramps ≤ 25° | slab 0.09–0.17 m proud, 0 buried, ramps ≤ 21°, 0 seams |
| Roads floating > 0.5 m / lake shore > 1 m under water | small | 0.4 % / 0.8 % |
| Page weight incl. three.js (brotli) | < 1 MB | 0.66 MB (664 KB), nothing render-blocking |
| Boot main-thread CPU (desktop / mobile quality) | — | ≈ 2.0 s / 1.4 s in SwiftShader on 4 cores |
| Triangles per frame, all passes (desktop) | — | 1.7–2.5 M depending on view |
| Shadow-map refreshes (static view) | ≤ 30 Hz | 30 / 15 / 8 Hz by distance to a hub, 30 Hz while the sun moves, none at night |

## Rebuild

```sh
npm install                                  # esbuild (bundler)
pip install duckdb pyarrow shapely pyproj rasterio scipy scikit-image pillow requests mercantile
cd windpark-hosskirch/tools                  # raw downloads go to windpark-hosskirch/.cache (or $WINDPARK_CACHE)
python fetch_turbines.py
python fetch_overture.py 9.37,47.915,9.52,48.005 core
python fetch_overture.py 9.26,47.83,9.63,48.09 wide land_use,land,water,segment,infrastructure,division
python fetch_dem.py && python terrain_dsm.py && python terrain_dtm.py
python imagery.py && python pads_sample.py && python pads_trace.py && python openness.py
python fetch_far.py
python build_data.py                         # → windpark-hosskirch/data/
cd ../.. && node windpark-hosskirch/tools/build.mjs   # → windpark-hosskirch/windpark-hosskirch.html
```

## Sources and licences

© OpenStreetMap contributors (ODbL), via Overture Maps · building heights: Microsoft ML Buildings (ODbL) ·
contains modified Copernicus Sentinel-2 data 2026 · Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and
Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA · AWS Terrain Tiles (Mapzen; EU-DEM,
SRTM and others) · ESA WorldCover 2021 (CC BY 4.0) · three.js (MIT). Turbine facts: Vestas, Uhl Windkraft, Max Bögl / Schelmberger, Schwäbische Zeitung,
Wikipedia, AVV Kennzeichnung von Luftfahrthindernissen (2020).

## Blade route survey (`hosskirch-blade-route.html`)

The road transport of the 84.3 m V172 blades from the LM Wind Power / Vestas plant in Goleniów (PL) to the crane pads:
935 km rebuilt on the Overture road graph through the points the press and police reported (A 7 → B 28 → B 30 at
Neu-Ulm, the B 30 past Bad Waldsee, the B 30 → B 32 ramp at Niederbiegen, the B 32 at Hirschegg, Haid → K 8274 →
Heratskirch), driven metre by metre with a swept-path model of the convoy (8×4 tractor, two-axle jeep dolly with the
lifting root adapter, the blade carried trailing edge up between it and the four-axle remote-steered rear dolly; BF4
escort ahead, BF3 behind; 95 m). Twelve passages are shown in 3D at true scale with the convoy, its swept area and what
stands in its way (Overture / OSM objects, ESA WorldCover trees), with measures and the reported evidence.

**The blade** (`src/route/blade.js`, mirrored in `route_swept.py`): V172 planform (84.35 m, root Ø 3.2 m, widest chord
4.3 m at 23 %, NREL 5 MW proportions), carried trailing edge up and turned about its axis only as far as the transport
height requires; its root sits on the adapter, the leading edge on the rear clamp at the user's underside, the prebend
lifts the tip to the user's value. The swept-path model takes the plan width and the underside of exactly this blade,
so a taller transport height gives a more upright, narrower blade.

**Own lane or oncoming lane** (`route_lanes.py`, `route_swept.lane_plan`): on every curve of a two-way road the convoy
keeps right where its lane is enough and uses the oncoming lane where that keeps the wheels on the road or the blade
over it (the escort holds oncoming traffic). The road view drives that line and paints those stretches violet; the
passages compare keeping right with the recommended line; the route card lists every stretch.

### The road anywhere, from official aerial photos

Clicking the route, typing a km into the route card (*Open the road here*), *Explore the road here* on a passage, or the
slider and *Drive* inside the road view opens the **road view** at any km, not only at the twelve passages: the official aerial photo along the
road (20–25 cm, strips of 500 m × 90 m that follow the route, plus a 600 m band at 2 m), the carriageway edges traced on
the photo, the convoy driving with its swept wheels and blade, mapped objects, buildings and bridges, a survey card
(width left / right, curve radius, gradient, wheel clearance, blade overswing) with a 2 km profile, and a measuring tool.
The twelve passages use the same data plus 25 cm photo tiles over the whole junction area, the laser terrain (DGM1 / NMT),
LoD2 buildings and trees from the surface model; their analysis uses the measured carriageway.

| Stretch | Photo | Height data (terrain / surface) | Buildings |
|---|---|---|---|
| Poland, km 0–45.5 | GUGiK orthophoto 25 cm (2025) | NMT / NMPT lidar via WCS | Overture |
| Mecklenburg-Vorpommern, km 45.5–64.5 | LAiV DOP (WMS) | DGM1 / DOM1 via WCS | Overture |
| Brandenburg + Berlin, km 64.5–296.6 | LGB DOP20 (WMS) | DGM1 / bDOM1 via WCS | Overture |
| Saxony-Anhalt, Saxony, km 296.6–419 | LVermGeo / GeoSN DOP20 (WMS) | DGM1 / DOM1 via WCS (ST), GetFeatureInfo per 1 m cell (SN) | Overture |
| Thuringia, km 419–495 | TLBG DOP (WMS) | none reachable from the build environment (needs `geoportal.geoportal-th.de`) | Overture |
| Bavaria, km 495–726, 804–832 | LDBV DOP20 (2024) | DGM1, DOM20 (range reads) | LoD2 |
| Baden-Württemberg, km 726–804, 832–935 | LGL DOP20 (2025) | DGM1 (2020/23), nDOM1 | LoD2 |

### What the road view answers

- **Will the convoy fit?** The *Vehicle & blade* panel takes the user's blade (length, root, chord, height, underside at
  the support and the tip) and haulier (tractor, front unit, dolly, widths, steering offset) and re-drives the swept path
  over the next 1.6 km live. The amber band and lines are the wheels, the thin red lines the blade's outer sweep.
- **Clear heights.** Every structure over the route (Overture bridges and rail bridges, plus anything the surface models
  show over the driving line: gantries, canopies, overhanging trees) carries its clear height: signed (OSM maxheight)
  where mapped, otherwise *estimated* = top of the structure above the road (surface − terrain model, over the convoy's
  band) minus a typical deck depth for its class, with its uncertainty. The verdict against the vehicle height + margin
  is *passes / check on site / does not fit / unknown*. Places where the route itself crosses on a bridge are told apart
  by taking the road's level from the terrain model before and after; vehicles caught by the surface model (open road on
  the photo, under 4.6 m) are listed as artefacts, not obstacles.
- **Signals, signs, lamps, poles.** Height measured from the surface model where it is plausible for the object class,
  otherwise the typical height (marked *typ.*). Signals and signs mapped as a junction node on the road are placed at the
  measured kerbs (*at kerb*). Labels say whether the object stands in the wheels' path, how far the blade's underside
  passes above it, or how far it stands beside the blade.
- **Trees** within 40 m: tops from the surface model, crown colour from the photo.
- **Signs** (`route_signs.py`, `src/route/signs.js`): speed limits where the mapped limit changes (274 / 278 / 282), town
  signs where a 50 km/h limit or the buildings begin and end (310 / 311, name of the nearest locality), signed height
  limits (265), zebra crossings from the map's crossing tags (350 at both kerbs; none at signal-controlled, unmarked or
  dashed crossings, nor where more than 50 km/h applies), the map's stop, give-way and bus-stop nodes, and guide posts
  every 50 m outside towns (closer in curves). Faces drawn from the sign catalogue's geometry; plates at the VwV-StVO
  size class for the speed of the traffic approaching them (mapped limits per metre and direction, `corr/speed_1m.npz`:
  round 420 / 600 / 750 mm up to 20 / 80 / above, triangles 630 / 900 / 1260 mm below 50 / up to 100 / above), lower
  edge 2.0 m, grey backs. Direction signs, warnings and the rest need OpenStreetMap's `traffic_sign` nodes, which this
  build environment cannot reach (`overpass-api.de`).
- **3D roads** (`route_roads.py`, `src/route/roads3d.js`; toggle "3D roads"): the route's carriageway between its measured
  edges and every road within 120 m (Overture segments: class, width, one-way, bridge / tunnel) as modelled asphalt
  (gravel on tracks) with German markings: edge and centre lines on two-way roads (dashes 3 / 6 m in towns, 4 / 8 m
  outside), hard-shoulder and lane lines (6 / 12 m) on dual carriageways, zebra stripes, kerbs in towns, parapets on
  small road bridges; roads over the route run on the bridge decks. In the passage views the asphalt covers the
  carriageway traced on the aerial photo and carries the swept-path paint; markings follow the mapped roads and stop
  at junctions. The wide photo band no longer folds over itself in tight curves or over another stretch of the route.
- **Mapped signs** (`osm_planet_signs.py` → `corr/osm_nodes.pkl`, merged by `route_signs.py`): every traffic_sign node
  within 30 m of the route from the OpenStreetMap planet on AWS open data (osm-pds; overpass-api.de is not reachable
  here): German and Polish codes with values and add-on plates stacked on one post, facing from the direction tags,
  motorway kilometre posts, speed cameras and sign gantries; inferred speed-limit and town signs give way to mapped
  ones within 250 m. Destinations on direction boards and gantries are not mapped: their rows are drawn as plain bars.
- **Traffic signals**: German signal posts (signs.js `signalGeo`): vehicle signal with visors on a black contrast panel
  with a white border, pedestrian signal and push button, a mast arm over carriageways of two lanes or more each way.
- **Smoothness**: 80-triangle tree crowns, terrain tiles at 4 / 8 m away from the path, the shadow map redrawn only when
  the convoy moves, idle views redrawn a few times a second, the resolution lowered when frames run slow.
- **Street level · photo.** A camera 2.5 m above the road (the Street View camera height) with a link that opens the same
  spot, heading, pitch and field of view in Google Street View; and the convoy drawn into a street-level photo the user
  brings (their own, or an openly licensed one: Google's terms do not allow screenshots of Street View). The photo stays
  in the browser; GPS and compass from its EXIF place the camera, sliders align it; the modelled terrain, buildings and
  trees hide the convoy behind them and its shadow falls on the photo.
- **Bridges in 3D.** Every bridge over the route is drawn from its Overture centreline and width: deck top from the
  surface model along the centreline (straight, or a gentle crest), ground under it from the terrain model, a typical
  deck depth for its class; the deck with its main body and cantilevers, caps, fascia, railings (guardrails on motorway
  and trunk decks, rails on railway bridges), abutments with wing walls, embankments where the view's ground is flat, and
  piers of round columns under a cap beam beside the carriageways. Under a bridge over the route the road follows the
  line between its approaches (the 30 m elevation model can hold the deck). Where the route itself runs on a bridge
  (Overture `is_bridge` on the route's segments) the deck, parapets, piers and abutments stand over the valley floor
  measured across the bridge every 4 m (±45 m); the road's height on a bridge is a line between the approaches plus the
  surface model's vertical curve, since GLO-30 sags into the valley there. In Thuringia no height model is reachable:
  decks over the route stand at the typical clear height and are drawn see-through, and the route's own bridges have no
  valley under them. The twelve passages draw every bridge in their area the same way (road and railway bridges); a
  small crossing under closed canopy (the surface model shows the crowns, not a deck) is drawn low at the level of its
  ends, a road and its footway on one deck as one deck, and a bridge over the route is labelled with its clear height.
  Where the route rides on a deck the swept path is painted on the deck, not on the ground below.
- **Passages, everything else in 3D.** LoD2 buildings, trees from the surface model over the whole passage area
  (`hd_trees_all.py`; the route data's tree cover where the surface model has no crown nearby), signals and signs (moved to the traced kerb when mapped as a junction
  node on the carriageway), lamps, barriers, and overhead lines: lattice towers where mapped, the wires drawn between
  neighbouring towers with a typical sag (their height is not measured).
- **Google Maps.** The *View centre* box in the dock gives the latitude / longitude of the centre of the current view
  (map, road view or passage) with links to the same place in Google Maps as a pin, the satellite picture at about the
  same zoom, and Street View looking the same way as the camera; measured points, passages and clear-height records
  carry the same links. Coordinates go back through the inverse transverse Mercator of each frame (UTM 33 for the road
  view, the map's TM, a local TM per passage); Google's pictures are only linked, never used as data.

Photo strips and survey packs (≈ 0.67 MB per 5 km) are files next to the page (`dist/r/`, `dist/h/`, published with the
artifact); the build copies them next to the repository's page (`r/`, `h/`), so the page in the repository is complete.

```sh
cd windpark-hosskirch/tools                  # needs the network extracts below in ../.cache/route
python route_build.py                        # route (graph from net_major / net_factory / net_site parquet)
python route_screen.py                       # whole-route swept-path screen
python route_objects.py && python route_elev.py   # roadside objects, bridges over the route, elevation (whole route)
python route_corridor_run.py 8 PL-32 DE-MV DE-BB DE-ST DE-SN DE-TH DE-BY DE-BW   # photo strips + carriageway edges per 500 m
WIDE=1 python route_corridor_run.py 8 PL-32 DE-MV DE-BB DE-ST DE-SN DE-TH DE-BY DE-BW
python route_survey_line.py                  # survey rows every 10 m, swept path on every curve (measured edges)
python route_lanes.py                        # own lane or oncoming lane on every curve of a two-way road
python route_bridges.py fetch && python route_bridges.py heights   # bridges over / under the route and at the passages
python route_hotspots.py                     # 12 passages: official geodata (hd_hot.py), obstacles, swept areas, lane plan
python hd_trees_all.py                       # trees from the surface model over each whole passage area
python route_clearance.py PL-32 DE-BW        # clear heights (elev.py / elev_fetch.py samplers); runs per group of regions:
CLEAR_OUT=clear_by.json python route_clearance.py DE-BY    # … clear_bb.json DE-BB, clear_east.json DE-MV DE-ST DE-SN
VERIFY=1 python route_clearance.py           # heights above the road itself (route on a bridge vs something over it)
python route_clear_hd.py                     # clear heights at the passages from the 1 m laser terrain → corr/clear_hd.json
                                             # (read before the surface-model runs; OVER_ONLY=1 route_pack.py: refresh the packs' clear heights)
python route_map.py && python route_map.py outer && python route_context.py
python route_bake.py                         # → data/route/
TAGS_ONLY=1 python route_objects.py         # refresh the kept map tags (crossings) of the cached roadside objects
python route_roads.py                        # roads within 120 m of the route → corr/roads.pkl
python osm_planet_signs.py                   # mapped signs from the OSM planet (≈ 80 GB read) → corr/osm_nodes.pkl
python route_signs.py                        # speed limits, town signs, height limits, zebra crossings, guide posts,
                                             # speeds → corr/signs.json, corr/speed_1m.npz
                                             # (SIGNS_ONLY=1 route_pack.py / route_hd_pack.py: refresh the packs' signs only)
python route_pack.py && python route_hd_pack.py   # → dist/r/, dist/h/
python route_guideposts.py ../dist/r          # the guide posts by the packed edges (after every route_pack.py)
cd ../.. && node windpark-hosskirch/tools/route_blade.mjs   # the blade beyond the edge at every passage and lane stretch → .cache/route/corr/blade_edge.json
cd windpark-hosskirch/tools && python route_bake.py && cd ../..   # (again: the passages' blade figures and areas from it)
node windpark-hosskirch/tools/build_route.mjs
```

**The blade beyond the road edge** (`src/route/bladeedge.js`, one model for the passage view, the drive view and the bake):
the page's vehicle drives the convoy's line (the swept-path model of `vehicle.js`, which chooses the rear dolly's steering);
the blade as drawn (`blade.js`) is taken at every place it passes — the metre poses and the places between them as the convoy
is animated, as many as keep its ends' moves across it within 25 cm — and measured along normals of the convoy's line (one per
metre, more in sharp bends), each normal holding the points whose nearest normal it is. Beyond the edge is what lies outside the
carriageway traced on the aerial photo (the band between the edges left and right of the line) and outside the paved surface
traced on a passage's photo (`h/<id>.json` pv: junction mouths, slip roads, lay-bys), by more than the traced edge's tolerance
(0.3 m). `tools/route_blade.mjs` runs it in Node on each passage's window (from where *Drive this passage* starts to 300 m
beyond the passage) with the road packs as the road view reads them; `route_bake.py` takes the result for the passage view's
painted area (layer `h_<id>_bout`), the card's figures (`bladeOut`, `bladeArea`, `lane.krBlade`), the trees in the blade's
swing, the lane list's figures and the drive view's copy (section `h_<id>_blade`: the stretches beyond on the passage's normals,
the depth per front-axle metre, the traced paved surface). On a passage's stretch the drive view shows that copy with the
default convoy; elsewhere, and with another vehicle, the sweep worker measures each window the same way.
Done for Münster (Lech) (2026-10-16; with every trouble spot of the route scan below as a passage, 2026-10-17; reviewed, with the blockers' clear heights corrected and the guide posts at the packed edges, version 6, 2026-10-17). Hoßkirch is not re-run yet and its page is unchanged: rebuild it only after
`route_blade.mjs` and `route_bake.py` have run for it (ROUTE_ROOT unset), else its drive view measures the new way while its
passages still paint the old area.

**Every place where the blade may have trouble** (`tools/route_scan.mjs`, then `tools/route_scan_hot.py`): the page's vehicle
drives the whole route along the convoy's line with the page's own code, window by window, and every front-axle metre is
checked for the blade beyond the traced edge (as above), the blade over what the road packs hold beside the road at its real
height — mapped objects (signals, lamps, poles; the road view's labels), road signs at their plate sizes and mounting heights
(`src/route/signdims.js`), guide posts 0.5 m beyond the edge, barriers at their typical heights (walls, noise barriers, fences,
hedges, guard rails), buildings — with the blade's underside across its section (`blade.js`), trees whose crowns reach into
the blade's swing beyond the edge, the wheels beyond the edge, and the structures over the road the page rates "too low" or
"to check". Barriers and signs mapped on the carriageway itself and buildings reaching over it (bridges, canopies) are mapping
artefacts and left out; an overhang over a mapped road only (a junction mouth, a slip road) is road, not verge.
`route_scan_hot.py` turns the places outside the passages into passages: a place within 1.5 km of a passage extends it, the
others become new passages (places within 2 km share one, up to 4 km), each from 250 m before its first trouble to 150 m after
its last, then `route_hotspots.py <ids>`, `hd_trees_all.py <ids>`, `ONE_ATLAS=1 route_hd_pack.py` (the photo tiles in one
atlas: two files per passage), `route_pix.py passages <ids>`, `route_bridges.py fetch && heights` (after a first bake: the
passages' areas), `route_blade.mjs`, `route_bake.py`. Thuringia's DGM1 / DOM1 tiles and Saxony's terrain (its height service,
one request per grid point: the terrain only, 8 m grid) are wired in for the passages there (`hd_hot.py`).

**After the bake and the packs** (each changes only what it names, byte for byte otherwise):
- `python tools/route_guideposts.py <r/>`: the guide posts (Z 620) by the packed edge. `route_signs.py` stands them 0.5 m beyond
  the edge traced at its time and `route_pack.py` copies them unchanged, while the packs' edges come from the later, corrected
  trace; where an edge was traced again a post could stand off the edge or on the carriageway. Each post's offset is set to the
  packed edge + 0.5 m at its chainage (the edges read as the road view reads them). Run it after every `route_pack.py`. The
  passage packs (`h/`) keep their own copies of the posts (`route_hd_pack.hd_signs`), not changed by it.
- `python tools/route_evidence_apply.py <route folder> <evidence file as last baked>`: review notes and measures from the
  route's evidence file into `route.json` as `route_bake.py` puts them (the bake copies them; only `incident`, `hard` and
  `cap` change what it computes, and those it refuses). With the evidence of the last bake it leaves `route.json` unchanged.
- `python tools/route_clear_fix.py <route folder> <r/>`: reviewed corrections of single clear-height records
  (`clear_fixes.json` in the route folder, each with its reason) in the clear list, the road pack holding the record and the
  passages' "check the clear height" measure, rebuilt as the bake builds it.

### Another route

The routes surveyed this way are in `routes/<route>/`, each with its own page next to its packs:
`routes/muenster-lech/muenster-lech-blade-route.html` — 84.3 m V172 blades from the Vestas blade plant in Goleniów to the five
V172 at Münster (Lech), Donau-Ries, 775 km, routed and surveyed without reports or local knowledge (artifact: Münster (Lech)
Blade Route). From the yard to km 629 it is the Hoßkirch route's road (same start, same chainage), so its corridor strips
and bridge heights were taken over from the Hoßkirch cache (`BRIDGE_SEED`, below).
Its work cache (`.cache/`) and build output (`dist/`) are not in git.

The same tools survey any route: `ROUTE_ROOT=<folder>` points them at the route's own folder (`route_config.json`, its
work cache `.cache/route/`, page data `data/route/`, packs `dist/`; tile caches of the official geodata stay shared,
`tools/routecfg.py`). The config gives the waypoints (start, crane pad), the page's name and texts, the legs, the
turbines and the map centre. Without fixed points the routing uses a heavy-transport policy (`route_graph.policy_matrix`:
motorways, trunk and federal roads on the long haul, town streets of 50 km/h or less eight times as expensive, minor
roads only within 30 km of either end), and the survey points come from the data alone (`route_findhot.py`: every 10 m
rated for wheels beyond the measured edge, blade overswing, oncoming lane, tight turns and clear heights; the worst
stretches in regions with survey-grade official data become passages, the start and the last kilometres always).

Further options (used for the Münster route):
- `legs_fixed` in the config: allowed road classes for single legs (e.g. the researched yard exit) while the policy routes
  the rest; extra waypoints pin a junction where the shortest path would turn back into an exit ramp (the graph has no
  turn penalties).
- `"passages": "all"` in the config: every difficult stretch becomes a passage (a clear height that is only "to check"
  stays a road-view finding); stretches over 4 km are split. Without survey-grade data (Saxony, Thuringia) a passage is
  built from the open European data.
- HD passages also in Brandenburg, Mecklenburg-Vorpommern and Saxony-Anhalt (`hd_hot.EF`: DGM1 and bDOM / DOM1 from the
  states' WCS through `elev_fetch.py`, the 20 cm photo from their WMS; buildings from the map, no LoD2 service wired in).
- `ALL=1 CLEAR_HD_OUT=clear_hd_all.json python route_clear_hd.py`: clear heights of every structure over the route from
  the 1 m laser terrain (where a state serves it), ahead of the surface-model estimates.
- `python route_clear_laz.py extract [DE-BY|PL-32]`, then `python route_clear_laz.py measure` → `corr/clear_laz.json`
  (read first of all clear-height files): clear heights from the raw airborne laser point clouds — Bavaria's LDBV 1 km
  tiles (`geodaten.bayern.de/odd_data/laser`, EPSG:25832) and Poland's GUGiK sheets (found per point through the
  geoportal's index WMS, newest flight first, EPSG:2180). `extract` downloads each tile once, keeps the points around every mapped
  structure (the driving line ±35 m and the deck lines, plus 12 m) (`laz/<key>.npz`: x, y, z, class, GPS time) and deletes
  the tile. `measure` fits the road as the lower envelope of the ground points ahead of and behind the deck (ballast or
  a lid classed as ground stays out), finds the deck as the layer that spans the driving line on both sides, and records
  the deck top above the road. A scanner overhead rarely sees a deck's underside, so the clear height is the top minus
  the larger of a typical deck depth and any underside seen. A crossing with no deck over the driving line is recorded
  as such (the route passes over or beside it); where the road is not seen beyond both ends of the deck (a covered
  section, a cutting under a lid) the record is left out and the next source holds. `ONLY=a-b` limits both to a
  chainage range in m.
  Brandenburg (`DE-BB`, `data.geobasis-bb.de/geobasis/daten/als/laz/als_33<E>-<N>.zip`, EPSG:25833) serves its 1 km tiles
  zipped from a slow server: `extract` fetches each in eight ranged parts at once (resumed after a break) and unpacks the LAZ.
- `python route_osm.py` → `corr/osm_tags.json`, `corr/limits.json`: OpenStreetMap's detailed tags along the route from
  overpass-api.de (plain HTTP; one answer per 8 km cached in `osm/`, so a run resumes, and it waits for a free slot when the
  server is busy): height / weight / width / length limits and lorry bans on the route's ways and nodes, overhead power and
  telecom lines crossing the route (voltage, operator), traffic islands, kerbs, bollards, gates and height restrictors.
  The bake tests islands, kerbs and barriers against each passage's wheel swept area and wires and limits against its
  stretch, adds them as findings with measures, and lists the lines and limits for the whole route on the page.
- `python route_roadworks.py` → `corr/roadworks.json`: the roadworks and closures of Autobahn GmbH
  (`verkehr.autobahn.de/o/autobahn/<A..>/services/roadworks|closure`) on the motorways the route uses, matched to the route
  in our direction of travel, with the phase dates or night windows, the narrowest passable width and the speed limit. The
  page compares the width with the convoy's. A snapshot: re-run before a transport.
- `python route_panoramax.py` → `corr/panoramax.json`: every Panoramax street photo within 20 m of the route (date, view
  direction, along or against our direction). `python route_pix.py` (after `route_pack.py`) picks up to four per passage
  (`dist/h/pix_<id>.json`) and one per 100 m of the route into the road packs (`pix` in `dist/r/NNN.json`). The page loads
  the thumbnails from the Panoramax instances in the viewer's browser and links each to the Panoramax viewer; where a page
  host blocks outside images, the link remains. The passage photos and, for every critical structure, the photo taken
  25–250 m before it looking at it (`dist/h/pix_bridges.json`) are built in as small JPEGs, so they show everywhere.
- `BRIDGE_SEED=<other route>/corr/bridges.pkl BRIDGE_SEED_MAX=<m> python route_bridges.py heights`: take over another
  route's measured bridges where both share road and chainage from the start.
- `python hot_dossier.py <dir> [ids]`: a review dossier per passage (summary with every conflict and clear height in
  lat/lon, the passage on the aerial photo with the swept areas, close-ups of the worst spots); reviewed notes and extra
  measures go into the route's `evidence.json` (`note`, `measures`, `hard`, `cap`/`capnote` per passage id).

```sh
export ROUTE_ROOT=/path/to/route                      # with route_config.json
python route_net.py 14.40,53.30,14.80,53.56 factory   # every road around the start / the site (net_factory, net_site);
python route_net.py 10.70,48.45,11.10,48.72 site      # net_major: motorway … secondary over the corridor
python route_build.py && python route_screen.py && python route_regions.py
# then the steps above from route_objects.py on, with route_findhot.py before route_hotspots.py
node windpark-hosskirch/tools/build_route.mjs         # → $ROUTE_ROOT/<page>.html, $ROUTE_ROOT/dist/
```


### Route planner: blade, start and end in, best route and its challenges out

`tools/survey_route.py` does the whole job for any trip within Germany and the Goleniów – Szczecin area of Poland:

```sh
cd windpark-hosskirch/tools
python survey_route.py plan <name> --start 14.7928,53.5511 --end 10.92308,48.60508 \
    [--via lon,lat …] [--blade 84.3 --root 4.2 --chord 4.3 --height 4.7 --width 4.2 --support 50 --weight 72 --length 98]
#  → routes/<name>/plan.json, routes/<name>/<name>-route-plan.html   (about 10 minutes)
python survey_route.py survey <name> [--pick N] [--list] [--from STEP] [--only STEP]
#  → the full survey and the 3D route page of the chosen candidate   (hours; resumable)
```

`plan`:
1. **Road graph of Germany** (`route_graph.Net`: flat arrays, 1.7 M nodes, built once in about 2 minutes from Overture's
   transportation segments, motorway → secondary, `.cache/route/graph_de.pkl`), plus every road within about 20 km of the
   start and the end. Roads with a signed weight, height, length or width limit the convoy exceeds are dropped for this
   convoy (limits on part of a segment, e.g. in a tunnel, count on the piece they cover). Germany only (Overture's country
   area) plus the Polish area around Goleniów and Szczecin.
2. **Candidates**: the heavy-transport policy of `policy_matrix` (motorways, trunk and federal roads on the long haul, town
   streets eight times as expensive, minor roads only near the ends), then up to `--alts` distinct routes by the penalty
   method (each found route's edges 1.35 × as expensive; one sharing more than 75 % of its length with an earlier one, or
   costing over 1.3 × the best, is dropped). The graph has no turn costs, so a turn back sharper than 125° (a U-turn into
   the opposite slip road, a hairpin at a junction) makes that edge 50 × as expensive and the route is searched again.
3. **Checks per candidate**: the swept-path screen (`route_screen.py` with `SCREEN_TAG`, the convoy of `route_swept.py`
   with this blade, `vehicle` in the route config): every bend under 700 m radius driven, with typical carriageway widths
   per road class; town streets; road bridges over the route (other roads' bridge pieces crossing it); tunnels of 80 m and
   more; signed height or width limits within 0.3 / 0.5 m of the convoy; mapped road widths under the convoy's need;
   today's roadworks and closures of the route's motorways (Autobahn GmbH) in our direction, narrow where the passable
   width is under the load's width + 0.5 m.
4. **Score**: the convoy's driving time in minutes (60 km/h motorway … 15 km/h minor roads, 20 km/h in towns) plus a
   time-equivalent per challenge (`WEIGHTS`; `--weights '{"bridge_over": 10}'` overrides). The lowest score is recommended.
   The page shows the candidates on a map of Germany, the score breakdown and every challenge with its km, road and links
   to the map and the satellite picture.

`survey` copies the chosen candidate to `route.pkl`, writes the route config (page name and texts from the places, legs
from the road numbers, towns along the way, the crane pad's height from the elevation) and runs the steps of this README
in order (`--list` shows them; each finished step is stamped in `.cache/route/stamps/`). The full survey needs the
states' open survey data: aerial photo strips and passages in Poland (Zachodniopomorskie), Mecklenburg-Vorpommern,
Brandenburg / Berlin, Saxony-Anhalt, Saxony, Thuringia, Bavaria and Baden-Württemberg; airborne laser point clouds in
Bavaria, Brandenburg and Poland. Elsewhere the road view and the passages fall back to the open European data.

Checked against the two surveyed routes: Goleniów → Münster (Lech) is planned on the road of the full survey (A 11, A 10,
A 9, B 16, 782 km), without the U-turn at Mittelstetten that needed a fixed waypoint there; Goleniów → Hoßkirch comes out
over the A 9, A 6, A 7 and B 30, as reported for the real convoys.

### Road profile, tunnels, lanes and medians

Run after the corridor, bridge and OSM steps (`survey_route.py` has them as steps `lanelines` and `vprof`), then
`route_lanes.py`, the swept pass of `route_survey_line.py`, `route_hotspots.py`, `route_bake.py`, `route_pack.py`,
`route_hd_pack.py`, `route_pix.py` and the build:

- `python route_vprof.py` → `corr/vprof.npz`: the road's height and cross slope every 1 m from the states' 1 m laser terrain
  (DGM1 / NMT) measured across the carriageway, bridge decks from the surface model, one smoothed vertical alignment with
  road-class limits on grade and curvature, and the terrain beside the road (`xrel`). Without a reachable laser terrain
  (Thuringia) the lower envelope of Copernicus GLO-30, ramped onto the neighbouring fits. RMS against DGM1 ≈ 2–5 cm.
- `python route_tunnels.py` → `corr/tunnels.json`: tunnels, covered sections and wildlife overpasses from the map flags (by
  geometry), the road through them as a grade between the portals, the lid from the laser terrain / surface model, the tube
  walls and a clear height (lid top − assumed depth, or the 4.50 m standard for mined tunnels). The page draws the tube,
  portals and lid and shows the convoy through it; every tunnel is a "check on site" record.
- `python route_lanelines.py` → `corr/lanelines.npz`: the painted lines read from the photo strips (edge lines, lane lines,
  lane count, the right lane), the median axis and the opposite carriageway, the barrier type and height (raised median,
  concrete wall or steel guard rail) from the map, the surface models and the laser point clouds.
- `route_lanes.py` keeps the convoy in the right lane (the right half of a two-way road) and moves it into lane 2 or the
  oncoming lane only where the swept path says the right side is not sufficient and the left side is.
