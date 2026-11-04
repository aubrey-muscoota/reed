# Sites from orbit

Companies describe physical projects in their 10-Ks: a new fab, a battery plant, an LNG terminal. This part of Reed checks a handful of those descriptions against free satellite imagery and asks one narrow question: **when did lasting construction first show up from orbit, and does that fit what the filing says?**

It is descriptive and backward-looking. It says nothing about whether a project is on budget, says nothing about the companies' prospects, and gives no trading signal. It shares no code paths or data with any trading work, and nothing here feeds the daily Reed page.

## What it does

| Step | Script | Runs where |
| --- | --- | --- |
| 1. Claims | `sites/claims.json` | Hand-written: company, site, our one-line summary of the claim, the year the filing gives for the start of work, and the site's coordinates. |
| 2. Imagery | `sites/orbit.py` | Anywhere with Python. For each year from 2018, picks the clearest Sentinel-2 image in the summer months, measures change against the first year, and draws a strip of images. |
| 3. Filing check | `scripts/sites-filings.mjs` | GitHub Actions (needs SEC EDGAR). Pulls the sentences in each company's 10-Ks that name the site, so our summary can be checked against the filing's own words. |
| 4. Model check | `scripts/sites-judge.mjs` | GitHub Actions (needs Cloudflare). Shows open vision models on Workers AI the dated images only and asks when construction first appears. Scores them against the pixel measurement and the filing year. |

All four run from the "Sites from orbit" workflow (Actions tab, run by hand). Results land in `sites/results/` and in the run's artifact.

```
pip install -r sites/requirements.txt
python sites/orbit.py                         # all claims, ~1-3 minutes per site
python sites/orbit.py --only txn-sherman
python sites/orbit.py --locate 33.558,-96.615 --year 2025   # one wide image, to place a site
```

## Method

**Imagery.** Sentinel-2 Level-2A (surface reflectance, 10 m pixels), read directly from the public archive on AWS (`sentinel-cogs`, the Earth Search copy). The script lists scenes for the site's MGRS tile by month and reads only a small window around the site from each cloud-optimized GeoTIFF, so a site-year costs a few megabytes. No account, API key or STAC service is needed.

**Picking images.** For each year, scenes from June to September (wider for the Gulf Coast site, which is often cloudy) are checked nearest mid-season first. The scene classification band decides how much of the site is clear ground; the first scene with at least 98% clear is used, or the clearest one if none reaches that, and the year is skipped below 90%. Summer-to-summer comparisons keep crop and leaf cycles from looking like construction.

**Measuring change.** Each pixel is compared with the same pixel in the first year. It counts as changed when it became brighter in visible light by more than 0.05 reflectance (cleared soil, concrete, roofs) or lost more than 0.25 NDVI (paving, dark roofs). A changed pixel counts as **lasting** from year *t* only if it is still changed in every later clear year. Crop rotation and a dry summer come and go; graded pads and buildings stay. The **first lasting change** is the first year where at least 10% of the site box shows lasting change.

**Verdict.** We compare the year of first lasting change with the year the filing gives for the start of physical work (`claim_year`): *consistent* if within a year either way, otherwise *earlier than stated* or *later than stated*. If nothing lasting shows by the latest image, the verdict says so.

**Sites.** Each site is a square 1.6 to 2.4 km across, centered by eye on the construction area in a recent image. The coordinates are ours, not the companies'; check the image strip before relying on a site.

## Limits

- 10 m pixels show ground clearing, pads, large roofs and tanks. They do not show what is inside a building, whether equipment is installed, or whether a plant is producing. "Construction visible" is the most this can say, and the Vogtle row is there to show it.
- The archive used here starts in 2017. Anything begun earlier has no "before" image.
- A site box can include neighbors' construction (Austin and Sherman both have other projects next door).
- Our claim summaries are short paraphrases. Read the filing sentences in `sites/results/filings.md` before quoting a company.
- Eight sites is a demonstration, not a sample. Thresholds were set by looking at these sites, so they are not tested out of sample.

## Licensing and credit

Sentinel-2 data is provided free under the Copernicus Sentinel data terms (EU Regulation 1159/2013 and the Sentinel data legal notice): reproduction, distribution, adaptation and public display are allowed, including commercially, provided the source is credited. Every image here is cropped and color-stretched, so the credit is **"Contains modified Copernicus Sentinel data [years]"**, which `orbit.py` writes on each image. Keep that line on any image published on muscoota.com or elsewhere.

Not used here, on purpose: Google, Esri, Mapbox and Bing imagery (their terms forbid extracting imagery), the EOX Sentinel-2 cloudless mosaics after 2016 (CC BY-NC-SA, no paid use), and commercial imagery (Planet, Maxar), whose licenses restrict redistribution. NAIP (USDA, public domain, about 1 m) and Landsat (USGS, public domain) are good next sources; NAIP would show much more detail for US sites but is flown only every two to three years per state.
