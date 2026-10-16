"""Render the drawing into 256 px map tiles for the web viewer.

Zoom level z shows the page at 2**z pixels per PDF point (z=4 is ~1150 dpi), so
the drawing stays sharp however far you zoom, on any screen.  Tiles are
rendered straight from the vector PDF with poppler (pdftoppm), using the same
font mapping as the SVG; fully blank tiles are skipped.

    python3 pipeline/make_tiles.py [--out web/tiles] [--min -4] [--max 4]
Layout: <out>/<z>/<x>/<y>.png   (Leaflet CRS.Simple, y down)
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PDF = os.path.join(ROOT, "source", "System_Map_Print.pdf")
PAGE_W, PAGE_H = 6552, 1440
TILE = 256
ENV = dict(os.environ, FONTCONFIG_FILE=os.path.join(HERE, "fonts.conf"))


def render(dpi, y, h, w):
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "r")
        subprocess.run(["pdftoppm", "-r", str(dpi), "-x", "0", "-y", str(y), "-W", str(w), "-H", str(h),
                        "-aa", "yes", "-aaVector", "yes", "-png", "-singlefile", PDF, base],
                       check=True, env=ENV)
        return Image.open(base + ".png").convert("RGB")


def save_tile(img, path):
    a = np.asarray(img)
    if a.min() >= 250:                       # blank: let the white background show
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.quantize(colors=64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)
    return True


def band(args):
    out, z, row = args
    k = 2.0 ** z
    W, H = math.ceil(PAGE_W * k), math.ceil(PAGE_H * k)
    y0 = row * TILE
    h = min(TILE, H - y0)
    img = render(72 * k, y0, h, W)
    n = 0
    for col in range(math.ceil(W / TILE)):
        t = img.crop((col * TILE, 0, min(W, (col + 1) * TILE), h))
        if t.size != (TILE, TILE):           # pad edge tiles to full size
            full = Image.new("RGB", (TILE, TILE), (255, 255, 255))
            full.paste(t, (0, 0))
            t = full
        n += save_tile(t, os.path.join(out, str(z), str(col), f"{row}.png"))
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "tiles"))
    ap.add_argument("--min", type=int, default=-4)
    ap.add_argument("--max", type=int, default=4)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    jobs = []
    for z in range(a.min, a.max + 1):
        H = math.ceil(PAGE_H * 2.0 ** z)
        jobs += [(a.out, z, r) for r in range(math.ceil(H / TILE))]
    total = 0
    with ProcessPoolExecutor(a.jobs) as ex:
        for i, n in enumerate(ex.map(band, jobs)):
            total += n
            if (i + 1) % 20 == 0 or i + 1 == len(jobs):
                print(f"  {i + 1}/{len(jobs)} bands, {total} tiles", flush=True)
    # index of non-blank tiles, so the viewer never requests a blank one
    index = {}
    for z in sorted(os.listdir(a.out), key=lambda v: int(v) if v.lstrip("-").isdigit() else 99):
        zd = os.path.join(a.out, z)
        if not os.path.isdir(zd):
            continue
        index[z] = {x: sorted(int(f[:-4]) for f in os.listdir(os.path.join(zd, x)))
                    for x in os.listdir(zd)}
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"wrote {total} tiles to {a.out}")


if __name__ == "__main__":
    sys.exit(main())
