# Hoßkirch Blade Route

Route survey for the 84.3 m V172 blades from the blade plant in Goleniów (PL) to the crane pads of Windpark Hoßkirch, 935 km: the whole route on a 3D map, a road view along every kilometre on official aerial photos with 3D roads, bridges, signs and the convoy, and the difficult passages driven in detail with a swept-path model.

## Current version: 3 (2026-10-12)

[`hosskirch-blade-route.html`](hosskirch-blade-route.html) is version 3, the newest; only the newest version is kept here (owner, 2026-10-15), the
earlier ones are in the git history. Compared with the first version:
- **Big passages open much faster on a slow graphics card**: while a view opens, the page stops drawing until the passage's data
  is on the graphics card (without a graphics card, the largest Hoßkirch passage, the plant exit, opens in about 25 s instead of 78 s).
- **No "loading" hang**, **smoother fast driving** (the next stretch of the swept path is prepared ahead) and **vehicle changes
  without a freeze** (the new convoy is built beside the one shown, then swapped in); 3D shaders prepared ahead, a frame-rate
  overlay with **P** / **Shift+P** (or `?perf` in the address).

The measurements are unchanged: compared with the first version on all 12 passages and along the road view, with 0 differences.

## ▶ [Open in the browser](https://claude.ai/artifact/9EShdBZTbkd99JhSCQwpth)

https://claude.ai/artifact/9EShdBZTbkd99JhSCQwpth — opens on claude.ai with everything included; it still shows the first version (version 3 is not published there yet).

## 🌐 [Open the website](https://hosskirch.netlify.app)

https://hosskirch.netlify.app — the page on its own website: no login, no Claude branding. It is not connected to this repository, so it shows
the version it was last deployed with (the first version).

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
