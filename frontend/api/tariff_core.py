"""
Shared part of the invoice -> HS code classification, whatever the AI model
(Gemini: api/gemini_tariff.py, Claude: api/claude_tariff.py).

    step 1  the model reads the invoice (or the typed names) and gives each
            product a French customs-style description        (model-specific)
    step 2  candidates are found locally in tariff_dataset.json   (here)
    step 3  the model picks the best candidate per product        (model-specific)
    step 4  every product is guaranteed a VALID national code     (here)

Results are cached in Redis per product for 30 days — shared by both models,
so a product classified once answers instantly next time.
"""

import hashlib
import json
import os
import re
import time
import unicodedata
from typing import Callable, Dict, List

CACHE_TTL = 30 * 24 * 3600     # 30 days
CACHE_VER = "v2"               # bump to invalidate previously cached results


def log(msg: str) -> None:
    print(f"[tariff] {msg}", flush=True)


def norm_key(text: str) -> str:
    t = unicodedata.normalize("NFKD", (text or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    return hashlib.sha1(t.encode()).hexdigest()


def get_redis():
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return None
    try:
        from upstash_redis import Redis
        return Redis(url=url, token=token)
    except Exception as exc:
        log(f"redis unavailable: {exc}")
        return None


# ---- prompts (identical for every model) ----------------------------------

EXTRACT_PROMPT = (
    "Extract every physical line-item product from this invoice "
    "(it may be an image or a multi-page PDF — read every page).\n"
    "For each item return:\n"
    '- "product": the item name/description exactly as written on the invoice.\n'
    '- "designation_fr": a concise French description of what the product IS, '
    "using customs-tariff vocabulary (translate if the invoice is in another "
    "language; expand abbreviations; name the material/function, e.g. "
    '"brosse à cheveux en plastique", "climatiseur split system 12000 BTU").\n'
    "Rules: only actual goods line-items — skip totals, fees, shipping, "
    "discounts, taxes, and section headers."
)


def normalize_prompt(names: List[str]) -> str:
    return (
        "Voici des produits saisis à la main par un agent de transit "
        "(français, arabe, anglais, abréviations ou fautes de frappe "
        "possibles).\n"
        "Pour chaque produit renvoie :\n"
        '- "product" : le texte saisi, inchangé.\n'
        '- "designation_fr" : une description française concise de ce QU\'EST '
        "le produit, en vocabulaire douanier (traduis si nécessaire, "
        "développe les abréviations, précise la matière ou la fonction, ex. "
        '"brosse à cheveux en plastique", "climatiseur split system 12000 '
        'BTU").\n'
        "Garde exactement le même ordre et le même nombre d'éléments.\n\n"
        + "\n".join(f"{i + 1}. {n}" for i, n in enumerate(names))
    )


def pick_prompt(items: List[Dict]) -> str:
    lines = []
    for it in items:
        lines.append(f"### Item {it['i']}: {it['designation_fr']}")
        lines.append(f"(invoice text: {it['product']})")
        for c in it["candidates"]:
            ctx = f" [{c['context']}]" if c.get("context") else ""
            lines.append(f"- {c['code']}: {c['designation'][:110]}{ctx[:120]}")
    return (
        "You are an expert Algerian customs clearance agent.\n"
        "For each item below, choose the single best matching HS code (Code "
        "Tarifaire) FROM THE ITEM'S CANDIDATE LIST.\n"
        "Rules:\n"
        "- You MUST return a codeHS for EVERY item — never leave it empty.\n"
        '- If one candidate clearly matches, return it with confidence "high".\n'
        "- If the match is approximate, return the closest candidate (prefer "
        "the 'Autres' residual subposition of the correct product family) "
        'with confidence "low".\n'
        "- Also return hs6: your own classification of the product in the "
        "universal 6-digit Harmonized System (SH2022), independent of the "
        "candidate list (digits only, e.g. 851713).\n\n"
        + "\n".join(lines)
    )


def parse_picks(raw_items) -> Dict[int, Dict]:
    """Model answer of step 3 -> {i: {codeHS, confidence, hs6, alt_codes}}."""
    out = {}
    for r in raw_items or []:
        try:
            i = int(r.get("i"))
        except (TypeError, ValueError):
            continue
        out[i] = {
            "codeHS": (r.get("codeHS") or "").replace(".", "").strip(),
            "confidence": r.get("confidence") if r.get("confidence") in ("high", "low") else "low",
            "hs6": re.sub(r"\D", "", r.get("hs6") or "")[:6],
            "alt_codes": [str(a).replace(".", "") for a in (r.get("alt_codes") or [])][:3],
        }
    return out


def keep_order(names: List[str], out: List[Dict]) -> List[Dict]:
    """Step 1 for typed names: never let the rows drift out of sync."""
    if len(out) != len(names):
        log(f"normalize returned {len(out)}/{len(names)} items -> using raw names")
        return [{"product": n, "designation_fr": n} for n in names]
    return [
        {"product": n, "designation_fr": (out[i].get("designation_fr") or n).strip()}
        for i, n in enumerate(names)
    ]


# ---- step 2 + 4 -------------------------------------------------------------


def residual_of_family(index, prefix: str) -> str:
    """Best valid national code for a family prefix: prefer the residual
    'Autres' subposition (what agents default to), else the last child."""
    for plen in (6, 4):
        p = prefix[:plen]
        if len(p) < plen:
            continue
        children = [e for e in index.entries if e["code"].startswith(p)]
        if not children:
            continue
        autres = [e for e in children
                  if "autre" in (e.get("designation") or "").lower()]
        pick = (autres or children)[-1]
        return pick["code"]
    return ""


def _cache_key(p: Dict) -> str:
    return f"tariff_cls:{CACHE_VER}:{norm_key(p['product'] + ' ' + p.get('designation_fr', ''))}"


def classify_core(pick: Callable[[List[Dict]], Dict[int, Dict]], index, redis_client,
                  extracted: List[Dict], t_start: float) -> dict:
    """Redis cache -> local candidates -> model choice (`pick`) -> guaranteed-
    valid national code. `extracted` is [{product, designation_fr}, ...]; the
    returned products keep exactly the same order."""

    # ---- Redis result cache ------------------------------------------------
    results = [None] * len(extracted)
    to_classify = []
    for i, p in enumerate(extracted):
        cached = None
        if redis_client:
            try:
                cached = redis_client.get(_cache_key(p))
            except Exception:
                pass
        if cached:
            try:
                parsed = json.loads(cached)
                if parsed.get("codeHS"):          # never trust cached empties
                    results[i] = parsed
                    continue
            except json.JSONDecodeError:
                pass
        to_classify.append(i)
    if results.count(None) < len(extracted):
        log(f"cache: {len(extracted) - len(to_classify)}/{len(extracted)} products from Redis")

    # ---- candidates + model choice for uncached products ------------------
    if to_classify:
        items = []
        for i in to_classify:
            p = extracted[i]
            query = f"{p.get('designation_fr', '')} {p['product']}"
            items.append({
                "i": i, "product": p["product"],
                "designation_fr": p.get("designation_fr", ""),
                "candidates": index.top_candidates(query, k=12),
            })

        picked = pick(items)

        valid_codes = {e["code"] for e in index.entries}
        by_code = {c["code"]: c for it in items for c in it["candidates"]}
        for it in items:
            i = it["i"]
            r = picked.get(i, {"codeHS": "", "confidence": "low", "hs6": "", "alt_codes": []})
            cand_codes = {c["code"] for c in it["candidates"]}
            # ---- guarantee a valid code for every product -----------------
            if r["codeHS"] not in valid_codes:
                fallback = ""
                if r["codeHS"]:
                    # off-list invention: snap to its family's residual code
                    fallback = residual_of_family(index, r["codeHS"])
                if not fallback and r.get("hs6"):
                    # model says no candidate fit: trust its universal 6-digit
                    # family and take that family's residual national code
                    fallback = residual_of_family(index, r["hs6"])
                if not fallback and it["candidates"]:
                    fallback = it["candidates"][0]["code"]   # best search hit
                if fallback:
                    log(f"item {i}: fallback code {fallback} "
                        f"(model gave {r['codeHS']!r}, hs6={r.get('hs6')!r})")
                r["codeHS"] = fallback
                r["confidence"] = "low"
            alts = [
                {"code": a, "label": by_code.get(a, {}).get("designation", "")[:80]}
                for a in r.get("alt_codes", []) if a in cand_codes and a != r["codeHS"]
            ]
            result = {
                "product": extracted[i]["product"],
                "codeHS": r["codeHS"],
                "confidence": r["confidence"],
                "candidates": alts,
            }
            results[i] = result
            if redis_client and result["codeHS"]:  # only cache non-empty results
                try:
                    redis_client.set(_cache_key(extracted[i]), json.dumps(result, ensure_ascii=False), ex=CACHE_TTL)
                except Exception:
                    pass

    products = [r for r in results if r]
    for i, p in enumerate(products):
        p["i"] = i                       # row index, so callers can map back
    n_coded = sum(1 for p in products if p.get("codeHS"))
    log(f"result: {len(products)} products, {n_coded} coded, "
        f"total {time.time() - t_start:.2f}s")
    return {"products": products}
