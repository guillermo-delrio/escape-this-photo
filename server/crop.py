# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11"]
# ///
"""Crop an object out of a picture, with a 15% margin, as the reference for a painted close-up:
uv run server/crop.py <in> <out.jpg> <left> <top> <right> <bottom>"""
import sys

from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
l, t, r, b = (float(v) for v in sys.argv[3:7])
mx, my = (r - l) * 0.15, (b - t) * 0.15
box = (max(0, l - mx), max(0, t - my), min(im.width, r + mx), min(im.height, b + my))
im.crop(tuple(round(v) for v in box)).save(sys.argv[2], quality=88)
