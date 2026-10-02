"""
Étiquetage — product labels (ملصقات) as a print-and-cut PDF
------------------------------------------------------------
The browser does the whole layout of every label (font size, line breaks,
baselines, care-symbol box) with the SAME font as here
(IBM Plex Sans Arabic Bold) and sends absolute positions in millimetres.
This module only draws them, so the PDF matches the screen:

  * the text lines (Arabic shaped with arabic-reshaper + python-bidi),
    right-aligned, horizontally squeezed if a line is a hair too wide;
  * the care symbols (علامة الصيانة) — the static drawing copied from
    TIKTAJ I.docx, same geometry as the SVG in src/Etiquetage.tsx;
  * the dashed cut line around each label.
"""

import io
import re
from pathlib import Path
from typing import Iterable, Tuple

import arabic_reshaper
from bidi.algorithm import get_display
from fpdf import FPDF

BASE_DIR = Path(__file__).resolve().parent
PLEX_PATH = BASE_DIR / "fonts" / "PlexSansArabic-Bold.ttf"
DEJAVU_PATH = BASE_DIR / "fonts" / "DejaVuSans-Bold.ttf"

PAGE_W, PAGE_H = 210.0, 297.0            # A4 portrait, mm

TEXT_INK = (0, 0, 0)
CUT_INK = (31, 41, 55)                    # dark grey, like the preview
CUT_W = 0.25                              # mm
CUT_DASH, CUT_GAP = 1.6, 1.1              # mm

# Care symbols drawing (units of the original VML group: 1723 × 330),
# drawn inside a viewBox padded by 8 units with a 16-unit stroke.
CARE_W, CARE_H, CARE_PAD, CARE_STROKE = 1723.0, 330.0, 8.0, 16.0
CARE_SHAPES = [
    # iron
    ("rect", (1390, 227.3, 333, 102.7)),
    ("line", (1560.1, 105, 1723, 227.3)),
    ("line", (1305, 105, 1560.1, 105)),
    # wash tub
    ("poly", ((1020, 105), (1091.2, 330), (1233.8, 330), (1305, 105))),
    # crossed triangle — do not bleach
    ("poly", ((855.5, 0), (968, 330), (743, 330))),
    ("line", (705, 0, 848, 330)),
    ("line", (1001, 0, 848, 330)),
    # dry clean
    ("ellipse", (562.5, 217.5, 142.5, 112.5)),
    # tumble dry
    ("rect", (0, 30, 345, 300)),
    ("ellipse", (172.5, 180, 172.5, 150)),
]


_AR_RE = re.compile("[֐-ࣿﭐ-﷿ﹰ-﻿]")
_reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False})

MAX_PAGES = 60
MAX_LABELS = 2000


def _vis(text: str) -> str:
    """Logical text -> visual glyph string. A line is an RTL paragraph, like
    in the browser (direction: rtl)."""
    if not _AR_RE.search(text):
        return get_display(text, base_dir="R")
    return get_display(_reshaper.reshape(text), base_dir="R")


def _num(v, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f and abs(f) < 1e5 else default  # NaN / absurd -> default


def _draw_care(pdf: FPDF, x: float, y: float, w: float, h: float) -> None:
    sx = w / (CARE_W + 2 * CARE_PAD)
    sy = h / (CARE_H + 2 * CARE_PAD)

    def P(ux: float, uy: float) -> Tuple[float, float]:
        return x + (ux + CARE_PAD) * sx, y + (uy + CARE_PAD) * sy

    with pdf.local_context(
        draw_color=TEXT_INK,
        line_width=max(0.12, CARE_STROKE * min(sx, sy)),
        stroke_join_style="ROUND",
        stroke_cap_style="ROUND",
    ):
        for kind, g in CARE_SHAPES:
            if kind == "rect":
                x0, y0 = P(g[0], g[1])
                pdf.rect(x0, y0, g[2] * sx, g[3] * sy, style="D")
            elif kind == "line":
                x0, y0 = P(g[0], g[1])
                x1, y1 = P(g[2], g[3])
                pdf.line(x0, y0, x1, y1)
            elif kind == "poly":
                pdf.polygon([P(px, py) for px, py in g], style="D")
            elif kind == "ellipse":
                cx, cy, rx, ry = g
                x0, y0 = P(cx - rx, cy - ry)
                pdf.ellipse(x0, y0, 2 * rx * sx, 2 * ry * sy, style="D")


def build_labels_pdf(pages: int, labels: Iterable[dict]) -> bytes:
    labels = list(labels)[:MAX_LABELS]
    pages = int(max(1, min(MAX_PAGES, pages or 1)))

    pdf = FPDF(unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)
    pdf.set_title("Étiquettes")
    pdf.set_creator("Transit Document Generator")
    font_path = PLEX_PATH if PLEX_PATH.exists() else DEJAVU_PATH
    pdf.add_font("label", "", str(font_path))

    for page in range(pages):
        pdf.add_page()
        for lab in labels:
            if int(_num(lab.get("page"), -1)) != page:
                continue
            x, y = _num(lab.get("x")), _num(lab.get("y"))
            w, h = _num(lab.get("w")), _num(lab.get("h"))
            if w <= 0 or h <= 0:
                continue
            size_pt = max(2.0, min(80.0, _num(lab.get("size_pt"), 8.0)))
            max_w = max(1.0, _num(lab.get("max_width"), w))

            # 1 — text + care symbols, clipped to the label. The font is
            # selected INSIDE a local context: the clip is a q/Q graphics
            # state, so a font chosen once outside would be lost after the
            # first label's Q (fpdf2 would not re-emit it).
            with pdf.rect_clip(x, y, w, h):
                with pdf.local_context(
                    font_family="label", font_style="", font_size_pt=size_pt,
                    text_color=TEXT_INK,
                ):
                    for ln in lab.get("lines") or []:
                        text = str(ln.get("text", ""))[:600]
                        if not text.strip():
                            continue
                        vis = _vis(text)
                        tw = pdf.get_string_width(vis)
                        x_right = _num(ln.get("x_right"), x + w)
                        baseline = _num(ln.get("baseline"), y)
                        if tw > max_w:
                            # a hair wider than on screen (metrics rounding):
                            # squeeze horizontally instead of overflowing
                            with pdf.local_context(font_stretching=max(50.0, 100.0 * max_w / tw)):
                                pdf.text(x_right - max_w, baseline, vis)
                        else:
                            pdf.text(x_right - tw, baseline, vis)

                care = lab.get("care")
                if care:
                    cw, ch = _num(care.get("w")), _num(care.get("h"))
                    if cw > 0 and ch > 0:
                        _draw_care(pdf, _num(care.get("x")), _num(care.get("y")), cw, ch)

            # 2 — dashed cut line = the label border
            with pdf.local_context(draw_color=CUT_INK, line_width=CUT_W):
                pdf.set_dash_pattern(dash=CUT_DASH, gap=CUT_GAP)
                pdf.rect(x, y, w, h, style="D")
                pdf.set_dash_pattern()

    out = io.BytesIO()
    pdf.output(out)
    return out.getvalue()
