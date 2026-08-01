"""
Two-step invoice -> HS code classification against the structured Algerian
tariff dataset (api/tariff_dataset.json).

Step 1 (vision, flash): extract line items from the invoice image and give
        each a normalized French tariff-style description.
Step 2 (text, flash or pro): for each product, retrieve top candidate codes
        locally (tariff_search), then have the model pick the best candidate.

Compared to the previous approach (3 tariff PDFs in the model context via the
Files API) this is ~5-10x faster, far more reliable, and works within tight
model quotas because contexts are tiny. Redis (optional) caches per-product
results so repeat products are instant and consistent.
"""

import hashlib
import json
import os
import re
import time
import unicodedata

from google import genai
from google.genai import types

try:
    from api.tariff_search import get_index
except ImportError:            # local execution from inside api/
    from tariff_search import get_index

CACHE_TTL = 30 * 24 * 3600     # 30 days
CACHE_VER = "v2"          # bump to invalidate previously cached results


def _log(msg: str) -> None:
    print(f"[tariff] {msg}", flush=True)


def _norm_key(text: str) -> str:
    t = unicodedata.normalize("NFKD", (text or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    return hashlib.sha1(t.encode()).hexdigest()


def _get_redis():
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return None
    try:
        from upstash_redis import Redis
        return Redis(url=url, token=token)
    except Exception as exc:
        _log(f"redis unavailable: {exc}")
        return None


def _quota_error(exc: Exception) -> bool:
    msg = str(exc)
    return "429" in msg or "RESOURCE_EXHAUSTED" in msg


def _overload_error(exc: Exception) -> bool:
    """Google returns 503 UNAVAILABLE / "model is overloaded" when demand on
    the model is high. It is transient — the user just has to retry."""
    msg = str(exc).lower()
    return "503" in msg or "unavailable" in msg or "overloaded" in msg


def _retryable(exc: Exception) -> bool:
    return _quota_error(exc) or _overload_error(exc)


# ---- user-facing messages (plain Arabic, never raw API text) --------------
MSG_QUOTA = "تم استنفاد حصة النموذج لهذا اليوم. حاول لاحقاً أو استعمل الوضع السريع."
MSG_BUSY = "الخدمة مشغولة حالياً بسبب كثرة الطلبات. أعد المحاولة بعد دقيقة."
MSG_GENERIC = "تعذّر إتمام التصنيف. أعد المحاولة بعد قليل."


def friendly_error(exc: Exception) -> str:
    """Turn any model/API exception into a short Arabic sentence for the UI.
    The raw error is only written to the server log."""
    _log(f"error: {type(exc).__name__}: {str(exc)[:300]}")
    if _quota_error(exc):
        return MSG_QUOTA
    if _overload_error(exc):
        return MSG_BUSY
    return MSG_GENERIC


_PRODUCTS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "products": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "product": {"type": "STRING"},
                    "designation_fr": {"type": "STRING"},
                },
                "required": ["product", "designation_fr"],
            },
        }
    },
    "required": ["products"],
}


def _extract_products(client, model: str, file_bytes: bytes, mime_type: str):
    """Step 1 — vision extraction from an invoice image or PDF.
    Returns [{product, designation_fr}, ...]."""
    prompt = (
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
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[prompt, types.Part.from_bytes(data=file_bytes, mime_type=mime_type)],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=_PRODUCTS_SCHEMA,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    _log(f"step1 extract ({model}, {mime_type}) took {time.time() - t0:.2f}s")
    try:
        return json.loads(response.text).get("products", [])
    except json.JSONDecodeError:
        return []


def _normalize_products(client, model: str, names):
    """Step 1 (text variant) — the agent typed the product names by hand, so
    there is nothing to read from an image: just normalize each name into a
    French tariff-style description. Returns [{product, designation_fr}, ...]
    in the SAME ORDER as `names`."""
    fallback = [{"product": n, "designation_fr": n} for n in names]
    prompt = (
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
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[prompt],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=_PRODUCTS_SCHEMA,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    _log(f"step1 normalize ({model}) took {time.time() - t0:.2f}s "
         f"for {len(names)} typed products")
    try:
        out = json.loads(response.text).get("products", [])
    except json.JSONDecodeError:
        return fallback
    if len(out) != len(names):          # never let the rows drift out of sync
        _log(f"normalize returned {len(out)}/{len(names)} items -> using raw names")
        return fallback
    # keep the agent's own wording as `product`, whatever the model echoed back
    return [
        {"product": n, "designation_fr": (out[i].get("designation_fr") or n).strip()}
        for i, n in enumerate(names)
    ]


def _pick_codes(client, model: str, items):
    """Step 2 — choose the best candidate code per product.

    items: [{i, product, designation_fr, candidates: [...]}, ...]
    Returns {i: {codeHS, confidence, alt_codes}}.
    """
    lines = []
    for it in items:
        lines.append(f"### Item {it['i']}: {it['designation_fr']}")
        lines.append(f"(invoice text: {it['product']})")
        for c in it["candidates"]:
            ctx = f" [{c['context']}]" if c.get("context") else ""
            lines.append(f"- {c['code']}: {c['designation'][:110]}{ctx[:120]}")
    prompt = (
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
    schema = {
        "type": "OBJECT",
        "properties": {
            "items": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "i": {"type": "INTEGER"},
                        "codeHS": {"type": "STRING"},
                        "confidence": {"type": "STRING", "enum": ["high", "low"]},
                        "hs6": {"type": "STRING"},
                        "alt_codes": {"type": "ARRAY", "items": {"type": "STRING"}},
                    },
                    "required": ["i", "codeHS", "confidence", "hs6"],
                },
            }
        },
        "required": ["items"],
    }
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[prompt],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=schema,
        ),
    )
    _log(f"step2 classify ({model}) took {time.time() - t0:.2f}s for {len(items)} items")
    out = {}
    try:
        for r in json.loads(response.text).get("items", []):
            out[r.get("i")] = {
                "codeHS": (r.get("codeHS") or "").replace(".", ""),
                "confidence": r.get("confidence", "low"),
                "hs6": re.sub(r"\D", "", r.get("hs6") or "")[:6],
                "alt_codes": [a.replace(".", "") for a in (r.get("alt_codes") or [])][:3],
            }
    except json.JSONDecodeError:
        pass
    return out


def _residual_of_family(index, prefix: str) -> str:
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


def _model_pro() -> str:
    return os.environ.get("GEMINI_MODEL_PRO", "gemini-3.1-pro-preview")


def _model_normal() -> str:
    return os.environ.get("GEMINI_MODEL_NORMAL", "gemini-3.5-flash")


def _setup():
    """Client + tariff index + optional Redis, shared by both entry points."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("Missing GEMINI_API_KEY environment variable")
    client = genai.Client(api_key=api_key)
    index = get_index()
    _log(f"index ready: {index.n} codes")
    return client, index, _get_redis()


def _pick_with_fallback(client, items, mode):
    """Step 2 with an automatic pro -> flash fallback when the pro model is
    out of quota or overloaded. Any remaining failure is raised as a ValueError
    carrying a plain Arabic message."""
    model2 = _model_pro() if mode == "pro" else _model_normal()
    try:
        return _pick_codes(client, model2, items)
    except Exception as exc:
        if _retryable(exc) and model2 != _model_normal():
            _log("pro model unavailable (quota/overload) -> falling back to flash")
            try:
                return _pick_codes(client, _model_normal(), items)
            except Exception as exc2:
                raise ValueError(friendly_error(exc2)) from exc2
        raise ValueError(friendly_error(exc)) from exc


def _classify_core(client, index, redis_client, extracted, mode, t_start) -> dict:
    """Shared tail of both entry points: Redis cache -> local candidate
    retrieval -> model choice -> guaranteed-valid national code.
    `extracted` is [{product, designation_fr}, ...]; the returned products
    keep exactly the same order."""

    # ---- Redis result cache ------------------------------------------------
    results = [None] * len(extracted)
    to_classify = []
    for i, p in enumerate(extracted):
        key = f"tariff_cls:{CACHE_VER}:{_norm_key(p['product'] + ' ' + p.get('designation_fr', ''))}"
        cached = None
        if redis_client:
            try:
                cached = redis_client.get(key)
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
        _log(f"cache: {len(extracted) - len(to_classify)}/{len(extracted)} products from Redis")

    # ---- Step 2: candidates + model choice for uncached products ----------
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

        picked = _pick_with_fallback(client, items, mode)

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
                    fallback = _residual_of_family(index, r["codeHS"])
                if not fallback and r.get("hs6"):
                    # model says no candidate fit: trust its universal 6-digit
                    # family and take that family's residual national code
                    fallback = _residual_of_family(index, r["hs6"])
                if not fallback and it["candidates"]:
                    fallback = it["candidates"][0]["code"]   # best search hit
                if fallback:
                    _log(f"item {i}: fallback code {fallback} "
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
                    key = f"tariff_cls:{CACHE_VER}:{_norm_key(extracted[i]['product'] + ' ' + extracted[i].get('designation_fr', ''))}"
                    redis_client.set(key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL)
                except Exception:
                    pass

    products = [r for r in results if r]
    for i, p in enumerate(products):
        p["i"] = i                       # row index, so callers can map back
    n_coded = sum(1 for p in products if p.get("codeHS"))
    _log(f"result: {len(products)} products, {n_coded} coded, "
         f"total {time.time() - t_start:.2f}s")
    return {"products": products}


# ---- public entry points --------------------------------------------------

def classify_invoice(file_bytes: bytes, mime_type: str, mode: str) -> dict:
    """Invoice image OR PDF -> products + HS codes."""
    t_start = time.time()
    client, index, redis_client = _setup()

    # Step 1: read the invoice (always flash — extraction is cheap)
    try:
        extracted = _extract_products(client, _model_normal(), file_bytes, mime_type)
    except Exception as exc:
        raise ValueError(friendly_error(exc)) from exc
    if not extracted:
        return {"products": []}

    return _classify_core(client, index, redis_client, extracted, mode, t_start)


def classify_products(names, mode: str) -> dict:
    """Hand-typed product names -> the same products + HS codes, in order.
    Used when the invoice has only a few lines and the agent would rather
    type them than photograph the invoice."""
    t_start = time.time()
    names = [str(n).strip() for n in names if str(n).strip()]
    if not names:
        return {"products": []}

    client, index, redis_client = _setup()

    # Step 1 (text): normalize the typed names — never fatal, falls back to
    # the raw text so a flaky model can't block the classification.
    try:
        extracted = _normalize_products(client, _model_normal(), names)
    except Exception as exc:
        if _retryable(exc):
            raise ValueError(friendly_error(exc)) from exc
        _log(f"normalize failed ({exc}) -> using raw typed names")
        extracted = [{"product": n, "designation_fr": n} for n in names]

    return _classify_core(client, index, redis_client, extracted, mode, t_start)
