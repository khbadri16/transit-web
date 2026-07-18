"""Parse a page range of the SH2022 correlation PDF and append rows to a JSON cache.
Usage: python3 parse_sh2022_chunk.py <pdf> <start_page> <end_page> <out_json>"""
import json
import sys
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).parent))
from build_tariff_dataset import SH22, CODE_RE, NUM_RE, XTOL, group_lines, clean, strip_dashes


def parse_pages(path, lo, hi):
    rows, cur, cur_old, old_desig = [], None, None, ""

    def inr(w, key):
        a, b = SH22[key]
        return a <= w["x0"] < b

    def close():
        nonlocal cur
        if cur:
            cur["designation"] = strip_dashes(clean(cur["designation"]))
            cur["old_designation"] = strip_dashes(clean(cur["old_designation"]))
            rows.append(cur)
            cur = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages[lo:hi]:
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
                        "old": cur_old, "new": new_c[0].replace(".", ""),
                        "new_dotted": new_c[0], "designation": "",
                        "old_designation": old_desig, "group_label": "",
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


if __name__ == "__main__":
    pdf_path, lo, hi, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    rows = parse_pages(pdf_path, lo, hi)
    p = Path(out)
    existing = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    existing.extend(rows)
    p.write_text(json.dumps(existing, ensure_ascii=False), encoding="utf-8")
    print(f"pages {lo}-{hi}: +{len(rows)} rows (total {len(existing)})")
