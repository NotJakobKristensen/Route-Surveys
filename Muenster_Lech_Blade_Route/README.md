# Münster (Lech) Blade Route

Blind-test route survey for 84.3 m V172 blades from the Vestas blade plant in Goleniów (PL) to the five V172 at Münster (Lech), Donau-Ries, 775 km: routed and checked from open data only, without reports or local knowledge. Every difficult stretch found by the swept-path model is a 3D passage (22 plus the yard exit), on official survey-grade data (one in Poland, seven in Brandenburg, fifteen in Bavaria; Mecklenburg-Vorpommern and Saxony-Anhalt serve the same data, but no passage lies there); the clear heights of more than 300 structures over the route are measured against the 1 m laser terrain and, in Poland, Brandenburg and Bavaria, in the raw airborne laser point clouds (road under each bridge and deck top), and each passage was reviewed on the aerial photo with the measures it needs.

## Current version: 4 (2026-10-16)

[`muenster-lech-blade-route.html`](muenster-lech-blade-route.html) is version 4, the newest; only the newest version is kept here (owner, 2026-10-15), the
earlier ones are in the git history.

### What changed: the blade beyond the road edge is one measure, the same in the passage and in the drive

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

### The blade beyond the road edge, before and after

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

### Earlier versions

Version 3 (2026-10-12): big passages open much faster on a slow graphics card (without a graphics card, the largest Hoßkirch
passage opens in about 25 s instead of 78 s), no "loading" hang, smoother fast driving and vehicle changes without a freeze, 3D
shaders prepared ahead, a frame-rate overlay with **P** / **Shift+P** (or `?perf` in the address). Its measurements were
unchanged from the first version.

## ▶ [Open in the browser](https://claude.ai/artifact/XBEDMHSwEk8XEtxkgVoDU9)

https://claude.ai/artifact/XBEDMHSwEk8XEtxkgVoDU9 — opens on claude.ai with everything included (version 4).

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
