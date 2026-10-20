#!/usr/bin/env python3
"""TrueCosmic Neville transcript -> branded PDF (matches 'Wonder Working Power' template).

Usage: python3 neville_pdf.py transcript.txt "Lecture Title" out.pdf
Accepts plain prose or ElevenLabs SRT-style text (timestamps / [Speaker N] tags are stripped).
No date line (dates are not available).
"""
import os, re, sys
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer
from reportlab.pdfgen import canvas as _c  # noqa

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "logo_trimmed.png")
FOOT = os.path.join(HERE, "footer_trimmed.png")

BLOG_URL = "https://truecosmic.com/wordpress/blog/"
FB_URL = "https://www.facebook.com/Truecosmiccom-104769814391239/"
IG_URL = "https://instagram.com/truecosmic?igshid=h858vo07gqdl"
PIN_URL = "https://pin.it/w54xxm6id3x3sk"

LOGO_W = 1.4 * 72 * 0.75   # ~75pt, as in template
FOOT_W = 2.6 * 72
# icon x-ranges / y-range measured on footer_trimmed.png (473 x 148 px)
ICONS = [((162, 205), FB_URL), ((219, 261), IG_URL), ((272, 312), PIN_URL)]
ICON_Y = (10, 58)  # px from top of footer image


def clean_transcript(raw):
    lines = []
    for ln in raw.splitlines():
        if re.match(r"^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->", ln.strip()):
            continue
        if not ln.strip():
            continue
        lines.append(ln.strip())
    text = " ".join(lines)
    text = re.sub(r"\[Speaker \d+\]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    # normalise characters the built-in PDF font cannot draw
    text = (text.replace("‑", "-").replace(" ", " ").replace(" ", " ")
                .replace(" ", " "))
    sentences = re.split(r"(?:(?<=[.!?])|(?<=[.!?][\"”']))\s+(?=[A-Z\"“'])", text)
    paras, cur, n = [], [], 0
    for s in sentences:
        cur.append(s)
        n += 1
        if n >= 5 and len(" ".join(cur)) > 450:
            paras.append(" ".join(cur)); cur, n = [], 0
    if cur:
        if paras and len(" ".join(cur)) < 150:
            paras[-1] += " " + " ".join(cur)
        else:
            paras.append(" ".join(cur))
    return paras


def title_from_filename(name):
    base = os.path.splitext(os.path.basename(name))[0]
    base = re.sub(r"[-_]+", " ", base).strip()
    return base.upper()


def safe(s):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.encode("cp1252", "replace").decode("cp1252")


def build_from_text(raw, title, out_path):
    paras = clean_transcript(raw)
    lw, lh = Image.open(LOGO).size
    fw, fh = Image.open(FOOT).size
    logo_h = LOGO_W * lh / lw
    foot_h = FOOT_W * fh / fw
    W, H = A4

    def decorate(c, doc):
        c.saveState()
        lx = (W - LOGO_W) / 2
        ly = H - 40 - logo_h
        c.drawImage(LOGO, lx, ly, LOGO_W, logo_h, mask="auto")
        c.linkURL(BLOG_URL, (lx, ly, lx + LOGO_W, ly + logo_h), relative=0)
        fx = (W - FOOT_W) / 2
        fy = 22
        c.drawImage(FOOT, fx, fy, FOOT_W, foot_h, mask="auto")
        sx = FOOT_W / fw
        sy = FOOT_W / fw
        for (x0, x1), url in ICONS:
            c.linkURL(url, (fx + x0 * sx, fy + foot_h - ICON_Y[1] * sy,
                            fx + x1 * sx, fy + foot_h - ICON_Y[0] * sy), relative=0)
        c.restoreState()

    top = 40 + logo_h + 24
    bottom = 22 + foot_h + 16
    doc = BaseDocTemplate(out_path, pagesize=A4, leftMargin=72, rightMargin=72,
                          topMargin=top, bottomMargin=bottom,
                          title=title.title(), author="TrueCosmic")
    frame = Frame(72, bottom, W - 144, H - top - bottom, id="f", leftPadding=0,
                  rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=decorate)])

    ts = ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=15, leading=20,
                        alignment=TA_CENTER, spaceAfter=22)
    bs = ParagraphStyle("b", fontName="Helvetica", fontSize=11, leading=16,
                        alignment=TA_JUSTIFY, spaceAfter=14)
    story = [Paragraph(safe(title.upper()), ts)]
    story += [Paragraph(safe(p), bs) for p in paras]
    doc.build(story)
    return out_path


