"""
Folder cover — the page glued on the front of a client's folder (A4)
--------------------------------------------------------------------
Model 3 "French + Arabic": every title in simple French and in Arabic, big
values, made for a black & white printer (frames only, no dark fills).

The page adapts to its content: a long client name goes to 2-3 lines and
shrinks, 10+ containers go in 4-5 columns, and when everything together is
too tall the whole page is scaled down a little until the pen boxes at the
bottom (Date / N° Déclaration / Taxes) still fit. The arrival box at the top
is a pen box too: only its title is printed, the date is written by hand.

Optional: the name of the person the folder belongs to ("Appartient à / ملك ل"
in the form) is printed alone in a thin box at the very top, and when the
folder is at a depot, "Dépôt-<name>" goes in a stamp-like box next to N° BL.

Shipping line logos: put the image in api/logos/ named after the line
(hmm.png, cma-cgm.png, msc.png, maersk.png, akkon.png, white-line.png,
cosco.png, arkas.png — or any other line: "Turkon Line" -> turkon-line.png).
PNG, JPG or SVG.
The logo is printed alone (it already shows the name); without a file the
line name is printed instead, in big letters.
"""

import io
import re
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import arabic_reshaper
from bidi.algorithm import get_display
from fpdf import FPDF
from PIL import Image, ImageChops

BASE_DIR = Path(__file__).resolve().parent
FONT_REGULAR = BASE_DIR / "fonts" / "PlexSansArabic-Regular.ttf"
FONT_BOLD = BASE_DIR / "fonts" / "PlexSansArabic-Bold.ttf"
LOGO_DIR = BASE_DIR / "logos"
LOGO_EXT = (".png", ".jpg", ".jpeg", ".svg")

W, H = 210.0, 297.0
M = 12.0                      # page margin
INNER = W - 2 * M
INK = (17, 17, 17)
GREY = (90, 90, 90)
LINE_GREY = (200, 200, 200)
PEN_H = 38.0                  # pen boxes at the bottom
FOOTER_H = 9.0                # office name under a thin line, very bottom
OFFICE = "Transit Belarbi Tayeb"
PT = 0.3528                   # 1 pt in mm

# Known lines -> name printed on the cover (the user can type any other)
LINES = {
    "HMM": "HMM",
    "CMA": "CMA CGM",
    "CMA CGM": "CMA CGM",
    "MSC": "MSC",
    "MAERSK": "MAERSK",
    "AKKON": "AKKON",
    "WHITE LINE": "WHITE LINE",
    "COSCO": "COSCO",
    "ARKAS": "ARKAS",
}

_AR_RE = re.compile("[֐-ࣿﭐ-﷿ﹰ-﻿]")
_reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False})


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def is_ar(s: str) -> bool:
    return bool(_AR_RE.search(s or ""))


def vis(s: str) -> str:
    """Logical -> visual order (Arabic shaped), for fpdf2."""
    if not is_ar(s):
        return s
    return get_display(_reshaper.reshape(s), base_dir="R")


def clean(s, limit: int = 200) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:limit]


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def logo_path(line: str) -> Optional[Path]:
    s = slug(line)
    if s == "cma":
        s = "cma-cgm"
    if not s:
        return None
    for ext in LOGO_EXT:
        p = LOGO_DIR / f"{s}{ext}"
        if p.is_file():
            return p
    return None


@lru_cache(maxsize=32)
def _trimmed(path_str: str, mtime: float):
    """The logo without its empty margins, so it fills the box (PNG/JPG).
    Transparent margins are cut; on a white JPG, the white border is cut."""
    im = Image.open(path_str)
    im.load()
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        box = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    else:
        im = im.convert("RGB")
        diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).convert("L")
        box = diff.point(lambda v: 255 if v > 18 else 0).getbbox()
    return im.crop(box) if box else im


def logo_image(path: Path):
    if path.suffix.lower() == ".svg":
        return str(path)
    try:
        return _trimmed(str(path), path.stat().st_mtime)
    except Exception:
        return str(path)


def available_logos() -> List[str]:
    if not LOGO_DIR.is_dir():
        return []
    return sorted({p.stem for p in LOGO_DIR.iterdir() if p.suffix.lower() in LOGO_EXT})


def fmt_int(v: str) -> str:
    """'1250' -> '1 250' ; anything not a plain number is kept as typed."""
    t = clean(v, 40)
    digits = t.replace(" ", "").replace(" ", "")
    if re.fullmatch(r"\d+", digits):
        return f"{int(digits):,}".replace(",", " ")
    m = re.fullmatch(r"(\d+)[.,](\d+)", digits)
    if m:
        return f"{int(m.group(1)):,}".replace(",", " ") + "," + m.group(2)
    return t


def fmt_container(c: str) -> str:
    c = re.sub(r"[\s\-./]+", "", c.upper())
    return f"{c[:4]} {c[4:]}" if re.fullmatch(r"[A-Z]{4}\d{7}", c) else c


CONTAINER_RE = re.compile(r"[A-Za-z]{4}\s*-?\s*\d{6}\s*-?\s*\d")


def split_containers(raw) -> List[str]:
    """Containers typed one per line, or pasted on one line, comma separated..."""
    text = "\n".join(map(str, raw)) if isinstance(raw, list) else str(raw or "")
    out: List[str] = []
    for chunk in re.split(r"[\n,;]+", text):
        found = CONTAINER_RE.findall(chunk)
        out.extend(found)
        rest = CONTAINER_RE.sub(" ", chunk)
        for tok in rest.split():
            if len(re.sub(r"[^A-Za-z0-9]", "", tok)) >= 4:   # other formats, kept as typed
                out.append(tok)
    return [fmt_container(c) for c in out][:60]


# --------------------------------------------------------------------------
# drawing
# --------------------------------------------------------------------------


class _Pdf(FPDF):
    def __init__(self):
        super().__init__(unit="mm", format="A4")
        self.set_auto_page_break(False)
        self.set_margins(M, M, M)
        self.add_font("plex", "", str(FONT_REGULAR))
        self.add_font("plex", "B", str(FONT_BOLD))
        self.set_draw_color(*INK)
        self.set_text_color(*INK)

    def width(self, text: str, size: float, bold: bool = True) -> float:
        self.set_font("plex", "B" if bold else "", size)
        return self.get_string_width(vis(text))

    def text_at(self, x, y, w, h, text, size, bold=False, align="L", color=INK):
        if not text:
            return
        self.set_font("plex", "B" if bold else "", size)
        self.set_text_color(*color)
        self.set_xy(x, y)
        self.cell(w, h, vis(text), align=align)

    def fit(self, text: str, w: float, size: float, min_size: float, bold=True) -> float:
        while size > min_size and self.width(text, size, bold) > w:
            size -= 0.5
        return size

    def wrap(self, text: str, w: float, size: float, bold=True) -> List[str]:
        words, lines, cur = text.split(" "), [], ""
        for word in words:
            trial = f"{cur} {word}".strip()
            if cur and self.width(trial, size, bold) > w:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        lines.append(cur)
        return lines

    def fit_lines(self, text: str, w: float, size: float, min_size: float, max_lines: int,
                  bold=True) -> Tuple[List[str], float]:
        """Biggest size where the text fits in max_lines lines of width w."""
        s = size
        while True:
            lines = self.wrap(text, w, s, bold)
            if len(lines) <= max_lines and all(self.width(l, s, bold) <= w for l in lines):
                return lines, s
            if s <= min_size:
                # last resort: keep max_lines lines, squeeze each one
                lines = lines[:max_lines - 1] + [" ".join(lines[max_lines - 1:])]
                return lines, s
            s -= 0.5

    def label(self, x, y, w, fr, ar, size):
        self.text_at(x, y, w, size * PT * 1.6, fr, size, True, "L", GREY)
        self.text_at(x, y, w, size * PT * 1.6, ar, size, True, "R", GREY)

    def lines_at(self, x, y, w, lines, size, bold=True, align="L", lh=1.18):
        """Draw lines; Arabic lines go to the right. Returns the height used."""
        step = size * PT * lh
        for i, ln in enumerate(lines):
            a = "R" if is_ar(ln) else align
            self.set_font("plex", "B" if bold else "", size)
            self.set_text_color(*INK)
            tw = self.get_string_width(vis(ln))
            if tw > w:  # squeeze a line that is still a hair too wide
                with self.local_context(font_stretching=max(60.0, 100.0 * w / tw)):
                    self.set_xy(x, y + i * step)
                    self.cell(w, step, vis(ln), align=a)
            else:
                self.set_xy(x, y + i * step)
                self.cell(w, step, vis(ln), align=a)
        return len(lines) * step

    def box(self, x, y, w, h, lw=0.6):
        self.set_draw_color(*INK)
        self.set_line_width(lw)
        self.rect(x, y, w, h, round_corners=True, corner_radius=2.5)


def _render(pdf: _Pdf, d: Dict, s: float, extra: float = 0.0) -> float:
    """Draw everything above the pen boxes at scale s; return the bottom y.
    `extra` (mm) is added between the blocks when the page has room to spare."""
    pad = 5 * s
    lab = 10.5 * s                    # label size (pt)
    lab_h = lab * PT * 1.6

    # ---- who the folder belongs to (optional): the name alone, very top -----
    top = M
    if d["belongs_to"]:
        bh = 13 * s
        pdf.box(M, M, INNER, bh, 0.5)
        size = pdf.fit(d["belongs_to"], INNER - 2 * pad, 22 * s, 10)
        pdf.text_at(M, M, INNER, bh, d["belongs_to"], size, True, "C")
        top = M + bh + 5 * s

    # ---- header: shipping line (logo + name) | arrival -------------------
    hh = 32 * s
    lw_box = 78
    pdf.box(M, top, lw_box, hh, 0.8)
    line = d["line"]
    logo = logo_path(line)
    if logo:
        # the logo alone — every logo already shows the line's name
        inset = 4.0 * s
        try:
            pdf.image(logo_image(logo), x=M + inset + 1.5, y=top + inset, w=lw_box - 2 * inset - 3, h=hh - 2 * inset,
                      keep_aspect_ratio=True)
        except Exception:
            logo = None
    if not logo:
        size = pdf.fit(line or " ", lw_box - 2 * pad, 32 * s, 12)
        pdf.text_at(M, top, lw_box, hh, line, size, True, "C")

    bx = M + lw_box + 6
    bw = W - M - bx
    pdf.box(bx, top, bw, hh, 0.7)
    pdf.label(bx + pad, top + 3 * s, bw - 2 * pad, "Arrivée", "تاريخ الوصول", lab)
    # left empty for the pen, like the boxes at the bottom
    pdf.set_draw_color(*LINE_GREY)
    pdf.set_line_width(0.3)
    pdf.line(bx + pad, top + hh - 9 * s, bx + bw - pad, top + hh - 9 * s)
    pdf.set_draw_color(*INK)
    y = top + hh + 8 * s + extra

    # ---- client ---------------------------------------------------------------
    pdf.label(M, y, INNER, "Client", "الزبون", 11.5 * s)
    y += 11.5 * s * PT * 1.6 + 1
    client = d["client"]
    if client:
        lines, size = None, None
        for max_lines, top, low in ((1, 44, 30), (2, 34, 20), (3, 24, 14)):
            ls, sz = pdf.fit_lines(client, INNER, top * s, low * s, max_lines)
            if len(ls) <= max_lines and all(pdf.width(l, sz) <= INNER for l in ls):
                lines, size = ls, sz
                break
        if lines is None:
            lines, size = pdf.fit_lines(client, INNER, 14 * s, 9, 3)
        y += pdf.lines_at(M, y, INNER, lines, size, lh=1.12)
    else:
        y += 18 * s
    y += 2 * s

    extras = [(fr, ar_, d[k]) for fr, ar_, k in (("Propriétaire", "المالك", "owner"), ("Destination", "الوجهة", "destination")) if d[k]]
    if extras:
        half = (INNER - 8) / 2
        used = 0.0
        for i, (fr, ar_, val) in enumerate(extras):
            x = M + i * (half + 8)
            pdf.label(x, y, half, fr, ar_, 10 * s)
            ls, sz = pdf.fit_lines(val, half, 16 * s, 10 * s, 2)
            used = max(used, 10 * s * PT * 1.6 + pdf.lines_at(x, y + 10 * s * PT * 1.6, half, ls, sz))
        y += used + 2 * s
    pdf.set_line_width(1.4)
    pdf.line(M, y + 1, W - M, y + 1)
    y += 6 * s + extra

    # ---- N° BL | Dépôt (optional) ----------------------------------------------
    bl_h = 30 * s
    bl_w = INNER
    if d["depot"]:
        dep_w = 66
        bl_w = INNER - dep_w - 6
        dx = M + bl_w + 6
        pdf.box(dx, y, dep_w, bl_h, 1.4)
        text = f"Dépôt-{d['depot']}"
        size = pdf.fit(text, dep_w - 2 * pad, 24 * s, 10)
        pdf.text_at(dx, y, dep_w, bl_h, text, size, True, "C")
    pdf.box(M, y, bl_w, bl_h)
    pdf.label(M + pad, y + 3 * s, bl_w - 2 * pad, "N° BL", "رقم بوليصة الشحن", lab)
    size = pdf.fit(d["bl"] or " ", bl_w - 2 * pad, 26 * s, 12)
    pdf.text_at(M + pad, y + 3 * s + lab_h, bl_w - 2 * pad, bl_h - 6 * s - lab_h, d["bl"], size, True)
    y += bl_h + 7 * s + extra

    # ---- containers --------------------------------------------------------------
    conts = d["containers"]
    n = len(conts)
    cols = 3 if n <= 3 else 4 if n <= 16 else 5
    cw = (INNER - 2 * pad) / cols
    size = 19 * s
    for c in conts:
        size = min(size, pdf.fit(c, cw - 3, 19 * s, 8))
    rows = max(1, -(-n // cols))
    row_h = size * PT * 1.55
    c_h = 3 * s + lab_h + 3 * s + rows * row_h + 4 * s
    c_h = max(c_h, 32 * s)
    pdf.box(M, y, INNER, c_h)
    pdf.label(M + pad, y + 3 * s, INNER - 2 * pad, f"Conteneurs ({n})" if n else "Conteneurs", "الحاويات", lab)
    cy = y + 3 * s + lab_h + 3 * s
    for i, c in enumerate(conts):
        pdf.text_at(M + pad + (i % cols) * cw, cy + (i // cols) * row_h, cw, row_h, c, size, True)
    y += c_h + 7 * s + extra

    # ---- colis / poids / marchandise ---------------------------------------------
    gap = 5
    tw = (INNER - 2 * gap) / 3
    tiles = [
        ("Colis", "عدد الطرود", d["packages"]),
        ("Poids", "الوزن", f"{d['weight']} kg" if d["weight"] else ""),
        ("Marchandise", "السلعة", d["goods"]),
    ]
    layouts = []
    for fr, ar_, val in tiles:
        if not val:
            layouts.append(([], 0))
            continue
        ls, sz = pdf.fit_lines(val, tw - 8, 24 * s, 11 * s, 2)
        layouts.append((ls, sz))
    body = max([len(ls) * sz * PT * 1.18 for ls, sz in layouts] + [24 * s * PT * 1.18])
    t_h = max(34 * s, 3 * s + lab_h + 4 * s + body + 4 * s)
    for i, ((fr, ar_, _), (ls, sz)) in enumerate(zip(tiles, layouts)):
        x = M + i * (tw + gap)
        pdf.box(x, y, tw, t_h)
        pdf.label(x + 4, y + 3 * s, tw - 8, fr, ar_, lab)
        if ls:
            pdf.lines_at(x + 4, y + 3 * s + lab_h + 4 * s, tw - 8, ls, sz)
    y += t_h
    return y


def _footer(pdf: _Pdf) -> None:
    """Thin line + the office name, at the very bottom of the page."""
    y = H - M - FOOTER_H + 3.5
    pdf.set_draw_color(*LINE_GREY)
    pdf.set_line_width(0.25)
    pdf.line(M, y, W - M, y)
    pdf.text_at(M, y + 1.2, INNER, 5, OFFICE, 9.5, False, "C", GREY)


def _pen_boxes(pdf: _Pdf) -> None:
    y = H - M - FOOTER_H - PEN_H
    gap = 4
    w = (INNER - 2 * gap) / 3
    for i, (fr, ar_, unit) in enumerate((("Date", "التاريخ", ""), ("N° Déclaration", "رقم التصريح", ""), ("Taxes", "الرسوم", "DA"))):
        x = M + i * (w + gap)
        pdf.box(x, y, w, PEN_H, 0.5)
        pdf.label(x + 4, y + 3, w - 8, fr, ar_, 11)
        if unit:
            pdf.text_at(x + 4, y + PEN_H - 9, w - 8, 6, unit, 12, True, "R", GREY)
        pdf.set_draw_color(*LINE_GREY)
        pdf.set_line_width(0.3)
        pdf.line(x + 4, y + PEN_H - 10, x + w - (14 if unit else 4), y + PEN_H - 10)


def normalize(data: Dict) -> Dict:
    raw_line = clean(data.get("line"), 40)
    line = LINES.get(raw_line.upper(), raw_line.upper() if not is_ar(raw_line) else raw_line)
    client = clean(data.get("client"), 160)
    # "SNTR" -> Dépôt-SNTR ; a typed "Depot SNTR" must not print Dépôt-DEPOT SNTR
    depot = re.sub(r"^d[ée]p[ôo]t\b[\s\-:]*", "", clean(data.get("depot"), 40), flags=re.I)
    return {
        "line": line,
        "client": client if is_ar(client) else client.upper(),
        "owner": clean(data.get("owner"), 80),
        "destination": clean(data.get("destination"), 80),
        "bl": re.sub(r"\s+", "", clean(data.get("bl"), 40)).upper(),
        "containers": split_containers(data.get("containers")),
        "packages": fmt_int(data.get("packages", "")),
        "weight": fmt_int(data.get("weight", "")),
        "goods": clean(data.get("goods"), 80),
        "depot": depot if is_ar(depot) else depot.upper(),
        "belongs_to": clean(data.get("belongs_to"), 60),
    }


def build_folder_cover(data: Dict) -> bytes:
    d = normalize(data)
    limit = H - M - FOOTER_H - PEN_H - 8   # content must end above the pen boxes

    def attempt(scale: float, extra: float = 0.0):
        pdf = _Pdf()
        pdf.set_title(f"Couverture — {d['client'] or 'dossier'}")
        pdf.set_creator("Transit Document Generator")
        pdf.add_page()
        return pdf, _render(pdf, d, scale, extra)

    s = 1.0
    pdf, bottom = attempt(s)
    while bottom > limit and s > 0.55:          # too tall: shrink everything a bit
        s = round(s - 0.04, 2)
        pdf, bottom = attempt(s)
    if bottom < limit - 4:                        # room left: spread the blocks
        pdf, bottom = attempt(s, min(9.0, (limit - bottom) / 4))
    _pen_boxes(pdf)
    _footer(pdf)
    out = io.BytesIO()
    pdf.output(out)
    return out.getvalue()
