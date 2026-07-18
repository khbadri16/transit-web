# Tariff dataset pipeline (ملحق التعريفات الجمركية)

Builds the structured dataset that replaces "3 PDFs in Gemini's context" for
HS-code classification.

## Files

- `build_tariff_dataset.py` — parses the DGD PDFs in `Web/tariff-reference-docs/`
  and merges them (chronological override chain) into `tariff_dataset.json`:
  **2020 base extract → SH2022 correlation → mars 2023 éclatement → 2024 éclatement**
- `parse_sh2022_chunk.py` — chunked parser for the 166-page SH2022 doc
  (writes `sh2022_rows.json`, consumed by the build as a cache)
- `tariff_dataset_v2.json` — current build: **2,639 codes, 71 chapters** (partial)
- `crawl_dgd_tree.js` — slow resumable crawler for the official online tariff
  tree (complete nomenclature, all chapters). Run inside a browser tab on
  douane.gov.dz. **Do not speed up the pacing — the WAF bans fast crawls.**
  Progress persists in `localStorage['dgdTariffCrawl']`.

## Rebuild

```
pip install pdfplumber
cd Web/tariff-tools
python3 parse_sh2022_chunk.py ../tariff-reference-docs/amendements_systeme_harmonise_2022_table_de_correlation_nationale_.pdf 0 166 sh2022_rows.json
python3 build_tariff_dataset.py ../tariff-reference-docs tariff_dataset.json
```

## Deployment

The API loads `Web/frontend/api/tariff_dataset.json` via
`Web/frontend/api/tariff_search.py` (no external deps, ~1ms lookups).
Copy the newest dataset there after a rebuild.

## Once the DGD crawl completes

1. Extract `localStorage['dgdTariffCrawl']` from the browser tab into
   `crawl_rows.json` (needs keys: rows, ranges, chapters).
2. `python3 merge_crawl.py crawl_rows.json tariff_dataset_v2.json tariff_dataset.json`
   — tree becomes the authoritative base; DD/TVA enriched from the PDF chain.
3. Copy the result to `Web/frontend/api/tariff_dataset.json` and deploy.

## Runtime flow (Phase B, implemented in api/gemini_tariff.py)

Step 1: flash vision call extracts line items + French designations.
Step 2: `tariff_search.top_candidates()` retrieves ~12 candidate codes per
product locally, then one small model call picks the code + confidence +
alternatives (pro mode = step 2 on the pro model, auto-fallback to flash on
quota). Redis (optional) caches per-product results for 30 days.
The UI highlights low-confidence rows with candidate chips.
