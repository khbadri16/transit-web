"""
DCP paper (تصريح باستيراد المنتوج) — fixed-layout PDF renderer
---------------------------------------------------------------
Replaces the fragile DCP.docx rendering. Every string is drawn at absolute
coordinates in an explicitly chosen order, then shipped as PDF: the output is
pixel-identical in every viewer and printer (Office 2010, LibreOffice, phones,
print shops) because no office suite ever re-computes the layout.

Arabic text is shaped with arabic-reshaper and ordered with python-bidi ONCE,
here on the server — the PDF contains plain positioned glyphs.

The س ت number (digits + one Arabic letter + digits) is the one thing the
Unicode bidi algorithm cannot lay out unambiguously, so it is drawn segment
by segment, strictly left to right: nn/nn-nnnnnnn [letter] nn.
"""

import io
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import arabic_reshaper
from bidi.algorithm import get_display
from fpdf import FPDF

BASE_DIR = Path(__file__).resolve().parent
# Font priority:
#   1. arialbd.ttf — the paper's original Arial Bold. Microsoft-licensed, so
#      not bundled: drop a copy from C:\Windows\Fonts into api/fonts/ and it
#      is picked up automatically.
#   2. PlexSansArabic-Bold.ttf — IBM Plex Sans Arabic (open SIL-OFL license),
#      a clean Arial-like sans with proper Arabic. Bundled default.
#   3. DejaVuSans-Bold.ttf — last-resort fallback.
ARIAL_PATH = BASE_DIR / "fonts" / "arialbd.ttf"
PLEX_PATH = BASE_DIR / "fonts" / "PlexSansArabic-Bold.ttf"
DEJAVU_PATH = BASE_DIR / "fonts" / "DejaVuSans-Bold.ttf"

FORM_INK = (60, 60, 60)     # static paper text — weak black
VALUE_INK = (0, 0, 0)       # entered data — full black
VALUE_PT_DELTA = 1.5        # entered data prints this much larger
VALUE_BOLDEN = 0.35         # second pass offset -> visibly heavier stroke

PAGE_W, PAGE_H = 595.28, 841.89          # A4 portrait, points
X_RIGHT = 549                            # right text edge (instructions)
X_FORM = 340                             # right edge of the form column
X_LEFT = 24                              # minimum left edge for form rows
COL_GAP = 12                             # required gap between the columns
BODY_PT = 11.5                           # nominal body size (auto-fits down)

# page border — a single light dash-dot line, like the .docx "dashDotStroked"
BORDER_INK = (0, 0, 0)                    # black, as in the original
BORDER_W = 1.0                            # thin line (not the heavy 3pt frame)
BORDER_INSET = 16.0                       # inset from the page edge
BORDER_DASH = (5, 2, 1, 2)               # dash, gap, dot, gap  (dash-dot)
INS_PT = 10.6                            # instruction column size

_AR_RE = re.compile("[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")


def _covers_paper(font_path: Path) -> bool:
    """Can this font display all shaped Arabic + Latin the paper needs?"""
    try:
        from fontTools.ttLib import TTFont
        cmap = TTFont(str(font_path), fontNumber=0).getBestCmap()
        probe = _vis(
            "\u0627\u0644\u062C\u0645\u0647\u0648\u0631\u064A\u0629 \u0627\u0644\u062C\u0632\u0627\u0626\u0631\u064A\u0629 \u0627\u0644\u062F\u064A\u0645\u0642\u0631\u0627\u0637\u064A\u0629 \u0627\u0644\u0634\u0639\u0628\u064A\u0629 \u0648\u0632\u0627\u0631\u0629 \u0627\u0644\u062A\u062C\u0627\u0631\u0629 \u062A\u0635\u0631\u064A\u062D "
            "\u0628\u0627\u0633\u062A\u064A\u0631\u0627\u062F \u0627\u0644\u0645\u0646\u062A\u0648\u062C \u0628\u062A\u0627\u0631\u064A\u062E \u0639\u0646\u0627\u0628\u0629 \u0645\u0628\u0627\u0634\u0631 \u0634\u0647\u0627\u062F\u0629 \u0627\u0644\u0645\u0637\u0627\u0628\u0642\u0629 \u0627\u0644\u0645\u0646\u0634\u0623 \u0628\u0627\u062E\u0631\u0629 "
            "\u0628\u062D\u0631\u064A\u0629 \u0627\u0644\u0644\u0642\u0628 \u0648\u0627\u0644\u0627\u0633\u0645 \u0623\u0648 \u0634\u0631\u0643\u0629 \u0627\u0644\u0645\u062A\u0639\u0627\u0645\u0644 \u0637\u0646 \u0645\u0631\u062C\u0639 \u0627\u0644\u0646\u0642\u0644 \u0648\u062B\u0627\u0626\u0642"
        ) + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/():.-,"
        return all(ord(ch) in cmap for ch in probe if ch.strip())
    except Exception:
        return False


def _pick_font() -> Path:
    """User's Arial Bold if present and complete, else the bundled IBM Plex
    Sans Arabic (Arial-like, open license), else DejaVu."""
    for candidate in (ARIAL_PATH, PLEX_PATH):
        if candidate.exists() and _covers_paper(candidate):
            return candidate
    return DEJAVU_PATH

_reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False})


def _vis(text: str, rtl: bool = True) -> str:
    """Logical text -> visual glyph string (shaped + bidi-ordered)."""
    return get_display(_reshaper.reshape(text), base_dir="R" if rtl else "L")


def _value_vis(value: str) -> str:
    """A typed value, kept exactly as typed. Anything containing Arabic flows
    right-to-left — so "2339 طرد" reads number first, unit after (طرد ends up
    on the right of the digits). Pure Latin/digit values (dates, amounts,
    BL numbers) flow left-to-right."""
    rtl = bool(_AR_RE.search(value))
    return _vis(value, rtl=rtl)


class _Draw:
    def __init__(self, pdf: FPDF):
        self.pdf = pdf
        self.body_pt = BODY_PT

    def ink(self, rgb: tuple):
        """Text + line colour: FORM_INK for the paper, VALUE_INK for values."""
        self.pdf.set_text_color(*rgb)
        self.pdf.set_draw_color(*rgb)

    def size(self, pt: float):
        self.pdf.set_font_size(pt)

    def form_size(self):
        self.size(self.body_pt)

    def value_size(self):
        self.size(self.body_pt + VALUE_PT_DELTA)

    def value_text(self, x: float, y: float, visual: str):
        """Entered data: full black, larger, double-struck for extra weight."""
        self.ink(VALUE_INK)
        self.pdf.text(x, y, visual)
        self.pdf.text(x + VALUE_BOLDEN, y, visual)
        self.ink(FORM_INK)

    def w(self, visual: str) -> float:
        return self.pdf.get_string_width(visual)

    def text(self, x: float, y: float, visual: str):
        self.pdf.text(x, y, visual)

    def right(self, x_right: float, y: float, logical: str, underline=False):
        v = _vis(logical)
        w = self.w(v)
        self.text(x_right - w, y, v)
        if underline:
            self.pdf.line(x_right - w, y + 2.2, x_right, y + 2.2)

    def center(self, y: float, logical: str, underline=False):
        v = _vis(logical)
        w = self.w(v)
        x = (PAGE_W - w) / 2
        self.text(x, y, v)
        if underline:
            self.pdf.line(x, y + 2.2, x + w, y + 2.2)

    def dots(self, width: float) -> str:
        dot = self.w(".")
        return "." * max(3, int(width / dot))


# ---------------------------------------------------------------------------
# form-row composition: tokens laid RIGHT -> LEFT from a given x
#   ("t",  logical_text)             static/label text (bidi-ordered here)
#   ("v",  value, dots_width[, sc])  typed value (optional per-value scale sc),
#                                    or a dotted blank when the value is empty
#   ("rc", parts, dots_width)        the س ت number, drawn manually left->right
#   ("g",  width)                    fixed gap
# ---------------------------------------------------------------------------


def _rc_visual_parts(parts: Tuple[str, str, str, str, str]) -> List[str]:
    p1, p2, p3, letter, p4 = parts
    out = [f"{p1}/{p2}-{p3}"]
    if letter:
        out.append(_vis(letter))  # isolated/shaped form of the single letter
    if p4:
        out.append(p4)
    return out


def _v_scale(tok: tuple) -> float:
    return tok[3] if len(tok) > 3 else 1.0


def _row_width(d: "_Draw", tokens: List[tuple]) -> float:
    """Total width of a form row (labels at body size, data at value size)."""
    total = 0.0
    for tok in tokens:
        kind = tok[0]
        if kind == "t":
            d.form_size()
            total += d.w(_vis(tok[1]))
        elif kind == "v":
            if tok[1]:
                d.size((d.body_pt + VALUE_PT_DELTA) * _v_scale(tok))
                total += d.w(_value_vis(tok[1])) + VALUE_BOLDEN
            else:
                d.form_size()
                total += d.w(d.dots(tok[2]))
        elif kind == "rc":
            parts, dots_w = tok[1], tok[2]
            if any(parts[i] for i in (0, 1, 2, 4)):
                d.value_size()
                total += sum(d.w(s) for s in _rc_visual_parts(parts)) + VALUE_BOLDEN
            else:
                d.form_size()
                total += d.w(d.dots(dots_w))
        elif kind == "g":
            total += tok[1]
    d.form_size()
    return total


def _draw_row(d: _Draw, y: float, tokens: List[tuple], x_start: float = X_FORM):
    x = x_start
    for tok in tokens:
        kind = tok[0]
        if kind == "t":
            d.form_size()
            v = _vis(tok[1])
            w = d.w(v)
            d.text(x - w, y, v)
            x -= w
        elif kind == "v":
            value, dots_w = tok[1], tok[2]
            if value:
                d.size((d.body_pt + VALUE_PT_DELTA) * _v_scale(tok))
                v = _value_vis(value)
                w = d.w(v) + VALUE_BOLDEN
                d.value_text(x - w, y, v)
                x -= w
            else:
                d.form_size()        # empty slot — dotted line, paper ink
                v = d.dots(dots_w)
                w = d.w(v)
                d.text(x - w, y, v)
                x -= w
        elif kind == "rc":
            parts, dots_w = tok[1], tok[2]
            if any(parts[i] for i in (0, 1, 2, 4)):
                d.value_size()
                segs = _rc_visual_parts(parts)
                total = sum(d.w(s) for s in segs) + VALUE_BOLDEN
                sx = x - total          # left edge of the cluster
                for s in segs:          # drawn strictly LEFT -> RIGHT
                    d.value_text(sx, y, s)
                    sx += d.w(s)
                x -= total
            else:
                d.form_size()
                v = d.dots(dots_w)
                w = d.w(v)
                d.text(x - w, y, v)
                x -= w
        elif kind == "g":
            x -= tok[1]
    d.form_size()


def build_dcp_pdf(fields: Dict[str, str],
                  rc_parts: Tuple[str, str, str, str, str]) -> bytes:
    """fields: display-ready values (dates formatted, currency/units already
    appended, NO bidi control characters). rc_parts: the 5 س ت inputs."""

    f = {k: (v or "").strip() for k, v in fields.items()}

    # legacy: an old free-text س ت value is shown in the same slot
    legacy_rc = f.get("رقم_س_ت", "")
    if legacy_rc and not any(rc_parts[i] for i in (0, 1, 2, 4)):
        rc_parts = (legacy_rc, "", "", "", "")

    pdf = FPDF(unit="pt", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)
    pdf.add_page()
    pdf.add_font("paper", "", str(_pick_font()))
    pdf.set_font("paper", "", 12)
    pdf.set_title("تصريح باستيراد المنتوج — DCP")

    d = _Draw(pdf)

    # ---------------- page border (light dash-dot line, like the .docx) ----
    pdf.set_draw_color(*BORDER_INK)
    pdf.set_line_width(BORDER_W)
    pdf._out("[" + " ".join(str(n) for n in BORDER_DASH) + "] 0 d")  # dash-dot
    pdf.rect(BORDER_INSET, BORDER_INSET,
             PAGE_W - 2 * BORDER_INSET, PAGE_H - 2 * BORDER_INSET, style="D")
    pdf._out("[] 0 d")  # reset to solid for everything else

    d.ink(FORM_INK)  # everything static prints in the softened paper gray

    # ---------------- header ----------------
    d.size(17)
    d.center(84, "الجمهورية الجزائرية الديمقراطية الشعبية", underline=True)
    d.size(13)
    d.right(X_RIGHT, 112, "وزارة التجارة", underline=True)
    d.right(X_RIGHT, 137, "مديرية التجارة لولاية عنابة", underline=True)
    d.right(X_RIGHT, 162, "مفتشية الحدود لميناء عنابة", underline=True)
    d.size(17)
    d.center(193, "تصريح باستيراد المنتوج", underline=True)
    d.size(14)
    d.center(221, "رقم :...../ المؤرخ :....../......./..........")
    d.size(9)
    d.center(244,
             "المادة3 من المرسوم التنفيذي رقم05-467مؤرخ في8دي القعدة عام1426الموافق10 ديسمبر في2005")

    # ---------------- body ----------------
    # Long single-value fields (المستورد, العنوان, الصانع) wrap onto a second
    # line instead of running off the paper, like a normal paragraph: line 1
    # uses the whole free line, line 2 continues directly below it and starts
    # on the SAME edge as line 1 — the text's own direction decides which edge
    # (Arabic -> right, Latin -> left). Each wrap adds WRAP_GAP of room so
    # everything below it slides down.
    WRAP_GAP = 14        # vertical room a wrap adds to the rows beneath it
    CONT_DY = 16         # continuation line sits this far below its main line
    MIN_WRAP_SCALE = 0.45

    def _vw(s: str, scale: float = 1.0) -> float:   # value width at value size
        d.size((d.body_pt + VALUE_PT_DELTA) * scale)
        w = d.w(_value_vis(s)) + VALUE_BOLDEN
        d.form_size()
        return w

    def _wrap(label: str, value: str, x_start: float = X_FORM):
        """(line1, line2|None, scale): if the value overruns its slot, fill
        line 1 with as many words as fit and put the rest on line 2; only if
        line 2 (or a single huge word) is still too wide, shrink just this
        field's value font until both lines fit."""
        d.form_size()
        budget = (x_start - d.w(_vis(label))) - X_LEFT
        if not value or _vw(value) <= budget:
            return value, None, 1.0
        words = value.split()
        scale = 1.0
        while True:
            first: List[str] = []
            for word in words:
                if first and _vw(" ".join(first + [word]), scale) > budget:
                    break
                first.append(word)
            line1, line2 = " ".join(first), " ".join(words[len(first):])
            fits = _vw(line1, scale) <= budget and (
                not line2 or _vw(line2, scale) <= budget)
            if fits or scale <= MIN_WRAP_SCALE:
                return line1, (line2 or None), round(scale, 3)
            scale = max(MIN_WRAP_SCALE, scale * 0.96)

    LBL_IMPORT, LBL_ADDR, LBL_MAKER = "(1)المستورد:  ", "(2)العنوان: ", "(10)الصانع:"
    imp1, imp2, imp_s = _wrap(LBL_IMPORT, f.get("المستورد", ""))
    adr1, adr2, adr_s = _wrap(LBL_ADDR, f.get("العنوان", ""))
    mak1, mak2, mak_s = _wrap(LBL_MAKER, f.get("الصانع", ""))
    d.form_size()

    # cumulative downward shift: a row moves down by WRAP_GAP for every wrapped
    # field placed above it (fields sit at base y 268 / 316 / 462)
    wrap_ys = [y for y, second in ((268, imp2), (316, adr2), (462, mak2)) if second]

    def _y(y: float) -> float:
        return y + WRAP_GAP * sum(1 for wy in wrap_ys if y > wy)

    # instruction column (right) — each line shrinks alone if it would ever
    # cross into the form column, so the two columns always stay separated
    INSTRUCTIONS = [
        (268, "1) اللقب والاسم أو شركة المتعامل"),
        (292, "2)العنوان الحقيقي للمتعامل المعني"),
        (316, "3)بين الطبيعة الحقيقة للمنتوج"),
        (340, "4)بين كيفية عرض المنتوج"),
        (364, "5)بين عدد الطروز"),
        (388, "6) الكمية بالأطنان"),
        (412, "7)التعريفة الجمركية ب8أرقام القيمة"),
        (462, "8)بين الرقم والتاريخ"),
        (487, "9)القيمة بالدينار الجزائري"),
        (511, "10)اللقب والاسم أو اسم شركة المنتج"),
        (536, "11)بين البلد الأصلي للمنتوج أو"),
        (551, "مكان التصنيع"),
        (598, "12)علامة التعريف والمعلومات المتعلقة."),
        (613, "بشفرة المنتوج"),
        (646, "13)مرجع الاشهاد المحتمل للمنتوج"),
        (670, "14) مرجع وسائل النقل"),
        (694, "مرجع وثائق المرفقة للمنتوج"),
        (718, "16) بين المكان والتاريخ"),
    ]
    ins_budget = X_RIGHT - (X_FORM + COL_GAP)
    for y, text in INSTRUCTIONS:
        d.size(INS_PT)
        v = _vis(text)
        w = d.w(v)
        if w > ins_budget:
            d.size(INS_PT * ins_budget / w)
            w = d.w(v)
        d.text(X_RIGHT - w, _y(y), v)

    # form column — measured first, then drawn once at one uniform size that
    # keeps every row inside the page (long values shrink the whole column
    # evenly instead of breaking the layout)
    ROWS: List[tuple] = [
        (268, [("t", LBL_IMPORT)] + ([] if imp2 else [("v", imp1, 200, imp_s)]), X_FORM),
        (292, [("t", "رقم وتاريخ س ت:"), ("rc", rc_parts, 95), ("g", 4),
               ("t", "بتاريخ:"), ("v", f.get("تاريخ_الاستراد", ""), 60)], X_FORM),
        (316, [("t", LBL_ADDR)] + ([] if adr2 else [("v", adr1, 200, adr_s)]), X_FORM),
        (340, [("t", "(3)تعيين المنتوج:"), ("v", f.get("تعيين_المنتوج", ""), 185)], X_FORM),
        (364, [("t", "(4)معروض في: "), ("v", f.get("معروض_في", ""), 58), ("g", 8),
               ("t", "(5)متكون من : "), ("v", f.get("متكون_من", ""), 58)], X_FORM),
        (388, [("t", "(6)الكمية:"), ("v", f.get("الكمية", ""), 60), ("g", 8),
               ("t", "(7)رقم التعريفة : انظر الملحق")], X_FORM),
        (412, [("t", "(8)فاتورة الشراء: "), ("v", f.get("فاتورة_الشراء", ""), 58), ("g", 8),
               ("t", "(9)القيمة: "), ("v", f.get("القيمة", ""), 76)], X_FORM),
        (436, [("t", "بتاريخ: "), ("v", f.get("الفاتورة_تاريخ", ""), 60), ("g", 34),
               ("v", f.get("القيمة_بالدينار", ""), 92)], X_FORM - 40),
        (462, [("t", LBL_MAKER)] + ([] if mak2 else [("v", mak1, 195, mak_s)]), X_FORM),
        (487, [("t", "(11) مكان المصدر : "), ("v", f.get("مكان_المصدر", ""), 175)], X_FORM),
        (511, [("t", "(12) رقم الحصة:"), ("v", "", 205)], X_FORM),
        (536, [("t", "(13) اشهاد المنتوج :"), ("t", ".....شهادة المنشأ"), ("v", "", 105)], X_FORM),
        (560, [("t", "المراقبات التي تعرض لها المنتوج: شهادة المطابقة"), ("v", "", 58)], X_FORM),
        (574, [("v", "", 300)], X_FORM),
        (598, [("v", "", 300)], X_FORM),
        (622, [("v", "", 300)], X_FORM),
        # باخرة بحرية / مباشر / عنابة are pre-filled DATA, not template text —
        # they print exactly like the values the user types
        (646, [("t", "(14) مرجع النقل : "), ("v", "باخرة بحرية", 0), ("g", 4),
               ("v", f.get("مرجع_النقل", ""), 105)], X_FORM),
        (670, [("t", "(15) وثائق النقل: "), ("v", f.get("وثائق_النقل", ""), 160)], X_FORM),
        (694, [("t", "(16)الانطلاق من : "), ("v", f.get("الانطلاق_من", ""), 58), ("g", 8),
               ("t", "بتاريخ: "), ("v", f.get("تاريخ_الانطلاق", ""), 58)], X_FORM),
        (718, [("t", "(16) العبور : "), ("v", "مباشر", 0), ("g", 24),
               ("t", "(16)الوصول: "), ("v", "عنابة", 0)], X_FORM),
    ]

    WRAPPED = [(base_y, label, first, second, scale)
               for base_y, label, first, second, scale in (
                   (268, LBL_IMPORT, imp1, imp2, imp_s),
                   (316, LBL_ADDR, adr1, adr2, adr_s),
                   (462, LBL_MAKER, mak1, mak2, mak_s))
               if second]

    def _continuations() -> List[tuple]:
        """Both lines of each wrapped field, line 2 right under line 1 and
        starting on the same edge. Arabic text: both lines start at the RIGHT
        edge (next to the label). Latin text: both lines start at the same
        LEFT edge, the block sitting against the label."""
        out: List[tuple] = []
        for base_y, label, first, second, scale in WRAPPED:
            d.form_size()
            label_left = X_FORM - d.w(_vis(label))
            w1, w2 = _vw(first, scale), _vw(second, scale)
            if _AR_RE.search(first + second):
                x1 = x2 = label_left
            else:
                left = max(X_LEFT, label_left - max(w1, w2))
                x1, x2 = left + w1, left + w2
            out.append((_y(base_y), [("v", first, 0, scale)], x1))
            out.append((_y(base_y) + CONT_DY, [("v", second, 0, scale)], x2))
        return out

    CONTINUATIONS = _continuations()

    # one uniform size for the whole column; iterate because entered data
    # keeps a fixed size bonus over the shrinking body size
    d.body_pt = BODY_PT
    for _ in range(3):
        shrink = 1.0
        # wrapped fields size themselves (see _wrap) — only ROWS count here
        for _, tokens, x_start in ROWS:
            width = _row_width(d, tokens)
            budget = x_start - X_LEFT
            if width > budget:
                shrink = min(shrink, budget / width)
        if shrink >= 0.999 or d.body_pt <= 9.0:
            break
        d.body_pt = max(d.body_pt * shrink, 9.0)
    CONTINUATIONS = _continuations()   # final positions at the final size
    for y, tokens, x_start in ROWS:
        _draw_row(d, _y(y), tokens, x_start)
    for abs_y, tokens, x_start in CONTINUATIONS:
        _draw_row(d, abs_y, tokens, x_start)

    # ---------------- footer ----------------
    d.size(11)
    d.right(X_RIGHT, 775, "تأشير وختم المستورد")
    d.center(775, "التاريخ:  /   /")
    v = _vis("إشعار بالاستلام لمتفشية الحدود")
    d.text(X_LEFT, 775, v)

    out = pdf.output()
    return bytes(out)
