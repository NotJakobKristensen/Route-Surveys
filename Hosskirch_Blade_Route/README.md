# Hoßkirch Blade Route

Route survey for the 84.3 m V172 blades from the blade plant in Goleniów (PL) to the crane pads of Windpark Hoßkirch, 935 km: the whole route on a 3D map, a road view along every kilometre on official aerial photos with 3D roads, bridges, signs and the convoy, and the difficult passages driven in detail with a swept-path model.

## 🆕 Version 3 (2026-10-12, evening): faster big passages, no loading hang

[`hosskirch-blade-route-v3.html`](hosskirch-blade-route-v3.html) builds on version 2:
- **Big passages open much faster on a slow graphics card.** While a view opens, the page stops drawing until the passage's data
  is on the graphics card, instead of handing it over one small portion per frame. Without a graphics card (software drawing),
  the largest Hoßkirch passage, the plant exit, now opens in about 25 s instead of about 78 s in version 2.
- **No more "loading" hang.** The background data reader is only given up when it fails or stops answering, never while it is
  still working.
- **Smoother fast driving** (the next stretch of the swept path is prepared ahead) and **vehicle changes without a freeze** (the new
  convoy is built beside the one shown, then swapped in).

The measurements are unchanged: compared with the current page on all 12 passages and along the road view, with 0 differences.
Version 2 and the current page stay as they are; all three use the same `r/` and `h/`. To open v3: in this folder run
`python3 -m http.server 8000` and open `http://localhost:8000/hosskirch-blade-route-v3.html`.

## Version 2 (2026-10-12): smoother, same survey

[`hosskirch-blade-route-v2.html`](hosskirch-blade-route-v2.html) is the same survey after a performance pass: the 3D shaders are prepared ahead, so a view
does not stutter the first time it opens; the road-view data is unpacked in the background and handed to the graphics card in small
steps; a frame-rate overlay opens with **P** / **Shift+P** (or `?perf` in the address). The measurements are unchanged:
carriageway widths and edges, trees, signs, signals, clear heights and swept paths were compared with the current page on all
12 passages and along the road view, with 0 differences.

The current page [`hosskirch-blade-route.html`](hosskirch-blade-route.html) stays as it is, so you can always go back to it; both use the same `r/` and
`h/`. The browser link and the website below still show the current page. To open v2: in this folder run
`python3 -m http.server 8000` and open `http://localhost:8000/hosskirch-blade-route-v2.html`. Opened from disk, it loads `r/` and `h/` from
hosskirch.netlify.app like the current page (only while that website is online).

## ▶ [Open in the browser](https://claude.ai/artifact/9EShdBZTbkd99JhSCQwpth)

https://claude.ai/artifact/9EShdBZTbkd99JhSCQwpth — opens on claude.ai with everything included.

## 🌐 [Open the website](https://hosskirch.netlify.app)

https://hosskirch.netlify.app — the same page on its own website: no login, no Claude branding, updated automatically from this
folder whenever `main` changes.

**Downloaded the page file?** It is the same page as the browser link and the website, but the road view and the
survey-grade passages are in the folders `r/` and `h/` (about 152 MB). Opened from disk, the page loads them from the website
(internet needed) and says so; offline you see the overview only. For the full survey offline, keep `r/` and `h/` next to
the page, run `python3 -m http.server 8000` in the folder and open `http://localhost:8000/hosskirch-blade-route.html`. The build date at the
end of *Sources and method* shows which version you have.

## Sharing

- **The browser link** (claude.ai) is private until you share it from the page's **Share** menu on claude.ai: either
  anyone with the link, or the people you invite by email.
- **The website** (Netlify) is a public address: no login and no Claude branding.
- **The HTML file alone** needs the website (internet) or a local web server with `r/` and `h/` next to it for the road
  view and the passages; without them it shows the overview only and says why.

## Your own website on Netlify (no Claude branding)

This folder is the complete website, ready to drop onto Netlify as it is:

- `hosskirch-blade-route.html` — the page
- `r/` — road-view data for every 5 km, `h/` — the detailed survey points (loaded only when viewed, so the page stays fast)
- `_redirects` — makes the site's main address open the page directly
- `windpark-hosskirch.html` is the 3D wind park, so the page's *3D wind park* link works on the website too.

**Put it online (once, about 5 minutes):**

1. Get the folder: on the [repository page](https://github.com/NotJakobKristensen/Route-Surveys) click the green **Code** button → **Download ZIP**, then unzip it.
   You need the folder **`Hosskirch_Blade_Route`** from it (about 154 MB).
2. Open **https://app.netlify.com/drop** and sign up or log in (free). Log in first — a site dropped without an account is
   deleted after an hour.
3. Drag the whole **`Hosskirch_Blade_Route`** folder (not the files inside it) onto the drop area and wait for the upload to finish.
4. Netlify shows the address of your site, e.g. `https://random-name-123.netlify.app` — open it: the page starts directly.
5. Optional, a nicer address: **Site configuration → Change site name**, e.g. `hosskirch-blade-route` → `https://hosskirch-blade-route.netlify.app`.

**Share** that address with anyone: no login and no Claude branding. To update the site later, open it on Netlify →
**Deploys** and drag the new folder onto the drop area there; the address stays the same.

*Opening it on your own computer instead:* see **Downloaded the page file?** above.

---
Source code, tools and data pipeline:
[`windpark-hosskirch/` in the `Source` folder](https://github.com/NotJakobKristensen/Route-Surveys/tree/main/Source/windpark-hosskirch).
