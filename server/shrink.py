# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11"]
# ///
"""Shrink a painting to a JPEG at most <width> px wide (default 720): uv run server/shrink.py <in.png> <out.jpg> [width]"""
import sys

from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
w = min(int(sys.argv[3]) if len(sys.argv) > 3 else 720, im.width)
im.resize((w, round(im.height * w / im.width)), Image.LANCZOS).save(sys.argv[2], quality=82, optimize=True)
