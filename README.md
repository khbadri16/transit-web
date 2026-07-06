# Transit Document Generator — Web

Single Vercel project: a React SPA plus a FastAPI Python function (`/api/*`)
that renders the .docx templates with docxtpl and returns them as one ZIP
download. Three independent parts: transit documents (Bon de Commande, Lettre
d'Engagement, Mise à Quai per container), the DCP declaration (تصريح باستيراد
المنتوج) and the tariff annex (ملحق التعريفات الجمركية).

- `frontend/` — Vite + React + TypeScript + Tailwind CSS v4
  - `frontend/api/index.py` — the FastAPI serverless function
  - `frontend/api/templates/` — the .docx templates
- `backend/` — optional standalone FastAPI server (same API, for non-Vercel hosts)
- `DEPLOYMENT_GUIDE.md` — GitHub → Vercel instructions

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
