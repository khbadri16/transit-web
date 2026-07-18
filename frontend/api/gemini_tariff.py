import os
import json
import time
from pathlib import Path

from google import genai
from google.genai import types
from upstash_redis import Redis

# Set up paths for PDF files
BASE_DIR = Path(__file__).resolve().parent
DOCS_DIR = BASE_DIR / "tariff-docs"

PDF_FILES = {
    "2020": "mise_a_jour_du_tarif_2020.pdf",
    "2023": "amendement_structure_tarif_-_spt_autres-_table_de_correlation-_mars_2023-2.pdf",
    "2024": "table_de_correlation_-_eclatement_tarifaire_spt_autres2024_.pdf"
}

def ensure_pdf_cached(client, redis_client, filename, file_path):
    """Check Redis for cached Gemini file URI. Re-upload if missing/expiring."""
    cache_key = f"tariff_pdf:{filename}"
    cached = redis_client.get(cache_key)
    if cached:
        data = json.loads(cached)
        # Check if expiring within 6 hours
        if data["expires_at"] - time.time() > 6 * 3600:
            return data["uri"]

    # Upload to Gemini Files API
    uploaded = client.files.upload(file=str(file_path))

    # Cache URI + expiry (48 hours from now)
    redis_client.set(
        cache_key,
        json.dumps({
            "uri": uploaded.uri,
            "name": uploaded.name,
            "expires_at": time.time() + 48 * 3600
        }),
        ex=47 * 3600  # Redis TTL slightly under 48h
    )
    return uploaded.uri

def classify_invoice(image_bytes: bytes, mime_type: str, mode: str) -> dict:
    """Classify invoice products against Algerian tariff schedule."""
    # Get config
    api_key = os.environ.get("GEMINI_API_KEY")
    redis_url = os.environ.get("UPSTASH_REDIS_REST_URL")
    redis_token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    model_pro = os.environ.get("GEMINI_MODEL_PRO", "gemini-3.1-pro-preview")
    model_normal = os.environ.get("GEMINI_MODEL_NORMAL", "gemini-3.5-flash")
    
    if not api_key or not redis_url or not redis_token:
        raise ValueError("Missing required environment variables for Gemini or Upstash Redis")

    # Initialize clients
    client = genai.Client(api_key=api_key)
    redis_client = Redis(url=redis_url, token=redis_token)
    
    # Select model based on mode
    model_name = model_pro if mode == "pro" else model_normal
    
    # Ensure all PDFs are cached and get their URIs
    pdf_uris = {}
    for year, filename in PDF_FILES.items():
        file_path = DOCS_DIR / filename
        pdf_uris[year] = ensure_pdf_cached(client, redis_client, filename, file_path)
    
    # Prepare contents using file_data and inline_data parts as requested
    contents = [
        types.Part.from_uri(file_uri=pdf_uris["2020"], mime_type="application/pdf"),
        types.Part.from_uri(file_uri=pdf_uris["2023"], mime_type="application/pdf"),
        types.Part.from_uri(file_uri=pdf_uris["2024"], mime_type="application/pdf"),
        types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
    ]

    # Detailed Prompt
    prompt = """You are an expert Algerian customs clearance agent.
Your task is to extract every line-item product from the attached invoice and find its correct Algerian HS Code (Code Tarifaire/Position Tarifaire).

Follow these exact steps for each product:
1. Identify the product name/description from the invoice.
2. Search for the corresponding HS Code in the base 2020 Algerian customs tariff document provided.
3. Check the 2023 amendment document to see if this code or structure was modified or overridden.
4. Check the 2024 amendment document to see if this code was further modified or split (éclatement tarifaire).
5. Determine the final, most up-to-date HS Code applicable to the product.

Rules:
- Return ONLY the final applicable HS Code.
- If you are not completely confident in an exact match, leave the codeHS empty (null/empty string). Do NOT fabricate or guess codes.
- Only extract products that are actual physical line-items on the invoice.
"""

    response_schema = {
        "type": "OBJECT",
        "properties": {
            "products": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "product": {"type": "STRING"},
                        "codeHS": {"type": "STRING"}
                    },
                    "required": ["product", "codeHS"]
                }
            }
        },
        "required": ["products"]
    }

    try:
        response = client.models.generate_content(
            model=model_name,
            contents=[prompt, *contents],
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
                response_schema=response_schema,
            )
        )
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            label = "Pro" if mode == "pro" else "Normal"
            raise ValueError(
                f"تم استنفاد حصة نموذج {label}. حاول لاحقاً أو استخدم الوضع الآخر."
            )
        raise

    try:
        data = json.loads(response.text)
    except json.JSONDecodeError:
        return {"products": []}

    # Strip dots from HS codes (e.g. 8431.49.90.00 -> 8431499000)
    for p in data.get("products", []):
        if p.get("codeHS"):
            p["codeHS"] = p["codeHS"].replace(".", "")

    return data
