"""
Visit day — printable list (PDF, French)
----------------------------------------
Clients added during the chosen period, in three sections:

    1. Sans date de visite   (no visit date yet)
    2. Visites à venir       (visit date after today, soonest first)
    3. Visites passées       (visit date before today, latest first)

Today's visits are NOT printed (they are on the page). Arabic client names
are shaped with arabic-reshaper + python-bidi, like the other PDFs.
"""

import io
import re
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, List, Optional

import arabic_reshaper
from bidi.algorithm import get_display
from fpdf import FPDF
from fpdf.fonts import FontFace

BASE_DIR = Path(__file__).resolve().parent
FONT_REGULAR = BASE_DIR / "fonts" / "PlexSansArabic-Regular.ttf"
FONT_BOLD = BASE_DIR / "fonts" / "PlexSansArabic-Bold.ttf"

MARGIN = 12.0
INK = (17, 24, 39)
MUTED = (100, 116, 139)
LINE = (203, 213, 225)
ZEBRA = (248, 250, 252)

SECTIONS = [
    # key, title, accent colour
    ("no_date", "Sans date de visite", (217, 119, 6)),
    ("upcoming", "Visites à venir", (37, 99, 235)),
    ("passed", "Visites passées", (71, 85, 105)),
]
COLUMNS = [  # title, width (mm), alignment
    ("N°", 9, "CENTER"),
    ("Client", 55, "LEFT"),
    ("N° déclaration", 34, "LEFT"),
    ("Lieu", 38, "LEFT"),
    ("Date de visite", 25, "CENTER"),
    ("Ajouté le", 25, "CENTER"),
]
FONT_PT = 9
CELL_PAD_X = 1.6

_AR_RE = re.compile("[֐-ࣿﭐ-﷿ﹰ-﻿]")
_reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False})


def _fr_date(iso: str) -> str:
    try:
        return date.fromisoformat((iso or "")[:10]).strftime("%d/%m/%Y")
    except ValueError:
        return ""


class _Pdf(FPDF):
    footer_note = ""

    def footer(self):
        self.set_y(-10)
        self.set_font("plex", "", 7.5)
        self.set_text_color(*MUTED)
        self.cell(0, 4, self.footer_note, align="L")
        self.set_x(self.l_margin)
        self.cell(0, 4, f"Page {self.page_no()}/{{nb}}", align="R")


def _cell_text(pdf: FPDF, text: str, width: float) -> str:
    """Arabic: wrap in reading order, then turn each line into visual order
    (fpdf2 would otherwise wrap the visual string backwards)."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if not _AR_RE.search(text):
        return text

    def vis(s: str) -> str:
        return get_display(_reshaper.reshape(s), base_dir="R")

    lines, cur = [], ""
    for word in text.split(" "):
        trial = f"{cur} {word}".strip()
        if cur and pdf.get_string_width(vis(trial)) > width:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    lines.append(cur)
    return "\n".join(vis(l) for l in lines)


def _sort(key: str, items: List[dict]) -> List[dict]:
    if key == "no_date":
        return sorted(items, key=lambda it: it.get("created_at", ""))
    if key == "upcoming":
        return sorted(items, key=lambda it: (it.get("visit_date", ""), it.get("client", "").lower()))
    return sorted(items, key=lambda it: (it.get("visit_date", ""), it.get("created_at", "")), reverse=True)


def split_sections(items: Iterable[dict], today: date) -> dict:
    t = today.isoformat()
    out = {"no_date": [], "upcoming": [], "passed": []}
    for it in items:
        d = it.get("visit_date") or ""
        if not d:
            out["no_date"].append(it)
        elif d > t:
            out["upcoming"].append(it)
        elif d < t:
            out["passed"].append(it)
        # d == today: not printed
    return {k: _sort(k, v) for k, v in out.items()}


def build_visits_pdf(items: Iterable[dict], today: date, start: Optional[date], end: Optional[date],
                     generated_at: datetime) -> bytes:
    sections = split_sections(items, today)

    pdf = _Pdf(unit="mm", format="A4")
    pdf.set_margins(MARGIN, MARGIN, MARGIN)
    pdf.set_auto_page_break(True, margin=14)
    pdf.add_font("plex", "", str(FONT_REGULAR))
    pdf.add_font("plex", "B", str(FONT_BOLD))
    pdf.set_title("Jours de visite")
    pdf.set_creator("Transit Document Generator")
    pdf.footer_note = f"Les visites du jour ({today.strftime('%d/%m/%Y')}) ne sont pas incluses."
    pdf.alias_nb_pages()
    pdf.add_page()
    full_w = pdf.w - 2 * MARGIN

    # ---- header ------------------------------------------------------------
    pdf.set_text_color(*INK)
    pdf.set_font("plex", "B", 18)
    pdf.cell(full_w * 0.6, 9, "Jours de visite", align="L")
    pdf.set_font("plex", "", 8.5)
    pdf.set_text_color(*MUTED)
    pdf.cell(full_w * 0.4, 9, f"Édité le {generated_at.strftime('%d/%m/%Y à %H:%M')}", align="R",
             new_x="LMARGIN", new_y="NEXT")
    if start and end:
        period = f"Clients ajoutés du {start.strftime('%d/%m/%Y')} au {end.strftime('%d/%m/%Y')}"
    elif start:
        period = f"Clients ajoutés depuis le {start.strftime('%d/%m/%Y')}"
    else:
        period = "Tous les clients"
    pdf.set_font("plex", "", 10)
    pdf.set_text_color(*INK)
    pdf.cell(full_w, 6, f"Période : {period}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # summary boxes
    box_w, gap = (full_w - 2 * 4) / 3, 4
    y = pdf.get_y()
    for i, (key, title, color) in enumerate(SECTIONS):
        x = MARGIN + i * (box_w + gap)
        pdf.set_draw_color(*LINE)
        pdf.set_fill_color(255, 255, 255)
        pdf.rect(x, y, box_w, 14, style="DF", round_corners=True, corner_radius=1.5)
        pdf.set_fill_color(*color)
        pdf.rect(x, y, 1.6, 14, style="F")
        pdf.set_xy(x + 4, y + 2)
        pdf.set_font("plex", "", 8)
        pdf.set_text_color(*MUTED)
        pdf.cell(box_w - 6, 4, title)
        pdf.set_xy(x + 4, y + 6.5)
        pdf.set_font("plex", "B", 13)
        pdf.set_text_color(*INK)
        pdf.cell(box_w - 6, 6, str(len(sections[key])))
    pdf.set_xy(MARGIN, y + 14 + 6)

    # ---- sections ----------------------------------------------------------
    widths = [w for _, w, _ in COLUMNS]
    for key, title, color in SECTIONS:
        rows = sections[key]
        if pdf.get_y() > pdf.h - 45:
            pdf.add_page()
        pdf.set_fill_color(*color)
        pdf.rect(MARGIN, pdf.get_y() + 1, 1.6, 6, style="F")
        pdf.set_x(MARGIN + 4)
        pdf.set_font("plex", "B", 12)
        pdf.set_text_color(*INK)
        pdf.cell(0, 8, f"{title}  ({len(rows)})", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1)
        if not rows:
            pdf.set_font("plex", "", 9)
            pdf.set_text_color(*MUTED)
            pdf.cell(0, 6, "Aucun client.", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(4)
            continue

        pdf.set_font("plex", "", FONT_PT)
        pdf.set_text_color(*INK)
        pdf.set_draw_color(*LINE)
        pdf.set_fill_color(*ZEBRA)
        heading = FontFace(family="plex", emphasis="BOLD", size_pt=8.5, color=(255, 255, 255), fill_color=color)
        with pdf.table(
            col_widths=widths,
            width=full_w,
            text_align=tuple(a for _, _, a in COLUMNS),
            headings_style=heading,
            line_height=4.6,
            padding=(1.4, CELL_PAD_X),
            cell_fill_color=ZEBRA,
            cell_fill_mode="ROWS",
            borders_layout="HORIZONTAL_LINES",
            v_align="MIDDLE",
        ) as table:
            head = table.row()
            for name, _, _ in COLUMNS:
                head.cell(name)
            for n, it in enumerate(rows, 1):
                r = table.row()
                r.cell(str(n))
                for col, field in ((1, "client"), (2, "declaration"), (3, "place")):
                    text = it.get(field, "") or ("—" if field == "place" else "")
                    r.cell(
                        _cell_text(pdf, text, widths[col] - 2 * CELL_PAD_X - 0.5),
                        align="RIGHT" if _AR_RE.search(text) else None,   # Arabic reads from the right
                    )
                r.cell(_fr_date(it.get("visit_date", "")) or "Pas encore")
                r.cell(_fr_date(it.get("created_at", "")))
        pdf.ln(6)

    out = io.BytesIO()
    pdf.output(out)
    return out.getvalue()
