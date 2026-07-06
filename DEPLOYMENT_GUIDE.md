# Deployment Guide — Transit Document Generator (Vercel, single project)

Everything deploys as **one Vercel project** on the free Hobby plan:

```
┌──────────────────────────────────────────────────────────────┐
│  Vercel project  (root directory: frontend/)                 │
│                                                              │
│  ┌────────────────────────┐      ┌────────────────────────┐  │
│  │ Static frontend        │      │ Python Function        │  │
│  │ React + Vite + TW v4   │ ───▶ │ FastAPI + docxtpl      │  │
│  │ yourapp.vercel.app     │ /api │ api/index.py           │  │
│  └────────────────────────┘      └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Why this setup: no separate backend host, no CORS, no environment variables to
link, one `git push` deploys both — and unlike Render's free tier (~1 minute
wake-up after 15 min idle), a Vercel function cold start is **~1 second**, which
you won't notice.

How it works: `vercel.json` rewrites every `/api/*` request to the serverless
function `api/index.py` (the FastAPI app). The `.docx` templates live in
`api/templates/` and are bundled with the function via `includeFiles`. The
frontend calls the relative URL `/api/generate` — same origin, no configuration.

> `Web/backend/` still exists as an optional standalone server (useful if you
> ever move to Koyeb/Render/a VPS). It is **not used** by this deployment; you
> may delete it if you want.

---

## 0. Run everything locally first

**Terminal 1 — API** (from `Web/frontend`, needs Python 3.10+):

```bash
cd Web/frontend
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn api.index:app --reload --port 8000
```

Check http://127.0.0.1:8000/api/health — you should see `{"status":"ok", ...}`
with the five templates listed.

**Terminal 2 — frontend** (needs Node 20.19+):

```bash
cd Web/frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server automatically proxies `/api/*`
to port 8000 (configured in `vite.config.ts`), so no env vars are needed.
Fill the form, click **Generate documents** — a ZIP should download.

---

## 1. Push the project to GitHub

1. Create an empty repository on https://github.com/new (e.g. `transit-web`).
   Do **not** initialize it with a README or .gitignore.

2. From the `Web` folder:

```bash
cd Web
git init
git add .
git commit -m "Transit document generator — Vercel single-project architecture"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/transit-web.git
git push -u origin main
```

> The `.docx` templates in `frontend/api/templates/` **must** be committed —
> the function needs them to render documents. The included `.gitignore`
> already keeps `node_modules/`, `.venv/` and `dist/` out of the repo.

---

## 2. Deploy to Vercel (the only deployment step)

1. Go to https://vercel.com and sign in with GitHub.
2. Click **Add New… → Project** and import the `transit-web` repository.
3. Fill in the settings:

   | Setting | Value |
   |---|---|
   | **Root Directory** | `frontend` (click *Edit* and select the folder) |
   | Framework Preset | **Vite** (auto-detected) |
   | Build Command | `npm run build` (default) |
   | Output Directory | `dist` (default) |
   | Environment Variables | **none needed** |

4. Click **Deploy**. Vercel builds the frontend AND installs
   `requirements.txt` for the Python function in the same deployment.

5. After ~1 minute you get a live URL like `https://transit-web.vercel.app`.
   Verify:
   - `https://transit-web.vercel.app` → the app loads
   - `https://transit-web.vercel.app/api/health` → `{"status":"ok",
     "templates_found":[...5 templates...]}`
   - Fill the form → **Generate documents** → ZIP downloads

That's it — there is no step 3. No second service, no URL linking.

---

## 3. Day-to-day updates

```bash
git add .
git commit -m "Describe your change"
git push
```

Vercel redeploys automatically on every push — frontend, API and templates
together. To update a template, replace the file in `frontend/api/templates/`
and push.

---

## 4. Free (Hobby) plan limits — and why they don't matter here

| Limit | Hobby plan | Your usage |
|---|---|---|
| Function duration | 60 s max | generation takes < 1 s |
| Active CPU | 4 h / month | ~0.1 s per generation → tens of thousands of docs |
| Response size | 4.5 MB | ZIP is ~0.1–0.3 MB |
| Functions per deploy | 12 | you use 1 |
| Bandwidth | 100 GB / month | far below |
| Cold start | ~1 s after idle | barely noticeable |

The Hobby plan is for personal / non-commercial use per Vercel's fair-use
policy — fine for an internal tool; if the business grows into it, Pro is $20/mo.

---

## 5. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `/api/health` returns 404 | `vercel.json` missing or not inside `frontend/` (the Root Directory), or Root Directory not set to `frontend`. |
| `Template not found on server` | Templates not committed to `frontend/api/templates/`, or the `includeFiles` entry was removed from `vercel.json`. |
| Python build fails on deploy | Check `requirements.txt` is at `frontend/requirements.txt` (not only in `api/`). See the build logs in Vercel → Deployments. |
| Works locally, 500 in production | Open Vercel → Project → **Logs** to see the function traceback. |
| `Could not reach the API` locally | Start the API: `uvicorn api.index:app --reload --port 8000` from `Web/frontend`. |
| Changed a template but output unchanged | Commit + push — the deployed function only sees files in git. |
| 413 / payload errors | Request bodies are limited to ~4.5 MB — not reachable with this form. |

---

## 6. Optional hardening (later)

- **Custom domain**: Vercel → Project → Settings → Domains (free). Nothing else
  changes — the API moves with it since it's the same origin.
- **Restrict CORS**: same-origin calls don't need CORS at all; the permissive
  middleware in `api/index.py` only matters if you call the API from elsewhere.
  Tighten `allow_origins` if you ever need to.
- **Keep a standalone fallback**: `Web/backend/` runs the identical API with
  `uvicorn main:app --host 0.0.0.0 --port $PORT` on any host (Koyeb,
  Northflank, Render, a VPS) if you ever outgrow Vercel's Hobby plan.
