"""
The Bon de Commande on one page, however many containers it lists
=================================================================
The Bon lists the containers in its "Sélection" column, one row per size
(20 / 40 / 45): "MSCU1234567, TGHU7654321, ...". The column is narrow: each
number takes a line of its own, and a row is tall enough for about three.
With more containers of one size the row grows and pushes down everything
after it, and the paper ends with empty lines (after "Cachet signature") that
then spilled onto a second, blank page: the empty paper at the end of the
merged folder (from 5 containers of one size).

So, on the RENDERED copy only (the .docx template is never modified):
  * The empty lines that end the paper are removed. They print nothing; they
    could only push a blank page out.
  * What the rows grow is given back by the empty lines between the table and
    "Cachet signature": as many are removed as the rows need, so "Cachet
    signature" stays where it always is. The first two of these lines stay.
    The table floats, anchored to the first one; the second goes below the
    table, and "Cachet signature" with it. (Right after the anchor, a line of
    text would be squeezed into the narrow gap beside the table, a letter
    per line.)
  * Containers that need more room than all these lines are printed smaller,
    several to a line (down to 6 pt), until they fit.
  * A container number is never cut across two lines: lines break only
    between numbers, after ", " (the spaces and hyphens inside a number,
    e.g. "AKKU408308-3", are made non-breaking).

The lines a cell needs are counted the way Word breaks them (after a space or
a hyphen) with the real character widths of the paper's font (paper_blanks),
a little generously: one line too many only lifts "Cachet signature" a bit,
one too few could push it onto a second page. Heights come from the font's
line spacing and each paragraph's own spacing, as the Bon has them (no
spacing in its styles).
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

try:
    from api.paper_blanks import RunStyles, char_width_pt, set_size
except ImportError:  # loaded outside the package context
    from paper_blanks import RunStyles, char_width_pt, set_size

# Single line spacing, in ems: the font's ascent + descent + line gap, which is
# what Word gives a line (Times New Roman 12 pt -> 13.8 pt, Calibri -> 1.22).
LINE_EM: Dict[str, float] = {"Times New Roman": 2355 / 2048, "Calibri": 2500 / 2048}
MIN_HALF_POINTS = 12   # numbers are printed down to 6 pt, never smaller
WIDTH_MARGIN = 0.98    # a line counts as full a little early: never too few lines
CELL_MARGIN = 108      # twips: Word's default left / right cell margin

_P, _R, _T, _TC, _TR, _TBL = (qn(t) for t in ("w:p", "w:r", "w:t", "w:tc", "w:tr", "w:tbl"))
_NB_HYPHEN = qn("w:noBreakHyphen")
SEPARATOR = ", "       # between two items of a growing cell


@dataclass(frozen=True)
class GrowingCells:
    """Table cells whose text grows with the data (the Bon's container
    numbers): the paper is kept on one page around them."""
    texts: Sequence[str]  # the cells' rendered texts, items joined by ", " ("" = an empty cell)
    font: str             # the paper's text font, e.g. "Times New Roman"


def keep_on_one_page(document, cells: GrowingCells) -> None:
    """`document` is the rendered python-docx Document."""
    body = document.element.body
    _drop_trailing_empty(body)
    texts = {t for t in cells.texts if t.strip()}
    found = [tc for tc in body.iter(_TC) if _text(tc) in texts]
    by_table: Dict[object, List] = {}
    for tc in found:
        _keep_items_whole(tc)
        by_table.setdefault(_ancestor(tc, _TBL), []).append(tc)
    styles = RunStyles(document)
    for tbl, tcs in by_table.items():
        _fit_table(tbl, tcs, cells.font, styles)


def _keep_items_whole(tc) -> None:
    """Lines break only between the cell's items, after ", ": a space inside
    an item becomes a no-break space, a hyphen a no-break hyphen (Word's own
    w:noBreakHyphen — a hyphen character would let the line break after it)."""
    for t in list(tc.iter(_T)):
        text = SEPARATOR.join(item.replace(" ", "\u00a0") for item in (t.text or "").split(SEPARATOR))
        parts = text.split("-")
        t.text = parts[0]
        t.set(qn("xml:space"), "preserve")
        prev = t
        for part in parts[1:]:
            hyphen = OxmlElement("w:noBreakHyphen")
            rest = OxmlElement("w:t")
            rest.set(qn("xml:space"), "preserve")
            rest.text = part
            prev.addnext(hyphen)
            hyphen.addnext(rest)
            prev = rest


# --------------------------------------------------------------------------
# Empty lines
# --------------------------------------------------------------------------

# a paragraph holding only these prints nothing
_NOTHING = {qn("w:pPr"), qn("w:proofErr"), qn("w:bookmarkStart"), qn("w:bookmarkEnd")}
# ...unless its properties print or move something
_PRINTS = tuple(qn(t) for t in ("w:sectPr", "w:framePr", "w:pageBreakBefore", "w:numPr", "w:pBdr", "w:shd"))


def _is_empty(el) -> bool:
    """A paragraph that prints nothing at all: no run, no bullet, no border."""
    if el.tag != _P:
        return False
    ppr = el.find(qn("w:pPr"))
    if ppr is not None and any(ppr.find(t) is not None for t in _PRINTS):
        return False
    return all(child.tag in _NOTHING for child in el)


def _drop_trailing_empty(body) -> None:
    """Remove the empty paragraphs that end the paper. (A document can't end
    with a table: the paragraph after a last table stays.)"""
    content = [el for el in body if el.tag != qn("w:sectPr")]
    while len(content) > 1 and _is_empty(content[-1]) and content[-2].tag != _TBL:
        body.remove(content.pop())


def _spacers_after(tbl) -> List:
    """The empty paragraphs between the table and what follows it, but the
    first two: a floating table is anchored to the paragraph after it, and
    the next empty one keeps what follows below the table (a line of text
    right after the anchor would be squeezed beside it)."""
    group = []
    el = tbl.getnext()
    while el is not None and _is_empty(el):
        group.append(el)
        el = el.getnext()
    if el is None or el.tag == qn("w:sectPr"):  # nothing after them: not spacers
        return []
    return group[2:]


# --------------------------------------------------------------------------
# One table
# --------------------------------------------------------------------------


def _fit_table(tbl, tcs: List, font: str, styles: RunStyles) -> None:
    rows: Dict[object, List] = {}
    for tc in tcs:
        rows.setdefault(_ancestor(tc, _TR), []).append(tc)
    spacers = _spacers_after(tbl)
    room = sum(_empty_height(p, font, styles) for p in spacers)

    def growth(hp: Optional[int]) -> float:
        return sum(_row_growth(tr, cells, font, styles, hp) for tr, cells in rows.items())

    grow, size = growth(None), None
    if grow > room:  # even all the empty lines are not enough: smaller numbers
        for hp in range(_cells_size(tcs, styles) - 1, MIN_HALF_POINTS - 1, -1):
            size, grow = hp, growth(hp)
            if grow <= room:
                break
        if size is not None:
            for tc in tcs:
                _set_cell_size(tc, size)

    # what the rows grow comes out of the empty lines just above what follows
    for p in reversed(spacers):
        if grow <= 0.01:
            break
        grow -= _empty_height(p, font, styles)
        p.getparent().remove(p)


def _row_growth(tr, cells: List, font: str, styles: RunStyles, hp: Optional[int]) -> float:
    """How much taller than in the template the row must be (points)."""
    height = tr.find(f"{qn('w:trPr')}/{qn('w:trHeight')}")
    rule = height.get(qn("w:hRule")) if height is not None else None
    if rule == "exact":  # an exact height never grows (Word cuts the text)
        return 0.0
    least = _int(height.get(qn("w:val"))) / 20 if height is not None and rule != "auto" else 0.0
    # in the template, each cell holds one line: its {{ placeholder }}
    template = max([least] + [_cell_height(tc, font, styles, None, one_line=True) for tc in cells])
    need = max(_cell_height(tc, font, styles, hp) for tc in cells)
    return max(0.0, need - template)


def _cell_height(tc, font: str, styles: RunStyles, hp: Optional[int], one_line: bool = False) -> float:
    """Height of the cell's paragraphs, its text printed at `hp` half-points
    (None: at its own size)."""
    width = _cell_width(tc)
    total = 0.0
    for p in tc.iterchildren(_P):
        chars: List[Tuple[str, float]] = []
        sizes: List[int] = []
        for r in p.iter(_R):
            # a no-break hyphen prints a hyphen, but never ends a line: U+2011
            text = "".join((el.text or "") if el.tag == _T else "\u2011"
                           for el in r if el.tag in (_T, _NB_HYPHEN))
            if text:
                run_hp = hp or styles.size(r, p)
                bold = styles.bold(r, p)
                sizes.append(run_hp)
                chars += [(ch, char_width_pt("-" if ch == "\u2011" else ch, font, bold, run_hp))
                          for ch in text]
        mark = hp or styles.mark_size(p)
        em = LINE_EM.get(font, 1.2)
        line = em * max(sizes, default=mark) / 2
        last = em * max(sizes + [mark]) / 2  # Word lets the paragraph mark make the last line taller
        lines = 1 if one_line else _count_lines(chars, _text_room(p, width) * WIDTH_MARGIN)
        total += (lines - 1) * _spaced(p, line) + _spaced(p, last) + _space_around(p)
    return total


def _count_lines(chars: List[Tuple[str, float]], width: float) -> int:
    """Lines a paragraph takes, broken as Word breaks them: after a space or a
    hyphen. Spaces at the end of a line never push it over; a word longer
    than a whole line is cut where the line is full."""
    words: List[Tuple[List[float], float]] = []  # (its characters, the spaces after it)
    word: List[float] = []
    spaces, hyphen = 0.0, False
    for ch, w in chars:
        if ch == " ":
            spaces += w
            continue
        if spaces or hyphen:  # a space or a hyphen ended the word before
            words.append((word, spaces))
            word, spaces = [], 0.0
        word.append(w)
        hyphen = ch == "-"
    if word or spaces:
        words.append((word, spaces))

    lines, x = 1, 0.0
    for word, spaces in words:
        size = sum(word)
        if x > 0 and x + size > width:  # no room left: the word starts a line
            lines, x = lines + 1, 0.0
        if size > width:  # longer than a whole line: cut where the line is full
            for w in word:
                if x > 0 and x + w > width:
                    lines, x = lines + 1, 0.0
                x += w
        else:
            x += size
        x += spaces
    return lines


def _empty_height(p, font: str, styles: RunStyles) -> float:
    """Height of an empty paragraph: one line of its mark."""
    return _spaced(p, LINE_EM.get(font, 1.2) * styles.mark_size(p) / 2) + _space_around(p)


def _cells_size(tcs: List, styles: RunStyles) -> int:
    """The largest size the cells' text is printed at, in half-points."""
    sizes = [styles.size(r, p) for tc in tcs for p in tc.iterchildren(_P) for r in p.iter(_R)
             if any((t.text or "") for t in r.iter(_T))]
    return max(sizes, default=24)


def _set_cell_size(tc, hp: int) -> None:
    """Print the cell's text, and its paragraph marks, at `hp` half-points."""
    for p in tc.iterchildren(_P):
        for r in p.iter(_R):
            rpr = r.find(qn("w:rPr"))
            if rpr is None:
                rpr = OxmlElement("w:rPr")
                r.insert(0, rpr)
            set_size(rpr, hp)
        ppr = p.find(qn("w:pPr"))
        if ppr is None:
            ppr = OxmlElement("w:pPr")
            p.insert(0, ppr)
        rpr = ppr.find(qn("w:rPr"))
        if rpr is None:  # the mark's properties come last, before sectPr / pPrChange
            rpr = OxmlElement("w:rPr")
            after = [ppr.find(qn(t)) for t in ("w:sectPr", "w:pPrChange")]
            after = [el for el in after if el is not None]
            if after:
                after[0].addprevious(rpr)
            else:
                ppr.append(rpr)
        set_size(rpr, hp)


# --------------------------------------------------------------------------
# Widths and spacing (twips = 1/20 pt)
# --------------------------------------------------------------------------


def _cell_width(tc) -> float:
    """Room for text in the cell, in points: its width less its margins."""
    tbl = _ancestor(tc, _TBL)
    tcw = tc.find(f"{qn('w:tcPr')}/{qn('w:tcW')}")
    width = 0
    if tcw is not None and (tcw.get(qn("w:type")) or "dxa") == "dxa":
        width = _int(tcw.get(qn("w:w")))
    if width <= 0:  # the grid columns the cell spans
        start = sum(_span(c) for c in tc.itersiblings(_TC, preceding=True))
        cols = [_int(g.get(qn("w:w"))) for g in tbl.iterfind(f"{qn('w:tblGrid')}/{qn('w:gridCol')}")]
        width = sum(cols[start:start + _span(tc)])
    margins = (tc.find(f"{qn('w:tcPr')}/{qn('w:tcMar')}"), tbl.find(f"{qn('w:tblPr')}/{qn('w:tblCellMar')}"))

    def margin(*names: str) -> int:  # the cell's own, else the table's
        for where in margins:
            if where is None:
                continue
            for name in names:
                el = where.find(qn(name))
                if el is not None:
                    return _int(el.get(qn("w:w")))
        return CELL_MARGIN

    return max(width - margin("w:left", "w:start") - margin("w:right", "w:end"), 0) / 20


def _text_room(p, width: float) -> float:
    """The paragraph's line width: the cell's room less its own indents."""
    ind = p.find(f"{qn('w:pPr')}/{qn('w:ind')}")
    if ind is None:
        return width

    def twips(*names: str) -> int:
        return next((_int(ind.get(qn(n))) for n in names if ind.get(qn(n)) is not None), 0)

    return width - (twips("w:left", "w:start") + twips("w:right", "w:end")) / 20


def _spaced(p, natural: float) -> float:
    """A line's height with the paragraph's own line spacing."""
    sp = p.find(f"{qn('w:pPr')}/{qn('w:spacing')}")
    line = _int(sp.get(qn("w:line"))) if sp is not None else 0
    if line <= 0:
        return natural
    rule = sp.get(qn("w:lineRule")) or "auto"
    if rule == "exact":
        return line / 20
    if rule == "atLeast":
        return max(natural, line / 20)
    return natural * line / 240


def _space_around(p) -> float:
    """The paragraph's own space before + after, in points."""
    sp = p.find(f"{qn('w:pPr')}/{qn('w:spacing')}")
    if sp is None:
        return 0.0
    return (_int(sp.get(qn("w:before"))) + _int(sp.get(qn("w:after")))) / 20


# --------------------------------------------------------------------------
# XML helpers
# --------------------------------------------------------------------------


def _text(el) -> str:
    return "".join(t.text or "" for t in el.iter(_T))


def _ancestor(el, tag):
    return next(el.iterancestors(tag))


def _span(tc) -> int:
    span = tc.find(f"{qn('w:tcPr')}/{qn('w:gridSpan')}")
    return max(_int(span.get(qn("w:val"))), 1) if span is not None else 1


def _int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
