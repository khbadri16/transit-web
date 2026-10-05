# Transit Document Generator — Web

Single Vercel project: a React SPA plus a FastAPI Python function (`/api/*`)
that renders the .docx templates with docxtpl and returns them as one ZIP
download. Five independent parts: transit documents (Bon de Commande, Lettre
d'Engagement ×2, Mise à Quai ×2 per container — selectable via checkboxes,
with an optional single merged Word file), the DCP declaration (تصريح باستيراد
المنتوج — generated as a fixed-layout PDF so it renders identically in every
Word/LibreOffice version), the tariff annex (ملحق التعريفات الجمركية — filled
by hand or by AI from an invoice image/PDF), the Mandat MSC (autorisation aux
mandataires — a toggle-gated letter with its own entreprise/transitaire names, and is
dated on the day it is generated) and the Facture de transit (toggle-gated,
fully independent, with live TVA 9% / TAUX / TOTAL TTC calculations — always a
standalone file, never merged).

The DCP part remembers each importer's fixed lines (المستورد, رقم س ت, تاريخ
س ت, العنوان) in the browser only (`src/DcpClientBook.tsx`): pick a saved
client to fill them; they are saved / updated automatically on generate, and
Export / Import moves the list to another browser — nothing is sent to the
server.

A second page, **Étiquetage** (left sidebar, `#/etiquetage`), is a small label
editor: product labels (الاسم / العنوان / المنتوج / التركيب / المنشأ / علامة
الصيانة) are placed and resized freely on A4 sheets, then exported as one PDF
with a dashed cut line around every label (`POST /api/labels`,
drawn by `frontend/api/labels_pdf.py`). The layout is computed in the browser
with the same font as the PDF (`public/fonts/PlexSansArabic-Bold.ttf`).

A third page, **Tracking** (`#/tracking`), keeps the list of BLs being
followed (saved in the browser; Export / Import moves it between computers).
AKKON BLs are checked automatically by the server (`POST /api/tracking/akkon`,
`frontend/api/akkon_tracking.py`, which posts Akkon's public tracking form and
reads its result table). MSC, MAERSK and COSCO open their own tracking page
with the BL already searched; CMA CGM and HMM open with the BL copied, and the
"⚡ Fill BL" bookmark fills and searches it on their page. HMM BLs also have an
"Arrival notice" button (Noatum's notice page): you type its code, then
"⚡ Fill BL" searches the BL and sends the arrival date back to the list.

At the end of the Documents page, **Folder cover** prints the A4 page glued on
the front of a client's folder (French + Arabic titles, black & white
friendly, sizes adapt to long names and many containers, "Transit Belarbi Tayeb"
at the bottom; the arrival date, date, N° déclaration and taxes boxes are left
empty to fill by hand; optional: the name the folder belongs to — "Appartient
à / ملك ل" — alone at the top, and a "Dépôt-SNTR" box next to the BL when the
folder is at a depot; containers are added like in the Containers section —
number + 20'/40'/45' — and printed one line per size, "02TC20 : HMMU6458810
TGHU6123457"): `POST
/api/folder-cover`, drawn by `frontend/api/folder_cover_pdf.py`. Shipping line
logos are image files in `frontend/api/logos/` (see the README there).

A fourth page, **Visit day** (`#/visit-day`), is the office's shared list of
customs visit days, saved on the server in Upstash Redis
(`frontend/api/visit_days.py`, routes `/api/visits/...`): no visit date yet /
waiting / today / passed (10 per page), plus a French PDF of the clients added
in a period (`frontend/api/visits_pdf.py`). It needs these Vercel environment
variables:

| Variable | What |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | the Upstash database |
| `VISIT_DAY_CODE` | the office access code (asked once per computer) |

The tariff annex (ملحق التعريفات الجمركية) can read invoices and find HS codes
with **Gemini or Claude** (switch in the page; same steps for both, see
`frontend/api/tariff_core.py`). Keys in Vercel:

| Variable | What |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini (optional `GEMINI_MODEL_PRO`, `GEMINI_MODEL_NORMAL`) |
| `ANTHROPIC_API_KEY` | Claude, from platform.claude.com (optional `CLAUDE_MODEL_PRO` = claude-sonnet-5-5, `CLAUDE_MODEL_NORMAL` = claude-haiku-4-5-20251001) |
| `CLAUDE_CODE` | the code that unlocks the Claude option (Claude is paid — without the code nobody can use it) |
| `COVER_CODE` | the code that unlocks the Folder cover section |

- `frontend/` — Vite + React + TypeScript + Tailwind CSS v4
  - `frontend/api/index.py` — the FastAPI serverless function
  - `frontend/api/templates/` — the .docx templates

## Quick start (local)

```bash
# terminal 1 — API on :8000
cd frontend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
uvicorn api.index:app --reload --port 8000

# terminal 2 — UI on :5173 (proxies /api to :8000)
cd frontend
npm install
npm run dev
```
