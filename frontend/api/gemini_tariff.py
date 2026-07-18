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
CACHE_VER = "v1"


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


def _extract_products(client, model: str, image_bytes: bytes, mime_type: str):
    """Step 1 — vision extraction. Returns [{product, designation_fr}, ...]."""
    prompt = (
        "Extract every physical line-item product from this invoice.\n"
        "For each item return:\n"
        '- "product": the item name/description exactly as written on the invoice.\n'
        '- "designation_fr": a concise French description of what the product IS, '
        "using customs-tariff vocabulary (translate if the invoice is in another "
        "language; expand abbreviations; name the material/function, e.g. "
        '"brosse à cheveux en plastique", "climatiseur split system 12000 BTU").\n'
        "Rules: only actual goods line-items — skip totals, fees, shipping, "
        "discounts, taxes, and section headers."
    )
    schema = {
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
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type=mime_type)],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=schema,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    _log(f"step1 extract ({model}) took {time.time() - t0:.2f}s")
    try:
        return json.loads(response.text).get("products", [])
    except json.JSONDecodeError:
        return []


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
        "Tarifaire) FROM THE ITEM'S CANDIDATE LIST ONLY.\n"
        "Rules:\n"
        '- If one candidate clearly matches, return it with confidence "high".\n'
        "- If several could match or the match is approximate, return the most "
        'likely one with confidence "low" and list up to 3 plausible '
        "alternatives from the list in alt_codes.\n"
        '- If NO candidate fits the product at all, return codeHS "" with '
        'confidence "low".\n'
        "- Never invent a code that is not in the candidate list.\n\n"
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
                        "alt_codes": {"type": "ARRAY", "items": {"type": "STRING"}},
                    },
                    "required": ["i", "codeHS", "confidence"],
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
                "alt_codes": [a.replace(".", "") for a in (r.get("alt_codes") or [])][:3],
            }
    except json.JSONDecodeError:
        pass
    return out


def classify_invoice(image_bytes: bytes, mime_type: str, mode: str) -> dict:
    t_start = time.time()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("Missing GEMINI_API_KEY environment variable")
    model_pro = os.environ.get("GEMINI_MODEL_PRO", "gemini-3.1-pro-preview")
    model_normal = os.environ.get("GEMINI_MODEL_NORMAL", "gemini-3.5-flash")

    client = genai.Client(api_key=api_key)
    redis_client = _get_redis()
    index = get_index()
    _log(f"index ready: {index.n} codes")

    # ---- Step 1: extract products from the invoice image (always flash) ----
    try:
        extracted = _extract_products(client, model_normal, image_bytes, mime_type)
    except Exception as exc:
        if _quota_error(exc):
            raise ValueError("تم استنفاد حصة النموذج. حاول لاحقاً.")
        raise
    if not extracted:
        return {"products": []}

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
                results[i] = json.loads(cached)
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

        model2 = model_pro if mode == "pro" else model_normal
        try:
            picked = _pick_codes(client, model2, items)
        except Exception as exc:
            if _quota_error(exc) and model2 != model_normal:
                _log("pro quota exhausted -> falling back to flash for step 2")
                try:
                    picked = _pick_codes(client, model_normal, items)
                except Exception as exc2:
                    if _quota_error(exc2):
                        raise ValueError("تم استنفاد حصة النموذجين. حاول لاحقاً.")
                    raise
            elif _quota_error(exc):
                raise ValueError("تم استنفاد حصة النموذج. حاول لاحقاً.")
            else:
                raise

        by_code = {c["code"]: c for it in items for c in it["candidates"]}
        for it in items:
            i = it["i"]
            r = picked.get(i, {"codeHS": "", "confidence": "low", "alt_codes": []})
            cand_codes = {c["code"] for c in it["candidates"]}
            if r["codeHS"] and r["codeHS"] not in cand_codes:
                r["confidence"] = "low"        # model went off-list: distrust
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
            if redis_client:
                try:
                    key = f"tariff_cls:{CACHE_VER}:{_norm_key(extracted[i]['product'] + ' ' + extracted[i].get('designation_fr', ''))}"
                    redis_client.set(key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL)
                except Exception:
                    pass

    products = [r for r in results if r]
    n_coded = sum(1 for p in products if p.get("codeHS"))
    _log(f"result: {len(products)} products, {n_coded} coded, "
         f"total {time.time() - t_start:.2f}s")
    return {"products": products}
