"""
Invoice -> HS code classification with Anthropic Claude.
Same steps, prompts, cache and safety net as the Gemini version
(api/gemini_tariff.py) — only the model calls differ. Shared part:
api/tariff_core.py.

Models (change them in Vercel without touching the code):
    CLAUDE_MODEL_PRO     default claude-sonnet-5-5           ("Pro" button)
    CLAUDE_MODEL_NORMAL  default claude-haiku-4-5-20251001   ("سريع" button,
                                                              and reading invoices)
Key: ANTHROPIC_API_KEY (from https://platform.claude.com -> API keys).

Answers are forced into a JSON schema (structured outputs,
output_config.format), so they are always valid JSON.
"""

import base64
import io
import json
import os
import re
import time

try:
    from api.tariff_search import get_index
    from api.tariff_core import (EXTRACT_PROMPT, classify_core, get_redis, keep_order,
                                 log as _log, normalize_prompt, parse_picks, pick_prompt)
except ImportError:            # local execution from inside api/
    from tariff_search import get_index
    from tariff_core import (EXTRACT_PROMPT, classify_core, get_redis, keep_order,
                             log as _log, normalize_prompt, parse_picks, pick_prompt)

MAX_IMAGE_BYTES = 4_500_000     # Claude accepts images up to 5 MB
MAX_IMAGE_SIDE = 2400           # px — plenty for reading an invoice


# ---- user-facing messages (plain Arabic, never raw API text) --------------
MSG_BUSY = "نموذج Claude مشغول حالياً بسبب كثرة الطلبات. أعد المحاولة بعد دقيقة أو جرّب Gemini."
MSG_RATE = "تم إرسال طلبات كثيرة إلى Claude في وقت قصير. انتظر دقيقة ثم أعد المحاولة."
MSG_CREDIT = "رصيد حساب Claude API نفد. أضف رصيداً من platform.claude.com (Billing) أو استعمل Gemini."
MSG_KEY = "مفتاح Claude API غير صحيح أو أُلغي. أنشئ مفتاحاً جديداً من platform.claude.com وضعه في Vercel."
MSG_NO_KEY = "مفتاح Claude غير مُعدّ على الخادم بعد (ANTHROPIC_API_KEY في إعدادات Vercel)."
MSG_MODEL = "نموذج Claude المحدد غير متوفر. تحقق من CLAUDE_MODEL_PRO / CLAUDE_MODEL_NORMAL في Vercel."
MSG_TOO_BIG = "الملف كبير جداً بالنسبة لـ Claude. صغّر الصورة أو قسّم ملف PDF."
MSG_GENERIC = "تعذّر إتمام التصنيف مع Claude. أعد المحاولة بعد قليل."


def _status(exc: Exception) -> int:
    return int(getattr(exc, "status_code", 0) or 0)


def _overloaded(exc: Exception) -> bool:
    import anthropic
    return isinstance(exc, (anthropic.APIConnectionError, anthropic.APITimeoutError)) or _status(exc) in (500, 502, 503, 504, 529)


def _rate_limited(exc: Exception) -> bool:
    return _status(exc) == 429


def _retryable(exc: Exception) -> bool:
    return _overloaded(exc) or _rate_limited(exc)


def friendly_error(exc: Exception) -> str:
    """Any Claude/API exception -> a short Arabic sentence for the UI.
    The raw error only goes to the server log."""
    _log(f"claude error: {type(exc).__name__}: {str(exc)[:300]}")
    msg = str(exc).lower()
    code = _status(exc)
    if "credit balance" in msg or "billing" in msg:
        return MSG_CREDIT
    if code in (401, 403):
        return MSG_KEY
    if code == 404 or "not_found" in msg and "model" in msg:
        return MSG_MODEL
    if code == 413:
        return MSG_TOO_BIG
    if _rate_limited(exc):
        return MSG_RATE
    if _overloaded(exc):
        return MSG_BUSY
    return MSG_GENERIC


# ---- JSON schemas (structured outputs) -------------------------------------

_PRODUCTS_SCHEMA = {
    "type": "object",
    "properties": {
        "products": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "product": {"type": "string"},
                    "designation_fr": {"type": "string"},
                },
                "required": ["product", "designation_fr"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["products"],
    "additionalProperties": False,
}

_PICK_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "codeHS": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "low"]},
                    "hs6": {"type": "string"},
                    "alt_codes": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["i", "codeHS", "confidence", "hs6", "alt_codes"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


# ---- models -------------------------------------------------------------------

def _model_pro() -> str:
    return os.environ.get("CLAUDE_MODEL_PRO", "claude-sonnet-5-5")


def _model_normal() -> str:
    return os.environ.get("CLAUDE_MODEL_NORMAL", "claude-haiku-4-5-20251001")


def _is_5x(model: str) -> bool:
    """Claude 5.x models think by default and refuse temperature; Haiku 4.5
    does not think unless asked."""
    return bool(re.match(r"claude-(sonnet|opus|fable|mythos)-5", model))


def _ask(client, model: str, content, schema: dict, think: bool = False, max_tokens: int = 8000) -> dict:
    """One Messages API call whose answer must match `schema`."""
    output_config = {"format": {"type": "json_schema", "schema": schema}}
    extra = {}
    if _is_5x(model):
        if think:
            output_config["effort"] = "medium"           # adaptive thinking, moderate
            max_tokens = max(max_tokens, 16000)          # thinking counts in max_tokens
        else:
            extra["thinking"] = {"type": "between_tools"}  # = no thinking before answering
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": content}],
        output_config=output_config,
        **extra,
    )
    text = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("claude answer cut by max_tokens")
    if response.stop_reason == "refusal":
        raise RuntimeError("claude refused the request")
    return json.loads(text)


# ---- invoice file -> content block -------------------------------------------

def _file_block(file_bytes: bytes, mime_type: str) -> dict:
    if mime_type == "application/pdf":
        return {"type": "document",
                "source": {"type": "base64", "media_type": "application/pdf",
                           "data": base64.b64encode(file_bytes).decode()}}
    data, mime = file_bytes, mime_type
    if len(data) > MAX_IMAGE_BYTES:
        # too heavy for Claude: shrink (an invoice stays perfectly readable)
        from PIL import Image
        im = Image.open(io.BytesIO(data))
        im.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=85)
        data, mime = buf.getvalue(), "image/jpeg"
        _log(f"image resized for claude: {len(file_bytes)} -> {len(data)} bytes")
    return {"type": "image",
            "source": {"type": "base64", "media_type": mime,
                       "data": base64.b64encode(data).decode()}}


# ---- steps --------------------------------------------------------------------

def _extract_products(client, model: str, file_bytes: bytes, mime_type: str):
    t0 = time.time()
    data = _ask(client, model, [_file_block(file_bytes, mime_type),
                                {"type": "text", "text": EXTRACT_PROMPT}],
                _PRODUCTS_SCHEMA, max_tokens=16000)
    _log(f"claude step1 extract ({model}, {mime_type}) took {time.time() - t0:.2f}s")
    return data.get("products", [])


def _normalize_products(client, model: str, names):
    t0 = time.time()
    data = _ask(client, model, normalize_prompt(names), _PRODUCTS_SCHEMA)
    _log(f"claude step1 normalize ({model}) took {time.time() - t0:.2f}s for {len(names)} typed products")
    return keep_order(names, data.get("products", []))


def _pick_codes(client, model: str, items, think: bool):
    t0 = time.time()
    data = _ask(client, model, pick_prompt(items), _PICK_SCHEMA, think=think)
    _log(f"claude step2 classify ({model}) took {time.time() - t0:.2f}s for {len(items)} items")
    return parse_picks(data.get("items", []))


def _setup():
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
    if not api_key:
        raise ValueError(MSG_NO_KEY)
    import anthropic
    client = anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=240)
    index = get_index()
    _log(f"index ready: {index.n} codes (claude)")
    return client, index, get_redis()


def _pick_with_fallback(client, items, mode):
    """Pro (Sonnet, thinking) -> automatic fallback to the fast model when
    the pro model is busy. Remaining failures become a plain Arabic ValueError."""
    pro = mode == "pro"
    model = _model_pro() if pro else _model_normal()
    try:
        return _pick_codes(client, model, items, think=pro)
    except Exception as exc:
        if _retryable(exc) and model != _model_normal():
            _log("claude pro model busy -> falling back to the fast model")
            try:
                return _pick_codes(client, _model_normal(), items, think=False)
            except Exception as exc2:
                raise ValueError(friendly_error(exc2)) from exc2
        raise ValueError(friendly_error(exc)) from exc


# ---- public entry points (same as gemini_tariff) -----------------------------

def classify_invoice(file_bytes: bytes, mime_type: str, mode: str) -> dict:
    t_start = time.time()
    client, index, redis_client = _setup()
    try:
        extracted = _extract_products(client, _model_normal(), file_bytes, mime_type)
    except Exception as exc:
        raise ValueError(friendly_error(exc)) from exc
    if not extracted:
        return {"products": []}
    return classify_core(lambda items: _pick_with_fallback(client, items, mode),
                         index, redis_client, extracted, t_start)


def classify_products(names, mode: str) -> dict:
    t_start = time.time()
    names = [str(n).strip() for n in names if str(n).strip()]
    if not names:
        return {"products": []}
    client, index, redis_client = _setup()
    try:
        extracted = _normalize_products(client, _model_normal(), names)
    except Exception as exc:
        if _retryable(exc) or _status(exc) in (400, 401, 403, 404):
            raise ValueError(friendly_error(exc)) from exc
        _log(f"claude normalize failed ({exc}) -> using raw typed names")
        extracted = [{"product": n, "designation_fr": n} for n in names]
    return classify_core(lambda items: _pick_with_fallback(client, items, mode),
                         index, redis_client, extracted, t_start)
