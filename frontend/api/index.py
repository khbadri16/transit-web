"""
Transit Document Generator — Vercel Python Function
---------------------------------------------------
FastAPI application packaged as a Vercel serverless function so the frontend
and the API deploy together in ONE Vercel project.

Routes are prefixed with /api because Vercel rewrites /api/* to this file
(see vercel.json) and the function receives the original request path:

    GET  /api/health    -> health check
    POST /api/generate  -> JSON payload in, documents.zip out
    POST /api/labels    -> Étiquetage labels in, etiquettes.pdf out
    POST /api/tracking/akkon -> Akkon Lines BL lookup (vessel, ETA, ...)

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
from typing import Dict, List, Literal, Optional

from docxtpl import DocxTemplate
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
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
TPL_MISE_AKKON = "MISE A QUAI L - AKKON.docx"  # AKKON variant — adds BL number
# DCP (تصريح باستيراد المنتوج) is generated as a PDF — see api/dcp_pdf.py
TPL_ANNEXE = "ANNEXE.docx"              # rendered once (if products present)
TPL_MANDAT = "MANDAT MSC.docx"          # rendered once (autorisation aux mandataires)
TPL_FACTURE = "FACTURE TRANSIT.docx"    # rendered once (facture de transit)

# The nine fixed libellés of the facture table, in the order they are printed.
FACTURE_KEYS = [
    "echange", "magasinage", "dechargement", "restitution", "surestaries",
    "ouverture", "honnoraire", "tva", "timbre",
]
TVA_RATE = 0.09                         # TVA 9% on HONNORAIRE

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
    # العبور / الوصول are static text inside DCP.docx now — no longer sent.
]
DCP_DATE_FIELDS = {"تاريخ_الاستراد", "الفاتورة_تاريخ", "تاريخ_الانطلاق"}

# رقم السجل التجاري (س ت) arrives split into 5 parts, entered left-to-right:
#   nn / nn - nnnnnnn [arabic letter] nn      e.g. 19/00-1163066ب23
# The DCP is generated as a PDF (api/dcp_pdf.py), which draws this number
# segment by segment strictly left-to-right — immune to bidi reordering.
RC_PART_KEYS = ("رقم_س_ت_1", "رقم_س_ت_2", "رقم_س_ت_3", "رقم_س_ت_حرف", "رقم_س_ت_4")


def format_dcp_date(value: str) -> str:
    """Forms send dd/mm/yyyy already; still convert ISO if it ever arrives."""
    value = (value or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", value)
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else value


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------


class Container(BaseModel):
    number: str = ""
    size: Literal["20", "40", "45"] = "20"


class Produit(BaseModel):
    produit: str = ""
    code: str = ""


class Mandat(BaseModel):
    """Autorisation aux mandataires (MSC). Fully independent from the transit
    part: the entreprise and transitaire names are typed in the Mandat part."""
    client_name: str = ""       # Nom de l'entreprise (client)
    transit_name: str = ""      # Transitaire (mandataire) — printed as typed
    client_username: str = ""   # personne à contacter, côté entreprise
    client_email: str = ""
    client_address: str = ""
    client_phone: str = ""
    client_rc: str = ""         # registre de commerce
    client_nif: str = ""        # numéro d'identification fiscale
    transit_username: str = ""  # personne à contacter, côté transitaire
    transit_email: str = ""
    transit_address: str = ""
    transit_phone: str = ""
    transit_rc: str = ""        # registre de commerce
    transit_nif: str = ""       # numéro d'identification fiscale
    transit_agrement: str = ""  # agrément N°


class FactureLigne(BaseModel):
    """One line of the merchandise table of the FACTURE DE TRANSIT."""
    marque: str = ""
    designation: str = ""
    nbrs: str = ""
    poids: str = ""          # number only — "KG" is printed by the template


class FactureRow(BaseModel):
    """One line of the invoice table: an amount in either column (or both)."""
    debours: str = ""
    produit: str = ""
    observation: str = ""


class FactureExtra(FactureRow):
    """A line the user added on top of the nine fixed libellés."""
    libelle: str = ""


class Facture(BaseModel):
    """FACTURE DE TRANSIT — fully independent from the transit part above
    (its own transit/client identity, never linked)."""
    transit_name: str = "TRANSIT AOULA"
    agrement: str = "04048"
    nif_transit: str = "196919250099510"
    client_name: str = ""
    client_adresse: str = ""
    client_nif: str = ""
    d10_numero: str = ""
    d10_date: str = ""
    ligne: FactureLigne = Field(default_factory=FactureLigne)   # single row
    lignes: List[FactureLigne] = Field(default_factory=list)    # legacy payloads
    rows: Dict[str, FactureRow] = Field(default_factory=dict)  # keyed by FACTURE_KEYS
    extras: List[FactureExtra] = Field(default_factory=list)
    tva_manual: bool = False   # True once the user overrode the 9% calculation


class GenerateRequest(BaseModel):
    # Part 1 — transit documents
    transit_name: str = ""
    client_name: str = ""
    company_name: str = ""  # shipping company — printed on every MISE A QUAI
    bl_number: str = ""      # AKKON only — printed on every AKKON MISE A QUAI
    marchandise_type: str = ""
    weight_of_all_containers: str = ""
    force_uppercase: bool = True
    containers: List[Container] = Field(default_factory=list)
    # Which transit documents to generate (checkboxes in the UI)
    doc_mise: bool = True     # MISE A QUAI — one file per container, ×2 copies
    doc_lettre: bool = True   # LETTRE D'ENGAGEMENT — ×2 copies
    doc_bon: bool = True      # BON DE COMMANDE — 1 copy
    doc_merge: bool = False   # one Word file: Mise ×2 each + Lettre ×2 + Bon
    # Part 2 — DCP (تصريح باستيراد المنتوج); values kept exactly as typed
    dcp_enabled: bool = False
    dcp: Dict[str, str] = Field(default_factory=dict)
    # Part 3 — Annexe (ملحق التعريفات الجمركية)
    dcp_produits: List[Produit] = Field(default_factory=list)
    # Part 4 — Mandat MSC (autorisation aux mandataires)
    mandat_enabled: bool = False
    mandat: Mandat = Field(default_factory=Mandat)
    # Part 5 — Facture de transit (always a standalone file, never merged)
    facture_enabled: bool = False
    facture: Facture = Field(default_factory=Facture)


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


def parse_money(value: str):
    """'20 000,50' / '20000.50' -> 20000.5 ; anything unusable -> None."""
    txt = (value or "").strip().replace(" ", "").replace(" ", "")
    if not txt:
        return None
    txt = txt.replace(",", ".")
    try:
        return float(txt)
    except ValueError:
        return None


def money(value: str) -> str:
    """Print an amount with 2 decimals; free text is passed through as typed."""
    n = parse_money(value)
    return f"{n:.2f}" if n is not None else (value or "").strip()


def build_facture_context(f: "Facture") -> dict:
    """Header + both tables + the three computed totals.

    Rules (confirmed with the user):
      * TVA 9% = 9% of HONNORAIRE, taken from whichever column it was
        typed in (debours + produit), printed in the PRODUIT column, and
        overridable by hand (tva_manual).
      * TAUX debours / TAUX produit = the sum of their column, extras included.
      * TOTAL TTC = TAUX debours + TAUX produit.
    """
    rows = {k: f.rows.get(k) or FactureRow() for k in FACTURE_KEYS}
    ligne = f.ligne
    if not any((ligne.marque, ligne.designation, ligne.nbrs, ligne.poids)):
        ligne = f.lignes[0] if f.lignes else FactureLigne()   # legacy payloads
    extras = [e for e in f.extras if (e.libelle or "").strip() or
              (e.debours or "").strip() or (e.produit or "").strip() or
              (e.observation or "").strip()]

    # --- TVA 9% ------------------------------------------------------------
    if f.tva_manual:
        tva_txt = money(rows["tva"].produit)
    else:
        base = (parse_money(rows["honnoraire"].produit) or 0.0) + \
               (parse_money(rows["honnoraire"].debours) or 0.0)
        tva_txt = f"{base * TVA_RATE:.2f}" if base else ""
        rows["tva"] = rows["tva"].model_copy(update={"produit": tva_txt})

    # --- totals ------------------------------------------------------------
    def column_total(attr: str) -> str:
        cells = [getattr(rows[k], attr) for k in FACTURE_KEYS]
        cells += [getattr(e, attr) for e in extras]
        values = [parse_money(c) for c in cells]
        total = sum(v for v in values if v is not None)
        return f"{total:.2f}" if any(v is not None for v in values) else ""

    taux_debours, taux_produit = column_total("debours"), column_total("produit")
    grand = (parse_money(taux_debours) or 0.0) + (parse_money(taux_produit) or 0.0)

    ctx = {
        "transit_name": f.transit_name.strip(),
        "agrement": f.agrement.strip(),
        "nif_transit": f.nif_transit.strip(),
        "client_name": f.client_name.strip(),
        "client_adresse": f.client_adresse.strip(),
        "client_nif": f.client_nif.strip(),
        "d10_numero": f.d10_numero.strip(),
        "d10_date": f.d10_date.strip(),
        # the merchandise table is a single line — always printed, even empty
        "lignes": [
            {"marque": ligne.marque.strip(),
             "designation": ligne.designation.strip(),
             "nbrs": ligne.nbrs.strip(), "poids": money(ligne.poids)}
        ],
        "extras": [
            {"libelle": e.libelle.strip().upper(), "debours": money(e.debours),
             "produit": money(e.produit), "observation": e.observation.strip()}
            for e in extras
        ],
        "taux_debours": taux_debours,
        "taux_produit": taux_produit,
        "total_ttc": f"{grand:.2f}" if (taux_debours or taux_produit) else "",
    }
    for k in FACTURE_KEYS:
        ctx[f"deb_{k}"] = money(rows[k].debours)
        ctx[f"pro_{k}"] = money(rows[k].produit)
        ctx[f"obs_{k}"] = rows[k].observation.strip()
    return ctx


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
# Document merging — every part keeps its EXACT original layout
# --------------------------------------------------------------------------
# compose_docs stacks rendered .docx parts into one file with:
#   * one SECTION per part, carrying that part's own page size/margins,
#   * minimal style isolation: identical copies of the same template are
#     left completely untouched; a part from a DIFFERENT template only gets
#     the styles that actually differ (in practice: "Normal", plus its
#     docDefaults when they differ) copied in under a private name, and its
#     paragraphs pointed at that private style. Everything else is shared.
# This was validated pixel-by-pixel against the standalone renders.
# Constraint: parts must be self-contained (no images/hyperlinks — true for
# all bundled templates, which is asserted at merge time).

_STYLE_EL_RE = re.compile(r"<w:style\b[^>]*>.*?</w:style>", re.S)
_STYLE_REF_RE = re.compile(r'(<w:(?:pStyle|rStyle|tblStyle) w:val=")([^"]+)(")')

# schema order of the children we may have to insert when merging properties
_RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
    "specVanish",
]
_PPR_ORDER = [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr",
    "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
    "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
    "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
    "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr",
]


def _part_pieces(docx_bytes: bytes):
    """Split one rendered part into (document_xml, body_inner, sectPr, styles_xml)."""
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
        document = z.read("word/document.xml").decode("utf-8")
        styles = z.read("word/styles.xml").decode("utf-8")
    m = re.search(r"<w:body>(.*)</w:body>", document, re.S)
    body = m.group(1)
    sect = re.search(r"(<w:sectPr[ >].*?</w:sectPr>)\s*$", body, re.S)
    sectpr = sect.group(1) if sect else "<w:sectPr/>"
    body = body[: sect.start()] if sect else body
    return document, body, sectpr, styles


def _norm(xml: str) -> str:
    """Normalize XML for comparison: drop revision ids + default flags."""
    xml = re.sub(r'\s+w:rsid\w*="[^"]*"', "", xml)
    xml = re.sub(r"<w:rsid [^>]*/>", "", xml)
    return xml.replace(' w:default="1"', "")


def _style_map(styles_xml: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for s in _STYLE_EL_RE.findall(styles_xml):
        m = re.search(r'w:styleId="([^"]+)"', s)
        if m:
            out[m.group(1)] = s
    return out


def _docdefaults(styles_xml: str) -> str:
    m = re.search(r"<w:docDefaults>.*?</w:docDefaults>", styles_xml, re.S)
    return m.group(0) if m else ""


def _default_style_id(styles_xml: str, style_type: str) -> str:
    """styleId of the w:default="1" style of the given type ("" if none)."""
    for tag in re.findall(r"<w:style\b[^>]*>", styles_xml):
        if f'w:type="{style_type}"' in tag and 'w:default="1"' in tag:
            m = re.search(r'w:styleId="([^"]+)"', tag)
            if m:
                return m.group(1)
    return ""


def _children(container_inner: str) -> List[tuple]:
    """Top-level (tag, xml) children of an element's inner XML."""
    out = []
    for m in re.finditer(r"<w:(\w+)\b[^>]*/>|<w:(\w+)\b[^>]*>.*?</w:\2>", container_inner, re.S):
        out.append((m.group(1) or m.group(2), m.group(0)))
    return out


def _merge_props(defaults_inner: str, own_inner: str, order: List[str]) -> str:
    """Merge docDefault properties under a style's own ones (own wins;
    rFonts merges per attribute). Children are emitted in schema order."""
    merged: Dict[str, str] = {t: x for t, x in _children(defaults_inner)}
    own: Dict[str, str] = {t: x for t, x in _children(own_inner)}
    for tag, xml in own.items():
        if tag == "rFonts" and tag in merged:
            attrs = dict(re.findall(r'(w:\w+)="([^"]*)"', merged[tag]))
            attrs.update(re.findall(r'(w:\w+)="([^"]*)"', xml))
            merged[tag] = "<w:rFonts " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) + "/>"
        else:
            merged[tag] = xml
    known = [merged[t] for t in order if t in merged]
    unknown = [x for t, x in merged.items() if t not in order]
    return "".join(known + unknown)


def _bake_docdefaults(style: str, docdefaults: str) -> str:
    """Copy a part's docDefault run/paragraph properties into a style so it no
    longer depends on the (different) document-wide defaults."""
    rpr_def = re.search(r"<w:rPrDefault>\s*<w:rPr>(.*?)</w:rPr>\s*</w:rPrDefault>", docdefaults, re.S)
    ppr_def = re.search(r"<w:pPrDefault>\s*<w:pPr>(.*?)</w:pPr>\s*</w:pPrDefault>", docdefaults, re.S)
    own_rpr = re.search(r"<w:rPr>(.*?)</w:rPr>", style, re.S)
    own_ppr = re.search(r"<w:pPr>(.*?)</w:pPr>", style, re.S)

    new_ppr = _merge_props(ppr_def.group(1) if ppr_def else "", own_ppr.group(1) if own_ppr else "", _PPR_ORDER)
    new_rpr = _merge_props(rpr_def.group(1) if rpr_def else "", own_rpr.group(1) if own_rpr else "", _RPR_ORDER)

    if own_ppr:
        style = style.replace(own_ppr.group(0), f"<w:pPr>{new_ppr}</w:pPr>" if new_ppr else "", 1)
    elif new_ppr:  # insert before rPr / tblPr / end
        style = re.sub(r"(<w:rPr>|<w:tblPr>|</w:style>)", lambda m: f"<w:pPr>{new_ppr}</w:pPr>" + m.group(1), style, count=1)
    if own_rpr:
        style = style.replace(own_rpr.group(0), f"<w:rPr>{new_rpr}</w:rPr>" if new_rpr else "", 1)
    elif new_rpr:
        style = re.sub(r"(<w:tblPr>|</w:style>)", lambda m: f"<w:rPr>{new_rpr}</w:rPr>" + m.group(1), style, count=1)
    return style


def _isolate_part(body: str, styles_xml: str, base_map: Dict[str, str],
                  base_dd: str, prefix: str):
    """Give one part private copies of exactly the styles whose definitions
    (or docDefaults) differ from the base document's. Returns the adjusted
    body and the new style definitions to append."""
    part_map = _style_map(styles_xml)
    part_dd = _docdefaults(styles_xml)
    dd_differs = _norm(part_dd) != _norm(base_dd)
    def_para = _default_style_id(styles_xml, "paragraph") or "Normal"

    # styles the part's rendering can reach: explicit references + the
    # default paragraph style, expanded through basedOn/next/link chains
    reachable = {m.group(2) for m in _STYLE_REF_RE.finditer(body)}
    reachable.add(def_para)
    changed = True
    while changed:
        changed = False
        for sid in list(reachable):
            for ref in re.findall(r'<w:(?:basedOn|next|link) w:val="([^"]+)"', part_map.get(sid, "")):
                if ref not in reachable:
                    reachable.add(ref)
                    changed = True
    reachable &= set(part_map)

    # which reachable styles need a private copy?
    if dd_differs:
        rename = set(reachable)
    else:
        rename = {s for s in reachable
                  if s not in base_map or _norm(part_map[s]) != _norm(base_map[s])}
        changed = True
        while changed:  # a style whose base/next/link was renamed follows it
            changed = False
            for sid in reachable - rename:
                refs = re.findall(r'<w:(?:basedOn|next|link) w:val="([^"]+)"', part_map[sid])
                if any(r in rename for r in refs):
                    rename.add(sid)
                    changed = True

    new_defs: List[str] = []
    for sid in rename:
        style = part_map[sid].replace(' w:default="1"', "")
        style = re.sub(r'(w:styleId=")([^"]+)(")', lambda m: m.group(1) + prefix + m.group(2) + m.group(3), style, count=1)
        style = re.sub(r'(<w:name w:val=")([^"]*)(")', lambda m: m.group(1) + prefix + m.group(2) + m.group(3), style, count=1)
        style = re.sub(
            r'(<w:(?:basedOn|next|link) w:val=")([^"]+)(")',
            lambda m: m.group(1) + (prefix + m.group(2) if m.group(2) in rename else m.group(2)) + m.group(3),
            style,
        )
        has_based_on = re.search(r'<w:basedOn w:val="([^"]+)"', part_map[sid])
        if dd_differs and (not has_based_on or has_based_on.group(1) not in part_map):
            style = _bake_docdefaults(style, part_dd)
        new_defs.append(style)

    # body: repoint references to the private copies
    body = _STYLE_REF_RE.sub(
        lambda m: m.group(1) + (prefix + m.group(2) if m.group(2) in rename else m.group(2)) + m.group(3),
        body,
    )
    # paragraphs without an explicit style follow the DOCUMENT default style,
    # which belongs to the base part — pin them to this part's own Normal.
    # (Verified pixel-identical; tables never need this: the default table
    # style is identical across the bundled templates.)
    if def_para in rename:
        p_style = f'<w:pStyle w:val="{prefix}{def_para}"/>'
        body = re.sub(r"<w:p((?:\s[^>]*?)?)/>",
                      lambda m: f"<w:p{m.group(1)}><w:pPr>{p_style}</w:pPr></w:p>", body)
        body = body.replace("<w:pPr/>", f"<w:pPr>{p_style}</w:pPr>")
        body = re.sub(r"(<w:p(?:\s[^>]*)?>)<w:pPr>(?!<w:pStyle)",
                      lambda m: m.group(1) + "<w:pPr>" + p_style, body)
        body = re.sub(r"(<w:p(?:\s[^>]*)?>)(?!<w:pPr)",
                      lambda m: m.group(1) + f"<w:pPr>{p_style}</w:pPr>", body)
    return body, new_defs


def _section_break(sectpr: str) -> str:
    """Tiny paragraph closing a part's section (keeps its page geometry)."""
    return (
        '<w:p><w:pPr>'
        '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'
        '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>'
        f"{sectpr}</w:pPr></w:p>"
    )


def compose_docs(parts: List[bytes]) -> bytes:
    """Stack rendered .docx parts into ONE file — every part starts on a new
    page and keeps its exact original layout. Used for the ×2 copies and for
    the merged document."""
    merged_bodies: List[str] = []
    extra_styles: List[str] = []
    base_document = base_styles = base_dd = ""
    base_map: Dict[str, str] = {}
    base_styles_norm = ""

    for i, part_bytes in enumerate(parts):
        document, body, sectpr, styles_xml = _part_pieces(part_bytes)
        if i == 0:
            base_document, base_styles = document, styles_xml
            base_map, base_dd = _style_map(styles_xml), _docdefaults(styles_xml)
            base_styles_norm = _norm(styles_xml)
        elif _norm(styles_xml) != base_styles_norm:
            # different template — isolate only what actually differs
            if "r:embed=" in body or "r:id=" in body:
                raise HTTPException(
                    status_code=500,
                    detail="Merging failed: a template contains images or "
                           "links, which the merged document does not support yet.",
                )
            body, new_defs = _isolate_part(body, styles_xml, base_map, base_dd, f"m{i}_")
            extra_styles += new_defs
        is_last = i == len(parts) - 1
        merged_bodies.append(body + (sectpr if is_last else _section_break(sectpr)))

    new_document = re.sub(
        r"<w:body>.*</w:body>",
        lambda m: "<w:body>" + "".join(merged_bodies) + "</w:body>",
        base_document,
        flags=re.S,
    )
    new_styles = base_styles.replace("</w:styles>", "".join(extra_styles) + "</w:styles>")

    # container: first part's package with document.xml + styles.xml replaced
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(parts[0])) as zin, \
         zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            if item == "word/document.xml":
                zout.writestr(item, new_document)
            elif item == "word/styles.xml":
                zout.writestr(item, new_styles)
            else:
                zout.writestr(item, zin.read(item))
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
    company_name = req.company_name.strip()
    bl_number = req.bl_number.strip()
    marchandise = req.marchandise_type.strip()
    weight = req.weight_of_all_containers.strip()

    if force_upper:
        transit_base = transit_base.upper()
        client_name = client_name.upper()
        company_name = company_name.upper()
        bl_number = bl_number.upper()
        marchandise = marchandise.upper()

    # AKKON gets a dedicated Mise à Quai template that also prints the BL number,
    # but only when a BL number was actually entered. If AKKON is chosen without a
    # BL number, fall back to the default template so the document does not show an
    # empty "BL number:" line.
    use_akkon_template = company_name.strip().upper() == "AKKON" and bool(bl_number)

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
    any_doc_selected = req.doc_mise or req.doc_lettre or req.doc_bon or req.doc_merge
    transit_ready = (
        bool(req.transit_name.strip())
        and bool(client_name)
        and len(req.containers) > 0
        and all(norm_number(c) for c in req.containers)
        and any_doc_selected
    )
    dcp_ready = req.dcp_enabled
    produits = [
        {"produit": p.produit.strip(), "code": p.code.strip()}
        for p in req.dcp_produits
        if p.produit.strip() or p.code.strip()
    ]
    annex_ready = len(produits) > 0
    # The Mandat carries its own entreprise / transitaire names (typed in the
    # Mandat part) — nothing from the transit part is needed.
    mandat_client_name = req.mandat.client_name.strip()
    mandat_transit_name = req.mandat.transit_name.strip()
    if force_upper:
        mandat_client_name = mandat_client_name.upper()
        mandat_transit_name = mandat_transit_name.upper()
    mandat_ready = (
        req.mandat_enabled
        and bool(mandat_client_name)
        and bool(mandat_transit_name)
    )

    # The Facture is fully independent — it carries its own client identity.
    facture_ready = (
        req.facture_enabled and bool(req.facture.client_name.strip())
    )

    if not (transit_ready or dcp_ready or annex_ready or mandat_ready
            or facture_ready):
        raise HTTPException(
            status_code=400,
            detail="Nothing to generate: complete at least one part — transit "
                   "documents (names + containers), the DCP declaration, the "
                   "tariff annex, the Mandat MSC (entreprise + transitaire "
                   "names), or "
                   "the Facture (client name).",
        )

    # --- Render everything into an in-memory ZIP ---------------------------
    try:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:

            # PART 1 — transit documents (only the types the user checked)
            if transit_ready:
                # Render each base document once, then duplicate/merge from it.
                bon_bytes: bytes | None = None
                lettre_bytes: bytes | None = None
                mise_docs: List[tuple] = []  # (zip_name, single_copy_bytes)

                if req.doc_bon or req.doc_merge:
                    bon_bytes = render_to_bytes(TPL_BON, {
                        **common,
                        "transit_name": transit_bare,
                        "containers_20": numbers_for_size("20"),
                        "containers_40": numbers_for_size("40"),
                        "containers_45": numbers_for_size("45"),
                    })
                if req.doc_lettre or req.doc_merge:
                    lettre_bytes = render_to_bytes(TPL_LETTRE, {
                        **common,
                        "transit_name": transit_lettre,
                        "containers_size": containers_size,
                    })
                if req.doc_mise or req.doc_merge:
                    used_names: set = set()
                    for c in req.containers:
                        num = norm_number(c) or "UNKNOWN"
                        name = f"MISE_A_QUAI_{sanitize_filename(num)}.docx"
                        i = 2
                        while name in used_names:
                            name = f"MISE_A_QUAI_{sanitize_filename(num)}_{i}.docx"
                            i += 1
                        used_names.add(name)
                        mise_ctx = {
                            **common,
                            "transit_name": transit_bare,
                            "company_name": company_name,
                            "container_number": num,
                            "container_size": c.size,
                            "container_marque": f"01TC{c.size}",  # always 01TC{size}
                        }
                        # AKKON + a BL number -> dedicated template with the BL line.
                        if use_akkon_template:
                            mise_ctx["BL_nb"] = bl_number
                        mise_docs.append((name, render_to_bytes(
                            TPL_MISE_AKKON if use_akkon_template else TPL_MISE,
                            mise_ctx,
                        )))

                # Individual files — LETTRE ×2 copies, each MISE ×2 copies
                # (second copy on a new page of the same file), BON ×1.
                if req.doc_bon:
                    zf.writestr("BON_DE_COMMANDE_GENERATED.docx", bon_bytes)
                if req.doc_lettre:
                    zf.writestr(
                        "LETTRE_D_ENGAGEMENT_GENERATED.docx",
                        compose_docs([lettre_bytes, lettre_bytes]),
                    )
                if req.doc_mise:
                    for name, single in mise_docs:
                        zf.writestr(name, compose_docs([single, single]))

                # Merged file — every Mise ×2, then Lettre ×2, then Bon ×1,
                # one below the other in a single Word document.
                if req.doc_merge:
                    merge_parts: List[bytes] = []
                    for _, single in mise_docs:
                        merge_parts += [single, single]
                    merge_parts += [lettre_bytes, lettre_bytes, bon_bytes]
                    zf.writestr(
                        "DOSSIER_COMPLET_GENERATED.docx",
                        compose_docs(merge_parts),
                    )

            # PART 2 — DCP (تصريح باستيراد المنتوج) — generated as a PDF.
            # A PDF is laid out ONCE on the server and renders identically in
            # every viewer/printer (Office 2010, LibreOffice, phones), which
            # ended the cross-application layout breakage of the .docx paper.
            if dcp_ready:
                dcp_raw = req.dcp or {}
                raw: Dict[str, str] = {}
                for field in DCP_FIELDS:
                    value = str(dcp_raw.get(field, "") or "").strip()
                    if field in DCP_DATE_FIELDS:
                        value = format_dcp_date(value)
                    raw[field] = value

                # القيمة is shipped together with the selected currency
                currency = str(dcp_raw.get("القيمة_عملة", "") or "").strip() or "USD"
                if currency == "SPEC":
                    currency = str(dcp_raw.get("القيمة_عملة_نص", "") or "").strip()
                if raw["القيمة"] and currency:
                    raw["القيمة"] = raw["القيمة"] + " " + currency
                # القيمة بالدينار is always shipped with DA
                if raw["القيمة_بالدينار"]:
                    raw["القيمة_بالدينار"] += " DA"
                # الكمية is always in tonnes
                if raw["الكمية"]:
                    raw["الكمية"] += " طن"
                # متكون من: only the number is typed — the unit طرد is static
                # (older history entries may already contain it: never twice)
                if raw["متكون_من"] and not raw["متكون_من"].endswith(("طرد", "طرود")):
                    raw["متكون_من"] += " طرد"

                rc_parts = tuple(
                    str(dcp_raw.get(k, "") or "").strip() for k in RC_PART_KEYS
                )
                try:
                    from api.dcp_pdf import build_dcp_pdf
                except ImportError:  # loaded outside the package context
                    import sys
                    if str(BASE_DIR) not in sys.path:
                        sys.path.append(str(BASE_DIR))
                    from dcp_pdf import build_dcp_pdf

                zf.writestr("DCP_GENERATED.pdf", build_dcp_pdf(raw, rc_parts))

            # PART 3 — Annexe (ملحق التعريفات الجمركية)
            if annex_ready:
                zf.writestr(
                    "ANNEXE_TARIFAIRE_GENERATED.docx",
                    render_to_bytes(TPL_ANNEXE, {"produits": produits}),
                )

            # PART 4 — Mandat MSC (autorisation aux mandataires).
            # The entreprise / transitaire names are the Mandat's own fields
            # (uppercased when the toggle is on); the contact details are kept
            # exactly as typed — uppercasing an e-mail address would be wrong.
            # The letter is dated on the day it is generated.
            if mandat_ready:
                m = req.mandat
                zf.writestr(
                    "MANDAT_MSC_GENERATED.docx",
                    render_to_bytes(TPL_MANDAT, {
                        "date": datetime.now().strftime("%d/%m/%Y"),
                        "client_name": mandat_client_name,
                        "client_username": m.client_username.strip(),
                        "client_email": m.client_email.strip(),
                        "client_address": m.client_address.strip(),
                        "client_phone": m.client_phone.strip(),
                        "client_rc": m.client_rc.strip(),
                        "client_nif": m.client_nif.strip(),
                        "transit_name": mandat_transit_name,
                        "transit_username": m.transit_username.strip(),
                        "transit_email": m.transit_email.strip(),
                        "transit_address": m.transit_address.strip(),
                        "transit_phone": m.transit_phone.strip(),
                        "transit_rc": m.transit_rc.strip(),
                        "transit_nif": m.transit_nif.strip(),
                        "transit_agrement": m.transit_agrement.strip(),
                    }),
                )

            # PART 5 — Facture de transit. Standalone by design: it has its own
            # transit/client identity and never joins the merged Word file.
            if facture_ready:
                zf.writestr(
                    "FACTURE_TRANSIT_GENERATED.docx",
                    render_to_bytes(TPL_FACTURE,
                                    build_facture_context(req.facture)),
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


# --------------------------------------------------------------------------
# Étiquetage — product labels as a print-and-cut PDF (see api/labels_pdf.py)
# --------------------------------------------------------------------------


class LabelLine(BaseModel):
    text: str = ""
    x_right: float = 0      # mm — right edge of the (RTL) line
    baseline: float = 0     # mm — from the top of the page


class LabelRect(BaseModel):
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0


class LabelScissors(BaseModel):
    cx: float = 0
    cy: float = 0
    size: float = 4


class LabelBox(BaseModel):
    """One label, fully laid out by the browser (millimetres)."""
    page: int = 0
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0
    size_pt: float = 8
    max_width: float = 0
    lines: List[LabelLine] = Field(default_factory=list)
    care: Optional[LabelRect] = None
    scissors: Optional[LabelScissors] = None


class LabelsRequest(BaseModel):
    pages: int = 1
    labels: List[LabelBox] = Field(default_factory=list)


@app.post("/api/labels")
def generate_labels(req: LabelsRequest) -> StreamingResponse:
    """Étiquetage page -> one PDF with every label, ready to print and cut."""
    if not req.labels:
        raise HTTPException(status_code=400, detail="لا توجد ملصقات.")
    try:
        try:
            from api.labels_pdf import build_labels_pdf
        except ImportError:  # loaded outside the package context
            import sys
            if str(BASE_DIR) not in sys.path:
                sys.path.append(str(BASE_DIR))
            from labels_pdf import build_labels_pdf

        pdf_bytes = build_labels_pdf(
            req.pages,
            [lab.model_dump() if hasattr(lab, "model_dump") else lab.dict()
             for lab in req.labels],
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Label PDF generation failed: {exc}"
        ) from exc

    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="etiquettes_{stamp}.pdf"',
        },
    )


# --------------------------------------------------------------------------
# Tracking — Akkon Lines automatic BL check (see api/akkon_tracking.py).
# The other shipping lines are opened from the browser with the BL ready.
# --------------------------------------------------------------------------


class AkkonTrackRequest(BaseModel):
    bl: str
    country: str = ""   # Akkon dropdown value ("CHINA|SBOAKKONCHINA"), "" = auto


@app.post("/api/tracking/akkon")
def tracking_akkon(req: AkkonTrackRequest):
    try:
        try:
            from api.akkon_tracking import AkkonError, track_akkon
        except ImportError:  # loaded outside the package context
            import sys
            if str(BASE_DIR) not in sys.path:
                sys.path.append(str(BASE_DIR))
            from akkon_tracking import AkkonError, track_akkon
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        return track_akkon(req.bl, req.country)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AkkonError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _ai_error_detail(exc: Exception) -> str:
    """Never leak a raw model/API error to the UI — always a short Arabic
    sentence. The real error goes to the server log."""
    try:
        from api.gemini_tariff import friendly_error

        return friendly_error(exc)
    except Exception:                       # gemini module itself unavailable
        print(f"[tariff] error: {type(exc).__name__}: {exc}", flush=True)
        return "تعذّر إتمام التصنيف. أعد المحاولة بعد قليل."


@app.post("/api/classify-tariff")
async def classify_tariff(
    invoice: UploadFile = File(...),
    mode: str = Form("pro"),
):
    """Extract products + HS codes from an invoice image or PDF using Gemini."""

    # --- validation --------------------------------------------------------
    mime_type = invoice.content_type or "application/octet-stream"
    allowed = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
    if mime_type not in allowed:
        raise HTTPException(
            status_code=400,
            detail="صيغة غير مدعومة. الصيغ المقبولة: JPEG, PNG, WebP, PDF",
        )

    file_bytes = await invoice.read()
    if len(file_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="حجم الملف يتجاوز 20MB.")

    if mode not in ("pro", "normal"):
        mode = "pro"

    # --- classification ----------------------------------------------------
    try:
        from api.gemini_tariff import classify_invoice

        return classify_invoice(file_bytes, mime_type, mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_ai_error_detail(exc))


class ProductsIn(BaseModel):
    """Hand-typed product names sent from the annex table."""

    products: List[str] = []
    mode: str = "pro"


@app.post("/api/classify-products")
async def classify_products_endpoint(payload: ProductsIn):
    """Classify products the agent typed by hand (no invoice image)."""

    names = [p.strip() for p in (payload.products or []) if p and p.strip()]
    if not names:
        raise HTTPException(status_code=400, detail="لا توجد منتوجات للإرسال.")
    if len(names) > 40:
        raise HTTPException(
            status_code=400, detail="عدد المنتوجات كبير جداً (الحد 40 في المرة)."
        )

    mode = payload.mode if payload.mode in ("pro", "normal") else "pro"

    try:
        from api.gemini_tariff import classify_products

        return classify_products(names, mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_ai_error_detail(exc))
