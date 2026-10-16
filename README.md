# Route Surveys

Transport route surveys for 84.3 m V172 rotor blades from the blade plant in Goleniów (PL) to German wind farms, built from
open data (official aerial photos, laser terrain and point clouds, OpenStreetMap, road and bridge records), plus the 3D model
of Windpark Hoßkirch. Each survey is one page: the whole route on a 3D map, a road view along every kilometre, the clear
heights of every structure over the route, and every difficult passage driven in detail with a swept-path model.

Moved here from the WindLab repository on 2026-10-13; its history up to that move (commit `07e803d`) stays there.

| Folder | What it is |
|---|---|
| [`Hosskirch_Blade_Route/`](Hosskirch_Blade_Route/) | Goleniów → Windpark Hoßkirch (Baden-Württemberg), 935 km. The page `hosskirch-blade-route.html` (version 3, the newest; earlier versions in the git history); the data packs `r/` (road view) and `h/` (survey-grade passages); `windpark-hosskirch.html` |
| [`Muenster_Lech_Blade_Route/`](Muenster_Lech_Blade_Route/) | Goleniów → Münster (Lech), Donau-Ries (Bavaria), 775 km: a blind test, routed and checked from open data only. Same layout: `muenster-lech-blade-route.html` (version 4) and its packs |
| [`Windpark_Hosskirch/`](Windpark_Hosskirch/) | 1:1 3D rebuild of Windpark Hoßkirch (6 × V172-7.2 MW) |
| [`Source/windpark-hosskirch/`](Source/windpark-hosskirch/) | The source: page code (`src/`, `src/route/`), survey data (`data/`), build tools and the survey pipeline (`tools/`), further routes and route plans (`routes/`) |

Each page folder has its own README (how to open the page, how to put it online on Netlify).

## Open a survey on your computer

The road view and the passages load their data packs next to the page, which browsers only allow over a web server:

```sh
cd Hosskirch_Blade_Route          # or Muenster_Lech_Blade_Route
python3 -m http.server 8000       # then open http://localhost:8000/hosskirch-blade-route.html
```

## Build

```sh
cd Source
npm install                       # esbuild
npm run build:windpark            # windpark-hosskirch/src + data → windpark-hosskirch/windpark-hosskirch.html
npm run build:route               # Hoßkirch: src/route + data/route → windpark-hosskirch/hosskirch-blade-route.html (+ r/, h/)
ROUTE_ROOT=windpark-hosskirch/routes/muenster-lech npm run build:route   # Münster (Lech)
```

Then copy the built page next to its packs in the page folder, replacing the page there: only the newest version is kept (owner,
2026-10-15), earlier ones stay in the git history.

## A new route

The survey pipeline (`Source/windpark-hosskirch/tools/route_*.py`, `route_pack.py`, `route_hd_pack.py`) downloads what a
corridor needs (terrain, laser point clouds, aerial photos, road network) into `Source/windpark-hosskirch/.cache/` (git-ignored)
and writes the route's data; a new route lives in `Source/windpark-hosskirch/routes/<route>/` with its `route_config.json`
(see `routes/muenster-lech/`). Details: [`Source/windpark-hosskirch/README.md`](Source/windpark-hosskirch/README.md).
