"""One-off: cluster every glyph found in label containers into shape classes.

Writes build/glyph_clusters.npz and build/glyph_clusters.png (a contact sheet
numbered by cluster).  A human (or Claude) then names each cluster once in
pipeline/glyph_labels.json, and glyph_prototypes.npz is produced from both.
Re-run only if the source drawing changes and new glyph shapes appear.
"""
import collections
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfmap  # noqa: E402

STRUCT = np.ones((5, 5), bool)


def similarity(a, da, b, db):
    """Symmetric tolerant overlap of two stroke bitmaps (1.0 = identical)."""
    c1 = (a & db).sum() / max(a.sum(), 1)
    c2 = (b & da).sum() / max(b.sum(), 1)
    return min(c1, c2)


def main():
    prim = pdfmap.load_primitives()
    strokes = pdfmap.stroke_objects(prim)
    X = []
    for c in pdfmap.find_containers(prim):
        chars, _ = pdfmap.segment_characters(c, strokes)
        X += [pdfmap.norm(ch["img"]) for ch in chars]
    D = [ndimage.binary_dilation(x, STRUCT) for x in X]
    reps, lab = [], []
    for i, x in enumerate(X):
        best, bs = -1, 0
        for k, r in enumerate(reps):
            s = similarity(x, D[i], X[r], D[r])
            if s > bs:
                best, bs = k, s
        if bs > 0.97:
            lab.append(best)
        else:
            reps.append(i)
            lab.append(len(reps) - 1)
    cnt = collections.Counter(lab)
    print(len(X), "glyphs ->", len(reps), "clusters")
    np.savez_compressed(os.path.join(pdfmap.ROOT, "build", "glyph_clusters.npz"),
                        protos=np.array([X[r] for r in reps]))
    cols, cw, ch = 10, 80, pdfmap.GLYPH_H + 16
    sheet = Image.new("L", (cols * cw, ((len(reps) + cols - 1) // cols) * ch), 60)
    d = ImageDraw.Draw(sheet)
    for k, r in enumerate(reps):
        x, y = (k % cols) * cw, (k // cols) * ch
        sheet.paste(Image.fromarray((X[r] * 255).astype("uint8")), (x, y))
        d.text((x + 2, y + pdfmap.GLYPH_H + 2), f"{k}:{cnt[k]}", fill=255)
    sheet.save(os.path.join(pdfmap.ROOT, "build", "glyph_clusters.png"))


def freeze():
    """Combine clusters + labels into the committed prototype file."""
    protos = np.load(os.path.join(pdfmap.ROOT, "build", "glyph_clusters.npz"))["protos"]
    labels = json.load(open(os.path.join(pdfmap.ROOT, "pipeline", "glyph_labels.json")))
    keep = [(int(k), v) for k, v in labels.items() if v is not None]
    np.savez_compressed(os.path.join(pdfmap.ROOT, "pipeline", "glyph_prototypes.npz"),
                        protos=np.array([protos[k] for k, _ in keep]),
                        labels=np.array([v for _, v in keep]))
    print("froze", len(keep), "prototypes")


if __name__ == "__main__":
    freeze() if sys.argv[1:] == ["freeze"] else main()
