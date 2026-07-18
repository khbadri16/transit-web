/**
 * Slow, resumable crawler for the official DGD tariff tree
 * (https://www.douane.gov.dz/spip.php?page=tarif_douanier).
 *
 * RUN INSIDE a browser tab already on douane.gov.dz (same-origin fetch).
 * Designed to be injected by Claude via the Chrome extension, or pasted
 * into DevTools console manually.
 *
 * Pacing: 1 request / ~2s (the site's WAF banned a 2-concurrent crawl at
 * ~120ms spacing — do NOT speed this up). Full run: ~1,400 requests ≈ 50 min.
 *
 * Progress persists to localStorage['dgdTariffCrawl'] on the DGD origin, so
 * an interruption (ban, reload, closed tab) resumes where it left off.
 *
 * Levels: tarif_douanier (sections) -> chapitre&section=SS ->
 *         range&section=SS&chapitre=CC -> position&...&range=RR
 *         (position pages list the 10-digit codes + dash-hierarchy labels)
 */
(function () {
  const KEY = "dgdTariffCrawl";
  const S = JSON.parse(localStorage.getItem(KEY) || "null") || {
    sections: null, chapters: null, ranges: null, doneRanges: {}, rows: [],
    failures: 0, finished: false,
  };
  const save = () => localStorage.setItem(KEY, JSON.stringify(S));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pace = () => sleep(1800 + Math.random() * 700);

  async function get(url) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (r.ok) {
          const doc = new DOMParser().parseFromString(await r.text(), "text/html");
          if (doc.querySelector("table")) { S.failures = 0; return doc; }
        }
      } catch (e) { /* connection refused = banned */ }
      await sleep(30000 * (i + 1));            // back off 30s / 60s / 90s
    }
    S.failures++; save();
    throw new Error("blocked at " + url.slice(-40));
  }

  const rowsOf = (doc) =>
    [...doc.querySelectorAll("table tr")]
      .filter((tr) => tr.cells && tr.cells.length >= 2)
      .map((tr) => ({
        href: tr.getAttribute("data-href") || "",
        code: tr.cells[0].innerText.trim(),
        label: tr.cells[1].innerText.trim(),
      }));

  window.__dgdCrawl = (async function crawl() {
    if (!S.sections) {
      const d = await get("spip.php?page=tarif_douanier");
      S.sections = rowsOf(d).filter((r) => /^\d{2}$/.test(r.code))
        .map((r) => ({ sec: r.code, label: r.label }));
      save(); await pace();
    }
    if (!S.chapters) {
      S.chapters = [];
      for (const s of S.sections) {
        const d = await get(`spip.php?page=chapitre&section=${s.sec}`);
        rowsOf(d).filter((r) => /^\d{2}$/.test(r.code))
          .forEach((r) => S.chapters.push({ sec: s.sec, ch: r.code, label: r.label }));
        save(); await pace();
      }
    }
    if (!S.ranges) {
      S.ranges = [];
      for (const c of S.chapters) {
        const d = await get(`spip.php?page=range&section=${c.sec}&chapitre=${c.ch}`);
        rowsOf(d).filter((r) => /^\d{2}[A-Z]?$/.test(r.code))
          .forEach((r) => S.ranges.push({ sec: c.sec, ch: c.ch, rg: r.code, label: r.label }));
        save(); await pace();
      }
    }
    for (const r of S.ranges) {
      const k = `${r.ch}-${r.rg}`;
      if (S.doneRanges[k]) continue;
      const d = await get(
        `spip.php?page=position&section=${r.sec}&chapitre=${r.ch}&range=${r.rg}`);
      for (const row of rowsOf(d)) {
        S.rows.push({ ch: r.ch, rg: r.rg, code: row.code, label: row.label,
                      leaf: row.href.includes("sous_position") });
      }
      S.doneRanges[k] = 1; save(); await pace();
    }
    S.finished = true; save();
    return `done: ${S.rows.length} rows`;
  })();

  return "crawler running; check localStorage." + KEY;
})();
