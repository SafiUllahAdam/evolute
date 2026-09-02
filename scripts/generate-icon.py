"""Generate the eVolutɘ brand icons.

Writes assets/icon.png, assets/icon.ico and assets/tray-icon.png from a single
drawn source, so the app icon, the installer icon and the tray icon can never
drift apart.

The mark is a glowing light-purple "V" - the same identity the cursor overlay
paints on screen. It has to stay legible against whatever is behind it, which
on a taskbar or a desktop wallpaper could be anything, so it is built from two
opposing layers:

  1. a wide purple bloom, which separates it from dark backgrounds
  2. a near-black outline hugging the letterform, which separates it from
     light ones

Run with the project's conda environment:

    conda activate evolute
    python scripts/generate-icon.py
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "assets")

SIZE = 512
FILL = (245, 233, 255, 255)  # #f5e9ff
OUTLINE = (35, 8, 62)        # #23083e
GLOW = (168, 85, 247)        # #a855f7

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def load_font(size):
    """A heavy grotesque; the V needs weight to survive a 16px tray icon."""
    for name in ("segoeuib.ttf", "arialbd.ttf"):
        path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit("No bold system font found (looked for Segoe UI Bold, Arial Bold).")


def draw_v(image, font, fill, offset=(0, 0)):
    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), "V", font=font)
    width, height = box[2] - box[0], box[3] - box[1]
    draw.text(
        ((SIZE - width) / 2 - box[0] + offset[0], (SIZE - height) / 2 - box[1] + offset[1]),
        "V",
        font=font,
        fill=fill,
    )


def build():
    font = load_font(330)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Bloom, outermost: two blur radii so the falloff is not a flat disc.
    for radius, alpha in ((42, 165), (20, 205)):
        layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        draw_v(layer, font, GLOW + (alpha,))
        canvas = Image.alpha_composite(canvas, layer.filter(ImageFilter.GaussianBlur(radius)))

    # Soft dark halo, then a ring of hard stamps. The halo alone is too fuzzy to
    # read as an edge on white; the stamps alone leave gaps on the diagonals.
    halo = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_v(halo, font, OUTLINE + (230,))
    canvas = Image.alpha_composite(canvas, halo.filter(ImageFilter.GaussianBlur(5)))

    ring = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    r = 9
    offsets = [
        (r, 0), (-r, 0), (0, r), (0, -r),
        (r, r), (-r, r), (r, -r), (-r, -r),
        (r, r // 2), (-r, r // 2), (r, -r // 2), (-r, -r // 2),
    ]
    for offset in offsets:
        draw_v(ring, font, OUTLINE + (250,), offset)
    canvas = Image.alpha_composite(canvas, ring)

    sharp = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_v(sharp, font, FILL)
    return Image.alpha_composite(canvas, sharp)


def main():
    if not os.path.isdir(ASSETS):
        raise SystemExit("assets/ not found next to the repo root: %s" % ASSETS)

    icon = build()
    png = os.path.join(ASSETS, "icon.png")
    tray = os.path.join(ASSETS, "tray-icon.png")
    ico = os.path.join(ASSETS, "icon.ico")

    icon.save(png)
    icon.resize((64, 64), Image.LANCZOS).save(tray)
    # Windows needs every size embedded: it picks, it does not scale well.
    icon.save(ico, format="ICO", sizes=ICO_SIZES)

    for path in (png, tray, ico):
        print("wrote %-14s %7d bytes" % (os.path.basename(path), os.path.getsize(path)))
    print("ico frames:", sorted(Image.open(ico).info.get("sizes", [])))


if __name__ == "__main__":
    sys.exit(main())
