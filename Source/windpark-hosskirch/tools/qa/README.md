# QA tools for the route pages

The checks that cleared v2 and v3 (2026-10-12): a new build is published only with **0 fingerprint mismatches** against the
previous one. Headless Chromium with Playwright; serve the builds over http (`python3 -m http.server`), the pages fetch `r/` and `h/`
next to themselves.

| Script | What it does |
|---|---|
| `fid.cjs` | `node fid.cjs <url> <hk\|ml> <outdir>`: fingerprints (SHA-256) of the decoded data and the built scene: every road pack (decoded arrays, meshes, instances, matrices, materials), the live swept path at three road points, every HD passage (scene, data, convoy poses, swept path, labels); plus screenshots at fixed cameras, each twice (what differs between the two is time-animated). `HOTS=id,id` limits the passages, `KMS=k,k` sets the road points |
| `cmp.py` | `python3 cmp.py <base outdir> <new outdir>`: fingerprints must match exactly; screenshot pixels that differ outside the animated ones are listed. `BLADE=1`: the blade beyond the edge (its drawing in the road view, its painted area in the passages) is reported apart, everything else must match |
| `blade.cjs`, `blade_cmp.py` | `node blade.cjs <url> <out.json> [ids\|all] [new\|old]`, then `python3 blade_cmp.py <out.json>`: the blade beyond the edge in both views of every passage — the passage view's painted area and card, the drive view's drawn area (within the passage's corridor) and its figure along the passage — and how far the two differ |
| `rp.cjs` | `OUT=res.json node rp.cjs <url> <hk\|ml>`: per-frame bench (main-thread JS, render CPU, draw calls, triangles, programs linked in frames, long tasks) through load, map, road open/drive/fast, passage open/drive/close and UI phases; `PHASES=load` for load runs |
| `final.py`, `table.py` | before → after tables from two `rp.cjs` results (and load runs) |
| `hot1.cjs` | opens one passage (`HOTS=factory`), with the worker, upload and frame timings |
| `gpu.cjs`, `alloc.cjs` | GPU time per frame at a given resolution; allocations per frame |

The scripts were written on the build machine: the paths at the top (three.js r159 local copy, Chromium, Playwright) need setting.
Run browsers one at a time; software rendering (no GPU) makes absolute times slow, so compare builds A/B on the same machine.
