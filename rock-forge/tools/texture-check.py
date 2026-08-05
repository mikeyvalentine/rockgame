# Are the rock textures actually usable? Requires Pillow.
#
#   python3 tools/texture-check.py
#
# Three things decide whether a rock texture earns its place here, and none of
# them is visible from the filename:
#
#   seamless    Everything is sampled triplanar, so every map tiles. A texture
#               with a visible join repeats that join across a whole beach.
#               Measured as the wrap discontinuity divided by the typical
#               internal one — about 1.0 means the seam looks like any other
#               pair of adjacent columns.
#
#   relief      A normal map that is nearly flat gives back the smooth primitive
#               the whole exercise is trying to avoid. Measured as the mean
#               angular deviation from (128,128,255) in degrees. Several sets in
#               this library are under 6 degrees and are effectively blank.
#
#   range       A height map only displaces if it has range. Reported as the
#               5th-to-95th percentile spread. Note that the 16-bit PNGs cannot
#               be judged through an 8-bit path — and browsers decode them to
#               8 bits anyway, so they are flagged rather than measured.
#
# There is a fourth test no script can run: *scale*. A texture depicting many
# rocks, mapped onto one rock, puts tiny rocks inside a rock. gravel_rubble,
# rock_beach_small_002, muddy_rubble_slope and everything in scan/ fail it, and
# they look perfectly good in a thumbnail.

import json
import math
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip install Pillow")

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "rock")


def pixels(im):
    return im.get_flattened_data() if hasattr(im, "get_flattened_data") else im.getdata()


def seam_error(im):
    """Wrap discontinuity relative to a typical internal one. ~1 is seamless."""
    im = im.convert("L").resize((512, 512))
    w, h = im.size
    px = im.load()
    wrap_h = [abs(px[w - 1, y] - px[0, y]) for y in range(h)]
    ref_h = [abs(px[w // 2, y] - px[w // 2 - 1, y]) for y in range(h)]
    wrap_v = [abs(px[x, h - 1] - px[x, 0]) for x in range(w)]
    ref_v = [abs(px[x, h // 2] - px[x, h // 2 - 1]) for x in range(w)]
    mean = lambda a: sum(a) / len(a)
    return max(mean(wrap_h) / max(0.5, mean(ref_h)),
               mean(wrap_v) / max(0.5, mean(ref_v)))


def normal_detail(path):
    """Mean angular deviation from flat, in degrees."""
    im = Image.open(path).convert("RGB").resize((256, 256))
    total = 0.0
    n = 0
    for r, g, b in pixels(im):
        x = r / 127.5 - 1.0
        y = g / 127.5 - 1.0
        z = max(1e-3, b / 127.5 - 1.0)
        total += math.degrees(math.atan2(math.hypot(x, y), z))
        n += 1
    return total / n


def height_range(path):
    im = Image.open(path)
    if im.mode in ("I;16", "I"):
        return None                       # 8-bit paths read these as garbage
    d = sorted(pixels(im.convert("L").resize((256, 256))))
    return d[int(len(d) * 0.95)] - d[int(len(d) * 0.05)]


def main():
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    print(f"\n{'material':<26}{'class':<14}{'seam':>6}{'relief':>8}{'height':>8}   notes")

    problems = 0
    for cls in manifest:
        for name, entry in sorted(manifest[cls].items()):
            d = os.path.join(ROOT, "..", "..", *entry["path"].split("/"))
            maps = entry["maps"]
            notes = []

            seam = seam_error(Image.open(os.path.join(d, maps["color"]))) if "color" in maps else float("nan")
            if seam == seam and seam > 2.5:
                notes.append("VISIBLE SEAM")

            if "normal" in maps:
                relief = normal_detail(os.path.join(d, maps["normal"]))
                if relief < 6:
                    notes.append("normal map is nearly flat")
            else:
                relief = float("nan")
                notes.append("no normal map")

            hr = ""
            if "height" in maps:
                r = height_range(os.path.join(d, maps["height"]))
                hr = "16-bit" if r is None else str(r)
                if r is not None and r < 40:
                    notes.append("height map has little range")

            if cls == "scan":
                notes.append("not seamless by design — UV-mapped to a mesh")

            if notes:
                problems += 1
            print(f"{name:<26}{cls:<14}{seam:6.2f}{relief:8.1f}{hr:>8}   {'; '.join(notes) or 'ok'}")

    print(f"\n{problems} of the set carry a caveat. That is expected — the point is "
          f"knowing which,\nnot having none. See SURFACES in src/babylon/rockTextures.js "
          f"for what is actually used.\n")


if __name__ == "__main__":
    main()
