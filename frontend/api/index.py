"""
Transit Document Generator — Vercel Python Function
---------------------------------------------------
Same FastAPI application as Web/backend, packaged as a Vercel serverless
function so the frontend and the API deploy together in ONE Vercel project.

Routes are prefixed with /api because Vercel rewrites /api/* to this file
(see vercel.json) and the function receives the original request path:

    GET  /api/health    -> health check
    POST /api/generate  -> JSON payload in, documents.zip out

Local development (from Web/frontend):
    pip install -r requirements.txt
    uvicorn api.index:app --reload --port 8000
The Vite dev server proxies /api/* to http://127.0.0.1:8000 automatically.
"""

import io
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Literal

from docxtpl import DocxTemplate
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates"

TPL_BON = "BON DE COMMANDE.docx"        # rendered once
TPL_LETTRE = "LETTRE D'ENGAGEMENT.docx"   # rendered once
TPL_MISE = "MISE A QUAI L.docx"         # rendered once PER container
TPL_DCP = "DCP.docx"                    # rendered once (if enabled)
TPL_ANNEXE = "ANNEXE.docx"              # rendered once (if products present)

app = FastAPI(title="Transit Document Generator API", version="2.0.0")

# Same-origin in production, so CORS is not strictly needed — kept for the
# case where the API is called from another origin (e.g. local dev without
# the Vite proxy).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# --------------------------------------------------------------------------
# DCP definitions (ported from the desktop docgen sidecar)
# --------------------------------------------------------------------------

DCP_FIELDS = [
    "المستورد", "رقم_س_ت", "تاريخ_الاستراد", "العنوان", "تعيين_المنتوج",
    "معروض_في", "متكون_من", "الكمية", "فاتورة_الشراء", "القيمة",
    "القيمة_بالدينار", "الفاتورة_تاريخ", "الصانع", "مكان_المصدر",
    "مرجع_النقل", "وثائق_النقل", "الانطلاق_من", "تاريخ_الانطلاق",
    "العبور", "الوصول",
]
DCP_DATE_FIELDS = {"تاريخ_الاستراد", "الفاتورة_تاريخ", "تاريخ_الانطلاق"}

LRE = chr(0x202A)  # LEFT-TO-RIGHT EMBEDDING
PDF = chr(0x202C)  # POP DIRECTIONAL FORMATTING
_AR = (0x0590, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)
ARABIC_CHAR = re.compile("[" + "".join(chr(a) + "-" + chr(b) for a, b in _AR) + "]")


def format_dcp_date(value: str) -> str:
    """Forms send dd/mm/yyyy already; still convert ISO if it ever arrives."""
    value = (value or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", value)
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else value


def bidi_keep_as_typed(value: str) -> str:
    """Keep mixed/Latin/numeric text displayed exactly as the user typed it
    inside the right-to-left DCP paragraphs (mirrors HTML dir="auto")."""
    for ch in value:
        if ARABIC_CHAR.match(ch):
            return value  # starts with Arabic -> natural RTL flow already
        if ch.isalpha():
            return LRE + value + PDF
    return LRE + value + PDF if value else value


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------


class Container(BaseModel):
    number: str = ""
    size: Literal["20", "40", "45"] = "20"


class Produit(BaseModel):
    produit: str = ""
    code: str = ""


class GenerateRequest(BaseModel):
    # Part 1 — transit documents
    transit_name: str = ""
    client_name: str = ""
    marchandise_type: str = ""
    weight_of_all_containers: str = ""
    force_uppercase: bool = True
    containers: List[Container] = Field(default_factory=list)
    # Part 2 — DCP (تصريح باستيراد المنتوج); values kept exactly as typed
    dcp_enabled: bool = False
    dcp: Dict[str, str] = Field(default_factory=dict)
    # Part 3 — Annexe (ملحق التعريفات الجمركية)
    dcp_produits: List[Produit] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def sanitize_filename(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    name = re.sub(r"\s+", "_", name)
    name = name.strip("._")
    return name or "UNKNOWN"


def strip_transit_prefix(name: str) -> str:
    """'TRANSIT ALPHA' -> 'ALPHA' (bare in BON/MISE, prefixed in the LETTRE)."""
    return re.sub(r"^\s*transit[\s:,\-]+", "", name or "", flags=re.IGNORECASE).strip()


def render_to_bytes(template_name: str, context: dict) -> bytes:
    """Render one template entirely in memory and return the .docx bytes."""
    tpl_path = TEMPLATE_DIR / template_name
    if not tpl_path.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Template not found on server: {template_name}",
        )
    doc = DocxTemplate(str(tpl_path))
    doc.render(context)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# --------------------------------------------------------------------------
# Routes (note the /api prefix — required by the Vercel rewrite)
# --------------------------------------------------------------------------


@app.get("/api/health")
def health():
    """Health check — also verifies the deploy bundled the templates."""
    return {
        "status": "ok",
        "service": "transit-docgen",
        "templates_found": sorted(
            p.name for p in TEMPLATE_DIR.glob("*.docx")
        ) if TEMPLATE_DIR.exists() else [],
    }


@app.post("/api/generate")
def generate(req: GenerateRequest) -> StreamingResponse:
    force_upper = req.force_uppercase

    # --- Part 1: transit static fields (+ optional uppercase mutation) ----
    transit_base = strip_transit_prefix(req.transit_name)
    client_name = req.client_name.strip()
    marchandise = req.marchandise_type.strip()
    weight = req.weight_of_all_containers.strip()

    if force_upper:
        transit_base = transit_base.upper()
        client_name = client_name.upper()
        marchandise = marchandise.upper()

    transit_bare = transit_base                                   # BON / MISE
    transit_lettre = f"TRANSIT {transit_base}".strip() if transit_base else "TRANSIT"

    def norm_number(c: Container) -> str:
        n = c.number.strip()
        return n.upper() if force_upper else n

    def numbers_for_size(size: str) -> str:
        return ", ".join(
            norm_number(c) for c in req.containers
            if c.size == size and norm_number(c)
        )

    count_20 = sum(1 for c in req.containers if c.size == "20")
    count_40 = sum(1 for c in req.containers if c.size == "40")
    count_45 = sum(1 for c in req.containers if c.size == "45")

    # LETTRE size field, e.g. "02TC40/01TC45"
    size_counts = {"20": count_20, "40": count_40, "45": count_45}
    containers_size = "/".join(
        f"{size_counts[s]:02d}TC{s}" for s in ("20", "40", "45") if size_counts[s]
    )

    common = {
        "client_name": client_name,
        "marchandise_type": marchandise,
        "weight_of_all_containers": weight,
        "count_20": count_20,
        "count_40": count_40,
        "count_45": count_45,
    }

    # --- Which parts are complete? (identical rules to the desktop app) ----
    transit_ready = (
        bool(req.transit_name.strip())
        and bool(client_name)
        and len(req.containers) > 0
        and all(norm_number(c) for c in req.containers)
    )
    dcp_ready = req.dcp_enabled
    produits = [
        {"produit": p.produit.strip(), "code": p.code.strip()}
        for p in req.dcp_produits
        if p.produit.strip() or p.code.strip()
    ]
    annex_ready = len(produits) > 0

    if not (transit_ready or dcp_ready or annex_ready):
        raise HTTPException(
            status_code=400,
            detail="Nothing to generate: complete at least one part — transit "
                   "documents (names + containers), the DCP declaration, or "
                   "the tariff annex.",
        )

    # --- Render everything into an in-memory ZIP ---------------------------
    try:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:

            # PART 1 — transit documents
            if transit_ready:
                zf.writestr(
                    "BON_DE_COMMANDE_GENERATED.docx",
                    render_to_bytes(TPL_BON, {
                        **common,
                        "transit_name": transit_bare,
                        "containers_20": numbers_for_size("20"),
                        "containers_40": numbers_for_size("40"),
                        "containers_45": numbers_for_size("45"),
                    }),
                )
                zf.writestr(
                    "LETTRE_D_ENGAGEMENT_GENERATED.docx",
                    render_to_bytes(TPL_LETTRE, {
                        **common,
                        "transit_name": transit_lettre,
                        "containers_size": containers_size,
                    }),
                )
                used_names: set = set()
                for c in req.containers:
                    num = norm_number(c) or "UNKNOWN"
                    name = f"MISE_A_QUAI_{sanitize_filename(num)}.docx"
                    i = 2
                    while name in used_names:
                        name = f"MISE_A_QUAI_{sanitize_filename(num)}_{i}.docx"
                        i += 1
                    used_names.add(name)
                    zf.writestr(
                        name,
                        render_to_bytes(TPL_MISE, {
                            **common,
                            "transit_name": transit_bare,
                            "container_number": num,
                            "container_size": c.size,
                            "container_marque": f"01TC{c.size}",  # always 01TC{size}
                        }),
                    )

            # PART 2 — DCP (تصريح باستيراد المنتوج), values kept as typed
            if dcp_ready:
                dcp_raw = req.dcp or {}
                raw: Dict[str, str] = {}
                for field in DCP_FIELDS:
                    value = str(dcp_raw.get(field, "") or "").strip()
                    if field in DCP_DATE_FIELDS:
                        value = format_dcp_date(value)
                    raw[field] = value

                # القيمة is shipped together with the selected currency
                currency = str(dcp_raw.get("القيمة_عملة", "") or "").strip() or "EUR"
                if currency == "SPEC":
                    currency = str(dcp_raw.get("القيمة_عملة_نص", "") or "").strip()
                if raw["القيمة"] and currency:
                    raw["القيمة"] = raw["القيمة"] + " " + currency
                # القيمة بالدينار is always shipped with DA
                if raw["القيمة_بالدينار"]:
                    raw["القيمة_بالدينار"] += " DA"

                dcp_ctx = {}
                for field, value in raw.items():
                    if field == "الكمية" and value:
                        dcp_ctx[field] = bidi_keep_as_typed(value) + " طن"
                    else:
                        dcp_ctx[field] = bidi_keep_as_typed(value)

                zf.writestr("DCP_GENERATED.docx", render_to_bytes(TPL_DCP, dcp_ctx))

            # PART 3 — Annexe (ملحق التعريفات الجمركية)
            if annex_ready:
                zf.writestr(
                    "ANNEXE_TARIFAIRE_GENERATED.docx",
                    render_to_bytes(TPL_ANNEXE, {"produits": produits}),
                )

    except HTTPException:
        raise
    except Exception as exc:  # docxtpl/jinja render errors -> readable 500
        raise HTTPException(
            status_code=500,
            detail=f"Document generation failed: {exc}",
        ) from exc

    zip_buffer.seek(0)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="documents_{stamp}.zip"',
        },
    )
