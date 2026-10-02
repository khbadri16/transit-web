import { useEffect, useState } from "react";
import { CalendarDays, Container, FileText, Ship, Tag } from "lucide-react";
import App from "./App";
import Etiquetage from "./Etiquetage";
import Tracking from "./Tracking";
import VisitDay from "./VisitDay";

/* --------------------------------------------------------------------------
 * App shell — left sidebar (desktop) / top tabs (phones) switching between
 * the pages: Documents, Étiquetage (labels), Tracking and Visit day.
 *
 * Both pages stay mounted: switching never loses what was typed. The current
 * page lives in the URL hash (#/etiquetage) so a refresh keeps it.
 * ------------------------------------------------------------------------ */

type Page = "documents" | "etiquetage" | "tracking" | "visit-day";

const pageFromHash = (): Page => {
  const h = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  return h === "etiquetage" || h === "tracking" || h === "visit-day" ? h : "documents";
};

const NAV: { page: Page; label: string; sub: string; icon: typeof FileText }[] = [
  { page: "documents", label: "Documents", sub: "الوثائق", icon: FileText },
  { page: "etiquetage", label: "Étiquetage", sub: "الملصقات", icon: Tag },
  { page: "tracking", label: "Tracking", sub: "التتبع", icon: Container },
  { page: "visit-day", label: "Visit day", sub: "المعاينة", icon: CalendarDays },
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
    const hash = p === "documents" ? "#/" : `#/${p}`;
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
            className={`flex-1 h-9 inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
              page === p
                ? "bg-indigo-500/20 text-indigo-100 border border-indigo-400/50"
                : "text-slate-400 border border-transparent"
            }`}
            aria-current={page === p ? "page" : undefined}
          >
            <Icon size={16} className="shrink-0 max-[459px]:hidden" /> <span className="truncate">{label}</span>
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
        <div className={page === "tracking" ? "h-full" : "hidden"}>
          <Tracking active={page === "tracking"} />
        </div>
        <div className={page === "visit-day" ? "h-full" : "hidden"}>
          <VisitDay active={page === "visit-day"} />
        </div>
      </div>
    </div>
  );
}
