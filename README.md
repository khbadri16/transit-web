# Transit Document Generator — Web

Single Vercel project: a React SPA plus a FastAPI Python function (`/api/*`)
that renders the .docx templates with docxtpl and returns them as one ZIP
download. Three independent parts: transit documents (Bon de Commande, Lettre
d'Engagement ×2, Mise à Quai ×2 per container — selectable via checkboxes,
with an optional single merged Word file), the DCP declaration (تصريح باستيراد
المنتوج — generated as a fixed-layout PDF so it renders identically in every
Word/LibreOffice version) and the tariff annex (ملحق التعريفات الجمركية).

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
