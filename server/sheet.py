# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11"]
# ///
"""Pictures for the count checks (server/verify.ts).

uv run server/sheet.py instances <picture> <out-prefix> <outlines.json>
    <out-prefix>-marked.jpg: the picture with each instance outlined and numbered from 1
    <out-prefix>-sheet.jpg: each instance cropped (with a margin) and numbered the same way
uv run server/sheet.py closeup <picture> <out.jpg> <left> <top> <width> <height>
    the exact view box the game's close-up shows (App.tsx bbox), so the check counts what the player sees
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

COLOURS = ["#ff2d55", "#00e5ff", "#ffd60a", "#30d158", "#bf5af2", "#ff9f0a"]


def font(size):
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except OSError:
        return ImageFont.load_default(size)


def tag(draw, xy, text, colour, size):
    f = font(size)
    l, t, r, b = draw.textbbox(xy, text, font=f)
    draw.rectangle((l - 4, t - 3, r + 4, b + 3), fill="black", outline=colour, width=2)
    draw.text(xy, text, fill=colour, font=f)


def instances(picture, prefix, outlines_file):
    im = Image.open(picture).convert("RGB")
    outlines = json.load(open(outlines_file))
    scale = min(1.0, 1600 / max(im.size))
    marked = im.resize((round(im.width * scale), round(im.height * scale))) if scale < 1 else im.copy()
    d = ImageDraw.Draw(marked)
    width = max(2, round(max(marked.size) / 400))
    for i, poly in enumerate(outlines):
        c = COLOURS[i % len(COLOURS)]
        pts = [(x * scale, y * scale) for x, y in poly]
        d.line(pts + [pts[0]], fill=c, width=width)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        tag(d, (min(xs), max(0, min(ys) - 30)), str(i + 1), c, 24)
    marked.save(f"{prefix}-marked.jpg", quality=85)

    cell = 300
    crops = []
    for i, poly in enumerate(outlines):
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        l, t, r, b = min(xs), min(ys), max(xs), max(ys)
        mx, my = max(12, (r - l) * 0.3), max(12, (b - t) * 0.3)
        c = im.crop((max(0, l - mx), max(0, t - my), min(im.width, r + mx), min(im.height, b + my)))
        c.thumbnail((cell, cell))
        crops.append(c)
    cols = min(4, len(crops))
    rows = (len(crops) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cell + 10) + 10, rows * (cell + 10) + 10), "#222")
    d = ImageDraw.Draw(sheet)
    for i, c in enumerate(crops):
        x, y = 10 + (i % cols) * (cell + 10), 10 + (i // cols) * (cell + 10)
        sheet.paste(c, (x + (cell - c.width) // 2, y + (cell - c.height) // 2))
        tag(d, (x + 6, y + 4), str(i + 1), COLOURS[i % len(COLOURS)], 28)
    sheet.save(f"{prefix}-sheet.jpg", quality=85)


def closeup(picture, out, l, t, w, h):
    im = Image.open(picture).convert("RGB")
    c = im.crop((round(l), round(t), round(l + w), round(t + h)))
    if max(c.size) < 900:  # the phone shows it large; give the checker the same detail, not a thumbnail
        k = 900 / max(c.size)
        c = c.resize((round(c.width * k), round(c.height * k)), Image.LANCZOS)
    c.save(out, quality=88)


if __name__ == "__main__":
    mode, *args = sys.argv[1:]
    if mode == "instances":
        instances(*args)
    elif mode == "closeup":
        closeup(args[0], args[1], *(float(v) for v in args[2:6]))
    else:
        sys.exit(__doc__)
