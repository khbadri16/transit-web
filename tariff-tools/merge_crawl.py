"""
Merge the DGD tree crawl (crawl_rows.json, extracted from
localStorage['dgdTariffCrawl']) with the PDF-chain dataset
(tariff_dataset_v2.json) into the final tariff_dataset.json.

Tree = authoritative for which codes exist + designations + hierarchy.
PDF chain = enrichment source for DD/TVA where available.

Usage: python3 merge_crawl.py crawl_rows.json tariff_dataset_v2.json tariff_dataset.json
"""

import json
import re
import sys
import time
from collections import defaultdict

DASH_RE = re.compile(r"^((?:\s*-)+)")


def dash_depth(label):
    m = DASH_RE.match(label or "")
    return m.group(1).count("-") if m else 0


def strip_dashes(label):
    return re.sub(r"^(?:\s*-)+\s*", "", label or "").strip().rstrip(":").strip()


def main(crawl_path, pdf_path, out_path):
    crawl = json.loads(open(crawl_path, encoding="utf-8").read())
    rows = crawl["rows"]
    ranges = {(r["ch"], r["rg"]): r["label"] for r in crawl.get("ranges", [])}
    chapters = {c["ch"]: c["label"] for c in crawl.get("chapters", [])}

    pdf = json.loads(open(pdf_path, encoding="utf-8").read())
    pdf_by_code = {e["code"]: e for e in pdf["entries"]}

    # group rows per range page, preserving order
    pages = defaultdict(list)
    for r in rows:
        pages[(r["ch"], r["rg"])].append(r)

    entries, seen = [], set()
    for (ch, rg), page_rows in pages.items():
        pos_heading = strip_dashes(ranges.get((ch, rg), ""))
        stack = []                                   # [(depth, label)]
        for r in page_rows:
            code, label = r["code"].strip(), r["label"].strip()
            d = dash_depth(label)
            if r.get("leaf") and re.fullmatch(r"\d{6}", code):
                full = f"{ch}{rg}{code}"
                if full in seen:
                    continue
                seen.add(full)
                while stack and stack[-1][0] >= d > 0:
                    stack.pop()
                context_parts = [pos_heading] + [t for _, t in stack]
                p = pdf_by_code.get(full, {})
                entries.append({
                    "code": full,
                    "code_dotted": f"{ch}{rg}.{code[:2]}.{code[2:4]}.{code[4:6]}",
                    "designation": strip_dashes(label),
                    "context": " / ".join(x for x in context_parts if x)[:300],
                    "dd": p.get("dd", ""), "tva": p.get("tva", ""),
                    "uqn": p.get("uqn", ""), "gu": p.get("gu", ""),
                    "source": "dgd_tree",
                })
            elif label:                              # hierarchy label row
                d = d or 1
                while stack and stack[-1][0] >= d:
                    stack.pop()
                stack.append((d, strip_dashes(label)))

    tree_codes = {e["code"] for e in entries}
    pdf_only = [c for c in pdf_by_code if c not in tree_codes]

    entries.sort(key=lambda e: e["code"])
    with_rates = sum(1 for e in entries if e["dd"])
    meta = {
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": "DGD online tariff tree (douane.gov.dz), crawl "
                + crawl.get("crawled_at", "?"),
        "entries": len(entries),
        "chapters": sorted({e["code"][:2] for e in entries}),
        "rates_from_pdf_chain": with_rates,
        "pdf_only_codes_dropped": len(pdf_only),
        "chapter_labels": chapters,
    }
    json.dump({"meta": meta, "entries": entries},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"tree codes: {len(entries)} | chapters: {len(meta['chapters'])} | "
          f"with DD/TVA: {with_rates} | pdf-only dropped: {len(pdf_only)}")
    if pdf_only[:10]:
        print("sample dropped:", pdf_only[:10])


if __name__ == "__main__":
    main(*sys.argv[1:4])
