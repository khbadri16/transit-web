"""
Build a structured Algerian tariff dataset from the DGD PDF documents.

Sources (in application order):
  1. mise_a_jour_du_tarif_2020.pdf          -> base rows (currently the ch. 28/84/85/87 extract;
                                               swap in the full official tariff when available)
  2. amendement ... mars_2023-2.pdf         -> correlation table (old -> new), Mar 2023
  3. table_de_correlation ... 2024_.pdf     -> correlation table (old -> new), 2024 phase 3

Output: tariff_dataset.json
  { "meta": {...}, "entries": [ {code, code_dotted, designation, context,
                                 dd, tva, uqn, gu, source} ] }

Column positions are detected PER PAGE from the table headers, because the
layout drifts a few points between chapters/pages.
"""

import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import pdfplumber

CODE_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}\.\d{2}$")
POS_RE = re.compile(r"^\d{2}\.\d{2}$")                 # e.g. 84.15
PARTIAL_RE = re.compile(r"^\d{4}\.\d{2}(\.\d{2})?$")   # e.g. 8415.10 / 8415.10.10
NUM_RE = re.compile(r"^\d{1,2}(\.\d+)?$")
DASH_RE = re.compile(r"^\s*[-–—]")
XTOL = 1.5


def group_lines(words, ytol=2.0):
    lines = defaultdict(list)
    for w in words:
        lines[round(w["top"] / ytol) * ytol].append(w)
    for key in sorted(lines):
        yield sorted(lines[key], key=lambda w: w["x0"])


def dash_depth(text):
    m = re.match(r"^((?:[-–—]\s*)+)", text)
    return m.group(1).count("-") + m.group(1).count("–") + m.group(1).count("—") if m else 0


def strip_dashes(text):
    return re.sub(r"^(?:[-–—]\s*)+", "", text).strip().rstrip(":").strip()


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------
# Parser 1: 2020 consolidated book pages (portrait, one table)
# --------------------------------------------------------------------------
def detect_cols_2020(words):
    hd = {}
    for w in words:
        if w["top"] < 115:
            t = w["text"]
            if t in ("D.D", "T.V.A", "G.U") or t.startswith("U.Q"):
                hd.setdefault("UQN" if t.startswith("U.Q") else t, w["x0"])
    if not all(k in hd for k in ("D.D", "T.V.A", "G.U", "UQN")):
        return None
    return {
        "code_hi": hd["G.U"] - 4,
        "gu": (hd["G.U"] - 4, hd["UQN"] - 4),
        "uqn": (hd["UQN"] - 4, hd["UQN"] + 20),
        "desig": (hd["UQN"] + 20, hd["D.D"] - 6),
        "dd": (hd["D.D"] - 8, hd["T.V.A"] - 4),
        "tva": (hd["T.V.A"] - 4, hd["T.V.A"] + 38),
    }


def parse_2020(path):
    entries, cols = [], None
    heading, stack, open_entry = "", [], None

    def close():
        nonlocal open_entry
        if open_entry:
            open_entry["designation"] = clean(open_entry["designation"])
            entries.append(open_entry)
            open_entry = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(x_tolerance=XTOL)
            c = detect_cols_2020(words) or cols
            if c is None:
                continue
            cols = c
            for line in group_lines(words):
                text_all = " ".join(w["text"] for w in line)
                if any(s in text_all for s in ("DOUANES ALGERIENNES", "DIRECTION DE LA",
                                               "Désignation des Produits", "SECTION",
                                               "CHAPITRE", "Position")):
                    continue
                if re.match(r"^-\s*\d+\s*-$", text_all.strip()):
                    continue

                first = line[0]
                code_w = [w for w in line if CODE_RE.match(w["text"]) and w["x0"] < cols["code_hi"]]

                def col(key):
                    lo, hi = cols[key]
                    return [w["text"] for w in line if lo <= w["x0"] < hi]

                desig = clean(" ".join(col("desig")))

                if code_w:                                            # entry row
                    close()
                    dd = next((t for t in col("dd") if NUM_RE.match(t)), "")
                    tva = next((t for t in col("tva") if NUM_RE.match(t) or t == "ex"), "")
                    d = dash_depth(desig)
                    while stack and stack[-1][0] >= d > 0:
                        stack.pop()
                    context = " / ".join([heading] + [t for _, t in stack]).strip(" /")
                    open_entry = {
                        "code": code_w[0]["text"].replace(".", ""),
                        "code_dotted": code_w[0]["text"],
                        "designation": strip_dashes(desig),
                        "context": clean(context), "dd": dd, "tva": tva,
                        "uqn": " ".join(col("uqn")), "gu": " ".join(col("gu")),
                        "source": "2020",
                    }
                elif first["x0"] < cols["code_hi"] and (POS_RE.match(first["text"])
                                                        or PARTIAL_RE.match(first["text"])):
                    close()
                    if POS_RE.match(first["text"]):                   # 84.15 position heading
                        heading, stack = desig, []
                    else:                                             # partial-code heading
                        d = dash_depth(desig) or 1
                        while stack and stack[-1][0] >= d:
                            stack.pop()
                        stack.append((d, strip_dashes(desig)))
                elif desig:
                    d = dash_depth(desig)
                    if d:                                             # parent dash-label
                        close()
                        while stack and stack[-1][0] >= d:
                            stack.pop()
                        stack.append((d, strip_dashes(desig)))
                    elif open_entry:                                  # wrapped entry text
                        open_entry["designation"] += " " + desig
                        if not open_entry["dd"]:
                            open_entry["dd"] = next(
                                (t for t in col("dd") if NUM_RE.match(t)), "")
                        if not open_entry["tva"]:
                            open_entry["tva"] = next(
                                (t for t in col("tva")
                                 if NUM_RE.match(t) or t == "ex"), "")
                    elif stack:                                       # wrapped label
                        pd, pt = stack[-1]
                        stack[-1] = (pd, pt + " " + desig)
                    elif heading:
                        heading += " " + desig
            close()
    return entries


# --------------------------------------------------------------------------
# Parsers 2/3: correlation tables (landscape). One old code -> N new codes.
# --------------------------------------------------------------------------
def detect_cols_corr(words):
    desigs = sorted(w["x0"] for w in words
                    if w["text"].startswith("Désignation") and w["top"] < 115)
    dds = sorted(w["x0"] for w in words if w["text"] == "DD" and w["top"] < 115)
    tvas = sorted(w["x0"] for w in words if w["text"] == "TVA" and w["top"] < 115)
    uqn = next((w["x0"] for w in words
                if w["text"].startswith("U.Q") and w["top"] < 115), None)
    eq = next((w["x0"] for w in words
               if w["text"].startswith("Equivalence") and w["top"] < 115), None)
    if len(desigs) < 2 or len(dds) < 2 or len(tvas) < 2 or uqn is None:
        return None
    return {
        "old_code": (18, desigs[0] - 6),
        "old_desig": (desigs[0] - 6, dds[0] - 5),
        "new_code": (tvas[0] + 28, (uqn - 55)),
        "gu": (uqn - 30, uqn - 2),
        "uqn": (uqn - 2, uqn + 34),
        "new_desig": (uqn + 24, dds[1] - 5),
        "dd": (dds[1] - 5, tvas[1] - 3),
        "tva": (tvas[1] - 3, (eq or tvas[1] + 45) - 8),
    }


def parse_correlation(path):
    rows, cols = [], None
    cur, cur_old, old_desig, group_label = None, None, "", ""

    def close():
        nonlocal cur
        if cur:
            cur["designation"] = clean(cur["designation"])
            rows.append(cur)
            cur = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(x_tolerance=XTOL)
            c = detect_cols_corr(words) or cols
            if c is None:
                continue
            cols = c
            for line in group_lines(words):
                text_all = " ".join(w["text"] for w in line)
                if any(s in text_all for s in ("Structure du Tarif", "Désignation des",
                                               "Amendement", "Applicables", "Sous positions",
                                               "phase", "Phase")):
                    continue

                def col(key):
                    lo, hi = cols[key]
                    return [w["text"] for w in line if lo <= w["x0"] < hi]

                old_c = [t for t in col("old_code") if CODE_RE.match(t)]
                new_c = [t for t in col("new_code") if CODE_RE.match(t)]

                if old_c:                       # a new old-block starts
                    close()
                    cur_old, old_desig, group_label = old_c[0].replace(".", ""), "", ""

                od = clean(" ".join(t for t in col("old_desig") if not CODE_RE.match(t)))
                if od:
                    old_desig = clean((old_desig + " " + od))

                nd = clean(" ".join(t for t in col("new_desig") if not CODE_RE.match(t)))

                if new_c:                       # new-code row
                    close()
                    cur = {
                        "old": cur_old,
                        "new": new_c[0].replace(".", ""),
                        "new_dotted": new_c[0],
                        "designation": nd,
                        "old_designation": strip_dashes(old_desig),
                        "group_label": strip_dashes(group_label),
                        "gu": next(iter(col("gu")), ""),
                        "uqn": " ".join(col("uqn")),
                        "dd": next((t for t in col("dd") if NUM_RE.match(t)), ""),
                        "tva": next((t for t in col("tva")
                                     if NUM_RE.match(t) or t == "ex"), ""),
                    }
                elif nd:
                    if DASH_RE.match(nd):       # subdivision label row (no code)
                        close()
                        group_label = clean(group_label + " " + nd) if group_label else nd
                    elif cur:                   # wrapped designation
                        cur["designation"] += " " + nd
                    elif group_label:
                        group_label += " " + nd
            close()

    for r in rows:
        r["designation"] = strip_dashes(clean(r["designation"]))
    return rows


# --------------------------------------------------------------------------
# Parser 4: SH2022 national correlation (166p, mixed notes + tables)
# --------------------------------------------------------------------------
# Header: SPT[~75] Désignation[~138] DD[~341] TVA[~362] | SPT[~401] Clé[~463]
#         Désignation[~483] DD[~625] TVA[~644] | Observation[~665]
SH22 = {
    "old_code": (70, 137), "old_desig": (137, 336),
    "new_code": (395, 460), "cle": (460, 481),
    "new_desig": (481, 621), "dd": (621, 641), "tva": (641, 661),
}


def parse_sh2022(path):
    rows = []
    cur, cur_old, old_desig = None, None, ""

    def inr(w, key):
        lo, hi = SH22[key]
        return lo <= w["x0"] < hi

    def close():
        nonlocal cur
        if cur:
            cur["designation"] = strip_dashes(clean(cur["designation"]))
            cur["old_designation"] = strip_dashes(clean(cur["old_designation"]))
            rows.append(cur)
            cur = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for line in group_lines(page.extract_words(x_tolerance=XTOL)):
                text_all = " ".join(w["text"] for w in line)
                if any(s in text_all for s in ("Amendements", "Entrée en vigueur",
                                               "Chapitre", "Notes", "Structure",
                                               "Désignation tarifaire", "Version")):
                    close()
                    cur_old, old_desig = None, ""
                    continue
                old_c = [w["text"] for w in line
                         if inr(w, "old_code") and CODE_RE.match(w["text"])]
                new_c = [w["text"] for w in line
                         if inr(w, "new_code") and CODE_RE.match(w["text"])]
                if old_c:
                    close()
                    cur_old, old_desig = old_c[0].replace(".", ""), ""
                od = " ".join(w["text"] for w in line
                              if inr(w, "old_desig") and not CODE_RE.match(w["text"]))
                if od:
                    old_desig = clean(old_desig + " " + od)
                if new_c:
                    close()
                    cur = {
                        "old": cur_old,
                        "new": new_c[0].replace(".", ""),
                        "new_dotted": new_c[0],
                        "designation": "",
                        "old_designation": old_desig,
                        "group_label": "",
                        "gu": "", "uqn": "",
                        "dd": next((w["text"] for w in line if inr(w, "dd")
                                    and NUM_RE.match(w["text"])), ""),
                        "tva": next((w["text"] for w in line if inr(w, "tva")
                                     and (NUM_RE.match(w["text"]) or w["text"] == "ex")), ""),
                    }
                if cur:
                    nd = " ".join(w["text"] for w in line
                                  if inr(w, "new_desig") and not CODE_RE.match(w["text"]))
                    if nd:
                        cur["designation"] = clean(cur["designation"] + " " + nd)
            close()
    return rows


# --------------------------------------------------------------------------
# Merge
# --------------------------------------------------------------------------
def apply_correlation(base, corr, source):
    grouped = defaultdict(list)
    for r in corr:
        grouped[r["old"]].append(r)
    for old, news in grouped.items():
        new_codes = {r["new"] for r in news}
        if old and old not in new_codes:
            base.pop(old, None)                 # suppressed / replaced
        for r in news:
            prev = base.get(r["new"], {})
            context = " / ".join(x for x in (r["old_designation"], r["group_label"]) if x)
            base[r["new"]] = {
                "code": r["new"], "code_dotted": r["new_dotted"],
                "designation": r["designation"] or prev.get("designation", ""),
                "context": context or prev.get("context", ""),
                "dd": r["dd"] or prev.get("dd", ""),
                "tva": r["tva"] or prev.get("tva", ""),
                "uqn": r["uqn"] or prev.get("uqn", ""),
                "gu": r["gu"] or prev.get("gu", ""),
                "source": source,
            }
    return base


def main(docs_dir, out_path):
    docs = Path(docs_dir)
    t0 = time.time()

    base_rows = parse_2020(docs / "mise_a_jour_du_tarif_2020.pdf")
    base = {e["code"]: e for e in base_rows}
    n2020 = len(base)
    print(f"2020 base: {len(base_rows)} rows, {n2020} unique codes")

    sh22_path = docs / "amendements_systeme_harmonise_2022_table_de_correlation_nationale_.pdf"
    sh22_cache = docs / "sh2022_rows.json"
    n_sh22 = 0
    if sh22_cache.exists() or sh22_path.exists():
        corr22 = (json.loads(sh22_cache.read_text(encoding="utf-8"))
                  if sh22_cache.exists() else parse_sh2022(sh22_path))
        n_sh22 = len(corr22)
        print(f"SH2022 correlation: {n_sh22} new-code rows, "
              f"{len({r['old'] for r in corr22 if r['old']})} old codes")
        apply_correlation(base, corr22, "2022")

    corr23 = parse_correlation(
        docs / "amendement_structure_tarif_-_spt_autres-_table_de_correlation-_mars_2023-2.pdf")
    print(f"2023 correlation: {len(corr23)} new-code rows, "
          f"{len({r['old'] for r in corr23})} old codes")
    apply_correlation(base, corr23, "2023")

    corr24 = parse_correlation(
        docs / "table_de_correlation_-_eclatement_tarifaire_spt_autres2024_.pdf")
    print(f"2024 correlation: {len(corr24)} new-code rows, "
          f"{len({r['old'] for r in corr24})} old codes")
    apply_correlation(base, corr24, "2024")

    entries = sorted(base.values(), key=lambda e: e["code"])
    chapters = sorted({e["code"][:2] for e in entries})
    meta = {
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "entries": len(entries),
        "chapters": chapters,
        "sources": {"2020_base": n2020, "2022_sh_corr": n_sh22,
                    "2023_corr": len(corr23), "2024_corr": len(corr24)},
        "note": "Base currently limited to the 2020 extract (ch. "
                + ", ".join(sorted({e['code'][:2] for e in base_rows}))
                + "); swap in the full official tariff when available.",
    }
    Path(out_path).write_text(
        json.dumps({"meta": meta, "entries": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"-> {out_path}: {len(entries)} entries ({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "."
    o = sys.argv[2] if len(sys.argv) > 2 else "tariff_dataset.json"
    main(d, o)
