# Route Surveys: working notes

- Layout: page folders at the top (`Hosskirch_Blade_Route/`, `Muenster_Lech_Blade_Route/`, `Windpark_Hosskirch/`), the source in
  `Source/windpark-hosskirch/` (build commands run in `Source/`, see README.md). HTML files are named after their page, never `index.html`.
- **Measurement fidelity is the point of these pages**: road widths and edges, trees, signs, signals, clear heights and swept paths
  must not change through code or performance work. Prove it (fingerprints of the decoded data, meshes, swept paths and labels of
  every passage and several road points, against the previous build) before publishing.
- **Published versions are never overwritten**: a new build goes next to the old ones as `<page>-vN.html` (all versions share `r/`
  and `h/`), with a short note in the page folder's README.
- The packs `r/` and `h/` are built by the tools into `dist/` and copied next to the page by the build; the page fetches them
  relative to itself, and opened from disk falls back to the website named in the build.
- Netlify: the page folders carry `netlify.toml`, `_redirects`, `_headers` for drag-and-drop or a Git-connected site (base
  directory = the page folder); no site is connected to this repository yet.
- Raw downloads (terrain, point clouds, photos) are cached in `Source/windpark-hosskirch/.cache/` and `routes/*/.cache/`
  (git-ignored, tens of GB): they live only on the machine that downloaded them.
