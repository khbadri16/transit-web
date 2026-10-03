"""
Two-step invoice -> HS code classification against the structured Algerian
tariff dataset (api/tariff_dataset.json) — Google Gemini version.
(The same thing with Claude: api/claude_tariff.py. Shared part: api/tariff_core.py)

Step 1 (vision, flash): extract line items from the invoice image and give
        each a normalized French tariff-style description.
Step 2 (text, flash or pro): for each product, retrieve top candidate codes
        locally (tariff_search), then have the model pick the best candidate.

Compared to the previous approach (3 tariff PDFs in the model context via the
Files API) this is ~5-10x faster, far more reliable, and works within tight
model quotas because contexts are tiny. Redis (optional) caches per-product
results so repeat products are instant and consistent.
"""

import json
import os
import time

from google import genai
from google.genai import types

try:
    from api.tariff_search import get_index
    from api.tariff_core import (EXTRACT_PROMPT, classify_core, get_redis, keep_order,
                                 log as _log, normalize_prompt, parse_picks, pick_prompt)
except ImportError:            # local execution from inside api/
    from tariff_search import get_index
    from tariff_core import (EXTRACT_PROMPT, classify_core, get_redis, keep_order,
                             log as _log, normalize_prompt, parse_picks, pick_prompt)


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
MSG_NO_KEY = "مفتاح Gemini غير مُعدّ على الخادم (GEMINI_API_KEY)."


def friendly_error(exc: Exception) -> str:
    """Turn any model/API exception into a short Arabic sentence for the UI.
    The raw error is only written to the server log."""
    _log(f"gemini error: {type(exc).__name__}: {str(exc)[:300]}")
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

_PICK_SCHEMA = {
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


def _extract_products(client, model: str, file_bytes: bytes, mime_type: str):
    """Step 1 — vision extraction from an invoice image or PDF.
    Returns [{product, designation_fr}, ...]."""
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[EXTRACT_PROMPT, types.Part.from_bytes(data=file_bytes, mime_type=mime_type)],
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
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[normalize_prompt(names)],
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
        return [{"product": n, "designation_fr": n} for n in names]
    return keep_order(names, out)


def _pick_codes(client, model: str, items):
    """Step 2 — choose the best candidate code per product.

    items: [{i, product, designation_fr, candidates: [...]}, ...]
    Returns {i: {codeHS, confidence, hs6, alt_codes}}.
    """
    t0 = time.time()
    response = client.models.generate_content(
        model=model,
        contents=[pick_prompt(items)],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=_PICK_SCHEMA,
        ),
    )
    _log(f"step2 classify ({model}) took {time.time() - t0:.2f}s for {len(items)} items")
    try:
        return parse_picks(json.loads(response.text).get("items", []))
    except json.JSONDecodeError:
        return {}


def _model_pro() -> str:
    return os.environ.get("GEMINI_MODEL_PRO", "gemini-3.1-pro-preview")


def _model_normal() -> str:
    return os.environ.get("GEMINI_MODEL_NORMAL", "gemini-3.5-flash")


def _setup():
    """Client + tariff index + optional Redis, shared by both entry points."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError(MSG_NO_KEY)
    client = genai.Client(api_key=api_key)
    index = get_index()
    _log(f"index ready: {index.n} codes")
    return client, index, get_redis()


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

    return classify_core(lambda items: _pick_with_fallback(client, items, mode),
                         index, redis_client, extracted, t_start)


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

    return classify_core(lambda items: _pick_with_fallback(client, items, mode),
                         index, redis_client, extracted, t_start)
