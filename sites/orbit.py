"""Look at a facility site from orbit with free Sentinel-2 imagery.

For each claim in sites/claims.json this picks the clearest Sentinel-2 L2A
scene over the site in each year's season window, measures how much of the
site changed from the first year and stayed changed, and renders a strip of
true-color images. Imagery is read straight from the public Sentinel-2 COG
archive on AWS (no account, no STAC API), a few hundred kilobytes per scene.

    python sites/orbit.py                    # every claim
    python sites/orbit.py --only tsla-giga-texas
    python sites/orbit.py --locate 30.222,-97.617 --year 2024   # one image, to check coordinates

Outputs go to sites/results/: results.json, report.md and one image strip per claim.
Images contain modified Copernicus Sentinel data and must carry that credit.
"""

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import mgrs
import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.enums import Resampling
from rasterio.warp import transform
from rasterio.windows import Window

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs"
HERE = Path(__file__).resolve().parent
OUT = HERE / "results"

# Scene classification (SCL) values that count as a clear view of the ground:
# vegetation, not vegetated, water, unclassified.
CLEAR = (4, 5, 6, 7)
BANDS = ("B02", "B03", "B04", "B08", "B11")
BRIGHTER = 0.05      # rise in mean visible reflectance that counts as change
GREEN_LOSS = 0.25    # drop in NDVI that counts as change
VISIBLE = 0.10       # share of the site that must change for "visible"
MIN_CLEAR = 0.90     # share of the site that must be clear to use a scene

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("VSI_CACHE", "TRUE")
if os.path.exists("/root/.ccr/ca-bundle.crt"):
    os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")

CREDIT = "Contains modified Copernicus Sentinel data {years}"


def fetch(url, tries=5):
    """GET with retries: the archive and proxies drop connections now and then."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def tile_for(lat, lon):
    code = mgrs.MGRS().toMGRS(lat, lon, MGRSPrecision=0)
    m = re.match(r"(\d+)([A-Z])([A-Z]{2})", code)
    return m.group(1).lstrip("0"), m.group(2), m.group(3)


def list_scenes(tile, year, month):
    """Scene folders for one MGRS tile and month, newest processing kept."""
    zone, band, square = tile
    prefix = f"{PREFIX}/{zone}/{band}/{square}/{year}/{month}/"
    url = f"{BUCKET}/?list-type=2&delimiter=/&prefix={prefix}"
    xml = fetch(url).decode()
    by_day = {}
    for p in re.findall(r"<Prefix>([^<]+_L2A/)</Prefix>", xml):
        name = p.rstrip("/").rsplit("/", 1)[1]           # S2A_14RPU_20240602_0_L2A
        sat, _, day, seq, _ = name.split("_")
        key = (day, sat)
        if key not in by_day or int(seq) > int(by_day[key][1]):
            by_day[key] = (p, seq)
    return [{"path": p, "date": d} for (d, _), (p, _) in sorted(by_day.items())]


def scene_meta(path):
    name = path.rstrip("/").rsplit("/", 1)[1]
    return json.loads(fetch(f"{BUCKET}/{path}{name}.json"))["properties"]


def window_for(src, lat, lon, half_m):
    xs, ys = transform("EPSG:4326", src.crs, [lon], [lat])
    res = src.res[0]
    r, c = src.index(xs[0], ys[0])
    n = int(round(half_m / res))
    return Window(c - n, r - n, 2 * n, 2 * n)


def read(path, band, lat, lon, half_m, size=None, resampling=Resampling.nearest):
    with rasterio.open(f"/vsicurl/{BUCKET}/{path}{band}.tif") as src:
        win = window_for(src, lat, lon, half_m)
        kw = {"window": win, "boundless": True, "fill_value": 0}
        if size:
            kw.update(out_shape=(src.count, size, size), resampling=resampling)
        return src.read(**kw)


def clear_share(scene, lat, lon, half_m):
    try:
        scl = read(scene["path"], "SCL", lat, lon, half_m)[0]
    except Exception as e:  # missing or damaged file: skip the scene
        print(f"  skip {scene['path']}: {e}", file=sys.stderr)
        return 0.0
    return float(np.isin(scl, CLEAR).mean())


def best_scene(tile, lat, lon, half_m, year, months, pool):
    scenes = []
    for m in months:
        try:
            scenes += list_scenes(tile, year, m)
        except Exception as e:
            print(f"  listing {tile} {year}-{m} failed: {e}", file=sys.stderr)
    if not scenes:
        return None
    mid = dt.date(year, months[len(months) // 2], 15)
    def days(s):
        return abs((dt.datetime.strptime(s["date"], "%Y%m%d").date() - mid).days)
    # Look nearest mid-season first, a batch at a time, and stop at the first
    # batch with an almost cloud-free view.
    scenes.sort(key=days)
    best, best_share = None, -1.0
    for k in range(0, len(scenes), 16):
        batch = scenes[k:k + 16]
        for s, share in zip(batch, pool.map(lambda s: clear_share(s, lat, lon, half_m), batch)):
            if round(share, 2) > round(best_share, 2):
                best, best_share = s, share
        if best_share >= 0.98:
            break
    if best_share < MIN_CLEAR:
        return None
    return {**best, "clear": best_share}


def load(scene, lat, lon, half_m, tries=4):
    for attempt in range(tries):
        try:
            return _load(scene, lat, lon, half_m)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def _load(scene, lat, lon, half_m):
    """Reflectance stack (bands, n, n), clear mask and true-color image."""
    n = int(round(2 * half_m / 10))
    props = scene_meta(scene["path"])
    # From processing baseline 04.00 (Jan 2022) ESA adds 1000 to L2A values.
    # Earth Search removes it in newer items; remove it here when it did not.
    offset = 0
    if float(props.get("s2:processing_baseline", "0") or 0) >= 4.0 and not props.get("earthsearch:boa_offset_applied", False):
        offset = 1000
    stack = []
    for b in BANDS:
        a = read(scene["path"], b, lat, lon, half_m, size=n, resampling=Resampling.bilinear)[0].astype("float32")
        stack.append(np.clip((a - offset) / 10000.0, 0, 1.5))
    scl = read(scene["path"], "SCL", lat, lon, half_m, size=n)[0]
    tci = read(scene["path"], "TCI", lat, lon, half_m, size=n, resampling=Resampling.bilinear)
    return np.stack(stack), np.isin(scl, CLEAR), tci.transpose(1, 2, 0), props


def brighten(rgb):
    a = rgb.astype("float32") / 255.0
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    a = np.clip((a - lo) / max(hi - lo, 1e-3), 0, 1) ** 0.8
    return (a * 255).astype("uint8")


def visible(refl):
    return refl[0:3].mean(axis=0)


def ndvi(refl):
    red, nir = refl[2], refl[3]
    return (nir - red) / np.maximum(nir + red, 1e-3)


def analyse(claim, pool, first_year, last_year):
    lat, lon = claim["lat"], claim["lon"]
    half_m = claim.get("half_km", 1.0) * 1000
    months = claim.get("months", [6, 7, 8, 9])
    tile = tile_for(lat, lon)
    snaps = []
    for year in range(claim.get("first_year", first_year), last_year + 1):
        s = best_scene(tile, lat, lon, half_m, year, months, pool)
        if not s:
            print(f"  {claim['id']} {year}: no clear scene", file=sys.stderr)
            continue
        refl, clear, tci, props = load(s, lat, lon, half_m)
        snaps.append({"year": year, "date": s["date"], "scene": s["path"].rstrip("/").rsplit("/", 1)[1],
                      "clear": round(float(clear.mean()), 3), "refl": refl, "mask": clear, "tci": tci})
        print(f"  {claim['id']} {year}: {s['date']} clear {s['clear']:.2f}", file=sys.stderr)
    if len(snaps) < 2:
        return {"id": claim["id"], "error": "fewer than two clear years"}

    base = snaps[0]
    changed = []
    for s in snaps:
        # Change toward bare or built ground: brighter in visible light (cleared
        # soil, concrete, roofs) or much less green (paving, dark roofs). Plain
        # year-to-year swings in how green a field or wood is stay under both.
        brighter = visible(s["refl"]) - visible(base["refl"]) > BRIGHTER
        greenloss = ndvi(base["refl"]) - ndvi(s["refl"]) > GREEN_LOSS
        changed.append((brighter | greenloss) & s["mask"] & base["mask"])
    # A pixel counts from year t if it changed then and in every later clear look.
    # Crops and seasons come and go; buildings, pads and cleared ground stay.
    persist = [None] * len(snaps)
    acc = np.ones_like(changed[0])
    for i in range(len(snaps) - 1, -1, -1):
        seen = snaps[i]["mask"] & base["mask"]
        acc = acc & (changed[i] | ~seen) if i < len(snaps) - 1 else changed[i].copy()
        persist[i] = acc & seen
    rows = []
    first_visible = None
    for i, s in enumerate(snaps):
        seen = s["mask"] & base["mask"]
        share = float(persist[i].sum() / max(seen.sum(), 1))
        rows.append({"year": s["year"], "date": s["date"], "scene": s["scene"], "clear": s["clear"],
                     "changed": round(float(changed[i].sum() / max(seen.sum(), 1)), 3),
                     "persistent": round(share, 3)})
        # The latest image has no later look to confirm it, so it can't start a run.
        if first_visible is None and 0 < i < len(snaps) - 1 and share >= VISIBLE:
            first_visible = s["date"]
    render(claim, snaps, persist[-1])
    return {"id": claim["id"], "tile": "".join(tile), "first_year": snaps[0]["year"],
            "first_visible": first_visible, "snapshots": rows,
            "verdict": verdict(claim, first_visible, snaps)}


def verdict(claim, first_visible, snaps):
    """Compare the first visible change with the year the filing gives."""
    if claim.get("control"):
        return "control: work began before the archive"
    year = claim.get("claim_year")
    if year is None:
        return "no date in claim"
    if snaps[0]["year"] >= year:
        return "no clear look before the stated date"
    seen = int(first_visible[:4]) if first_visible else None
    if seen is None:
        return "no lasting change visible" if snaps[-1]["year"] >= year else "too early to tell"
    if seen <= year:
        return "consistent" if seen >= year - 1 else "change visible earlier than stated"
    return "change visible later than stated" if seen > year + 1 else "consistent"


def render(claim, snaps, last_persist):
    """A strip of yearly images plus a final panel with lasting change in red."""
    scale = 2
    n = snaps[0]["tci"].shape[0] * scale
    pad, label = 6, 18
    panels = [(s["date"], brighten(s["tci"])) for s in snaps]
    over = brighten(snaps[-1]["tci"]).copy()
    over[last_persist] = (0.45 * over[last_persist] + 0.55 * np.array([230, 40, 40])).astype("uint8")
    panels.append(("lasting change", over))
    cols = min(len(panels), 6)
    rows = math.ceil(len(panels) / cols)
    W = cols * (n + pad) + pad
    H = rows * (n + label + pad) + pad + 40
    img = Image.new("RGB", (W, H), (250, 250, 248))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    for k, (title, arr) in enumerate(panels):
        r, c = divmod(k, cols)
        x, y = pad + c * (n + pad), pad + r * (n + label + pad)
        img.paste(Image.fromarray(arr).resize((n, n), Image.NEAREST), (x, y + label))
        if re.fullmatch(r"\d{8}", title):
            title = f"{title[:4]}-{title[4:6]}-{title[6:]}"
        draw.text((x, y + 3), title, fill=(30, 30, 30), font=font)
    years = sorted({s["date"][:4] for s in snaps})
    span = years[0] if len(years) == 1 else f"{years[0]}-{years[-1]}"
    km = claim.get("half_km", 1.0) * 2
    draw.text((pad, H - 34), f"{claim['company']}: {claim['site']}. Each image {km:g} km across, north up.", fill=(30, 30, 30), font=font)
    draw.text((pad, H - 18), CREDIT.format(years=span), fill=(90, 90, 90), font=font)
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / f"{claim['id']}.jpg", quality=85, optimize=True)

    # The same years with dates only, no change overlay or caption, for the
    # model check: it should judge the pictures, not our measurement.
    k = len(snaps)
    m = snaps[0]["tci"].shape[0]
    cols = min(k, 5)
    rows = math.ceil(k / cols)
    plain = Image.new("RGB", (cols * (m + pad) + pad, rows * (m + label + pad) + pad), (255, 255, 255))
    draw = ImageDraw.Draw(plain)
    for i, (title, arr) in enumerate(panels[:k]):
        r, c = divmod(i, cols)
        x, y = pad + c * (m + pad), pad + r * (m + label + pad)
        plain.paste(Image.fromarray(arr), (x, y + label))
        draw.text((x, y + 3), f"{title[:4]}-{title[4:6]}-{title[6:]}", fill=(0, 0, 0), font=font)
    (OUT / "plain").mkdir(exist_ok=True)
    plain.save(OUT / "plain" / f"{claim['id']}.jpg", quality=90)


def locate(lat, lon, year, half_km, months):
    """Save one clear image around a point, to check a site's coordinates."""
    half_m = half_km * 1000
    with ThreadPoolExecutor(16) as pool:
        s = best_scene(tile_for(lat, lon), lat, lon, half_m, year, months, pool)
    if not s:
        sys.exit("no clear scene")
    tci = read(s["path"], "TCI", lat, lon, half_m)[0:3].transpose(1, 2, 0)
    img = Image.fromarray(brighten(tci))
    d = ImageDraw.Draw(img)
    c = img.width // 2
    d.line([(c - 6, c), (c + 6, c)], fill=(255, 0, 0))
    d.line([(c, c - 6), (c, c + 6)], fill=(255, 0, 0))
    out = OUT / "locate" / f"{lat:.4f}_{lon:.4f}_{year}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(out, s["date"])


def report(results, claims):
    by_id = {c["id"]: c for c in claims}
    lines = ["# Sites from orbit: results", "",
             "Generated by `sites/orbit.py`. Contains modified Copernicus Sentinel data.", "",
             "| Site | Filing says | First lasting change seen | Verdict |", "| --- | --- | --- | --- |"]
    for r in results:
        c = by_id[r["id"]]
        fv = r.get("first_visible")
        fv = f"{fv[:4]}-{fv[4:6]}-{fv[6:]}" if fv else "none"
        lines.append(f"| {c['company']}: {c['site']} | {c['claim']} | {fv} | {r.get('verdict', r.get('error'))} |")
    lines += ["", "## Per year", ""]
    for r in results:
        if "snapshots" not in r:
            continue
        c = by_id[r["id"]]
        lines += [f"### {c['company']}: {c['site']}", "", f"![{c['site']}]({r['id']}.jpg)", "",
                  "| Image date | Clear | Changed vs first year | Lasting change |", "| --- | --- | --- | --- |"]
        for s in r["snapshots"]:
            lines.append(f"| {s['date'][:4]}-{s['date'][4:6]}-{s['date'][6:]} | {s['clear']:.0%} | {s['changed']:.0%} | {s['persistent']:.0%} |")
        lines.append("")
    (OUT / "report.md").write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--claims", default=str(HERE / "claims.json"))
    ap.add_argument("--only", help="comma-separated claim ids")
    ap.add_argument("--first-year", type=int, default=2018)
    ap.add_argument("--last-year", type=int, default=dt.date.today().year)
    ap.add_argument("--locate", help="lat,lon: save one image to check coordinates")
    ap.add_argument("--year", type=int, default=dt.date.today().year - 1)
    ap.add_argument("--half-km", type=float, default=2.0)
    ap.add_argument("--months", default="4,5,6,7,8,9,10")
    args = ap.parse_args()

    if args.locate:
        lat, lon = map(float, args.locate.split(","))
        locate(lat, lon, args.year, args.half_km, [int(m) for m in args.months.split(",")])
        return

    claims = json.loads(Path(args.claims).read_text())["claims"]
    if args.only:
        want = set(args.only.split(","))
        claims = [c for c in claims if c["id"] in want]
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "results.json"
    old = {r["id"]: r for r in json.loads(path.read_text())["results"]} if path.exists() else {}
    all_claims = json.loads(Path(args.claims).read_text())["claims"]

    def save():
        results = [old[c["id"]] for c in all_claims if c["id"] in old]
        path.write_text(json.dumps({"generated": dt.date.today().isoformat(),
                                    "settings": {"brighter": BRIGHTER, "green_loss": GREEN_LOSS, "visible": VISIBLE, "min_clear": MIN_CLEAR},
                                    "results": results}, indent=1) + "\n")
        report(results, all_claims)

    with ThreadPoolExecutor(16) as pool:
        for c in claims:
            print(f"{c['id']}", file=sys.stderr)
            old[c["id"]] = analyse(c, pool, args.first_year, args.last_year)
            save()  # after each site, so a failure later keeps the earlier ones

if __name__ == "__main__":
    main()
