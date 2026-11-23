"""
Optional values written into the blank spaces of a rendered paper
=================================================================
The BON DE COMMANDE and the LETTRE D'ENGAGEMENT leave spaces blank to be
filled by pen once the ship has arrived: NAVIRE (its name), GROS and ARTICLE
(numbers). When the user typed one of these values, it is written into the
RENDERED copy, in memory. The .docx templates themselves are never modified.

  * The value goes into the blank that follows its label ("NAVIRE :"), in the
    blank's own formatting (never the label's underline).
  * Only blank characters are replaced: spaces, or the dots / underscores of a
    fill line. Every other character the template prints stays.
  * The value takes exactly as much of the blank as its printed width,
    measured with the real character widths of the paper's font (tables
    below), so what follows the blank on the line ("DATE ARR NAVIRE",
    "ARTICLE", "POIDS BRUT") stays where it was.
  * A value wider than its whole blank is printed smaller (down to half the
    line's size); one still too wide pushes what follows to the right, but
    never so far that the line breaks in two (it shrinks more instead, to 5 pt
    at the very least).
  * An empty value changes nothing: the paper keeps its blank for the pen.

The arrival date goes in a date line, "DATE ARR NAVIRE :  __ / __ /2026": the
day and the month are written centered in their two blanks, with exactly as
much space on each side, so the slashes and the year stay where the template
prints them. The year is replaced only by another year (all digits have the
same width: nothing moves).
"""

import copy
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

UNITS_PER_EM = 2048

# Advance widths, in font units (2048 per em), of the printable ASCII
# characters U+0020..U+007E. Read from fonts that have exactly the same
# metrics as the ones the papers use: Liberation Serif = Times New Roman,
# Carlito = Calibri. (Times New Roman regular is not needed: everything the
# Bon prints is bold.)
_ASCII_WIDTHS: Dict[Tuple[str, bool], Tuple[int, ...]] = {
    ("Times New Roman", True): (
        512, 682, 1137, 1024, 1024, 2048, 1706, 569, 682, 682, 1024, 1167,
        512, 682, 512, 569, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024,
        1024, 1024, 682, 682, 1167, 1167, 1167, 1024, 1905, 1479, 1366, 1479,
        1479, 1366, 1251, 1593, 1593, 797, 1024, 1593, 1366, 1933, 1479, 1593,
        1251, 1593, 1479, 1139, 1366, 1479, 1479, 2048, 1479, 1479, 1366, 682,
        569, 682, 1190, 1024, 682, 1024, 1139, 909, 1139, 909, 682, 1024,
        1139, 569, 682, 1139, 569, 1706, 1139, 1024, 1139, 1139, 909, 797,
        682, 1139, 1024, 1479, 1024, 1024, 909, 807, 451, 807, 1065,
    ),
    ("Calibri", True): (
        463, 667, 898, 1020, 1038, 1493, 1443, 478, 638, 638, 1020, 1020, 528,
        627, 547, 880, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038,
        1038, 565, 565, 1020, 1020, 1020, 949, 1840, 1241, 1148, 1084, 1291,
        999, 940, 1305, 1292, 546, 678, 1120, 866, 1790, 1349, 1385, 1090,
        1405, 1153, 968, 1014, 1337, 1211, 1856, 1128, 1064, 979, 665, 880,
        665, 1020, 1020, 615, 1011, 1099, 857, 1099, 1031, 648, 971, 1099,
        503, 523, 983, 503, 1666, 1099, 1101, 1099, 1099, 728, 817, 710, 1099,
        969, 1526, 941, 970, 814, 704, 973, 704, 1020,
    ),
    ("Calibri", False): (
        463, 667, 821, 1020, 1038, 1464, 1397, 452, 621, 621, 1020, 1020, 511,
        627, 517, 791, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038,
        1038, 548, 548, 1020, 1020, 1020, 949, 1831, 1185, 1114, 1092, 1260,
        1000, 941, 1292, 1276, 516, 653, 1064, 861, 1751, 1322, 1356, 1058,
        1378, 1112, 941, 998, 1314, 1162, 1822, 1063, 998, 959, 628, 791, 628,
        1020, 1020, 596, 981, 1076, 866, 1076, 1019, 625, 964, 1076, 470, 490,
        931, 470, 1636, 1076, 1080, 1076, 1076, 714, 801, 686, 1076, 925,
        1464, 887, 927, 809, 644, 943, 644, 1020,
    ),
}
# the few other characters these papers print
_OTHER_WIDTHS: Dict[Tuple[str, bool], Dict[str, int]] = {
    ("Times New Roman", True): {"°": 819, "’": 682},
    ("Calibri", True): {"°": 701, "’": 528},
    ("Calibri", False): {"°": 694, "’": 511},
}

_BLANK = " \u00a0._"   # what a blank is made of: spaces, a dotted / underscored line
_OBJECT = "\ufffc"     # stands for a run holding a tab, a break, a picture...
_MIN_SCALE = 0.5       # a long value is printed down to half its line's size...
_FLOOR_HP = 10         # ...or, only to keep its line on one line, down to 5 pt
_GAP_AFTER = 2         # spaces kept between a value and what follows its blank

# w:rPr children in schema order — Word rejects a file whose order is wrong
_RPR_ORDER = (
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
    "specVanish", "oMath", "rPrChange",
)
_TEXT_ONLY = {qn("w:rPr"), qn("w:t"), qn("w:lastRenderedPageBreak")}


@dataclass(frozen=True)
class Blank:
    """One blank of a paper: the label it follows, and what to write in it."""
    label: str                   # regex, searched in a paragraph's text
    value: str                   # "" = left blank, to be filled by pen
    font: str                    # the paper's text font, e.g. "Times New Roman"
    bold: Optional[bool] = None  # None = like the blank; False = regular weight


@dataclass(frozen=True)
class DateBlank:
    """A date line of a paper, "<label> __ / __ /2026", and the date to write."""
    label: str                   # regex, searched in a paragraph's text
    day: str                     # "15" ("" = the line stays blank, for the pen)
    month: str                   # "11"
    year: str                    # "2027", or "" = the year the paper prints
    font: str                    # the paper's text font, e.g. "Times New Roman"
    bold: Optional[bool] = None  # None = like the blank; False = regular weight


# what follows a date's label: day blank / month blank / the printed year
_DATE_PARTS = r"(?P<day>[ \u00a0._]*)/(?P<month>[ \u00a0._]*)/[ \u00a0]*(?P<year>\d{4})"


def fill_blanks(document, blanks: Sequence[object]) -> List[str]:
    """Write every value into its blank (Blank) or date line (DateBlank), in the
    first paragraph whose text matches its label. `document` is the rendered
    python-docx Document. An empty value is skipped: its blank stays for the
    pen. Returns the labels that were not found (their value is not printed)."""
    body = document.element.body
    styles = RunStyles(document)
    text_width = _text_width_pt(body)
    missing = []
    for blank in blanks:
        if isinstance(blank, DateBlank):
            if not (blank.day and blank.month):
                continue
            found = any(_fill_date(p, blank, styles) for p in body.iter(qn("w:p")))
        else:
            value = _clean(blank.value)
            if not value:
                continue
            found = any(_fill(p, blank, value, styles, text_width) for p in body.iter(qn("w:p")))
        if not found:
            missing.append(blank.label)
    return missing


# --------------------------------------------------------------------------
# One blank
# --------------------------------------------------------------------------


def _fill(p, blank: Blank, value: str, styles: "RunStyles", text_width: float) -> bool:
    chars = _chars(p)
    text = "".join(ch for _, ch in chars)
    m = re.search(blank.label, text)
    if not m or m.end() == 0:
        return False
    start = end = m.end()
    while end < len(text) and text[end] in _BLANK:
        end += 1
    bounded = end < len(text)  # something is printed after the blank

    props = {}  # run -> (bold, size in half-points)
    for run, _ in chars:
        if run not in props:
            props[run] = (styles.bold(run, p), styles.size(run, p))

    def width(i: int) -> float:  # printed width of character i, in points
        run, ch = chars[i]
        bold, hp = props[run]
        return _units(ch, blank.font, bold) * hp / (2 * UNITS_PER_EM)

    # the blank's own formatting (the label's when there is no blank at all)
    src = chars[start][0] if end > start else chars[start - 1][0]
    src_bold, src_hp = props[src]
    val_bold = src_bold if blank.bold is None else blank.bold
    space = _units(" ", blank.font, src_bold) * src_hp / (2 * UNITS_PER_EM)
    per_hp = sum(_units(ch, blank.font, val_bold) for ch in value) / (2 * UNITS_PER_EM)

    # the line without its blank (trailing spaces never push a line over)
    line = _line_width_pt(p, text_width)
    last = len(text.rstrip(" \u00a0"))
    rest = sum(width(i) for i in range(last) if not start <= i < end)
    single_line = 0 < line and rest <= line
    if bounded:
        room = sum(width(i) for i in range(start, end))
    else:  # a blank ending the paragraph goes up to the right margin
        room = max(line - (rest if single_line or line <= 0 else rest % line), 0.0)
    # two spaces at least between the value and what follows it on the line
    trail = _GAP_AFTER * space if bounded else 0.0

    hp = src_hp
    if per_hp and space + per_hp * hp + trail > room:  # too wide for its blank: smaller
        fit = math.floor((room - space - trail) / per_hp)
        hp = max(math.ceil(src_hp * _MIN_SCALE), min(src_hp, fit))
    if per_hp and single_line:  # ...and never so wide that the line breaks in two
        line_fit = math.floor((line - rest - space - trail) / per_hp)
        if hp > line_fit:
            hp = max(_FLOOR_HP, line_fit)
    need = space + per_hp * hp + trail

    # take the blank's characters, from its start, as wide as the value needs
    if bounded:
        stop, taken = start, 0.0
        while stop < end and taken < need - 1e-6:
            taken += width(stop)
            stop += 1
        pad = int((taken - need) / space + 1e-6) if taken > need else 0
    else:  # a blank at the end of the line is invisible: all of it
        stop, pad = end, 0

    # --- rewrite the runs ------------------------------------------------
    blank_rpr = _rpr_copy(src, drop_underline=end == start)
    value_rpr = copy.deepcopy(blank_rpr)
    if val_bold != src_bold:
        _set_bold(value_rpr, val_bold, styles.style_bold(p))
    if hp != src_hp:
        set_size(value_rpr, hp)
    new_runs = [_new_run(blank_rpr, " "), _new_run(value_rpr, value)]
    if bounded:
        new_runs.append(_new_run(blank_rpr, " " * (_GAP_AFTER + pad)))
    _replace(chars, start, stop, new_runs)
    return True


# --------------------------------------------------------------------------
# A date line
# --------------------------------------------------------------------------


def _fill_date(p, blank: DateBlank, styles: "RunStyles") -> bool:
    m = re.search(blank.label + _DATE_PARTS, "".join(ch for _, ch in _chars(p)))
    if not m or m.start("day") == 0:
        return False
    # right to left: what is rewritten never moves the characters before it
    if blank.year and blank.year != m.group("year"):
        _swap_chars(p, m.start("year"), blank.year)
    _center(p, m.start("month"), m.end("month"), blank.month, blank, styles)
    _center(p, m.start("day"), m.end("day"), blank.day, blank, styles)
    return True


def _center(p, start: int, end: int, value: str, blank: DateBlank, styles: "RunStyles") -> None:
    """Write `value` centered in the blank made of characters [start, end), in
    the blank's formatting, with exactly as much space on each side: what
    follows the blank stays where it was."""
    chars = _chars(p)
    props = {}  # run -> (bold, size in half-points)
    for run, _ in chars:
        if run not in props:
            props[run] = (styles.bold(run, p), styles.size(run, p))
    src = chars[start][0] if end > start else chars[start - 1][0]
    src_bold, src_hp = props[src]
    val_bold = src_bold if blank.bold is None else blank.bold
    room = sum(char_width_pt(ch, blank.font, *props[run]) for run, ch in chars[start:end])
    per_hp = sum(_units(ch, blank.font, val_bold) for ch in value) / (2 * UNITS_PER_EM)

    hp = src_hp
    if per_hp and per_hp * hp > room:  # wider than its blank: smaller
        hp = max(math.ceil(src_hp * _MIN_SCALE), math.floor(room / per_hp))
    side = max(room - per_hp * hp, 0.0) / 2

    blank_rpr = _rpr_copy(src, drop_underline=end == start)
    value_rpr = copy.deepcopy(blank_rpr)
    if val_bold != src_bold:
        _set_bold(value_rpr, val_bold, styles.style_bold(p))
    if hp != src_hp:
        set_size(value_rpr, hp)
    spacer = _spacer_runs(blank_rpr, side, blank.font, src_bold, src_hp)
    _replace(chars, start, end, spacer + [_new_run(value_rpr, value)]
             + _spacer_runs(blank_rpr, side, blank.font, src_bold, src_hp))


def _spacer_runs(rpr, width: float, font: str, bold: bool, half_points: int) -> list:
    """Blank space exactly `width` points wide: whole spaces in the blank's
    size, then one smaller space for the rest (never taller than the line)."""
    unit = _units(" ", font, bold)
    space = unit * half_points / (2 * UNITS_PER_EM)
    whole = int(width / space + 1e-6) if space else 0
    runs = [_new_run(rpr, " " * whole)] if whole else []
    rest_hp = round((width - whole * space) * 2 * UNITS_PER_EM / unit) if unit else 0
    if rest_hp >= 2:  # Word's smallest size: 1 pt
        small = copy.deepcopy(rpr)
        set_size(small, min(rest_hp, half_points))
        runs.append(_new_run(small, " "))
    return runs


def _swap_chars(p, start: int, text: str) -> None:
    """Replace the characters from `start` with `text`, one for one, each in
    its own run and formatting (for characters of the same width: digits)."""
    chars = _chars(p)
    new = [ch for _, ch in chars]
    new[start:start + len(text)] = list(text)
    done = []
    for run, _ in chars[start:start + len(text)]:
        if run not in done:
            done.append(run)
            _set_text(run, "".join(new[i] for i, (r, _) in enumerate(chars) if r is run))


# --------------------------------------------------------------------------
# Rewriting a paragraph's runs
# --------------------------------------------------------------------------


def _replace(chars: List[tuple], start: int, stop: int, new_runs: list) -> None:
    """Put `new_runs` in place of the characters [start, stop) of a paragraph
    (`chars` as _chars gives them, start >= 1): the run holding character
    start - 1 stays, the new runs follow it, and what is left of the runs the
    replaced characters were in comes after them."""
    anchor = chars[start - 1][0]  # holds the label's last character

    def kept(run, keep) -> str:
        return "".join(ch for i, (r, ch) in enumerate(chars) if r is run and keep(i))

    touched = []
    for i in range(start, stop):
        r = chars[i][0]
        if r is not anchor and r not in touched:
            touched.append(r)
    for r in touched:  # what is left of them follows the new runs
        _set_text(r, kept(r, lambda i: i >= stop))
    anchor_after = kept(anchor, lambda i: i >= stop)
    if any(chars[i][0] is anchor for i in range(start, len(chars))):
        _set_text(anchor, kept(anchor, lambda i: i < start))
    if anchor_after:  # the label's run went on after the replaced characters
        tail = copy.deepcopy(anchor)
        _set_text(tail, anchor_after)
        new_runs = new_runs + [tail]
    prev = anchor
    for r in new_runs:
        prev.addnext(r)
        prev = r


def _clean(value: str) -> str:
    """One line of text, without characters a .docx cannot hold."""
    value = re.sub(r"[\x00-\x1f\x7f\ufffe\uffff]", " ", value or "")
    return " ".join(value.split())


def _chars(p) -> List[tuple]:
    """(run, character) for every character of the paragraph's runs, in order.
    A run holding anything but text (a tab, a picture...) counts as one
    character that is never blank, so a blank never goes across it."""
    out: List[tuple] = []
    for r in p.iterchildren(qn("w:r")):
        if all(child.tag in _TEXT_ONLY for child in r):
            out += [(r, ch) for ch in "".join(t.text or "" for t in r.iterchildren(qn("w:t")))]
        else:
            out.append((r, _OBJECT))
    return out


def _units(ch: str, font: str, bold: bool) -> int:
    table = _ASCII_WIDTHS.get((font, bold)) or _ASCII_WIDTHS.get((font, not bold))
    if table is None:
        raise ValueError(f"No character widths for the font {font!r}")
    code = ord(ch)
    if 0x20 <= code <= 0x7E:
        return table[code - 0x20]
    if ch == "\u00a0":
        return table[0]
    other = _OTHER_WIDTHS.get((font, bold), {}).get(ch)
    if other:
        return other
    base = unicodedata.normalize("NFD", ch)[:1]  # É -> E
    if base and 0x20 <= ord(base) <= 0x7E:
        return table[ord(base) - 0x20]
    return max(table)  # unknown: as wide as the widest letter


def char_width_pt(ch: str, font: str, bold: bool, half_points: int) -> float:
    """Printed width of one character, in points."""
    return _units(ch, font, bold) * half_points / (2 * UNITS_PER_EM)


# --------------------------------------------------------------------------
# Page and run properties
# --------------------------------------------------------------------------


def _text_width_pt(body) -> float:
    """Width between the page margins (these papers have a single section)."""
    try:
        sect = body.find(qn("w:sectPr"))
        page = int(sect.find(qn("w:pgSz")).get(qn("w:w")))
        mar = sect.find(qn("w:pgMar"))
        side = sum(int(mar.get(qn(k)) or 0) for k in ("w:left", "w:right", "w:gutter"))
        return (page - side) / 20
    except (AttributeError, TypeError, ValueError):
        return 453.6  # A4, 2.5 cm margins


def _line_width_pt(p, text_width: float) -> float:
    """Width of the paragraph's first line (its indents taken off)."""
    ind = p.find(f"{qn('w:pPr')}/{qn('w:ind')}")
    if ind is None:
        return text_width

    def twips(*names: str) -> int:
        for n in names:
            try:
                return int(ind.get(qn(n)))
            except (TypeError, ValueError):
                continue
        return 0

    indent = (twips("w:left", "w:start") + twips("w:right", "w:end")
              + twips("w:firstLine") - twips("w:hanging"))
    return text_width - indent / 20


def _on(el) -> bool:
    """A toggle property (w:b...) that is present and not switched off."""
    return el is not None and (el.get(qn("w:val")) or "1").lower() not in ("0", "false", "off")


class RunStyles:
    """What a run's size and boldness are when the run itself doesn't say:
    the paragraph's style (and the styles it is based on), then the
    document defaults."""

    def __init__(self, document):
        root = document.styles.element
        self._by_id = {s.get(qn("w:styleId")): s for s in root.iterchildren(qn("w:style"))}
        self._default = next(
            (sid for sid, s in self._by_id.items()
             if s.get(qn("w:type")) == "paragraph" and _on_attr(s.get(qn("w:default")))),
            None,
        )
        self._doc_rpr = root.find(f"{qn('w:docDefaults')}/{qn('w:rPrDefault')}/{qn('w:rPr')}")

    def _inherited(self, p, tag: str):
        pstyle = p.find(f"{qn('w:pPr')}/{qn('w:pStyle')}")
        sid = pstyle.get(qn("w:val")) if pstyle is not None else self._default
        seen = set()
        while sid and sid not in seen and sid in self._by_id:
            seen.add(sid)
            style = self._by_id[sid]
            el = style.find(f"{qn('w:rPr')}/{qn(tag)}")
            if el is not None:
                return el
            based = style.find(qn("w:basedOn"))
            sid = based.get(qn("w:val")) if based is not None else None
        return self._doc_rpr.find(qn(tag)) if self._doc_rpr is not None else None

    def _own_or_inherited(self, run, p, tag: str):
        el = run.find(f"{qn('w:rPr')}/{qn(tag)}")
        return el if el is not None else self._inherited(p, tag)

    def size(self, run, p) -> int:
        """In half-points (Word's own default: 10 pt)."""
        return _half_points(self._own_or_inherited(run, p, "w:sz"))

    def mark_size(self, p) -> int:
        """Size of the paragraph mark, in half-points: the height of an empty
        paragraph's line (and Word lets it make a last line taller)."""
        el = p.find(f"{qn('w:pPr')}/{qn('w:rPr')}/{qn('w:sz')}")
        return _half_points(el if el is not None else self._inherited(p, "w:sz"))

    def bold(self, run, p) -> bool:
        return _on(self._own_or_inherited(run, p, "w:b"))

    def style_bold(self, p) -> bool:
        return _on(self._inherited(p, "w:b"))


def _on_attr(value: Optional[str]) -> bool:
    return (value or "0").lower() in ("1", "true", "on")


def _half_points(sz) -> int:
    """A w:sz element's value (Word's own default: 10 pt)."""
    try:
        return int(sz.get(qn("w:val")))
    except (AttributeError, TypeError, ValueError):
        return 20


# --------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------


def _rpr_copy(run, drop_underline: bool = False):
    rpr = run.find(qn("w:rPr"))
    rpr = copy.deepcopy(rpr) if rpr is not None else OxmlElement("w:rPr")
    if drop_underline:
        for el in rpr.findall(qn("w:u")):
            rpr.remove(el)
    return rpr


def _insert_in_order(rpr, el) -> None:
    rank = _RPR_ORDER.index(el.tag.split("}")[1])
    for child in rpr:
        name = child.tag.split("}")[-1]
        if name in _RPR_ORDER and _RPR_ORDER.index(name) > rank:
            child.addprevious(el)
            return
    rpr.append(el)


def _set_bold(rpr, on: bool, style_bold: bool) -> None:
    for tag in ("w:b", "w:bCs"):
        for el in rpr.findall(qn(tag)):
            rpr.remove(el)
    if on != style_bold:  # only say it when the style says otherwise
        for tag in ("w:b", "w:bCs"):
            el = OxmlElement(tag)
            if not on:
                el.set(qn("w:val"), "0")
            _insert_in_order(rpr, el)


def set_size(rpr, half_points: int) -> None:
    for tag in ("w:sz", "w:szCs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = OxmlElement(tag)
            _insert_in_order(rpr, el)
        el.set(qn("w:val"), str(half_points))


def _new_run(rpr, text: str):
    r = OxmlElement("w:r")
    r.append(copy.deepcopy(rpr))
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    r.append(t)
    return r


def _set_text(run, text: str) -> None:
    """Replace a text run's text; a run left without text is removed."""
    for t in run.findall(qn("w:t")):
        run.remove(t)
    if not text:
        if run.getparent() is not None:
            run.getparent().remove(run)
        return
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    run.append(t)
