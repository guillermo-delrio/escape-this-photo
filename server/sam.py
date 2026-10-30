# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.60", "meta-sam-parser==0.1.0", "pillow>=11", "numpy>=2", "opencv-python-headless>=4.10"]
# ///
"""Segment a photo with hosted SAM 3.1, one noun phrase per call, all calls in parallel.

usage: uv run server/sam.py <image> <phrase> [<phrase> ...]
prints JSON: {"<phrase>": [{"outline": [[x, y], ...], "area": <mask pixels>, "box": [l, t, r, b]}, ...], ...}
Each list item is one instance SAM found, so its length is the instance count the puzzles may use.
Runs only from pipeline.ts, which books the calls first (META_SAM_BOOKED), and only while the spend switch is on
(server/lockdown.ts); otherwise it exits before any request.
"""

import base64
import io
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from meta_sam_parser import CompletedOutcome, SegmentationMaskRecord, decode_mask_to_raster, image_segmentation_format
from openai import OpenAI
import cv2
import numpy as np
from PIL import Image

SAM_MODEL = "sam-3.1"
TIMEOUT_S = 40
STOP_AT = "2026-11-11T00:00:00Z"  # meta.ts STOP_AT


def spend_off_reason():
    """lockdown.ts spendOffReason, for this second entry point to the API."""
    if os.environ.get("META_OFF") == "1":
        return "Meta calls are switched off (META_OFF=1)."
    if os.environ.get("META_SAM_BOOKED") != "1":
        return "sam.py runs only from pipeline.ts, which books its calls first."
    now = datetime.now(timezone.utc)
    try:
        until = datetime.fromisoformat(os.environ.get("META_SPEND_UNTIL", "").replace("Z", "+00:00"))
        if until.tzinfo is None:
            raise ValueError
    except ValueError:
        return "Meta calls are switched off (no META_SPEND_UNTIL)."
    if now >= until:
        return "Meta calls are switched off (META_SPEND_UNTIL has passed)."
    if now >= datetime.fromisoformat(STOP_AT.replace("Z", "+00:00")):
        return "The event is over, so Meta calls are switched off."
    return None


def outline(mask):
    """The mask's own edge, not a hull around it: the largest connected piece's outer contour, simplified to about
    0.4% of its perimeter so a chair keeps its legs but the polygon stays a few dozen points."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    c = max(contours, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, max(1.0, 0.004 * cv2.arcLength(c, True)), True)
    return [(int(p[0][0]), int(p[0][1])) for p in c]


def instances(output_text, width, height):
    parser = image_segmentation_format().create_parser()
    parser.push(output_text)
    found = []
    for rec in parser.finish(CompletedOutcome()).result.records:
        if not isinstance(rec, SegmentationMaskRecord):
            continue
        raster = decode_mask_to_raster(rec.mask)
        mw, mh = rec.mask.width, rec.mask.height
        left, top = max(0, rec.bounds.left), max(0, rec.bounds.top)
        right, bottom = min(width, rec.bounds.right), min(height, rec.bounds.bottom)
        if right <= left or bottom <= top or len(raster) != mw * mh:
            continue
        sx, sy = (right - left) / mw, (bottom - top) / mh  # mask raster to image pixels
        mask = (np.frombuffer(bytes(raster), dtype=np.uint8) if isinstance(raster, (bytes, bytearray)) else np.asarray(raster, dtype=np.uint8)).reshape(mh, mw)
        mask = (mask > 0).astype(np.uint8)
        edge = outline(mask)
        if len(edge) < 3:
            continue
        pixels = int(mask.sum()) * sx * sy
        found.append({
            "outline": [[round(left + x * sx), round(top + y * sy)] for x, y in edge],
            "area": round(pixels),
            "box": [round(left), round(top), round(right), round(bottom)],
            "confidence": rec.confidence,
        })
    return found


def main():
    off = spend_off_reason()
    if off:
        sys.exit(f"sam: {off}")
    path, phrases = sys.argv[1], sys.argv[2:]
    data = open(path, "rb").read()
    width, height = Image.open(io.BytesIO(data)).size
    mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    client = OpenAI(base_url=os.environ.get("META_BASE_URL", "https://api.meta.ai/v1"), api_key=os.environ["META_API_KEY"], timeout=TIMEOUT_S, max_retries=1)

    def segment(phrase):
        try:
            r = client.responses.create(
                model=SAM_MODEL,
                input=[{"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": phrase},
                    {"type": "input_image", "image_url": url},
                ]}],
                metadata={"mask_encoding": "one_bit"},
                store=False,
            )
            return phrase, instances(r.output_text or "", width, height) if r.output_text else []
        except Exception as e:  # one failed phrase drops that object, not the room
            print(f"sam: {phrase}: {e}", file=sys.stderr)
            return phrase, None

    with ThreadPoolExecutor(max_workers=16) as pool:
        out = dict(pool.map(segment, phrases))
    print(json.dumps({"width": width, "height": height, "calls": len(phrases), "objects": out}))


if __name__ == "__main__":
    main()
