# Münster (Lech) Blade Route

Blind-test route survey for 84.3 m V172 blades from the Vestas blade plant in Goleniów (PL) to the five V172 at Münster (Lech), Donau-Ries, 775 km: routed and checked from open data only, without reports or local knowledge. Every place on the route where the blade may have trouble passing is a 3D passage (67 plus the yard exit), on official survey-grade data (seven in Poland, two in Mecklenburg-Vorpommern, 21 in Brandenburg, seven in Saxony-Anhalt, two in Saxony, five in Thuringia, 24 in Bavaria); the clear heights of more than 300 structures over the route are measured against the 1 m laser terrain and, in Poland, Brandenburg and Bavaria, in the raw airborne laser point clouds (road under each bridge and deck top). Every passage is reviewed by hand on the aerial photo, street photos, OpenStreetMap and the laser data, with the measures it needs (the first 23 in versions 2 to 4; the 45 passages version 5 added and the 10 it extended in version 6).

## Current version: 6 (2026-10-17)

[`muenster-lech-blade-route.html`](muenster-lech-blade-route.html) is version 6, the newest; only the newest version is kept here (owner, 2026-10-15), the
earlier ones are in the git history.

### What changed: every passage reviewed, the two blockers settled, the guide posts at the road edge

**Every new and extended passage reviewed by hand.** The 45 passages version 5 added and the 10 it extended were each checked
against the 20 cm aerial photo, street photos (KartaView, Panoramax), OpenStreetMap and its edit history, and the states' open
laser point clouds. Each passage card now carries the review: what is really there, and what to do about it (its measures). What
the route scan had flagged turned out to be:

- **real at 24 passages**: mostly bridges whose registered clear height is needed before the run, and the blade's overswing at
  Pichl, Fleischnershausen, Höfelhof, Feldheim, Plötzin and Schwarzholzwinkel. They are Warcisławiec, Kliniska Małe, Załom,
  Kołowo, Radziszewo, Nadrensee, Radewitz, Hohengüstow, Heidehof, Trumpf, Neuhaus, Redernswalde, Althüttendorf, Finowfurt,
  Woltersdorf, Schmetzdorf, Lindenhof (its three structures are in Berlin), Zeestow, Plötzin, Schwarzholzwinkel, Pichl,
  Fleischnershausen, Höfelhof and Feldheim;
- **uncertain at 19 passages**: clear heights that only the registered value can settle (the laser sees a deck's top, not its
  underside), and speed-limit signs whose exact place is not mapped: Kołbaskowo, Reesdorf, Neue Mühle, Werdermühle, Köselitz
  (B 107), Brehna, Doberstau, Werlitzsch, Rippach, Blintendorf, Gössenreuth, Neunkirchen am Sand, both Feucht passages, Seehof,
  Obermühle, Zell, Unterhausen and Neuhof;
- **an artefact at 12 passages**: a traced road edge too narrow, a km post mapped on the carriageway, a guide post placed on a
  wrong edge, wall lamps in underpasses counted as standing in the road, a surface-model height under a slim deck: Buckow,
  Köselitz (A 9), Vockerode, Kößlitz-Wiedebach, Kleinhelmsdorf, Heideland, Klengel, Tautendorf, Raila, Sachsenvorwerk,
  Oberaltenreuth and Feldkirchen.

The passages stay where they are (every place where the blade may have trouble is shown); their cards now say what the trouble
really is.

**The two blockers.**

- **A6 at Kołbaskowo, "signed height limit 4.0 m": there is no such sign.** The 4.0 m came into OpenStreetMap with a desk edit
  on 21 February 2021 (changeset 99692142; the seven versions before it had no limit). Westbound street photos of 2016 and 2020
  show no height-limit sign at the bridge, and the laser puts the deck top 5.8 to 6.2 m above the road. The limit is taken off
  the page. The DK13 bridge itself stays **"check"**: the deck top from the laser (re-measured for this version) minus the steel
  girders measured on a June 2020 street photo gives about **4.9 ± 0.2 m**, marginal for the 4.8 m convoy, and only the clear
  height registered with GDDKiA Szczecin can settle it. The card names the way round if it is too low, and the A6 border works
  just west of the junction.
- **A 11 at Buckow, "3.50 m, too low": not too low.** The 3.50 m came from the surface model made from aerial images, which
  barely sees a track bridge 3 to 4 m wide. Brandenburg's laser point cloud puts the deck top 6.8 to 6.9 m above the road
  (re-measured for this version), so the bridge clears about **5.8 ± 0.4 m** and the page now rates it **"passes"**.

**Three more corrections the review proved.** At **Brehna** the footbridge at km 354.6 showed 11.6 m, "passes": that is the crown
of a steel arch (OpenStreetMap maps it as an arch bridge; street photos), and the walkway hangs below it, unmeasured. It is now
"check". At **Hohengüstow** the "path" bridge at km 76.5 (5.8 m, "passes") is the footway on the B 198 bridge, one structure
with it, so it now has the bridge's 4.9 ± 0.45 m, "check". At **Röthenbachtal** the bridge over the A 9 at the Nürnberg
interchange carries the A 3, not the A6, and the card now says so.

**Guide posts at the road edge.** The road view's guide posts are modelled: one every 50 m (closer in curves), 0.5 m beyond
the traced road edge. Where an edge was traced again later, its posts had stayed at the old place. 1,585 of them stood on the
carriageway, and 2,537 were more than 5 cm out. Each one now stands 0.5 m beyond the edge the road view draws (in 135 of the 155
road data files). Where a traced edge is itself too narrow (see below) the posts follow it. The passage views keep their own
copy of the posts and are unchanged. 896 posts in 53 passages are still at the old place there.

**Not done: Saxony's terrain.** Doberstau and Werlitzsch keep the 8 m terrain from Saxony's height service, and they have no
trees at all. Version 5 said they had trees from the land-cover map, which was wrong. Saxony's 1 m terrain and surface tiles can
be downloaded (geocloud.landesvermessung.sachsen.de, 2 km tiles `dgm1_33<E>_<N>_2_sn_tiff.zip` and `dom1_…`). Rebuilding the two
passages needs their work data, which were not kept after version 5. The review checked both clear heights there against
Saxony's point heights, and they match.

### What the review found that is not changed yet

These come from the review notes. They need new tracing, registered heights or a rebuild of a passage, so this version does not
change them:

- **Places outside every passage.** The A6 border works at km 44.4–45.2: a new viaduct is being built and both directions run on
  one carriageway, so the convoy would be in a contraflow lane that no passage covers. Cantilever signs and gantries over the
  convoy's carriageway are missing from the clear-height list: km 73.13 (A 11), km 279.83 (A 9, before Neue Mühle) and km
  490.55 (A 9, after Blintendorf). Inside passages: Tautendorf km 447.11, Sachsenvorwerk km 495.28 and one at Hohengüstow. All
  of them need registered clear heights.
- **Traced edges too narrow.** Köselitz (A 9) km 299.70–299.76: the card's blade beyond the edge, 0.6 m, comes from this.
  Vockerode km 317.32–317.50, Heideland km 423.50–423.70, Raila km 482.90–482.97, the Blintendorf passage trace (its 0.89 m
  "wheels off the paved area"), and the Oberaltenreuth notch at km 546.81–546.85. Guide posts placed by these edges still
  stand on the carriageway there.
- **Clear heights the reviewers measured but this version does not re-measure.** In Brandenburg's laser data, Zu den Ihlowbergen
  (km 109.3) has a deck top of 6.30 m against the page's 5.88 m. The Wandlitz junction (km 142.25, a motorway link) has 6.16 m
  against 6.30 m. Schmetzdorf has 6.22 m and 6.17 m against 6.38 m and 6.29 m. Spans that are arched or haunched at Radewitz,
  Heidehof, the track at km 77.47 and the Trumpf wildlife overpass are estimated as flat decks, which is optimistic over the
  outer lanes.
- **A possible duplicate.** The Oberaltenreuth "unknown" structure at km 547.72 is the BT 46 bridge under construction, beside
  the existing one. It stays listed, because the new bridge may be standing by the transport date.
- **What the scan counted but is not there.** Km posts mapped on the carriageway (Kößlitz-Wiedebach, Kleinhelmsdorf, Heideland,
  Tautendorf). The speed-limit signs on the B 16 at Seehof, Zell, Fleischnershausen and Unterhausen are inferred from the
  map's speed limits, not mapped. The Feldkirchen lamps are wall lamps in underpasses. Sign 448 at Blintendorf is on a
  cantilever, not a ground plate. The Kößlitz-Wiedebach guard rail is on the road under the bridge. Tautendorf's 15 % grade is
  the valley under the bridge. The objects at Klengel and Tautendorf do not show on the aerial photo.
- **Names.** Plötzin's overpass is the Bochower Weg. Zeestow's "trunk" is the B 5. Althüttendorf's are the K 6016 and the
  B 198. Several "motorway" structures are slip roads. Both Köselitz passages share one title (the second is the B 107 at the
  Coswig junction). At the Nürnberg interchange the A 9 bridge BW 373c is being replaced (until the end of 2026): check the
  lane layout at Röthenbachtal for the transport date.

### The blade beyond the road edge in both views, all 68 passages

Measured again on version 6 (the same build tools, all 68 passages): every passage gives the same figures as in version 5, in both views. None of this version's changes touches the blade (the corrected bridge heights do not change the passages' outlines).

| Passage (km) | Passage view: card · painted | Drive view: up to · drawn | Differ by |
|---|---|---|---|
| Yard exit, Łozienica (0–3.65) | 26.5 m · 6281 m² · 6280 m² | 26.5 m · 6281 m² | 28 m² |
| S3 near Warcisławiec *(new)* (5.65–6.45) | no | no | 0 m² |
| S3 at Kliniska Małe *(new)* (11.38–12.17) | no | no | 0 m² |
| A6 near Załom *(new)* (16.66–17.94) | no | no | 0 m² |
| A6 near Kołowo *(new)* (24.04–24.84) | no | no | 0 m² |
| A6 near Radziszewo *(new)* (33.66–34.46) | no | no | 0 m² |
| A6 at Kołbaskowo *(new)* (42.39–43.18) | no | no | 0 m² |
| A 11 at Nadrensee *(new)* (48.59–49.39) | no | no | 0 m² |
| A 11 at Radewitz *(new)* (61.93–62.73) | no | no | 0 m² |
| A 11 at Hohengüstow *(new)* (74.02–77.62) | no | no | 0 m² |
| A 11 at Heidehof *(new)* (79.8–80.6) | no | no | 0 m² |
| A 11 near Trumpf *(new)* (83.33–84.13) | no | no | 0 m² |
| A 11 near Neuhaus *(new)* (97.62–98.42) | no | no | 0 m² |
| A 11 at Redernswalde *(new)* (100.51–101.31) | no | no | 0 m² |
| A 11 at Althüttendorf *(new)* (108.21–110.75) | no | no | 0 m² |
| A 11 at Buckow *(new)* (118.35–119.14) | no | no | 0 m² |
| A 11 at Finowfurt *(extended)* (124.83–125.97) | no | no | 0 m² |
| A 11 near Woltersdorf *(new)* (141.8–142.6) | no | no | 0 m² |
| A 11 at Schmetzdorf *(new)* (146.24–147.8) | no | no | 0 m² |
| A 10 near Lindenhof *(new)* (160.21–161.87) | no | no | 0 m² |
| A 10 at Briese (176.54–177.34) | no | no | 0 m² |
| A 10 near Groß-Ziethen (196.34–197.14) | no | no | 0 m² |
| A 10 at Paaren im Glien (201.93–202.73) | no | no | 0 m² |
| A 10 at Glien (205.71–206.5) | no | no | 0 m² |
| A 10 at Zeestow *(extended)* (211–213.44) | no | no | 0 m² |
| A 10 at Kartzow (220.32–221.12) | no | no | 0 m² |
| A 10 near Plötzin *(new)* (237.71–239.2) | 0.5 m · 4 m² · 4 m² | 0.5 m · 4 m² | 0 m² |
| A 9 near Reesdorf *(new)* (256.68–257.48) | no | no | 0 m² |
| A 9 at Neue Mühle *(new)* (279.93–280.72) | no | no | 0 m² |
| A 9 at Werdermühle *(new)* (283.97–284.77) | no | no | 0 m² |
| A 9 near Köselitz *(new)* (299.25–300.05) | 0.6 m · 6 m² · 6 m² | 0.6 m · 6 m² | 1 m² |
| A 9 near Köselitz *(new)* (302.15–302.95) | no | no | 0 m² |
| A 9 at Vockerode *(new)* (316.97–317.77) | no | no | 0 m² |
| A 9 near Brehna *(new)* (353.88–354.68) | no | no | 0 m² |
| A 9 at Doberstau *(new)* (358.24–359.04) | no | no | 0 m² |
| A 9 at Werlitzsch *(new)* (368.12–368.92) | no | no | 0 m² |
| A 9 at Rippach *(new)* (392.9–393.7) | no | no | 0 m² |
| A 9 near Kößlitz-Wiedebach *(new)* (401.13–401.92) | no | no | 0 m² |
| A 9 at Kleinhelmsdorf *(new)* (418.09–418.89) | no | no | 0 m² |
| A 9 at Heideland *(new)* (423.16–423.96) | no | no | 0 m² |
| A 9 at Klengel *(new)* (429.82–431.31) | no | no | 0 m² |
| A 9 at Tautendorf *(new)* (444.74–447.23) | no | no | 0 m² |
| A 9 at Raila *(new)* (482.41–483.21) | no | no | 0 m² |
| A 9 at Blintendorf *(new)* (489.63–490.43) | no | no | 0 m² |
| A 9 at Sachsenvorwerk *(new)* (494.79–495.59) | no | no | 0 m² |
| A 9 at Schwarzholzwinkel *(new)* (517.01–517.81) | 0.6 m · 6 m² · 6 m² | 0.6 m · 6 m² | 1 m² |
| A 9 at Gössenreuth *(new)* (542.59–543.39) | no | no | 0 m² |
| A 9 at Oberaltenreuth *(new)* (546.56–547.87) | no | no | 0 m² |
| A 9 near Bayreuth (553.91–554.7) | no | no | 0 m² |
| A 9 near Neunkirchen am Sand *(new)* (615.24–616.76) | no | no | 0 m² |
| A 9 at Steinberg (621.15–621.95) | no | no | 0 m² |
| A 9 at Röthenbachtal (623.19–623.99) | no | no | 0 m² |
| A 9 near Feucht *(new)* (631.32–632.12) | no | no | 0 m² |
| A 9 at Feucht *(new)* (634.05–635.27) | no | no | 0 m² |
| A 9 at Feldkirchen *(new)* (707.75–709.33) | no | no | 0 m² |
| B 16 at Pichl *(extended)* (715.67–716.89) | 5.7 m · 771 m² · 774 m² | 5.7 m · 771 m² | 13 m² |
| B 16 at Seehof *(extended)* (720.69–721.97) | 0.9 m · 49 m² · 50 m² | 0.9 m · 49 m² | 3 m² |
| B 16 at Obermühle *(extended)* (728.51–731.66) | no | no | 0 m² |
| B 16 at Zell *(extended)* (733.39–736.61) | no | no | 0 m² |
| B 16 at Fleischnershausen *(extended)* (737.18–740.42) | 23.2 m · 2061 m² · 2054 m² | 23.2 m · 2056 m² | 23 m² |
| B 16 at Kalkbauer (741.27–742.11) | 1.5 m · 80 m² · 82 m² | 1.5 m · 80 m² | 6 m² |
| B 16 at Höfelhof *(extended)* (742.95–745.52) | 2.0 m · 228 m² · 227 m² | 2.0 m · 228 m² | 24 m² |
| B 16 at Unterhausen *(extended)* (746.47–749.28) | 2.0 m · 269 m² · 270 m² | 2.0 m · 269 m² | 20 m² |
| B 16 at Moos (750.58–754.45) | 1.2 m · 26 m² · 26 m² | 1.2 m · 26 m² | 2 m² |
| B 16 at Neuhof *(new)* (756.39–758.87) | no | no | 0 m² |
| B 16 → St 2047 at Feldheim *(extended)* (759.92–762.21) | 18.2 m · 4186 m² · 4188 m² | 18.2 m · 4186 m² | 43 m² |
| DON 30 → St 2047 near Unterpeiching (763.82–767.55) | 21.7 m · 3605 m² · 3601 m² | 21.7 m · 3604 m² | 51 m² |
| St 2047 near Pessenburgheim → crane pad (768.87–774.77) | 27.6 m · 15270 m² · 15268 m² | 27.6 m · 15269 m² | 101 m² |

The passage view's card and painted area, and the drive view's largest figure along the passage with the area it drew;
"differ by" is the ground that only one of the two views paints red (outlines drawn at slightly different resolutions and, in
the drive view, the convoy just before the passage).

### Checks

**What changed in the data.**

- **Page data** (route.json): it differs from version 5 only in two ways:
  - the review notes and measures of 56 passages (the 55 reviewed ones and Röthenbachtal);
  - five clear-height records: the Kołbaskowo limit is gone, also from the map's list of limits, and the Kołbaskowo, Buckow, Brehna and Hohengüstow bridges are corrected.
- **Road data files**: only the guide posts' offsets (135 files) and those clear-height records (four files) changed.
- **Passage data files**: only the heights of the four corrected bridges changed.
- **How the notes went in**: through `tools/route_evidence_apply.py`, which writes them as the bake does. Run with version 5's notes, it reproduces version 5's page data byte for byte.
- **How the clear heights went in**: through `tools/route_clear_fix.py` from `clear_fixes.json`, each fix with its reason. It rebuilds the "check the clear height" measure the way the bake builds it, and it reproduces all 48 such measures of version 5.

**Fingerprints** (headless browser, version 5 against version 6): checked at ten road points (km 37.2, 42.8, 76.5, 118.8, 266.1, 354.6, 437.0, 547.2, 722.0 and 750.6) and in seven passages (Kołbaskowo, Buckow, Brehna, Hohengüstow, Pichl, Zell and Oberaltenreuth).

- **Road data files**: in every one, the decoded data and the aerial photo are the same, and so is the header once the guide posts' offsets are masked (apart from the corrected clear heights in four of them). Of its meshes, only the two instanced ones for the guide posts and their reflectors changed, with the same number of instances.
- **Corrected clear heights**, the only other changes: at Kołbaskowo the 4.0 m limit's gate is gone and the DK13 bridge's gate shows the new estimate; at Buckow the bridge's gate now shows "passes"; at Brehna the footbridge has no gate any more, because its height is unknown and the list of clear heights rates it "check"; at Hohengüstow the footway's gate shows the B 198 bridge's height.
- **Along the road**: the swept path and the objects and their labels are the same.
- **Passages**: only the height labels of the corrected bridges at Kołbaskowo and Buckow changed.
- **Page errors**: none.

**The blade**, measured again in both views at all 68 passages: every one of the 68 rows is the same as in version 5 (the table above), and the two views agree within 0 to 101 m². The only console messages were the test machine's certificate errors for outside resources.

**Speed** (software drawing, one run each, with another browser running): the page loads as before, with the first map picture
at 1.7 s in version 5 and 1.5 s now. Driving draws exactly the same: at km 722, 144 draw calls and 421,717 triangles in both.
Opening the road and the passages varies within the noise of the shared machine: the road 5.6 / 5.1 s against 5.9 / 5.4 s, Zell
19 s against 23 s, Moos 13 s against 10 s. The number of guide posts is the same, so nothing changes per frame.

**Downloaded the page file?** The data key is the same as version 5's. The website still holds the first version, so a copy
opened from disk shows the overview until the website is updated from this folder.

### Earlier versions

#### Version 5 (2026-10-17): every place where the blade may have trouble is a passage

The owner's rule: *show every single place on the route where the blade may have trouble in passing.* So the whole route was
scanned with the page's own code: the default V172 convoy drove all 775 km on the convoy's line (the swept-path model of the
drive view), and every metre was checked for

- **the blade beyond the edge** of the carriageway traced on the aerial photo (more than its 0.3 m tolerance; the model of
  version 4),
- **the blade over what stands beside the road, at its real height**: signals, lamps, poles (the road view's labels), road signs
  at their plate sizes and mounting heights, guide posts, kilometre posts, walls, noise barriers, fences, hedges, guard rails
  and buildings, against the blade's underside across its section (1.6 m at the rear support, rising to 3.2 m at the tip,
  lower over the root), and **trees** whose crowns reach into the blade's swing beyond the edge,
- **the wheels** beyond the traced edge, and **the structures over the road** whose clear height is "too low" or "to check".

It found 132 such troubles outside the 23 passages, at 83 places along the route (mapping slips — a guard rail or a sign mapped on
the carriageway itself, a bridge mapped as a building — were left out). Each is now shown: a place within 1.5 km of a passage
extends it, the others are new passages (places within 2 km share one), from 250 m before the first trouble to 150 m after the
last. **Pichl** now starts at km 715.67 instead of 716.09, so it contains the blade's overhang before it (front axle at km
715.92 to 716.07) with 250 m to spare. Ten passages are extended, 45 are new, 68 in all. A second scan of the finished page
finds no trouble left outside a passage.

The new passages have the same survey-grade data as the others: the state's 20 cm aerial photo with the carriageway traced on
it, the 1 m laser terrain and surface model (trees), LoD2 buildings in Bavaria, mapped buildings elsewhere, signs, bridges and
the convoy driven through them. One thing differs: in **Saxony** (Doberstau, Werlitzsch) the state's terrain comes through its
height service one point at a time, so those two have the terrain at 8 m spacing and their trees from the land-cover map.

With the traced paved surface many motorway places turn out to be paved shoulder, ramp or lay-by: their blade "beyond the edge"
drops to nothing in the passage. What remains is in the table (last column).

##### The places found, and where they are shown

| Passage | km (front axle) | What the scan found outside the passages (default convoy) | After the survey: blade beyond the edge |
|---|---|---|---|
| S3 near Warcisławiec (new) | 5.65–6.45 | clear height 5.30 ± 0.80 m (check) under a covered section / overpass at km 6.095 | none |
| S3 at Kliniska Małe (new) | 11.38–12.17 | clear height 4.96 ± 0.35 m (check) under footway at km 11.825 | none |
| A6 near Załom (new) | 16.66–17.94 | clear height 5.25 ± 0.80 m (check) under a covered section / overpass at km 16.913; clear height 4.93 ± 0.40 m (check) under service at km 17.787 | none |
| A6 near Kołowo (new) | 24.04–24.84 | clear height 5.02 ± 0.40 m (check) under Kozia at km 24.489 | none |
| A6 near Radziszewo (new) | 33.66–34.46 | clear height 5.00 ± 0.40 m (check) under Bielańska at km 34.113 | none |
| A6 at Kołbaskowo (new) | 42.39–43.18 | signed height limit 4.0 m on the A6 (map) at km 42.814 (too low); clear height 4.76 ± 0.45 m (check) under primary + cycleway at km 42.857 | none |
| A 11 at Nadrensee (new) | 48.59–49.39 | clear height 4.97 ± 0.40 m (check) under Dorfstraße at km 49.039 | none |
| A 11 at Radewitz (new) | 61.93–62.73 | clear height 5.13 ± 0.40 m (check) under unclassified at km 62.384 | none |
| A 11 at Hohengüstow (new) | 74.02–77.62 | clear height 5.13 ± 0.50 m (check) under motorway at km 74.268; clear height 5.18 ± 0.40 m (check) under track at km 74.548; clear height 4.79 ± 0.40 m (check) under Lützlower Damm at km 75.709; clear height 4.90 ± 0.45 m (check) under Gramzower Straße at km 76.509; clear height 4.94 ± 0.40 m (check) under track at km 77.469 | none |
| A 11 at Heidehof (new) | 79.8–80.6 | clear height 5.15 ± 0.40 m (check) under tertiary at km 80.250 | none |
| A 11 near Trumpf (new) | 83.33–84.13 | clear height 4.37 ± 0.80 m (check) under a covered section / overpass at km 83.777 | none |
| A 11 near Neuhaus (new) | 97.62–98.42 | clear height 6.14 ± 0.80 m (check) under a covered section / overpass at km 98.073 | none |
| A 11 at Redernswalde (new) | 100.51–101.31 | clear height 4.78 ± 0.40 m (check) under Angermünder Straße at km 100.957 | none |
| A 11 at Althüttendorf (new) | 108.21–110.75 | clear height 5.04 ± 0.40 m (check) under Neugrimnitzer Straße at km 108.460; clear height 4.88 ± 0.40 m (check) under Zu den Ihlowbergen at km 109.300; clear height 4.98 ± 0.45 m (check) under primary at km 110.600 | none |
| A 11 at Buckow (new) | 118.35–119.14 | clear height 3.50 ± 0.40 m (too low) under track at km 118.795 | none |
| A 11 at Finowfurt (extended, was km 124.83–125.62) | 124.83–125.97 | clear height 4.99 ± 0.40 m (check) under Fichtenweg at km 125.825 | none |
| A 11 near Woltersdorf (new) | 141.8–142.6 | clear height 4.80 ± 0.50 m (check) under motorway at km 142.250 | none |
| A 11 at Schmetzdorf (new) | 146.24–147.8 | clear height 5.18 ± 0.40 m (check) under Wandlitzer Chaussee at km 146.491; clear height 5.09 ± 0.40 m (check) under Schönower Chaussee at km 147.651 | none |
| A 10 near Lindenhof (new) | 160.21–161.87 | clear height 4.47 ± 0.60 m (check) under Stettiner Bahn at km 160.455; clear height 4.93 ± 0.60 m (check) under standard_gauge at km 160.895; clear height 4.81 ± 0.40 m (check) under Hobrechtsfelder Chaussee at km 161.715 | none |
| A 10 at Zeestow (extended, was km 211–212.73) | 211–213.44 | clear height 5.13 ± 0.50 m (check) under trunk at km 213.286 | none |
| A 10 near Plötzin (new) | 237.71–239.2 | blade 0.48 m beyond the traced edge, km 237.960–237.965; clear height 5.15 ± 0.40 m (check) under Plötziner Straße at km 239.050 | up to 0.5 m · 4 m² |
| A 9 near Reesdorf (new) | 256.68–257.48 | clear height 5.96 ± 0.80 m (check) under a covered section / overpass at km 257.131 | none |
| A 9 at Neue Mühle (new) | 279.93–280.72 | clear height 5.22 ± 0.45 m (check) under primary + path at km 280.375 | none |
| A 9 at Werdermühle (new) | 283.97–284.77 | clear height 5.64 ± 0.80 m (check) under a covered section / overpass at km 284.423 | none |
| A 9 near Köselitz (new) | 299.25–300.05 | blade 0.62 m beyond the traced edge, km 299.733–299.755 (2 stretches) | up to 0.6 m · 6 m² |
| A 9 near Köselitz (new) | 302.15–302.95 | clear height 5.24 ± 0.45 m (check) under primary + path at km 302.596 | none |
| A 9 at Vockerode (new) | 316.97–317.77 | wheels 0.49 m beyond the traced edge, km 317.317–317.342 (2 stretches); blade 0.94 m beyond the traced edge, km 317.327–317.352 (3 stretches) | none |
| A 9 near Brehna (new) | 353.88–354.68 | clear height 5.23 ± 0.50 m (check) under motorway at km 354.335 | none |
| A 9 at Doberstau (new) | 358.24–359.04 | clear height 5.15 ± 0.40 m (check) under secondary at km 358.690 | none |
| A 9 at Werlitzsch (new) | 368.12–368.92 | clear height 5.06 ± 0.50 m (check) under motorway at km 368.570 | none |
| A 9 at Rippach (new) | 392.9–393.7 | clear height 5.18 ± 0.50 m (check) under motorway at km 393.332; clear height 5.23 ± 0.50 m (check) under motorway at km 393.372 | none |
| A 9 near Kößlitz-Wiedebach (new) | 401.13–401.92 | blade over a sign km (1.40 m high, 0.29 m free), km 401.567 | none |
| A 9 at Kleinhelmsdorf (new) | 418.09–418.89 | blade over a sign km (1.40 m high, 0.31 m free), km 418.531 | none |
| A 9 at Heideland (new) | 423.16–423.96 | blade 0.55 m beyond the traced edge, km 423.602–423.624; blade over a sign km (1.40 m high, 0.05 m free), km 423.602 and 1 more | none |
| A 9 at Klengel (new) | 429.82–431.31 | blade 1.33 m beyond the traced edge, km 430.068–430.098 (2 stretches) | none |
| A 9 at Tautendorf (new) | 444.74–447.23 | blade over a sign km (1.40 m high, 0.03 m free), km 447.041 and 1 more | none |
| A 9 at Raila (new) | 482.41–483.21 | blade 0.70 m beyond the traced edge, km 482.968–483.003 (2 stretches); blade over a guide post (1.05 m high, 0.47 m free), km 482.969; wheels 0.27 m beyond the traced edge, km 482.973–482.989 | none |
| A 9 at Blintendorf (new) | 489.63–490.43 | blade over a sign 448 (4.50 m high, 3.02 m too low), km 490.033 | none |
| A 9 at Sachsenvorwerk (new) | 494.79–495.59 | blade 0.36 m beyond the traced edge, km 495.242–495.243 | none |
| A 9 at Schwarzholzwinkel (new) | 517.01–517.81 | blade 0.59 m beyond the traced edge, km 517.453–517.460 | up to 0.6 m · 6 m² |
| A 9 at Gössenreuth (new) | 542.59–543.39 | clear height 4.92 ± 0.45 m (check) under primary at km 543.039 | none |
| A 9 at Oberaltenreuth (new) | 546.56–547.87 | wheels 1.06 m beyond the traced edge, km 546.813–546.845; blade 1.52 m beyond the traced edge, km 546.824–546.869 (2 stretches); guide post in the wheels' path, km 546.833; sign km in the wheels' path, km 546.837; clear height 5.22 ± 0.50 m (check) under unknown at km 547.718 | none |
| A 9 near Neunkirchen am Sand (new) | 615.24–616.76 | clear height 5.13 ± 0.60 m (check) under Nürnberg–Cheb at km 615.492; clear height 5.22 ± 0.60 m (check) under Nürnberg–Schwandorf at km 616.611 | none |
| A 9 near Feucht (new) | 631.32–632.12 | clear height 5.20 ± 0.50 m (check) under motorway at km 631.763; clear height 5.19 ± 0.50 m (check) under motorway at km 631.783 | none |
| A 9 at Feucht (new) | 634.05–635.27 | clear height 5.11 ± 0.40 m (check) under Josef-Schlosser-Weg at km 634.302; clear height 5.17 ± 0.50 m (check) under motorway at km 635.101; clear height 5.13 ± 0.50 m (check) under motorway at km 635.121 | none |
| A 9 at Feldkirchen (new) | 707.75–709.33 | street lamp in the wheels' path, km 708.001; street lamp in the wheels' path, km 709.156 | none |
| B 16 at Pichl (extended, was km 716.09–716.89) | 715.67–716.89 | blade over a guide post (1.05 m high, 0.02 m too low), km 715.950 and 10 more; blade 7.28 m beyond the traced edge, km 715.920–716.070 | up to 5.7 m · 771 m² |
| B 16 at Seehof (extended, was km 720.69–721.49) | 720.69–721.97 | blade 0.35 m beyond the traced edge, km 721.648–721.659 (3 stretches); blade over a sign 274 (2.60 m high, 1.14 m too low), km 721.673 and 1 more | up to 0.9 m · 49 m² |
| B 16 at Obermühle (extended, was km 729.89–730.88) | 728.51–731.66 | clear height 5.11 ± 0.40 m (check) under tertiary at km 728.757; clear height 5.02 ± 0.40 m (check) under unclassified at km 729.217; clear height 4.87 ± 0.45 m (check) under primary at km 731.516 | none |
| B 16 at Zell (extended, was km 733.39–735.91) | 733.39–736.61 | blade over a sign 274 (2.75 m high, 0.82 m too low), km 736.361 and 2 more | none |
| B 16 at Fleischnershausen (extended, was km 737.18–738.06) | 737.18–740.42 | blade 0.84 m beyond the traced edge, km 738.107–738.125; tree (crown 4.9 m, 10 m high) in the blade swing, km 738.111; tree (crown 5.5 m, 15 m high) in the blade swing, km 738.120; blade over a sign 274 (2.60 m high, 1.14 m too low), km 739.398; clear height 4.78 ± 0.40 m (check) under Augsburger Straße at km 739.991; clear height 4.85 ± 0.40 m (check) under track at km 740.271 | up to 23.2 m · 2061 m² |
| B 16 at Höfelhof (extended, was km 744.01–745.52) | 742.95–745.52 | blade 1.17 m beyond the traced edge, km 743.563–743.707 (3 stretches) | up to 2.0 m · 228 m² |
| B 16 at Unterhausen (extended, was km 747.85–748.95) | 746.47–749.28 | blade over a sign 274 (2.75 m high, 1.26 m too low), km 746.722 and 2 more; blade 0.38 m beyond the traced edge, km 749.124–749.137 | up to 2.0 m · 269 m² |
| B 16 at Neuhof (new) | 756.39–758.87 | clear height 5.04 ± 0.40 m (check) under unclassified at km 756.640; clear height 4.96 ± 0.40 m (check) under unclassified at km 758.719 | none |
| B 16 → St 2047 at Feldheim (extended, was km 760.39–761.54) | 759.92–762.21 | clear height 4.97 ± 0.40 m (check) under secondary at km 760.165; blade 0.78 m beyond the traced edge, km 761.549–761.560 (3 stretches); blade over a guide post (1.05 m high, 0.41 m free), km 762.051 | up to 18.2 m · 4186 m² |

##### Checks

Nothing else changed: the 13 passages that are neither new nor extended, and the road view at six points, have the same
fingerprints as version 4 (0 differences; the route data of those passages are byte for byte the same). The pictures differ only
in the list of survey points, the route's markers and the blade drawn where a new passage now holds the measure.

**Speed** (no graphics card on the test machine, software drawing; version 4 and 5 two runs each): the page loads as fast (first
map picture 1.4 s in both); the road view and driving are unchanged (the same draw calls and triangles, no new long tasks, the
script's share of a frame at most 16 ms when skipping ahead at speed); the unchanged passages open as before, the extended ones
in proportion to their new length (Feldheim, now twice as long: 12–13 s instead of 5–11 s here) and the new ones in 3–11 s
(Hohengüstow, 3.6 km, the longest). The page file grows from 1.6 to 2.5 MB (the cards, outlines and aerial thumbnails of 45
more passages) and the passage data from 35 to 102 MB (two files per new passage, 0.6–3.1 MB each, loaded only when a passage
is opened). 60 fps at 1440p / 4K is for a real graphics card to confirm; the per-frame work of the road view did not grow.

**Downloaded the page file?** This version's road and passage data carry a new key, so a copy opened from disk can use the
website's data only once the website has been updated from this folder (until then it shows the overview and says so).

#### Version 4 (2026-10-16): the blade beyond the road edge is one measure, the same in the passage and in the drive

The red area "blade beyond the road edge" and its figures ("up to … m · … m²") came from two different calculations, and
they disagreed, often by a factor of two or more (table below):

- **The passage view** (what opens when you click a passage) took the blade's outline only every 2 m of the drive. In a bend
  the tip swings several metres between two such snapshots, so the area was a comb with gaps: its card gave only a third to
  two thirds of the real area, and the painted area, which did not even match the card, 40 to 90 %. It measured against the
  mapped road network widened by typical road widths, not the edge traced on the aerial photo.
- **The drive view** ("Drive this passage with your vehicle") painted, at the spot of the tractor's front axle, how far out
  the blade reached somewhere behind it. So the red strip sat up to 90 m too far forward and had the wrong shape. Its figure
  could also pick the wrong part of the road in tight turns (at Pessenburgheim it showed the blade 80 m beyond the edge, more
  than the blade's whole overhang), and a junction mouth or a slip road counted as verge.

**Now both views use one model, and it is the accurate one:**

1. **The real convoy:** the vehicle of the page (its default V172 convoy, or your own) drives the convoy's line with the same
   swept-path model as before. The wheels, their paths, the convoy and its steering are unchanged.
2. **The real blade:** its outline as drawn (root frame, then the blade's sections as carried), taken at every place it
   passes: every metre of the drive and the places between, as finely as the tip moves, so the swinging tip leaves no gaps.
3. **The real road edge:** what counts as beyond is the ground outside the carriageway traced on the aerial photo and, at the
   passages, outside the paved surface traced there: a junction mouth, a slip road or a lay-by is road, not verge. Less than
   0.3 m beyond the traced edge (its measuring tolerance) is not counted.
4. **The figures:** the area is the ground the blade sweeps beyond that edge; "up to" is the farthest the blade reaches from
   the paved surface.

Why this model: it is the only one of the three that follows the blade everywhere it actually goes and measures against the
road as it is on the ground, so it is the one that is right; the other two were approximations of it (snapshots, or a figure
moved to the front axle). Each passage is computed once with the page's own code when the data are built
(`tools/route_blade.mjs`, which runs `src/route/bladeedge.js`): the passage view paints exactly that area and its card states its
figures; when you drive the passage with the default convoy, the drive view draws the same area and its card shows the same
figures, metre by metre. Before and after the passages, and with your own vehicle, the drive measures the same way as it goes
(in the background, so driving stays smooth). The thin red line of the blade's outer sweep in the drive view now runs where the
blade really passes, too.

The trees counted "in the blade swing" and the lane list's blade figures follow the new area. Nothing else changed: road
widths and edges, trees, signs, signals, clear heights, wheel paths and convoy poses are identical to version 3 (checked with
the fingerprint tools on all 23 passages and along the road view: 0 differences outside the blade beyond the edge).

**Speed:** the passages draw exactly as before (the same draw calls and triangles). In the drive view the blade is now 4 drawn
pieces instead of 6; its measure runs in the background thread (on the test machine it adds 0.1 to 0.6 s before a new 1.9 km
stretch's swept path is ready, well ahead of the convoy) and its drawing is about 10 ms of work per stretch, done in small
slices. Frame times in the test were unchanged. The test machine draws in software (no graphics card), so 60 fps at
1440p / 4K is for a real graphics card to confirm; the graphics card's work per frame did not grow (draw calls the
same or fewer, triangles within 2 %, mostly fewer).

#### Version 4: the blade beyond the road edge, before and after

| Passage | Before: passage view, card (up to · area) and painted area | Before: drive view (up to · area drawn) | Before: areas differ by | After: passage view, card and painted | After: drive view | After: areas differ by |
|---|---|---|---|---|---|---|
| Yard exit, Łozienica (km 0) | 21.0 m · 2202 m² (painted 3572) | 40.6 m · 6583 m² | 8511 m² | 26.5 m · 6281 m² (painted 6280) | 26.5 m · 6281 m² | 20 m² |
| A 11 at Finowfurt (km 124.83) | no | no | 0 m² | no | no | 0 m² |
| A 10 at Briese (km 176.54) | no | no | 0 m² | no | no | 0 m² |
| A 10 near Groß-Ziethen (km 196.34) | no | no | 0 m² | no | no | 0 m² |
| A 10 at Paaren im Glien (km 201.93) | no | no | 0 m² | no | no | 0 m² |
| A 10 at Glien (km 205.71) | no | no | 0 m² | no | no | 0 m² |
| A 10 at Zeestow (km 211) | no | no | 0 m² | no | no | 0 m² |
| A 10 at Kartzow (km 220.32) | no | no | 0 m² | no | no | 0 m² |
| A 9 near Bayreuth (km 553.91) | no | no | 0 m² | no | no | 0 m² |
| A 9 at Steinberg (km 621.15) | no | no | 0 m² | no | no | 0 m² |
| A 9 at Röthenbachtal (km 623.19) | no | no | 0 m² | no | no | 0 m² |
| B 16 at Pichl (km 716.09) | 4.6 m · 157 m² (painted 189) | 4.5 m · 1302 m² | 1462 m² | 4.5 m · 235 m² (painted 235) | 4.5 m · 620 m² | 389 m² |
| B 16 at Seehof (km 720.69) | 0.7 m · 6 m² (painted 5) | 1.0 m · 80 m² | 86 m² | 0.7 m · 14 m² (painted 15) | 0.7 m · 14 m² | 1 m² |
| B 16 at Obermühle (km 729.89) | no | 0.1 m · 16 m² | 16 m² | no | no | 0 m² |
| B 16 at Zell (km 733.39) | no | 0.3 m · 37 m² | 37 m² | no | no | 0 m² |
| B 16 at Fleischnershausen (km 737.18) | 15.0 m · 1093 m² (painted 1201) | 26.0 m · 2063 m² | 2657 m² | 22.3 m · 2056 m² (painted 2049) | 22.3 m · 2064 m² | 22 m² |
| B 16 at Kalkbauer (km 741.27) | 1.5 m · 43 m² (painted 37) | 1.5 m · 106 m² | 114 m² | 1.5 m · 80 m² (painted 82) | 1.5 m · 80 m² | 4 m² |
| B 16 at Höfelhof (km 744.01) | 2.0 m · 62 m² (painted 61) | 2.0 m · 295 m² | 356 m² | 2.0 m · 130 m² (painted 130) | 2.0 m · 129 m² | 6 m² |
| B 16 at Unterhausen (km 747.85) | 2.1 m · 136 m² (painted 140) | 2.1 m · 350 m² | 387 m² | 2.0 m · 255 m² (painted 258) | 2.0 m · 255 m² | 13 m² |
| B 16 at Moos (km 750.58) | 1.1 m · 11 m² (painted 12) | 1.2 m · 286 m² | 298 m² | 1.2 m · 26 m² (painted 26) | 1.2 m · 26 m² | 1 m² |
| B 16 → St 2047 at Feldheim (km 760.39) | 16.9 m · 2506 m² (painted 3645) | 21.6 m · 5469 m² | 5669 m² | 18.0 m · 4148 m² (painted 4153) | 18.0 m · 4162 m² | 43 m² |
| DON 30 → St 2047 near Unterpeiching (km 763.82) | 20.9 m · 1814 m² (painted 2453) | 24.4 m · 4120 m² | 5825 m² | 21.7 m · 3605 m² (painted 3601) | 21.7 m · 3604 m² | 28 m² |
| St 2047 near Pessenburgheim → crane pad (km 768.87) | 26.1 m · 7836 m² (painted 9689) | 79.7 m · 17476 m² | 22268 m² | 27.6 m · 15270 m² (painted 15268) | 27.6 m · 15269 m² | 81 m² |

Before: the passage view's card and painted area; the drive view's largest figure along the passage and the area it drew.
After: the same for version 4. "Differ by" is the ground that only one of the two views paints red. What remains after is the
outline drawn at slightly different resolutions and, in the drive view, the blade of the convoy just before the passage begins.
At **Pichl** that is real and worth a look: the blade already reaches up to 7.3 m beyond the edge before the passage starts
(front axle at km 715.93 to 716.07, deepest at km 716.015), so the drive view shows 385 m² there that lie outside the passage's
stretch and so are not in the passage view. Version 3 showed it as well, in the drive view only.

#### Version 3 (2026-10-12)

Version 3: big passages open much faster on a slow graphics card (without a graphics card, the largest Hoßkirch
passage opens in about 25 s instead of 78 s), no "loading" hang, smoother fast driving and vehicle changes without a freeze, 3D
shaders prepared ahead, a frame-rate overlay with **P** / **Shift+P** (or `?perf` in the address). Its measurements were
unchanged from the first version.

## ▶ [Open in the browser](https://claude.ai/artifact/XBEDMHSwEk8XEtxkgVoDU9)

https://claude.ai/artifact/XBEDMHSwEk8XEtxkgVoDU9 — opens on claude.ai with everything included (version 6).

## 🌐 [Open the website](https://muensterroutesurvey.netlify.app)

https://muensterroutesurvey.netlify.app — the page on its own website: no login, no Claude branding. It is not connected to this repository, so it shows
the version it was last deployed with (the first version).

**Downloaded the page file?** It is the same page as the browser link and the website, but the road view and the
survey-grade passages are in the folders `r/` and `h/` (about 142 MB). Opened from disk, the page loads them from the website
(internet needed) and says so (until the website is updated it notes that its detail data are an older build: they are the
same data, only the blade figures inside the page are new); offline you see the overview only. For the full survey offline, keep `r/` and `h/` next to
the page, run `python3 -m http.server 8000` in the folder and open `http://localhost:8000/muenster-lech-blade-route.html`. The build date at the
end of *Sources and method* shows which version you have.

## Sharing

- **The browser link** (claude.ai) is private until you share it from the page's **Share** menu on claude.ai: either
  anyone with the link, or the people you invite by email.
- **The website** (Netlify) is a public address: no login and no Claude branding.
- **The HTML file alone** needs the website (internet) or a local web server with `r/` and `h/` next to it for the road
  view and the passages; without them it shows the overview only and says why.

## Your own website on Netlify (no Claude branding)

This folder is the complete website, ready to drop onto Netlify as it is:

- `muenster-lech-blade-route.html` — the page
- `r/` — road-view data for every 5 km, `h/` — the detailed survey points (loaded only when viewed, so the page stays fast)
- `_redirects` — makes the site's main address open the page directly

**Put it online (once, about 5 minutes):**

1. Get the folder: on the [repository page](https://github.com/NotJakobKristensen/Route-Surveys) click the green **Code** button → **Download ZIP**, then unzip it.
   You need the folder **`Muenster_Lech_Blade_Route`** from it (about 143 MB).
2. Open **https://app.netlify.com/drop** and sign up or log in (free). Log in first — a site dropped without an account is
   deleted after an hour.
3. Drag the whole **`Muenster_Lech_Blade_Route`** folder (not the files inside it) onto the drop area and wait for the upload to finish.
4. Netlify shows the address of your site, e.g. `https://random-name-123.netlify.app` — open it: the page starts directly.
5. Optional, a nicer address: **Site configuration → Change site name**, e.g. `muenster-lech-blade-route` → `https://muenster-lech-blade-route.netlify.app`.

**Share** that address with anyone: no login and no Claude branding. To update the site later, open it on Netlify →
**Deploys** and drag the new folder onto the drop area there; the address stays the same.

*Opening it on your own computer instead:* see **Downloaded the page file?** above.

---
Source code, tools and data pipeline:
[`windpark-hosskirch/routes/muenster-lech/` in the `Source` folder](https://github.com/NotJakobKristensen/Route-Surveys/tree/main/Source/windpark-hosskirch/routes/muenster-lech).
