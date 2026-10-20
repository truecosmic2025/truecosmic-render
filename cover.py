#!/usr/bin/env python3
"""Title cover graphic generator (matches the 'By Imagination We Become' Canva design).
Usage: python3 neville_cover.py "Lecture Title" out.png ["Subtitle"]
Needs base_clean.png (made by make_base() from A_Divine_Event.png) and fonts/ dir."""
import os, sys
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
TITLE_BOX = (30, 388, 482, 528)
SUBTITLE_BOX = (60, 558, 452, 605)
MAGENTA = (199, 21, 152)
DEFAULT_SUB = "A Neville Goddard lecture transcript"

def make_base(src=os.path.join(HERE, "A_Divine_Event.png"), dst=os.path.join(HERE, "base_clean.png")):
    img = cv2.imread(src)
    mask = np.zeros(img.shape[:2], np.uint8)
    mask[388:530, 30:482] = 255
    mask[553:612, 60:452] = 255
    # only inpaint the text pixels: magenta title and white subtitle
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    magenta = cv2.inRange(hsv, (140, 80, 80), (175, 255, 255))
    white = cv2.inRange(hsv, (0, 0, 150), (180, 60, 255))
    text = cv2.bitwise_and(mask, cv2.bitwise_or(magenta, white))
    text = cv2.dilate(text, np.ones((5, 5), np.uint8), iterations=2)
    out = cv2.inpaint(img, text, 7, cv2.INPAINT_TELEA)
    cv2.imwrite(dst, out)

def _wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    lines.append(cur)
    return lines

def generate(title, subtitle=DEFAULT_SUB, output_path="cover.png"):
    base = os.path.join(HERE, "base_clean.png")
    if not os.path.exists(base):
        make_base()
    img = Image.open(base).convert("RGB")
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = TITLE_BOX
    boxw, boxh = x1 - x0, y1 - y0
    title = title.upper()
    for size in range(58, 20, -2):
        f = ImageFont.truetype(os.path.join(HERE, "fonts/LeagueGothic-Regular.ttf"), size)
        lines = _wrap(d, title, f, boxw)
        lh = int(size * 1.15)
        if len(lines) * lh <= boxh and all(d.textlength(l, font=f) <= boxw for l in lines):
            break
    y = y0 + (boxh - len(lines) * lh) // 2
    for l in lines:
        d.text(((512 - d.textlength(l, font=f)) / 2, y), l, font=f, fill=MAGENTA)
        y += lh
    sf = ImageFont.truetype(os.path.join(HERE, "fonts/Caveat-Medium.ttf"), 30)
    sx0, sy0, sx1, sy1 = SUBTITLE_BOX
    slines = _wrap(d, subtitle, sf, sx1 - sx0)
    y = sy0 + ((sy1 - sy0) - len(slines) * 34) // 2
    for l in slines:
        d.text(((512 - d.textlength(l, font=sf)) / 2, y), l, font=sf, fill="white")
        y += 34
    img.save(output_path)
    return output_path

if __name__ == "__main__":
    generate(sys.argv[1], sys.argv[3] if len(sys.argv) > 3 else DEFAULT_SUB, sys.argv[2])
