import { useEffect, useState } from "react";
import { FileText, Ship, Tag } from "lucide-react";
import App from "./App";
import Etiquetage from "./Etiquetage";

/* --------------------------------------------------------------------------
 * App shell — left sidebar (desktop) / top tabs (phones) switching between
 * the document generator and the Étiquetage (labels) page.
 *
 * Both pages stay mounted: switching never loses what was typed. The current
 * page lives in the URL hash (#/etiquetage) so a refresh keeps it.
 * ------------------------------------------------------------------------ */

type Page = "documents" | "etiquetage";

const pageFromHash = (): Page =>
  window.location.hash.replace(/^#\/?/, "").toLowerCase() === "etiquetage"
    ? "etiquetage"
    : "documents";

const NAV: { page: Page; label: string; sub: string; icon: typeof FileText }[] = [
  { page: "documents", label: "Documents", sub: "الوثائق", icon: FileText },
  { page: "etiquetage", label: "Étiquetage", sub: "الملصقات", icon: Tag },
];

export default function Shell() {
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (p: Page) => {
    setPage(p);
    const hash = p === "etiquetage" ? "#/etiquetage" : "#/";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };

  return (
    <div className="shell-h flex flex-col md:flex-row bg-[#0a0d14] text-slate-100 overflow-hidden">
      {/* Desktop: left rail */}
      <nav className="side-rail hidden md:flex" aria-label="Pages">
        <div className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30 mb-4">
          <Ship size={22} className="text-white" />
        </div>
        {NAV.map(({ page: p, label, sub, icon: Icon }) => (
          <button
            key={p}
            type="button"
            onClick={() => go(p)}
            className={`side-rail-btn ${page === p ? "side-rail-btn-active" : ""}`}
            aria-current={page === p ? "page" : undefined}
            title={label}
          >
            <Icon size={20} />
            <span className="text-[10.5px] font-semibold leading-tight">{label}</span>
            <span className="text-[10px] text-slate-500 leading-tight">{sub}</span>
          </button>
        ))}
      </nav>

      {/* Phones: top tabs */}
      <nav className="md:hidden flex items-center gap-1.5 px-3 h-12 shrink-0 border-b border-slate-800 bg-[#0b0f19]" aria-label="Pages">
        {NAV.map(({ page: p, label, icon: Icon }) => (
          <button
            key={p}
            type="button"
            onClick={() => go(p)}
            className={`flex-1 h-9 inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors ${
              page === p
                ? "bg-indigo-500/20 text-indigo-100 border border-indigo-400/50"
                : "text-slate-400 border border-transparent"
            }`}
            aria-current={page === p ? "page" : undefined}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 min-h-0 min-w-0">
        <div className={page === "documents" ? "h-full" : "hidden"}>
          <App />
        </div>
        <div className={page === "etiquetage" ? "h-full" : "hidden"}>
          <Etiquetage active={page === "etiquetage"} />
        </div>
      </div>
    </div>
  );
}
